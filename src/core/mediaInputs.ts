// macOS may leave the native permission sheet open while the user reads it.
// Keep permission acquisition generous, then use a shorter deadline only for
// starting an already-authorised device.
export const MEDIA_PERMISSION_TIMEOUT_MS = 120_000;
export const MEDIA_DEVICE_START_TIMEOUT_MS = 20_000;

export type MediaInputTarget = "devices" | "camera" | "microphone";

export type MediaInputErrorCode =
  | "unsupported"
  | "permission-denied"
  | "not-found"
  | "device-busy"
  | "overconstrained"
  | "aborted"
  | "security"
  | "timeout"
  | "disposed"
  | "unknown";

export class MediaInputError extends Error {
  readonly code: MediaInputErrorCode;
  readonly target: MediaInputTarget;
  readonly originalError: unknown;

  constructor(
    code: MediaInputErrorCode,
    target: MediaInputTarget,
    message: string,
    originalError?: unknown,
  ) {
    super(message);
    this.name = "MediaInputError";
    this.code = code;
    this.target = target;
    this.originalError = originalError;
  }
}

export type MediaDeviceOption = Readonly<{
  deviceId: string;
  groupId: string;
  kind: "videoinput" | "audioinput";
  label: string;
  isDefault: boolean;
}>;

export type MediaInputDevices = Readonly<{
  cameras: readonly MediaDeviceOption[];
  microphones: readonly MediaDeviceOption[];
}>;

export type CameraSession = Readonly<{
  stream: MediaStream;
  track: MediaStreamTrack;
  video: HTMLVideoElement;
  deviceId: string;
  requestedDeviceId: string | null;
}>;

export type MicrophoneSession = Readonly<{
  stream: MediaStream;
  track: MediaStreamTrack;
  deviceId: string;
  requestedDeviceId: string | null;
}>;

export type MediaDeviceChangeEvent =
  | Readonly<{ devices: MediaInputDevices; error: null }>
  | Readonly<{ devices: null; error: MediaInputError }>;

export type MediaDeviceChangeListener = (
  event: MediaDeviceChangeEvent,
) => void;

const ERROR_MESSAGES: Record<
  MediaInputTarget,
  Record<MediaInputErrorCode, string>
> = {
  devices: {
    unsupported: "当前环境不支持媒体设备 API。",
    "permission-denied": "媒体设备权限被拒绝。",
    "not-found": "没有找到可用的媒体设备。",
    "device-busy": "媒体设备正被其他应用占用。",
    overconstrained: "媒体设备不支持所请求的参数。",
    aborted: "媒体设备请求已取消。",
    security: "当前页面无权访问媒体设备。",
    timeout: "媒体设备请求超时。",
    disposed: "媒体设备管理器已释放。",
    unknown: "读取媒体设备时发生未知错误。",
  },
  camera: {
    unsupported: "当前环境不支持摄像头。",
    "permission-denied": "摄像头权限被拒绝。",
    "not-found": "没有找到可用的摄像头。",
    "device-busy": "摄像头正被其他应用占用。",
    overconstrained: "摄像头不支持所请求的参数。",
    aborted: "摄像头请求已取消。",
    security: "当前页面无权访问摄像头。",
    timeout: "等待摄像头授权或设备启动超时。",
    disposed: "媒体设备管理器已释放。",
    unknown: "打开摄像头时发生未知错误。",
  },
  microphone: {
    unsupported: "当前环境不支持麦克风。",
    "permission-denied": "麦克风权限被拒绝。",
    "not-found": "没有找到可用的麦克风。",
    "device-busy": "麦克风正被其他应用占用。",
    overconstrained: "麦克风不支持所请求的参数。",
    aborted: "麦克风请求已取消。",
    security: "当前页面无权访问麦克风。",
    timeout: "等待麦克风授权或设备启动超时。",
    disposed: "媒体设备管理器已释放。",
    unknown: "打开麦克风时发生未知错误。",
  },
};

const errorName = (error: unknown) => {
  if (!error || typeof error !== "object" || !("name" in error)) return "";
  return String(error.name);
};

export const mapMediaInputError = (
  error: unknown,
  target: MediaInputTarget,
): MediaInputError => {
  if (error instanceof MediaInputError) return error;

  const code: MediaInputErrorCode = (() => {
    switch (errorName(error)) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "permission-denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "not-found";
      case "NotReadableError":
      case "TrackStartError":
        return "device-busy";
      case "OverconstrainedError":
      case "ConstraintNotSatisfiedError":
        return "overconstrained";
      case "AbortError":
        return "aborted";
      case "SecurityError":
        return "security";
      case "TypeError":
        return "unsupported";
      default:
        return "unknown";
    }
  })();

  return new MediaInputError(
    code,
    target,
    ERROR_MESSAGES[target][code],
    error,
  );
};

