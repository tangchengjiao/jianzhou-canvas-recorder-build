import {
  HOST_CAPABILITIES,
  UnsupportedCapabilityError,
  type HostBridge,
  type HostCapability,
  type HostCapabilityProvider,
  type HostCapabilitySnapshot,
  type HostCapabilityStatus,
  type HostPathSelection,
  type HostWritableStream,
  type HostWindowReference,
  type HostWriteStreamOptions,
  type IsolatedHtmlWebviewRequest,
  type OpenPathRequest,
  type PresentationConversionRequest,
  type PresentationConversionResult,
  type SavePathRequest,
  type TeleprompterAlwaysOnTopRequest,
} from "./hostBridge";

const isPropertyContainer = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const readProperty = (value: unknown, key: PropertyKey): unknown =>
  isPropertyContainer(value) ? (Reflect.get(value, key) as unknown) : undefined;

const hasCallableProperty = (value: unknown, key: PropertyKey): boolean =>
  typeof readProperty(value, key) === "function";

const browserStatus = (
  supported: boolean,
  supportedReason: string,
  unsupportedReason: string,
): HostCapabilityStatus =>
  Object.freeze({
    supported,
    provider: supported ? "browser" : "none",
    reason: supported ? supportedReason : unsupportedReason,
  });

const unavailableNativeStatus = (reason: string): HostCapabilityStatus =>
  Object.freeze({
    supported: false,
    provider: "none" satisfies HostCapabilityProvider,
    reason,
  });

/**
 * Feature detection only: this function never opens a picker, requests a
 * permission, starts a device, or writes data.
 */
export const detectWebHostCapabilities = (): HostCapabilitySnapshot => {
  const secureContext = globalThis.isSecureContext === true;
  const hasOpenPicker =
    secureContext && hasCallableProperty(globalThis, "showOpenFilePicker");
  const hasSavePicker =
    secureContext && hasCallableProperty(globalThis, "showSaveFilePicker");
  const fileHandleConstructor = readProperty(
    globalThis,
    "FileSystemFileHandle",
  );
  const fileHandlePrototype =
    typeof fileHandleConstructor === "function"
      ? readProperty(fileHandleConstructor, "prototype")
      : undefined;
  const hasFileHandleWriter =
    hasSavePicker && hasCallableProperty(fileHandlePrototype, "createWritable");

  const storageManager =
    typeof navigator === "undefined" ? undefined : navigator.storage;
  const hasOpfs =
    secureContext && hasCallableProperty(storageManager, "getDirectory");

  const hasMediaRecorder =
    hasCallableProperty(globalThis, "MediaRecorder") &&
    typeof HTMLCanvasElement !== "undefined" &&
    hasCallableProperty(HTMLCanvasElement.prototype, "captureStream");
  const hasVideoCodecs =
    hasCallableProperty(globalThis, "VideoEncoder") &&
    hasCallableProperty(globalThis, "VideoFrame");
  const hasAudioCodecs =
    hasCallableProperty(globalThis, "AudioEncoder") &&
    hasCallableProperty(globalThis, "AudioData");

  const nativeHostReason =
    "The web runtime does not expose stable native filesystem paths or desktop window controls.";

  return Object.freeze({
    [HOST_CAPABILITIES.nativeOpenPath]: unavailableNativeStatus(nativeHostReason),
    [HOST_CAPABILITIES.nativeSavePath]: unavailableNativeStatus(nativeHostReason),
    [HOST_CAPABILITIES.directStreamWrite]: unavailableNativeStatus(nativeHostReason),
    [HOST_CAPABILITIES.presentationToPdf]: unavailableNativeStatus(
      "PPT/PPTX conversion requires an installed desktop conversion engine.",
    ),
    [HOST_CAPABILITIES.isolatedHtmlWebview]: unavailableNativeStatus(
      "A browser tab cannot create a separately permission-scoped desktop WebView.",
    ),
    [HOST_CAPABILITIES.alwaysOnTopTeleprompter]: unavailableNativeStatus(
      "Browsers cannot force an always-on-top application window.",
    ),
    [HOST_CAPABILITIES.browserOpenFilePicker]: browserStatus(
      hasOpenPicker,
      "The secure browser context exposes showOpenFilePicker().",
      "showOpenFilePicker() is unavailable in this context; use the app's input fallback.",
    ),
    [HOST_CAPABILITIES.browserSaveFilePicker]: browserStatus(
      hasSavePicker,
      "The secure browser context exposes showSaveFilePicker().",
      "showSaveFilePicker() is unavailable in this context; use a download fallback.",
    ),
    [HOST_CAPABILITIES.browserFileHandleStreamWrite]: browserStatus(
      hasFileHandleWriter,
      "FileSystemFileHandle.createWritable() is available.",
      "A writable browser file handle is unavailable; this is not native path access.",
    ),
    [HOST_CAPABILITIES.originPrivateFileSystem]: browserStatus(
      hasOpfs,
      "The secure browser context exposes navigator.storage.getDirectory().",
      "Origin Private File System access is unavailable in this context.",
    ),
    [HOST_CAPABILITIES.mediaRecorder]: browserStatus(
      hasMediaRecorder,
      "MediaRecorder and canvas.captureStream() are available.",
      "The required browser recording APIs are unavailable.",
    ),
    [HOST_CAPABILITIES.webCodecsVideo]: browserStatus(
      hasVideoCodecs,
      "VideoEncoder and VideoFrame are available.",
      "The browser does not expose the required WebCodecs video APIs.",
    ),
    [HOST_CAPABILITIES.webCodecsAudio]: browserStatus(
      hasAudioCodecs,
      "AudioEncoder and AudioData are available.",
      "The browser does not expose the required WebCodecs audio APIs.",
    ),
  });
};

