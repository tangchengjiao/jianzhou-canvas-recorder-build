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
import { parseControlledMarkdown } from "./markdown/parser";
import { buildMarkdownLayout, renderMarkdownPage } from "./markdown/renderer";
import { getMarkdownPageSize, MARKDOWN_THEMES } from "./markdown/themes";
import type {
  MarkdownDiagnostic,
  MarkdownLayout,
  MarkdownLayoutOptions,
  MarkdownLocalImageResolver,
  MarkdownMode,
  MarkdownPageOrientation,
  MarkdownThemeName,
} from "./markdown/types";

export type MarkdownAdapterInput = string | Blob | ArrayBuffer | Uint8Array;

export type MarkdownAdapterOptions = {
  id?: string;
  title?: string;
  mode?: MarkdownMode;
  orientation?: MarkdownPageOrientation;
  theme?: MarkdownThemeName;
  width?: number;
  height?: number;
  padding?: number;
  baseFontSize?: number;
  lineHeight?: number;
  frameCacheSize?: number;
  thumbnailCacheSize?: number;
  signal?: AbortSignal;
  resolveLocalImage?: MarkdownLocalImageResolver;
};

type NormalizedMarkdownOptions = {
  title: string;
  mode: MarkdownMode;
  orientation: MarkdownPageOrientation;
  theme: MarkdownThemeName;
  width: number;
  height: number;
  padding: number;
  baseFontSize: number;
  lineHeight: number;
  frameCacheSize: number;
  thumbnailCacheSize: number;
  signal?: AbortSignal;
  resolveLocalImage?: MarkdownLocalImageResolver;
};

const DEFAULT_FRAME_CACHE_SIZE = 8;
const DEFAULT_THUMBNAIL_CACHE_SIZE = 48;
const MAX_CANVAS_DIMENSION = 4_096;
const MAX_CANVAS_PIXELS = 16_000_000;

const finite = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? (value as number) : fallback;

const normalizeOptions = (
  input: MarkdownAdapterInput,
  options: MarkdownAdapterOptions,
): NormalizedMarkdownOptions => {
  const orientation = options.orientation ?? "landscape";
  const { width, height } = getMarkdownPageSize(
    orientation,
    options.width,
    options.height,
  );
  const defaultFontSize = orientation === "portrait" ? 32 : 30;
  const baseFontSize = Math.min(72, Math.max(18, finite(options.baseFontSize, defaultFontSize)));
  const inferredTitle =
    typeof File !== "undefined" && input instanceof File && input.name
      ? input.name
      : options.title;
  return {
    title: inferredTitle?.trim() || "未命名 Markdown",
    mode: options.mode ?? "document",
    orientation,
    theme: options.theme ?? "paper",
    width,
    height,
    padding: Math.min(
      Math.min(width, height) * 0.24,
      Math.max(32, finite(options.padding, orientation === "portrait" ? 84 : 72)),
    ),
    baseFontSize,
    lineHeight: Math.max(
      baseFontSize * 1.2,
      Math.min(baseFontSize * 2.2, finite(options.lineHeight, baseFontSize * 1.58)),
    ),
    frameCacheSize: Math.max(
      2,
      Math.floor(finite(options.frameCacheSize, DEFAULT_FRAME_CACHE_SIZE)),
    ),
    thumbnailCacheSize: Math.max(
      2,
      Math.floor(finite(options.thumbnailCacheSize, DEFAULT_THUMBNAIL_CACHE_SIZE)),
    ),
    signal: options.signal,
    resolveLocalImage: options.resolveLocalImage,
  };
};

const inputToText = async (input: MarkdownAdapterInput) => {
  if (typeof input === "string") return input;
  let bytes: Uint8Array;
  if (input instanceof Blob) {
    bytes = new Uint8Array(await input.arrayBuffer());
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input.slice(0));
  } else {
    bytes = new Uint8Array(input.byteLength);
    bytes.set(input);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
};

const getOutputDimensions = (
  sourceWidth: number,
  sourceHeight: number,
  request: Pick<FrameRequest, "maxWidth" | "maxHeight" | "scale">,
  fallbackWidth: number,
  fallbackHeight: number,
) => {
  const maxWidth = Math.min(
    MAX_CANVAS_DIMENSION,
    Math.max(1, finite(request.maxWidth, fallbackWidth)),
  );
  const maxHeight = Math.min(
    MAX_CANVAS_DIMENSION,
    Math.max(1, finite(request.maxHeight, fallbackHeight)),
  );
  const requestedScale = Math.max(0.05, finite(request.scale, 1));
  let scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight) * requestedScale;
  scale = Math.max(0.05, scale);
  let width = Math.max(1, Math.round(sourceWidth * scale));
  let height = Math.max(1, Math.round(sourceHeight * scale));
  const dimensionGuard = Math.min(
    1,
    MAX_CANVAS_DIMENSION / width,
    MAX_CANVAS_DIMENSION / height,
  );
  const pixelGuard = Math.min(
    1,
    Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height)),
  );
  const guard = Math.min(dimensionGuard, pixelGuard);
  if (guard < 1) {
    width = Math.max(1, Math.round(width * guard));
    height = Math.max(1, Math.round(height * guard));
  }
  return { width, height };
};

