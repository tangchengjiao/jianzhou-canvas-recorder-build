/**
 * Platform boundary for operations that a browser must never pretend to own.
 *
 * The current application runs on the web. A future Tauri host can implement
 * this interface without leaking Tauri imports throughout the React and core
 * layers. Browser runtime capabilities are reported separately from native
 * path-based capabilities so callers cannot mistake a FileSystemHandle for a
 * stable desktop path.
 */

export type HostPlatform = "web" | "tauri";

export const HOST_CAPABILITIES = {
  nativeOpenPath: "native-open-path",
  nativeSavePath: "native-save-path",
  directStreamWrite: "direct-stream-write",
  presentationToPdf: "presentation-to-pdf",
  isolatedHtmlWebview: "isolated-html-webview",
  alwaysOnTopTeleprompter: "always-on-top-teleprompter",
  browserOpenFilePicker: "browser-open-file-picker",
  browserSaveFilePicker: "browser-save-file-picker",
  browserFileHandleStreamWrite: "browser-file-handle-stream-write",
  originPrivateFileSystem: "origin-private-file-system",
  mediaRecorder: "media-recorder",
  webCodecsVideo: "web-codecs-video",
  webCodecsAudio: "web-codecs-audio",
} as const;

export type HostCapability =
  (typeof HOST_CAPABILITIES)[keyof typeof HOST_CAPABILITIES];

export type HostCapabilityProvider = "browser" | "tauri" | "none";

export type HostCapabilityStatus = Readonly<{
  supported: boolean;
  provider: HostCapabilityProvider;
  /** Human-readable evidence or limitation; useful in diagnostics. */
  reason: string;
}>;

export type HostCapabilitySnapshot = Readonly<
  Record<HostCapability, HostCapabilityStatus>
>;

export class UnsupportedCapabilityError extends Error {
  readonly capability: HostCapability;
  readonly platform: HostPlatform;
  readonly operation: string;

  constructor(options: {
    capability: HostCapability;
    platform: HostPlatform;
    operation: string;
    reason?: string;
  }) {
    const reason = options.reason ? ` ${options.reason}` : "";
    super(
      `Host operation \"${options.operation}\" requires unsupported capability ` +
        `\"${options.capability}\" on ${options.platform}.${reason}`,
    );
    this.name = "UnsupportedCapabilityError";
    this.capability = options.capability;
    this.platform = options.platform;
    this.operation = options.operation;
  }
}

export type HostFileFilter = Readonly<{
  name: string;
  /** Lowercase extensions without a leading dot, for example ["pdf"]. */
  extensions: readonly string[];
  mimeTypes?: readonly string[];
}>;

export type OpenPathRequest = Readonly<{
  title?: string;
  kind?: "file" | "directory";
  multiple?: boolean;
  filters?: readonly HostFileFilter[];
}>;

export type SavePathRequest = Readonly<{
  title?: string;
  suggestedName?: string;
  filters?: readonly HostFileFilter[];
}>;

/** A real host filesystem path, never a browser object URL or fake path. */
export type HostPathSelection = Readonly<{
  path: string;
  name: string;
  kind: "file" | "directory";
}>;

export type HostWriteStreamOptions = Readonly<{
  append?: boolean;
  create?: boolean;
  truncate?: boolean;
}>;

/** Sequential, backpressure-aware writer owned by the native host. */
export interface HostWritableStream {
  readonly path: string;
  readonly bytesWritten: number;
  write(chunk: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

export type PresentationConversionEngine = "powerpoint" | "libreoffice";

export type PresentationConversionRequest = Readonly<{
  sourcePath: string;
  outputPath?: string;
  preferredEngine?: PresentationConversionEngine;
  overwrite?: boolean;
}>;

export type PresentationConversionResult = Readonly<{
  sourcePath: string;
  outputPath: string;
  engine: PresentationConversionEngine;
  warnings: readonly string[];
}>;

export type HtmlNetworkPolicy = "blocked" | "allowlist";

export type IsolatedHtmlWebviewRequest = Readonly<{
  sourcePath: string;
  title?: string;
  /** Network access is blocked unless an implementation honors an allowlist. */
  networkPolicy?: HtmlNetworkPolicy;
  allowedOrigins?: readonly string[];
  /** Script execution must remain opt-in for local, untrusted documents. */
  allowScripts?: boolean;
  width?: number;
  height?: number;
}>;

export type HostWindowReference = Readonly<{
  id: string;
  label: string;
}>;

export type TeleprompterAlwaysOnTopRequest = Readonly<{
  enabled: boolean;
  /** Omit to target the host's dedicated teleprompter window. */
  windowId?: string;
}>;

/**
 * Native host contract. Implementations must advertise a capability only when
 * the corresponding operation is usable in the current runtime.
 */
export interface HostBridge {
  readonly platform: HostPlatform;

  getCapabilities(): HostCapabilitySnapshot;
  refreshCapabilities(): Promise<HostCapabilitySnapshot>;
  supports(capability: HostCapability): boolean;

  openPath(
    request?: OpenPathRequest,
  ): Promise<readonly HostPathSelection[] | null>;
  savePath(request?: SavePathRequest): Promise<HostPathSelection | null>;
  createWriteStream(
    path: string,
    options?: HostWriteStreamOptions,
  ): Promise<HostWritableStream>;
  convertPresentationToPdf(
    request: PresentationConversionRequest,
  ): Promise<PresentationConversionResult>;
  openIsolatedHtmlWebview(
    request: IsolatedHtmlWebviewRequest,
  ): Promise<HostWindowReference>;
  setTeleprompterAlwaysOnTop(
    request: TeleprompterAlwaysOnTopRequest,
  ): Promise<void>;
}

export const requireHostCapability = (
  bridge: Pick<HostBridge, "platform" | "getCapabilities">,
  capability: HostCapability,
  operation: string,
) => {
  const status = bridge.getCapabilities()[capability];
  if (status.supported) return;
  throw new UnsupportedCapabilityError({
    capability,
    platform: bridge.platform,
    operation,
    reason: status.reason,
  });
};