const createMediaInputError = (
  code: MediaInputErrorCode,
  target: MediaInputTarget,
  originalError?: unknown,
) =>
  new MediaInputError(
    code,
    target,
    ERROR_MESSAGES[target][code],
    originalError,
  );

const getMediaDevices = (target: MediaInputTarget): MediaDevices => {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function" ||
    typeof navigator.mediaDevices.enumerateDevices !== "function"
  ) {
    throw createMediaInputError("unsupported", target);
  }
  return navigator.mediaDevices;
};

const stopStream = (stream: MediaStream | null) => {
  stream?.getTracks().forEach((track) => track.stop());
};

const detachVideo = (video: HTMLVideoElement | null) => {
  if (!video) return;
  video.pause();
  video.srcObject = null;
  video.remove();
};

const createCameraVideo = (stream: MediaStream) => {
  if (typeof document === "undefined") {
    throw createMediaInputError("unsupported", "camera");
  }

  const video = document.createElement("video");
  video.autoplay = true;
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.disablePictureInPicture = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.dataset.mediaInputSource = "camera";

  // WKWebView is more reliable when the media element is connected to the DOM.
  // Keep it paintable but completely outside the visible/interactive viewport.
  Object.assign(video.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(video);
  video.srcObject = stream;
  return video;
};

const requestUserMedia = (
  target: Exclude<MediaInputTarget, "devices">,
  constraints: MediaStreamConstraints,
  timeoutMs: number,
): Promise<MediaStream> => {
  const mediaDevices = getMediaDevices(target);

  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false;
    let request: Promise<MediaStream>;

    try {
      request = mediaDevices.getUserMedia(constraints);
    } catch (error) {
      reject(mapMediaInputError(error, target));
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(createMediaInputError("timeout", target));
    }, timeoutMs);

    request.then(
      (stream) => {
        if (settled) {
          // getUserMedia cannot be aborted. If permission resolves after our
          // timeout, immediately release the otherwise leaked late stream.
          stopStream(stream);
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeoutId);
        resolve(stream);
      },
      (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        reject(mapMediaInputError(error, target));
      },
    );
  });
};

const withTimeout = <T>(
  promise: Promise<T>,
  target: Exclude<MediaInputTarget, "devices">,
  timeoutMs: number,
) =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(createMediaInputError("timeout", target));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        reject(mapMediaInputError(error, target));
      },
    );
  });

const waitForCurrentVideoFrame = (
  video: HTMLVideoElement,
  timeoutMs: number,
) => {
  if (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  ) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
      globalThis.clearTimeout(timeoutId);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(mapMediaInputError(error, "camera"));
      } else {
        resolve();
      }
    };
    const onReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) finish();
    };
    const onError = () =>
      finish(video.error ?? new Error("The camera preview could not load."));
    const timeoutId = globalThis.setTimeout(
      () => finish(createMediaInputError("timeout", "camera")),
      timeoutMs,
    );

    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
  });
};

const selectedDeviceId = (deviceId?: string) => {
  const normalized = deviceId?.trim();
  return normalized ? normalized : null;
};

const deviceConstraint = (deviceId: string | null) =>
  deviceId ? ({ exact: deviceId } as const) : undefined;

const isSameRequestedDevice = (
  requestedDeviceId: string | null,
  current: { deviceId: string; requestedDeviceId: string | null },
) =>
  requestedDeviceId === null ||
  current.requestedDeviceId === requestedDeviceId ||
  current.deviceId === requestedDeviceId;