/**
 * Web implementation of the host boundary. It intentionally rejects all
 * native operations; browser file input/download/OPFS remain separate browser
 * services and are represented here only by capability detection.
 */
export class WebHostBridge implements HostBridge {
  readonly platform = "web" as const;
  private snapshot = detectWebHostCapabilities();

  getCapabilities(): HostCapabilitySnapshot {
    return this.snapshot;
  }

  refreshCapabilities(): Promise<HostCapabilitySnapshot> {
    this.snapshot = detectWebHostCapabilities();
    return Promise.resolve(this.snapshot);
  }

  supports(capability: HostCapability): boolean {
    return this.snapshot[capability].supported;
  }

  openPath(
    _request?: OpenPathRequest,
  ): Promise<readonly HostPathSelection[] | null> {
    return this.unsupported(HOST_CAPABILITIES.nativeOpenPath, "openPath");
  }

  savePath(_request?: SavePathRequest): Promise<HostPathSelection | null> {
    return this.unsupported(HOST_CAPABILITIES.nativeSavePath, "savePath");
  }

  createWriteStream(
    _path: string,
    _options?: HostWriteStreamOptions,
  ): Promise<HostWritableStream> {
    return this.unsupported(
      HOST_CAPABILITIES.directStreamWrite,
      "createWriteStream",
    );
  }

  convertPresentationToPdf(
    _request: PresentationConversionRequest,
  ): Promise<PresentationConversionResult> {
    return this.unsupported(
      HOST_CAPABILITIES.presentationToPdf,
      "convertPresentationToPdf",
    );
  }

  openIsolatedHtmlWebview(
    _request: IsolatedHtmlWebviewRequest,
  ): Promise<HostWindowReference> {
    return this.unsupported(
      HOST_CAPABILITIES.isolatedHtmlWebview,
      "openIsolatedHtmlWebview",
    );
  }

  setTeleprompterAlwaysOnTop(
    _request: TeleprompterAlwaysOnTopRequest,
  ): Promise<void> {
    return this.unsupported(
      HOST_CAPABILITIES.alwaysOnTopTeleprompter,
      "setTeleprompterAlwaysOnTop",
    );
  }

  private unsupported<T>(
    capability: HostCapability,
    operation: string,
  ): Promise<T> {
    return Promise.reject(
      new UnsupportedCapabilityError({
        capability,
        platform: this.platform,
        operation,
        reason: this.snapshot[capability].reason,
      }),
    );
  }
}

export const webHostBridge: HostBridge = new WebHostBridge();
