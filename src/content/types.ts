/**
 * A content source is deliberately independent from the recorder and from
 * Excalidraw. Adapters turn local documents into drawImage-compatible frames;
 * the compositor can then treat a whiteboard, image, or PDF page identically.
 */

export type ContentKind =
  | "excalidraw"
  | "image"
  | "pdf"
  | "markdown"
  | "html"
  | "html-capture";

export type ContentOrientation = "landscape" | "portrait" | "square";

export type ContentAdapterStatus =
  | "loading"
  | "ready"
  | "error"
  | "disposed";

export type ContentMetadata = {
  id: string;
  kind: ContentKind;
  title: string;
  mimeType: string;
  pageCount: number;
  currentPageIndex: number;
  width: number;
  height: number;
  orientation: ContentOrientation;
  status: ContentAdapterStatus;
  /** Optional document information such as PDF author or subject. */
  details?: Readonly<Record<string, string>>;
};

export type SourceFrame = {
  id: string;
  kind: ContentKind;
  /** Any browser-native object accepted by CanvasRenderingContext2D.drawImage. */
  source: CanvasImageSource;
  width: number;
  height: number;
  pageIndex: number;
  pageCount: number;
  /** Increases whenever the visible source changes. */
  revision: number;
  renderedAt: number;
};

export type SourceThumbnail = {
  source: CanvasImageSource;
  width: number;
  height: number;
  pageIndex: number;
};

export type FrameRequest = {
  /** Zero-based page index. Omitting it prepares the active page. */
  pageIndex?: number;
  /** Bounding box in physical canvas pixels; aspect ratio is preserved. */
  maxWidth?: number;
  maxHeight?: number;
  /** Optional extra raster scale after fitting the bounding box. */
  scale?: number;
  signal?: AbortSignal;
};

export type ThumbnailRequest = {
  maxWidth?: number;
  maxHeight?: number;
  signal?: AbortSignal;
};

export type ContentNavigationAction =
  | { type: "next" }
  | { type: "previous" }
  | { type: "first" }
  | { type: "last" }
  | { type: "page"; pageIndex: number };

export type ContentAdapterListener = (
  metadata: Readonly<ContentMetadata>,
) => void;

export interface ContentAdapter {
  readonly id: string;
  readonly kind: ContentKind;

  getMetadata(): Readonly<ContentMetadata>;

  /** Returns the last prepared active frame without blocking the render loop. */
  getFrame(): SourceFrame | null;

  /** Renders a page when necessary. This never performs network I/O. */
  prepareFrame(request?: FrameRequest): Promise<SourceFrame>;

  /** Multi-page adapters update their active page; single-page sources no-op. */
  navigate(action: ContentNavigationAction): Promise<SourceFrame>;

  getThumbnail(
    pageIndex: number,
    request?: ThumbnailRequest,
  ): Promise<SourceThumbnail>;

  subscribe(listener: ContentAdapterListener): () => void;
  dispose(): void | Promise<void>;
}

export type ContentAdapterErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_FORMAT"
  | "LOAD_FAILED"
  | "RENDER_FAILED"
  | "PASSWORD_REQUIRED"
  | "PAGE_OUT_OF_RANGE"
  | "ABORTED"
  | "DISPOSED";

export class ContentAdapterError extends Error {
  readonly code: ContentAdapterErrorCode;
  readonly cause?: unknown;

  constructor(
    code: ContentAdapterErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "ContentAdapterError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export const getContentOrientation = (
  width: number,
  height: number,
): ContentOrientation => {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const ratio = safeWidth / safeHeight;
  if (Math.abs(ratio - 1) < 0.01) return "square";
  return ratio > 1 ? "landscape" : "portrait";
};

export const createContentId = (kind: ContentKind) => {
  const randomPart =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-${randomPart}`;
};

export const clampPageIndex = (pageIndex: number, pageCount: number) => {
  const lastPageIndex = Math.max(0, Math.floor(pageCount) - 1);
  const safeIndex = Number.isFinite(pageIndex) ? Math.floor(pageIndex) : 0;
  return Math.min(lastPageIndex, Math.max(0, safeIndex));
};

export const resolveNavigationPage = (
  action: ContentNavigationAction,
  currentPageIndex: number,
  pageCount: number,
) => {
  switch (action.type) {
    case "first":
      return 0;
    case "last":
      return Math.max(0, pageCount - 1);
    case "next":
      return clampPageIndex(currentPageIndex + 1, pageCount);
    case "previous":
      return clampPageIndex(currentPageIndex - 1, pageCount);
    case "page":
      return clampPageIndex(action.pageIndex, pageCount);
  }
};

export const throwIfAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return;
  throw new ContentAdapterError("ABORTED", "内容渲染已取消。", {
    cause: signal.reason,
  });
};
