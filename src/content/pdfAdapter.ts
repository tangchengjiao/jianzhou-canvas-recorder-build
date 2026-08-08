import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ContentAdapterError,
  createContentId,
  getContentOrientation,
  resolveNavigationPage,
  throwIfAborted,
  type ContentAdapter,
  type ContentAdapterListener,
  type ContentMetadata,
  type ContentNavigationAction,
  type FrameRequest,
  type SourceFrame,
  type SourceThumbnail,
  type ThumbnailRequest,
} from "./types";

export type PdfAdapterInput = ArrayBuffer | Uint8Array | Blob;

export type PdfAdapterOptions = {
  id?: string;
  title?: string;
  password?: string;
  /** Raster dimensions for a normal page frame. */
  maxFrameWidth?: number;
  maxFrameHeight?: number;
  /** Includes the active page and its immediate neighbours; minimum is 3. */
  pageCacheSize?: number;
  thumbnailCacheSize?: number;
};

type NormalizedPdfAdapterOptions = {
  title: string;
  password?: string;
  maxFrameWidth: number;
  maxFrameHeight: number;
  pageCacheSize: number;
  thumbnailCacheSize: number;
};

const DEFAULT_FRAME_WIDTH = 2_560;
const DEFAULT_FRAME_HEIGHT = 2_560;
const DEFAULT_PAGE_CACHE_SIZE = 5;
const DEFAULT_THUMBNAIL_CACHE_SIZE = 32;
const DEFAULT_THUMBNAIL_WIDTH = 220;
const DEFAULT_THUMBNAIL_HEIGHT = 160;
const MAX_CANVAS_DIMENSION = 4_096;
const MAX_CANVAS_PIXELS = 16_000_000;
export const PDF_IMPORT_LIMITS = {
  maxBytes: 80_000_000,
  maxPages: 200,
} as const;

const getPdfInputBytes = (input: PdfAdapterInput) =>
  input instanceof Blob ? input.size : input.byteLength;

const finitePositive = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) && (value as number) > 0
    ? (value as number)
    : fallback;

const normalizeOptions = (
  options: PdfAdapterOptions,
): NormalizedPdfAdapterOptions => ({
  title: options.title?.trim() || "未命名 PDF",
  password: options.password,
  maxFrameWidth: Math.min(
    MAX_CANVAS_DIMENSION,
    Math.round(finitePositive(options.maxFrameWidth, DEFAULT_FRAME_WIDTH)),
  ),
  maxFrameHeight: Math.min(
    MAX_CANVAS_DIMENSION,
    Math.round(finitePositive(options.maxFrameHeight, DEFAULT_FRAME_HEIGHT)),
  ),
  pageCacheSize: Math.max(
    3,
    Math.floor(finitePositive(options.pageCacheSize, DEFAULT_PAGE_CACHE_SIZE)),
  ),
  thumbnailCacheSize: Math.max(
    1,
    Math.floor(
      finitePositive(options.thumbnailCacheSize, DEFAULT_THUMBNAIL_CACHE_SIZE),
    ),
  ),
});

const clonePdfBytes = async (input: PdfAdapterInput) => {
  if (input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy;
};

const stringDetail = (value: unknown) => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
};

const collectDocumentDetails = async (document: PDFDocumentProxy) => {
  const details: Record<string, string> = {};
  let title = "";

  try {
    const result = await document.getMetadata();
    const info = result.info as unknown as Record<string, unknown>;
    const metadata = result.metadata;
    title =
      stringDetail(metadata?.get("dc:title")) || stringDetail(info.Title);

    const candidates: ReadonlyArray<[string, unknown]> = [
      ["author", metadata?.get("dc:creator") || info.Author],
      ["subject", metadata?.get("dc:description") || info.Subject],
      ["creator", info.Creator],
      ["producer", info.Producer],
    ];
    for (const [key, value] of candidates) {
      const normalized = stringDetail(value);
      if (normalized) details[key] = normalized;
    }
  } catch {
    // Malformed optional metadata must not make a renderable PDF unusable.
  }

  try {
    const labels = await document.getPageLabels();
    if (labels?.length) details.pageLabels = JSON.stringify(labels);
  } catch {
    // Page labels are optional.
  }

  return { title, details };
};

const getRequestSignature = (request: FrameRequest, options: NormalizedPdfAdapterOptions) => {
  const width = Math.round(
    finitePositive(request.maxWidth, options.maxFrameWidth),
  );
  const height = Math.round(
    finitePositive(request.maxHeight, options.maxFrameHeight),
  );
  const scale = finitePositive(request.scale, 1);
  return `${width}x${height}@${scale.toFixed(3)}`;
};