const microphoneConstraintAttempts = (
  requestedDeviceId: string | null,
): readonly MediaTrackConstraints[] => {
  const deviceId = deviceConstraint(requestedDeviceId);
  const advanced: MediaTrackConstraints = {
    deviceId,
    sampleRate: { ideal: 48_000 },
    channelCount: { ideal: 1 },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  if (!requestedDeviceId) {
    return [advanced, {}];
  }

  return [advanced, { deviceId }, {}];
};

const cameraConstraintAttempts = (
  requestedDeviceId: string | null,
): readonly (MediaTrackConstraints | true)[] => {
  const deviceId = deviceConstraint(requestedDeviceId);
  const preferred: MediaTrackConstraints = {
    deviceId,
    width: { ideal: 640 },
    height: { ideal: 360 },
    frameRate: { ideal: 30, max: 30 },
  };

  if (!requestedDeviceId) return [preferred, true];
  return [preferred, { deviceId }, { width: { ideal: 640 }, height: { ideal: 360 } }, true];
};

const canFallbackMicrophoneRequest = (error: MediaInputError) =>
  ![
    "permission-denied",
    "security",
    "timeout",
    "disposed",
  ].includes(error.code);

const canFallbackCameraRequest = canFallbackMicrophoneRequest;

export class MediaInputManager {
  private cameraSession: CameraSession | null = null;
  private microphoneSession: MicrophoneSession | null = null;
  private cameraRequestId = 0;
  private microphoneRequestId = 0;
  private disposed = false;
  private deviceChangeListening = false;
  private readonly deviceChangeListeners =
    new Set<MediaDeviceChangeListener>();

  private readonly handleNativeDeviceChange = () => {
    void this.enumerate().then(
      (devices) => this.emitDeviceChange({ devices, error: null }),
      (error) =>
        this.emitDeviceChange({
          devices: null,
          error: mapMediaInputError(error, "devices"),
        }),
    );
  };

  async enumerate(): Promise<MediaInputDevices> {
    this.assertAvailable("devices");

    try {
      const devices = await getMediaDevices("devices").enumerateDevices();
      let cameraNumber = 0;
      let microphoneNumber = 0;
      const cameras: MediaDeviceOption[] = [];
      const microphones: MediaDeviceOption[] = [];

      devices.forEach((device) => {
        if (device.kind === "videoinput") {
          cameraNumber += 1;
          cameras.push({
            deviceId: device.deviceId,
            groupId: device.groupId,
            kind: "videoinput",
            label: device.label.trim() || `摄像头 ${cameraNumber}`,
            isDefault: device.deviceId === "default",
          });
        } else if (device.kind === "audioinput") {
          microphoneNumber += 1;
          microphones.push({
            deviceId: device.deviceId,
            groupId: device.groupId,
            kind: "audioinput",
            label: device.label.trim() || `麦克风 ${microphoneNumber}`,
            isDefault: device.deviceId === "default",
          });
        }
      });

      return { cameras, microphones };
    } catch (error) {
      throw mapMediaInputError(error, "devices");
    }
  }

  async startCamera(deviceId?: string): Promise<CameraSession> {
    this.assertAvailable("camera");
    const requestedDeviceId = selectedDeviceId(deviceId);
    const current = this.cameraSession;
    if (
      current?.track.readyState === "live" &&
      isSameRequestedDevice(requestedDeviceId, current)
    ) {
      return current;
    }

    const requestId = ++this.cameraRequestId;
    const permissionDeadline = Date.now() + MEDIA_PERMISSION_TIMEOUT_MS;
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    let lastError: MediaInputError | null = null;

    const attempts = cameraConstraintAttempts(requestedDeviceId);
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      try {
        const remainingPermissionMs = permissionDeadline - Date.now();
        if (remainingPermissionMs <= 0) {
          throw createMediaInputError("timeout", "camera", lastError);
        }
        stream = await requestUserMedia(
          "camera",
          { audio: false, video: attempts[attemptIndex] },
          remainingPermissionMs,
        );
        this.assertCurrentCameraRequest(requestId);

        const track = stream.getVideoTracks()[0];
        if (!track) {
          throw createMediaInputError("not-found", "camera");
        }

        video = createCameraVideo(stream);
        await withTimeout(
          video.play(),
          "camera",
          MEDIA_DEVICE_START_TIMEOUT_MS,
        );
        await waitForCurrentVideoFrame(video, MEDIA_DEVICE_START_TIMEOUT_MS);
        this.assertCurrentCameraRequest(requestId);

        const session: CameraSession = {
          stream,
          track,
          video,
          deviceId: track.getSettings().deviceId ?? requestedDeviceId ?? "",
          requestedDeviceId,
        };
        track.addEventListener(
          "ended",
          () => {
            if (this.cameraSession?.track !== track) return;
            const endedSession = this.cameraSession;
            this.cameraSession = null;
            detachVideo(endedSession.video);
            stopStream(endedSession.stream);
          },
          { once: true },
        );

        const previous = this.cameraSession;
        this.cameraSession = session;
        if (previous) this.stopCameraSession(previous);
        return session;
      } catch (error) {
        detachVideo(video);
        stopStream(stream);
        video = null;
        stream = null;
        if (this.disposed) {
          throw createMediaInputError("disposed", "camera", error);
        }
        if (requestId !== this.cameraRequestId) {
          throw createMediaInputError("aborted", "camera", error);
        }

        lastError = mapMediaInputError(error, "camera");
        const hasFallback = attemptIndex < attempts.length - 1;
        if (!hasFallback || !canFallbackCameraRequest(lastError)) {
          throw lastError;
        }
      }
    }

    throw lastError ?? createMediaInputError("unknown", "camera");
  }

  stopCamera() {
    this.cameraRequestId += 1;
    const session = this.cameraSession;
    this.cameraSession = null;
    if (session) this.stopCameraSession(session);
  }

  getCameraSession() {
    return this.cameraSession;
  }

  async acquireMicrophone(deviceId?: string): Promise<MicrophoneSession> {
    this.assertAvailable("microphone");
    const requestedDeviceId = selectedDeviceId(deviceId);
    const current = this.microphoneSession;
    if (
      current?.track.readyState === "live" &&
      isSameRequestedDevice(requestedDeviceId, current)
    ) {
      return current;
    }

    const requestId = ++this.microphoneRequestId;
    const deadline = Date.now() + MEDIA_PERMISSION_TIMEOUT_MS;
    let stream: MediaStream | null = null;
    let lastError: MediaInputError | null = null;

    const attempts = microphoneConstraintAttempts(requestedDeviceId);
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw createMediaInputError("timeout", "microphone", lastError);
        }

        stream = await requestUserMedia(
          "microphone",
          {
            video: false,
            audio: attempts[attemptIndex],
          },
          remainingMs,
        );
        this.assertCurrentMicrophoneRequest(requestId);

        const track = stream.getAudioTracks()[0];
        if (!track) {
          throw createMediaInputError("not-found", "microphone");
        }

        const session: MicrophoneSession = {
          stream,
          track,
          deviceId: track.getSettings().deviceId ?? requestedDeviceId ?? "",
          requestedDeviceId,
        };
        track.addEventListener(
          "ended",
          () => {
            if (this.microphoneSession?.track !== track) return;
            const endedSession = this.microphoneSession;
            this.microphoneSession = null;
            stopStream(endedSession.stream);
          },
          { once: true },
        );

        const previous = this.microphoneSession;
        this.microphoneSession = session;
        if (previous) stopStream(previous.stream);
        return session;
      } catch (error) {
        // A resolved stream can still fail validation or be superseded. Never
        // leave it live while trying a less restrictive constraint set.
        stopStream(stream);
        stream = null;

        if (this.disposed) {
          throw createMediaInputError("disposed", "microphone", error);
        }
        if (requestId !== this.microphoneRequestId) {
          throw createMediaInputError("aborted", "microphone", error);
        }

        lastError = mapMediaInputError(error, "microphone");
        const hasFallback = attemptIndex < attempts.length - 1;
        if (!hasFallback || !canFallbackMicrophoneRequest(lastError)) {
          throw lastError;
        }
      }
    }

    throw lastError ?? createMediaInputError("unknown", "microphone");
  }

  releaseMicrophone() {
    this.microphoneRequestId += 1;
    const session = this.microphoneSession;
    this.microphoneSession = null;
    stopStream(session?.stream ?? null);
  }

  getMicrophoneSession() {
    return this.microphoneSession;
  }

  onDeviceChange(listener: MediaDeviceChangeListener) {
    this.assertAvailable("devices");
    this.deviceChangeListeners.add(listener);
    this.attachDeviceChangeListener();

    return () => {
      this.deviceChangeListeners.delete(listener);
      if (this.deviceChangeListeners.size === 0) {
        this.detachDeviceChangeListener();
      }
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCamera();
    this.releaseMicrophone();
    this.detachDeviceChangeListener();
    this.deviceChangeListeners.clear();
  }

  private assertAvailable(target: MediaInputTarget) {
    if (this.disposed) {
      throw createMediaInputError("disposed", target);
    }
    getMediaDevices(target);
  }

  private assertCurrentCameraRequest(requestId: number) {
    this.assertAvailable("camera");
    if (requestId !== this.cameraRequestId) {
      throw createMediaInputError("aborted", "camera");
    }
  }

  private assertCurrentMicrophoneRequest(requestId: number) {
    this.assertAvailable("microphone");
    if (requestId !== this.microphoneRequestId) {
      throw createMediaInputError("aborted", "microphone");
    }
  }

  private stopCameraSession(session: CameraSession) {
    detachVideo(session.video);
    stopStream(session.stream);
  }

  private attachDeviceChangeListener() {
    if (this.deviceChangeListening) return;
    getMediaDevices("devices").addEventListener(
      "devicechange",
      this.handleNativeDeviceChange,
    );
    this.deviceChangeListening = true;
  }

  private detachDeviceChangeListener() {
    if (!this.deviceChangeListening) return;
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        this.handleNativeDeviceChange,
      );
    }
    this.deviceChangeListening = false;
  }

  private emitDeviceChange(event: MediaDeviceChangeEvent) {
    this.deviceChangeListeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error("Media device change listener failed", error);
      }
    });
  }
}