const releaseCanvas = (source: CanvasImageSource) => {
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    source instanceof HTMLCanvasElement
  ) {
    source.width = 1;
    source.height = 1;
  }
};

/**
 * Renders a small, documented Markdown subset directly into local canvases.
 * It never creates HTML, executes scripts, follows links, or performs fetches.
 */
export class MarkdownContentAdapter implements ContentAdapter {
  readonly id: string;
  readonly kind = "markdown" as const;

  private readonly listeners = new Set<ContentAdapterListener>();
  private readonly frameCache = new Map<string, SourceFrame>();
  private readonly thumbnailCache = new Map<string, SourceThumbnail>();
  private readonly layout: MarkdownLayout;
  private readonly layoutOptions: MarkdownLayoutOptions;
  private readonly options: NormalizedMarkdownOptions;
  private metadata: ContentMetadata;
  private currentFrame: SourceFrame | null = null;
  private revision = 0;
  private disposed = false;

  private constructor(
    id: string,
    layout: MarkdownLayout,
    options: NormalizedMarkdownOptions,
  ) {
    this.id = id;
    this.layout = layout;
    this.options = options;
    this.layoutOptions = {
      mode: options.mode,
      width: options.width,
      height: options.height,
      orientation: options.orientation,
      theme: MARKDOWN_THEMES[options.theme],
      padding: options.padding,
      baseFontSize: options.baseFontSize,
      lineHeight: options.lineHeight,
      resolveLocalImage: options.resolveLocalImage,
    };
    const warningCount = layout.diagnostics.filter(
      (diagnostic) => diagnostic.severity !== "info",
    ).length;
    this.metadata = {
      id,
      kind: this.kind,
      title: options.title,
      mimeType: "text/markdown",
      pageCount: layout.pages.length,
      currentPageIndex: 0,
      width: options.width,
      height: options.height,
      orientation: getContentOrientation(options.width, options.height),
      status: "ready",
      details: {
        markdownMode: options.mode,
        markdownSubset: "controlled-v1",
        theme: options.theme,
        warningCount: String(warningCount),
      },
    };
  }

  static async load(
    input: MarkdownAdapterInput,
    options: MarkdownAdapterOptions = {},
  ) {
    const normalized = normalizeOptions(input, options);
    try {
      throwIfAborted(normalized.signal);
      const parsed = parseControlledMarkdown(await inputToText(input), {
        mode: normalized.mode,
      });
      throwIfAborted(normalized.signal);
      const layoutOptions: MarkdownLayoutOptions = {
        mode: normalized.mode,
        width: normalized.width,
        height: normalized.height,
        orientation: normalized.orientation,
        theme: MARKDOWN_THEMES[normalized.theme],
        padding: normalized.padding,
        baseFontSize: normalized.baseFontSize,
        lineHeight: normalized.lineHeight,
        signal: normalized.signal,
        resolveLocalImage: normalized.resolveLocalImage,
      };
      const layout = await buildMarkdownLayout(
        parsed.sections,
        parsed.diagnostics,
        layoutOptions,
      );
      throwIfAborted(normalized.signal);
      return new MarkdownContentAdapter(
        options.id ?? createContentId("markdown"),
        layout,
        normalized,
      );
    } catch (error) {
      if (error instanceof ContentAdapterError) throw error;
      if (
        normalized.signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw new ContentAdapterError("ABORTED", "Markdown 内容加载已取消。", {
          cause: error,
        });
      }
      throw new ContentAdapterError("LOAD_FAILED", "无法读取 Markdown 内容。", {
        cause: error,
      });
    }
  }

  getMetadata() {
    return {
      ...this.metadata,
      details: this.metadata.details && { ...this.metadata.details },
    };
  }

  getFrame() {
    return this.currentFrame;
  }