const getRenderViewport = (
  page: PDFPageProxy,
  maxWidth: number,
  maxHeight: number,
  requestedScale: number,
) => {
  const base = page.getViewport({ scale: 1 });
  const safeMaxWidth = Math.min(
    MAX_CANVAS_DIMENSION,
    finitePositive(maxWidth, DEFAULT_FRAME_WIDTH),
  );
  const safeMaxHeight = Math.min(
    MAX_CANVAS_DIMENSION,
    finitePositive(maxHeight, DEFAULT_FRAME_HEIGHT),
  );
  let scale =
    Math.min(safeMaxWidth / base.width, safeMaxHeight / base.height) *
    finitePositive(requestedScale, 1);
  scale = Math.max(0.05, scale);

  let viewport = page.getViewport({ scale });
  const dimensionScale = Math.min(
    1,
    MAX_CANVAS_DIMENSION / Math.max(1, viewport.width),
    MAX_CANVAS_DIMENSION / Math.max(1, viewport.height),
  );
  const pixelScale = Math.min(
    1,
    Math.sqrt(
      MAX_CANVAS_PIXELS /
        Math.max(1, Math.ceil(viewport.width) * Math.ceil(viewport.height)),
    ),
  );
  const safetyScale = Math.min(dimensionScale, pixelScale);
  if (safetyScale < 1) {
    viewport = page.getViewport({ scale: scale * safetyScale });
  }
  return viewport;
};

