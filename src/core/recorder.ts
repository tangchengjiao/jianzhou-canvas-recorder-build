import {
  createPreferredRecordingSink,
  type RecordingSink,
  type RecordingSinkStats,
} from "./recordingSink";

export type RecorderStartResult = {
  mimeType: string;
};

export type RecorderOptions = {
  audioTrack?: MediaStreamTrack | null;
  videoBitsPerSecond?: number;
  onError?: (error: Error) => void;
  /** Defaults to OPFS streaming when supported, otherwise explicit short-memory mode. */
  recordingSink?: RecordingSink;
};

const START_TIMEOUT_MS = 4_000;
const STOP_TIMEOUT_MS = 8_000;
const RUNTIME_ERROR_STOP_GRACE_MS = 2_000;
const FINAL_FRAME_GRACE_MS = 50;
const FALLBACK_CAPTURE_FPS = 30;

const toError = (value: unknown, fallback: string) => {
  if (value instanceof Error) return value;
  if (value instanceof DOMException) return new Error(value.message);
  return new Error(typeof value === "string" ? value : fallback);
};

const recorderEventError = (event: Event) =>
  toError(
    (event as Event & { error?: DOMException }).error,
    "浏览器录制器发生错误",
  );

const getMimeTypeCandidates = (hasAudio: boolean) => {
  // Prefer an editor-friendly MP4 file, but keep WebM as a reliable browser
  // fallback. `isTypeSupported()` is only a capability hint: some Chromium
  // and hardware combinations still fail in the constructor or during
  // `start()`, so `CanvasRecorder.start()` tries every supported candidate.
  const candidates = hasAudio
    ? [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1.42001E,mp4a.40.2",
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm",
      ]
    : [
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4;codecs=avc1.42001E",
        "video/mp4;codecs=avc1",
        "video/mp4",
        "video/webm;codecs=vp8",
        "video/webm;codecs=vp9",
        "video/webm",
      ];

  const supported = candidates.filter((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );

  // Let the browser choose a container only on engines that do not advertise
  // any explicit candidate. The resulting recorder MIME type remains the
  // source of truth for the downloaded extension.
  return supported.length > 0 ? supported : [""];
};

const requestCanvasFrame = (track: CanvasCaptureMediaStreamTrack | null) => {
  try {
    if (
      track?.readyState === "live" &&
      typeof track.requestFrame === "function"
    ) {
      track.requestFrame();
    }
  } catch {
    // A broken requestFrame implementation must not crash the compositor loop.
  }
};

const createCanvasCaptureStream = (canvas: HTMLCanvasElement) => {
  let manualStream: MediaStream | null = null;

  try {
    manualStream = canvas.captureStream(0);
    const manualTrack = manualStream
      .getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    if (manualTrack && typeof manualTrack.requestFrame === "function") {
      try {
        // Presence alone is not sufficient on a few partial implementations.
        manualTrack.requestFrame();
        return manualStream;
      } catch {
        // Fall through to a browser-driven stream below.
      }
    }
  } catch {
    // Some engines reject a zero frame rate instead of exposing requestFrame().
  }

  // A zero-rate stream without requestFrame() would remain frozen forever.
  // Release it before creating a regular browser-driven capture stream.
  manualStream?.getTracks().forEach((track) => track.stop());
  return canvas.captureStream(FALLBACK_CAPTURE_FPS);
};

export class CanvasRecorder {
  private recorder: MediaRecorder | null = null;
  private recordingSink: RecordingSink | null = null;
  private lastSinkStats: RecordingSinkStats | null = null;
  private sinkWriteError: Error | null = null;
  private runtimeError: Error | null = null;
  private runtimeErrorNotified = false;
  private runtimeErrorNotificationPending = false;
  private runtimeErrorTimer = 0;
  private runtimeStopListener: (() => void) | null = null;
  private ownedTracks: MediaStreamTrack[] = [];
  private readonly ownedTrackEndListeners = new Map<
    MediaStreamTrack,
    () => void
  >();
  private canvasTrack: CanvasCaptureMediaStreamTrack | null = null;
  private activeMimeType = "";
  private onError: ((error: Error) => void) | null = null;

  private readonly handleRuntimeError = (event: Event) => {
    const error = recorderEventError(event);
    this.runtimeError ??= error;
    this.deferRuntimeErrorNotification(error);
  };

  async start(
    canvas: HTMLCanvasElement,
    options: RecorderOptions = {},
  ): Promise<RecorderStartResult> {
    if (this.recorder && this.recorder.state !== "inactive") {
      throw new Error("录制器已经在运行");
    }

    await this.abortInternal();
    // A zero-rate stream lets the compositor request exactly one encoded
    // frame after each complete double-buffered paint. This avoids Chromium
    // sampling the canvas midway through a frame and removes a second,
    // unsynchronised 30fps capture loop.
    const canvasStream = createCanvasCaptureStream(canvas);
    const videoTracks = canvasStream.getVideoTracks();
    if (videoTracks.length === 0) {
      canvasStream.getTracks().forEach((track) => track.stop());
      throw new Error("浏览器无法从输出画布创建视频轨道");
    }

    try {
      const tracks: MediaStreamTrack[] = [...videoTracks];
      // Own the canvas tracks before cloning optional audio so every early
      // failure (including a failed `clone()`) releases the capture stream.
      this.ownedTracks = tracks;
      if (options.audioTrack?.readyState === "live") {
        tracks.push(options.audioTrack.clone());
      }

      this.canvasTrack = videoTracks[0] as CanvasCaptureMediaStreamTrack;
      this.onError = options.onError ?? null;
      this.recordingSink = options.recordingSink ?? createPreferredRecordingSink();
      this.lastSinkStats = null;
      this.sinkWriteError = null;
      this.runtimeError = null;
      this.runtimeErrorNotified = false;
      this.runtimeErrorNotificationPending = false;
      window.clearTimeout(this.runtimeErrorTimer);
      this.runtimeErrorTimer = 0;

      const hasAudio = tracks.some((track) => track.kind === "audio");
      const stream = new MediaStream(tracks);
      const failures: string[] = [];

      for (const mimeType of getMimeTypeCandidates(hasAudio)) {
        const settings: MediaRecorderOptions = {
          videoBitsPerSecond: options.videoBitsPerSecond ?? 4_000_000,
          ...(hasAudio ? { audioBitsPerSecond: 96_000 } : {}),
          ...(mimeType ? { mimeType } : {}),
        };

        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, settings);
        } catch (error) {
          failures.push(
            `${mimeType || "浏览器默认格式"}：${toError(error, "创建失败").message}`,
          );
          continue;
        }

        const candidateMimeType =
          recorder.mimeType || mimeType || "video/webm";
        try {
          await this.recordingSink.open({ mimeType: candidateMimeType });
        } catch (error) {
          throw toError(error, "Could not open recording storage.");
        }

        this.recorder = recorder;
        recorder.addEventListener("dataavailable", this.handleDataAvailable);

        try {
          await this.startCandidate(recorder);
        } catch (error) {
          failures.push(
            `${mimeType || "浏览器默认格式"}：${toError(error, "启动失败").message}`,
          );
          await this.discardCandidate(recorder);
          await this.recordingSink.abort(error);
          this.recorder = null;
          continue;
        }

        this.activeMimeType = candidateMimeType;
        recorder.addEventListener("error", this.handleRuntimeError);
        this.attachOwnedTrackEndListeners();
        return { mimeType: this.activeMimeType };
      }

      const detail = failures.length > 0 ? `：${failures.join("；")}` : "";
      throw new Error(`无法启动浏览器录制器，已尝试 MP4 和 WebM${detail}`);
    } catch (error) {
      await this.abortInternal(error);
      throw toError(error, "无法创建浏览器录制器");
    }
  }

  requestFrame() {
    requestCanvasFrame(this.canvasTrack);
  }

  pause() {
    if (this.recorder?.state === "recording") this.recorder.pause();
  }

  resume() {
    if (this.recorder?.state === "paused") this.recorder.resume();
  }

  async stop(): Promise<Blob> {
    const recorder = this.recorder;
    const sink = this.recordingSink;
    if (!recorder || !sink) {
      throw new Error("没有正在进行的录制");
    }

    recorder.removeEventListener("error", this.handleRuntimeError);
    this.clearRuntimeErrorNotification();

    if (recorder.state === "inactive") {
      try {
        const blob = await sink.finalize();
        const terminalError = this.runtimeError ?? this.sinkWriteError;
        this.lastSinkStats = sink.stats();
        this.cleanupSession();
        if (terminalError) throw terminalError;
        if (blob.size === 0) {
          throw new Error("录制结果为空，请降低画质后重试");
        }
        return blob;
      } catch (error) {
        this.lastSinkStats = sink.stats();
        this.cleanupSession();
        throw toError(error, "封装录制结果失败");
      }
    }

    return new Promise<Blob>((resolve, reject) => {
      let settled = false;
      let stopTimer = 0;
      let watchdogTimer = 0;
      const cleanupListeners = () => {
        window.clearTimeout(stopTimer);
        window.clearTimeout(watchdogTimer);
        recorder.removeEventListener("stop", handleStop);
        recorder.removeEventListener("error", handleError);
      };
      const finish = () => {
        if (settled) return false;
        settled = true;
        cleanupListeners();
        this.lastSinkStats = sink.stats();
        this.cleanupSession();
        return true;
      };
      const handleError = (event: Event) => {
        const error = recorderEventError(event);
        this.runtimeError ??= error;
        // MediaRecorder dispatches its final dataavailable before stop. Do not
        // tear down listeners or storage from the error event itself.
      };
      const handleStop = async () => {
        if (settled) return;
        // The media stop watchdog only guards the browser event. Sink drain
        // and final file close are allowed to take as long as storage needs.
        cleanupListeners();
        try {
          const blob = await sink.finalize();
          const terminalError = this.runtimeError ?? this.sinkWriteError;
          if (!finish()) return;
          if (terminalError) {
            reject(terminalError);
          } else if (blob.size === 0) {
            reject(new Error("录制结果为空，请降低画质后重试"));
          } else {
            resolve(blob);
          }
        } catch (error) {
          if (!finish()) return;
          reject(toError(error, "封装录制结果失败"));
        }
      };

      recorder.addEventListener("stop", handleStop, { once: true });
      recorder.addEventListener("error", handleError, { once: true });

      const stopRecorder = () => {
        if (settled) return;
        try {
          if (recorder.state === "recording") recorder.requestData();
          if (recorder.state !== "inactive") recorder.stop();
        } catch (error) {
          const stopError = toError(error, "停止录制失败");
          void sink.abort(stopError).finally(() => {
            if (!finish()) return;
            reject(stopError);
          });
        }
      };

      watchdogTimer = window.setTimeout(async () => {
        if (settled) return;
        const timeoutError = new Error(
          "停止录制超时（8 秒），已释放录制轨道，请重新录制",
        );
        try {
          if (recorder.state === "recording") recorder.requestData();
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // cleanupSession() below still releases every owned track.
        }
        await sink.abort(timeoutError).catch(() => undefined);
        if (!finish()) return;
        reject(timeoutError);
      }, STOP_TIMEOUT_MS);

      // Ask the zero-rate canvas track for one final complete compositor frame.
      // The short grace period also lets a 30fps fallback stream publish its
      // latest frame before requestData()/stop() finalize the container.
      requestCanvasFrame(this.canvasTrack);
      stopTimer = window.setTimeout(stopRecorder, FINAL_FRAME_GRACE_MS);
    });
  }

  abort() {
    void this.abortInternal();
  }

  getRecordingSinkStats() {
    return this.recordingSink?.stats() ?? this.lastSinkStats;
  }

  private async abortInternal(reason?: unknown) {
    const recorder = this.recorder;
    const sink = this.recordingSink;
    if (recorder) {
      recorder.removeEventListener("dataavailable", this.handleDataAvailable);
      recorder.removeEventListener("error", this.handleRuntimeError);
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // The tracks are still stopped below even when the recorder is broken.
        }
      }
    }
    window.clearTimeout(this.runtimeErrorTimer);
    this.runtimeErrorTimer = 0;
    if (sink) this.lastSinkStats = sink.stats();
    this.cleanupSession();
    if (sink) {
      await sink.abort(reason).catch(() => undefined);
      this.lastSinkStats = sink.stats();
    }
  }

  private startCandidate(recorder: MediaRecorder) {
    return new Promise<void>((resolve, reject) => {
      let timer = 0;
      let startupFramePump = 0;
      const cleanup = () => {
        window.clearTimeout(timer);
        window.clearInterval(startupFramePump);
        recorder.removeEventListener("start", handleStart);
        recorder.removeEventListener("error", handleError);
      };
      const handleStart = () => {
        cleanup();
        resolve();
      };
      const handleError = (event: Event) => {
        cleanup();
        reject(recorderEventError(event));
      };

      recorder.addEventListener("start", handleStart, { once: true });
      recorder.addEventListener("error", handleError, { once: true });
      timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("录制器启动超时，请重试或降低画质"));
      }, START_TIMEOUT_MS);

      try {
        recorder.start(1_000);
        requestCanvasFrame(this.canvasTrack);
        // Chromium may defer MediaRecorder's `start` event for an A/V
        // stream until it has seen more than one video frame. Pump a few
        // duplicate complete frames only during the startup handshake;
        // steady-state frames remain compositor-driven.
        startupFramePump = window.setInterval(
          () => requestCanvasFrame(this.canvasTrack),
          100,
        );
      } catch (error) {
        cleanup();
        reject(toError(error, "录制器启动失败"));
      }
    });
  }

  private async discardCandidate(recorder: MediaRecorder) {
    recorder.removeEventListener("dataavailable", this.handleDataAvailable);
    if (recorder.state === "inactive") return;

    await new Promise<void>((resolve) => {
      let timer = 0;
      const cleanup = () => {
        window.clearTimeout(timer);
        recorder.removeEventListener("stop", finish);
        recorder.removeEventListener("error", finish);
      };
      const finish = () => {
        cleanup();
        resolve();
      };

      recorder.addEventListener("stop", finish, { once: true });
      recorder.addEventListener("error", finish, { once: true });
      timer = window.setTimeout(finish, 500);
      try {
        recorder.stop();
      } catch {
        finish();
      }
    });
  }

  private readonly handleDataAvailable = (event: BlobEvent) => {
    const sink = this.recordingSink;
    if (!sink || event.data.size === 0) return;
    void sink.write(event.data).catch((value) => {
      const error = toError(value, "Recording storage write failed.");
      if (this.sinkWriteError) return;
      this.sinkWriteError = error;
      this.runtimeError ??= error;
      this.deferRuntimeErrorNotification(error);

      // Stop producing chunks once bounded storage has failed. The deferred
      // error notification waits for MediaRecorder's terminal dataavailable
      // and stop sequence before the app is allowed to tear the session down.
      const recorder = this.recorder;
      if (!recorder || recorder.state === "inactive") return;
      try {
        if (recorder.state === "recording") recorder.requestData();
        recorder.stop();
      } catch {
        // The runtime notification watchdog will release the session.
      }
    });
  };

  private deferRuntimeErrorNotification(error: Error) {
    if (
      this.runtimeErrorNotified ||
      this.runtimeErrorNotificationPending
    ) {
      return;
    }
    this.runtimeErrorNotificationPending = true;

    const notify = () => {
      if (this.runtimeErrorNotified) return;
      this.runtimeErrorNotificationPending = false;
      this.runtimeErrorNotified = true;
      this.stopOwnedTracks();
      this.onError?.(error);
    };
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      const handleStop = () => {
        this.runtimeStopListener = null;
        window.clearTimeout(this.runtimeErrorTimer);
        // stop is dispatched after the final dataavailable event. Defer one
        // more task so all data listeners can enqueue their sink writes first.
        this.runtimeErrorTimer = window.setTimeout(notify, 0);
      };
      this.runtimeStopListener = handleStop;
      recorder.addEventListener("stop", handleStop, { once: true });
      this.runtimeErrorTimer = window.setTimeout(() => {
        if (this.runtimeStopListener) {
          recorder.removeEventListener("stop", this.runtimeStopListener);
          this.runtimeStopListener = null;
        }
        notify();
      }, RUNTIME_ERROR_STOP_GRACE_MS);
      return;
    }

    this.runtimeErrorTimer = window.setTimeout(notify, 0);
  }

  private clearRuntimeErrorNotification() {
    window.clearTimeout(this.runtimeErrorTimer);
    this.runtimeErrorTimer = 0;
    if (this.recorder && this.runtimeStopListener) {
      this.recorder.removeEventListener("stop", this.runtimeStopListener);
    }
    this.runtimeStopListener = null;
    this.runtimeErrorNotificationPending = false;
  }

  private stopOwnedTracks() {
    this.detachOwnedTrackEndListeners();
    this.ownedTracks.forEach((track) => track.stop());
    this.ownedTracks = [];
  }

  private attachOwnedTrackEndListeners() {
    this.detachOwnedTrackEndListeners();
    this.ownedTracks.forEach((track) => {
      const handleEnded = () => {
        const recorder = this.recorder;
        if (!recorder || recorder.state === "inactive") return;
        const error = new Error(
          track.kind === "audio"
            ? "麦克风轨道意外结束，录制已安全停止。"
            : "录制画面轨道意外结束，录制已安全停止。",
        );
        this.runtimeError ??= error;
        try {
          if (recorder.state === "recording") recorder.requestData();
          recorder.stop();
        } catch {
          // The notification watchdog still releases tracks and reports the failure.
        }
        this.deferRuntimeErrorNotification(error);
      };
      this.ownedTrackEndListeners.set(track, handleEnded);
      track.addEventListener("ended", handleEnded, { once: true });
    });
  }

  private detachOwnedTrackEndListeners() {
    this.ownedTrackEndListeners.forEach((listener, track) => {
      track.removeEventListener("ended", listener);
    });
    this.ownedTrackEndListeners.clear();
  }

  private cleanupSession() {
    this.clearRuntimeErrorNotification();
    this.stopOwnedTracks();
    this.recorder?.removeEventListener(
      "dataavailable",
      this.handleDataAvailable,
    );
    this.recorder?.removeEventListener("error", this.handleRuntimeError);
    this.recorder = null;
    this.recordingSink = null;
    this.canvasTrack = null;
    this.activeMimeType = "";
    this.sinkWriteError = null;
    this.runtimeError = null;
    this.runtimeErrorNotified = false;
    this.onError = null;
  }
}

type RecordingMimeSource = string | Pick<Blob, "type">;

const getMimeType = (source: RecordingMimeSource) =>
  (typeof source === "string" ? source : source.type)
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

export const getRecordingFileExtension = (
  source: RecordingMimeSource = "video/webm",
) => {
  const mimeType = getMimeType(source);
  if (mimeType === "video/mp4" || mimeType === "application/mp4") {
    return "mp4";
  }
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/x-matroska") return "mkv";
  return "webm";
};

export const createRecordingFilename = (
  source: RecordingMimeSource = "video/webm",
  date = new Date(),
) => {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(
    date.getSeconds(),
  )}`;
  return `excalidraw-recording_${stamp}.${getRecordingFileExtension(source)}`;
};

export const downloadRecording = (
  blob: Blob,
  filename = createRecordingFilename(blob),
) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return filename;
};