  getDiagnostics(): readonly MarkdownDiagnostic[] {
    return this.layout.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  /** Alias for hosts that expose warnings next to an imported source. */
  getWarnings() {
    return this.getDiagnostics().filter(
      (diagnostic) => diagnostic.severity !== "info",
    );
  }

  async prepareFrame(request: FrameRequest = {}) {
    this.assertReady();
    throwIfAborted(request.signal);
    const pageIndex = request.pageIndex ?? this.metadata.currentPageIndex;
    this.assertPage(pageIndex);
    const dimensions = getOutputDimensions(
      this.options.width,
      this.options.height,
      request,
      this.options.width,
      this.options.height,
    );
    const key = `${pageIndex}:${dimensions.width}x${dimensions.height}`;
    let frame = this.touch(this.frameCache, key);
    if (!frame) {
      const canvas = renderMarkdownPage(
        this.layout.pages[pageIndex],
        this.layoutOptions,
        dimensions.width,
        dimensions.height,
      );
      frame = {
        id: this.id,
        kind: this.kind,
        source: canvas,
        width: canvas.width,
        height: canvas.height,
        pageIndex,
        pageCount: this.layout.pages.length,
        revision: ++this.revision,
        renderedAt: performance.now(),
      };
      this.frameCache.set(key, frame);
      this.trimCache(this.frameCache, this.options.frameCacheSize, (item) =>
        releaseCanvas(item.source),
      );
    }
    throwIfAborted(request.signal);
    if (pageIndex === this.metadata.currentPageIndex) this.currentFrame = frame;
    return frame;
  }

  async navigate(action: ContentNavigationAction) {
    this.assertReady();
    const pageIndex = resolveNavigationPage(
      action,
      this.metadata.currentPageIndex,
      this.metadata.pageCount,
    );
    if (pageIndex !== this.metadata.currentPageIndex) {
      this.metadata = { ...this.metadata, currentPageIndex: pageIndex };
      this.currentFrame = null;
      this.emit();
    }
    return this.prepareFrame({ pageIndex });
  }

  async getThumbnail(
    pageIndex: number,
    request: ThumbnailRequest = {},
  ): Promise<SourceThumbnail> {
    this.assertReady();
    throwIfAborted(request.signal);
    this.assertPage(pageIndex);
    const dimensions = getOutputDimensions(
      this.options.width,
      this.options.height,
      request,
      240,
      180,
    );
    const key = `${pageIndex}:${dimensions.width}x${dimensions.height}`;
    const cached = this.touch(this.thumbnailCache, key);
    if (cached) return cached;
    const canvas = renderMarkdownPage(
      this.layout.pages[pageIndex],
      this.layoutOptions,
      dimensions.width,
      dimensions.height,
    );
    const thumbnail: SourceThumbnail = {
      source: canvas,
      width: canvas.width,
      height: canvas.height,
      pageIndex,
    };
    this.thumbnailCache.set(key, thumbnail);
    this.trimCache(this.thumbnailCache, this.options.thumbnailCacheSize, (item) =>
      releaseCanvas(item.source),
    );
    throwIfAborted(request.signal);
    return thumbnail;
  }

  subscribe(listener: ContentAdapterListener) {
    this.listeners.add(listener);
    listener(this.getMetadata());
    return () => this.listeners.delete(listener);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.frameCache.forEach((frame) => releaseCanvas(frame.source));
    this.thumbnailCache.forEach((thumbnail) => releaseCanvas(thumbnail.source));
    this.frameCache.clear();
    this.thumbnailCache.clear();
    this.layout.ownedBitmaps.forEach((bitmap) => bitmap.close());
    this.layout.ownedBitmaps.length = 0;
    this.currentFrame = null;
    this.metadata = { ...this.metadata, status: "disposed" };
    this.emit();
    this.listeners.clear();
  }

  private touch<T>(cache: Map<string, T>, key: string) {
    const value = cache.get(key);
    if (!value) return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  private trimCache<T>(
    cache: Map<string, T>,
    limit: number,
    release: (value: T) => void,
  ) {
    while (cache.size > limit) {
      const oldest = cache.entries().next().value as [string, T] | undefined;
      if (!oldest) break;
      cache.delete(oldest[0]);
      release(oldest[1]);
    }
  }

  private emit() {
    const metadata = this.getMetadata();
    this.listeners.forEach((listener) => listener(metadata));
  }

  private assertReady() {
    if (!this.disposed) return;
    throw new ContentAdapterError("DISPOSED", "Markdown 内容已经关闭。");
  }

  private assertPage(pageIndex: number) {
    if (
      Number.isInteger(pageIndex) &&
      pageIndex >= 0 &&
      pageIndex < this.metadata.pageCount
    ) {
      return;
    }
    throw new ContentAdapterError(
      "PAGE_OUT_OF_RANGE",
      `Markdown 页码超出范围：${pageIndex}`,
    );
  }
}

export * from "./markdown/types";
export * from "./markdown/parser";
export * from "./markdown/themes";