/** Ensures PDF.js uses the worker bundled with the app, never a CDN. */
export const configureLocalPdfWorker = () => {
  if (GlobalWorkerOptions.workerSrc !== pdfWorkerUrl) {
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
};

export class PdfContentAdapter implements ContentAdapter {
  readonly id: string;
  readonly kind = "pdf" as const;

  private readonly options: NormalizedPdfAdapterOptions;
  private readonly listeners = new Set<ContentAdapterListener>();
  private readonly pageCache = new Map<string, SourceFrame>();
  private readonly thumbnailCache = new Map<string, SourceThumbnail>();
  private readonly pendingFrames = new Map<string, Promise<SourceFrame>>();
  private readonly pendingThumbnails = new Map<
    string,
    Promise<SourceThumbnail>
  >();
  private readonly renderTasks = new Set<RenderTask>();

  private loadingTask: PDFDocumentLoadingTask | null = null;
  private document: PDFDocumentProxy | null = null;
  private currentFrame: SourceFrame | null = null;
  private revision = 0;
  private disposed = false;
  private metadata: ContentMetadata;

  private constructor(id: string, options: NormalizedPdfAdapterOptions) {
    this.id = id;
    this.options = options;
    this.metadata = {
      id,
      kind: this.kind,
      title: options.title,
      mimeType: "application/pdf",
      pageCount: 0,
      currentPageIndex: 0,
      width: 1,
      height: 1,
      orientation: "square",
      status: "loading",
    };
  }

  static async load(input: PdfAdapterInput, options: PdfAdapterOptions = {}) {
    if (getPdfInputBytes(input) > PDF_IMPORT_LIMITS.maxBytes) {
      throw new ContentAdapterError(
        "INVALID_INPUT",
        `PDF 超过 ${(PDF_IMPORT_LIMITS.maxBytes / 1_000_000).toFixed(0)} MB 的轻量导入限制。`,
      );
    }
    const normalized = normalizeOptions({
      ...options,
      title:
        input instanceof File && input.name ? input.name : options.title,
    });
    const adapter = new PdfContentAdapter(
      options.id ?? createContentId("pdf"),
      normalized,
    );

    try {
      await adapter.loadDocument(await clonePdfBytes(input));
      return adapter;
    } catch (error) {
      await adapter.releaseResources();
      if (error instanceof ContentAdapterError) throw error;
      throw new ContentAdapterError("LOAD_FAILED", "无法读取本地 PDF。", {
        cause: error,
      });
    }
  }

  getMetadata() {
    return { ...this.metadata, details: this.metadata.details && { ...this.metadata.details } };
  }

  getFrame() {
    return this.currentFrame;
  }

  async prepareFrame(request: FrameRequest = {}) {
    this.assertReady();
    throwIfAborted(request.signal);
    const pageIndex = request.pageIndex ?? this.metadata.currentPageIndex;
    this.assertPageIndex(pageIndex);
    const frame = await this.getOrRenderFrame(pageIndex, request);
    throwIfAborted(request.signal);

    if (pageIndex === this.metadata.currentPageIndex) {
      this.setCurrentFrame(frame);
    }
    return frame;
  }

  async navigate(action: ContentNavigationAction) {
    this.assertReady();
    const pageIndex = resolveNavigationPage(
      action,
      this.metadata.currentPageIndex,
      this.metadata.pageCount,
    );
    this.metadata = { ...this.metadata, currentPageIndex: pageIndex };
    this.emit();

    const frame = await this.getOrRenderFrame(pageIndex, {});
    if (this.metadata.currentPageIndex === pageIndex) {
      this.setCurrentFrame(frame);
      void this.prefetchNeighbours(pageIndex);
    }
    return frame;
  }

  async getThumbnail(
    pageIndex: number,
    request: ThumbnailRequest = {},
  ): Promise<SourceThumbnail> {
    this.assertReady();
    throwIfAborted(request.signal);
    this.assertPageIndex(pageIndex);

    const maxWidth = Math.round(
      finitePositive(request.maxWidth, DEFAULT_THUMBNAIL_WIDTH),
    );
    const maxHeight = Math.round(
      finitePositive(request.maxHeight, DEFAULT_THUMBNAIL_HEIGHT),
    );
    const key = `${pageIndex}:${maxWidth}x${maxHeight}`;
    const cached = this.touch(this.thumbnailCache, key);
    if (cached) return cached;

    const pending = this.pendingThumbnails.get(key);
    if (pending) return pending;

    const promise = this.renderThumbnail(pageIndex, maxWidth, maxHeight)
      .then((thumbnail) => {
        this.thumbnailCache.set(key, thumbnail);
        this.trimSimpleCache(
          this.thumbnailCache,
          this.options.thumbnailCacheSize,
        );
        return thumbnail;
      })
      .finally(() => this.pendingThumbnails.delete(key));
    this.pendingThumbnails.set(key, promise);
    const thumbnail = await promise;
    throwIfAborted(request.signal);
    return thumbnail;
  }

  subscribe(listener: ContentAdapterListener) {
    this.listeners.add(listener);
    listener(this.getMetadata());
    return () => this.listeners.delete(listener);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.metadata = { ...this.metadata, status: "disposed" };
    this.emit();
    this.listeners.clear();
    await this.releaseResources();
  }

  private async loadDocument(data: Uint8Array) {
    if (data.byteLength < 5) {
      throw new ContentAdapterError("INVALID_INPUT", "PDF 文件内容为空。" );
    }

    configureLocalPdfWorker();
    let passwordRequested = false;
    const loadingTask = getDocument({
      data,
      password: this.options.password,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
      useSystemFonts: true,
    });
    this.loadingTask = loadingTask;
    loadingTask.onPassword = () => {
      passwordRequested = true;
      void loadingTask.destroy();
    };

    try {
      const document = await loadingTask.promise;
      if (this.disposed) {
        await loadingTask.destroy();
        throw new ContentAdapterError("DISPOSED", "PDF 内容已经关闭。" );
      }
      if (document.numPages > PDF_IMPORT_LIMITS.maxPages) {
        await loadingTask.destroy();
        this.document = null;
        throw new ContentAdapterError(
          "INVALID_INPUT",
          `PDF 共 ${document.numPages} 页，超过 ${PDF_IMPORT_LIMITS.maxPages} 页的轻量演示限制；请拆分后再导入。`,
        );
      }
      this.document = document;
      const documentMetadata = await collectDocumentDetails(document);
      this.metadata = {
        ...this.metadata,
        title: documentMetadata.title || this.options.title,
        pageCount: document.numPages,
        status: "ready",
        details:
          Object.keys(documentMetadata.details).length > 0
            ? documentMetadata.details
            : undefined,
      };
      this.emit();
      await this.navigate({ type: "first" });
    } catch (error) {
      if (passwordRequested) {
        throw new ContentAdapterError(
          "PASSWORD_REQUIRED",
          this.options.password
            ? "PDF 密码不正确。"
            : "该 PDF 需要密码才能打开。",
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async getOrRenderFrame(pageIndex: number, request: FrameRequest) {
    const signature = getRequestSignature(request, this.options);
    const key = `${pageIndex}:${signature}`;
    const cached = this.touch(this.pageCache, key);
    if (cached) return cached;

    const pending = this.pendingFrames.get(key);
    if (pending) return pending;

    const promise = this.renderFrame(pageIndex, request)
      .then((frame) => {
        this.pageCache.set(key, frame);
        this.trimPageCache();
        return frame;
      })
      .finally(() => this.pendingFrames.delete(key));
    this.pendingFrames.set(key, promise);
    return promise;
  }

  private async renderFrame(
    pageIndex: number,
    request: FrameRequest,
  ): Promise<SourceFrame> {
    const page = await (this.document as PDFDocumentProxy).getPage(pageIndex + 1);
    throwIfAborted(request.signal);
    const viewport = getRenderViewport(
      page,
      finitePositive(request.maxWidth, this.options.maxFrameWidth),
      finitePositive(request.maxHeight, this.options.maxFrameHeight),
      finitePositive(request.scale, 1),
    );
    const canvas = await this.renderPageToCanvas(page, viewport);
    return {
      id: this.id,
      kind: this.kind,
      source: canvas,
      width: canvas.width,
      height: canvas.height,
      pageIndex,
      pageCount: this.metadata.pageCount,
      revision: ++this.revision,
      renderedAt: performance.now(),
    };
  }

  private async renderThumbnail(
    pageIndex: number,
    maxWidth: number,
    maxHeight: number,
  ): Promise<SourceThumbnail> {
    const page = await (this.document as PDFDocumentProxy).getPage(pageIndex + 1);
    const viewport = getRenderViewport(page, maxWidth, maxHeight, 1);
    const canvas = await this.renderPageToCanvas(page, viewport);
    return {
      source: canvas,
      width: canvas.width,
      height: canvas.height,
      pageIndex,
    };
  }

  private async renderPageToCanvas(
    page: PDFPageProxy,
    viewport: ReturnType<PDFPageProxy["getViewport"]>,
  ) {
    this.assertReady();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const task = page.render({
      canvas,
      viewport,
      background: "#ffffff",
    });
    this.renderTasks.add(task);
    try {
      await task.promise;
      return canvas;
    } catch (error) {
      if (this.disposed) {
        throw new ContentAdapterError("DISPOSED", "PDF 内容已经关闭。", {
          cause: error,
        });
      }
      throw new ContentAdapterError("RENDER_FAILED", "PDF 页面渲染失败。", {
        cause: error,
      });
    } finally {
      this.renderTasks.delete(task);
    }
  }

  private setCurrentFrame(frame: SourceFrame) {
    this.currentFrame = frame;
    this.metadata = {
      ...this.metadata,
      currentPageIndex: frame.pageIndex,
      width: frame.width,
      height: frame.height,
      orientation: getContentOrientation(frame.width, frame.height),
    };
    this.emit();
  }

  private async prefetchNeighbours(currentPageIndex: number) {
    const neighbours = [currentPageIndex - 1, currentPageIndex + 1].filter(
      (pageIndex) =>
        pageIndex >= 0 && pageIndex < this.metadata.pageCount,
    );
    await Promise.allSettled(
      neighbours.map((pageIndex) => this.getOrRenderFrame(pageIndex, {})),
    );
  }

  private trimPageCache() {
    while (this.pageCache.size > this.options.pageCacheSize) {
      const protectedPages = new Set([
        this.metadata.currentPageIndex - 1,
        this.metadata.currentPageIndex,
        this.metadata.currentPageIndex + 1,
      ]);
      const removable = Array.from(this.pageCache.keys()).find((key) => {
        const pageIndex = Number(key.slice(0, key.indexOf(":")));
        return !protectedPages.has(pageIndex);
      });
      const fallback = this.pageCache.keys().next().value as string | undefined;
      const key = removable ?? fallback;
      if (!key) break;
      this.pageCache.delete(key);
    }
  }

  private trimSimpleCache<T>(cache: Map<string, T>, maximum: number) {
    while (cache.size > maximum) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }

  private touch<T>(cache: Map<string, T>, key: string) {
    const value = cache.get(key);
    if (!value) return null;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  private assertPageIndex(pageIndex: number) {
    if (
      !Number.isInteger(pageIndex) ||
      pageIndex < 0 ||
      pageIndex >= this.metadata.pageCount
    ) {
      throw new ContentAdapterError(
        "PAGE_OUT_OF_RANGE",
        `PDF 页码超出范围：${pageIndex + 1}`,
      );
    }
  }

  private assertReady() {
    if (!this.disposed && this.document && this.metadata.status === "ready") {
      return;
    }
    throw new ContentAdapterError(
      this.disposed ? "DISPOSED" : "LOAD_FAILED",
      this.disposed ? "PDF 内容已经关闭。" : "PDF 尚未加载完成。",
    );
  }

  private emit() {
    const metadata = this.getMetadata();
    for (const listener of this.listeners) listener(metadata);
  }

  private async releaseResources() {
    for (const task of this.renderTasks) task.cancel();
    this.renderTasks.clear();
    this.pendingFrames.clear();
    this.pendingThumbnails.clear();

    for (const frame of this.pageCache.values()) {
      if (frame.source instanceof HTMLCanvasElement) {
        frame.source.width = 1;
        frame.source.height = 1;
      }
    }
    for (const thumbnail of this.thumbnailCache.values()) {
      if (thumbnail.source instanceof HTMLCanvasElement) {
        thumbnail.source.width = 1;
        thumbnail.source.height = 1;
      }
    }
    this.pageCache.clear();
    this.thumbnailCache.clear();
    this.currentFrame = null;

    const document = this.document;
    const loadingTask = this.loadingTask ?? document?.loadingTask ?? null;
    this.document = null;
    if (loadingTask) {
      try {
        await loadingTask.destroy();
      } catch {
        // Best-effort cleanup; resources are already detached from the adapter.
      }
    }
    this.loadingTask = null;
  }
}
