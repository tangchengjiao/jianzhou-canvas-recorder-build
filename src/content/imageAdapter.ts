import {
  ContentAdapterError,
  createContentId,
  getContentOrientation,
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

export type ImageAdapterInput =
  | Blob
  | ArrayBuffer
  | Uint8Array
  | HTMLImageElement
  | ImageBitmap;

export type ImageAdapterOptions = {
  title?: string;
  mimeType?: string;
  id?: string;
};

const DEFAULT_IMAGE_MIME_TYPE = "image/png";

const isHtmlImageElement = (
  input: ImageAdapterInput,
): input is HTMLImageElement =>
  typeof HTMLImageElement !== "undefined" && input instanceof HTMLImageElement;

const isImageBitmap = (input: ImageAdapterInput): input is ImageBitmap =>
  typeof ImageBitmap !== "undefined" && input instanceof ImageBitmap;

const getImageDimensions = (source: HTMLImageElement | ImageBitmap) => {
  if (source instanceof HTMLImageElement) {
    return {
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height,
    };
  }
  return { width: source.width, height: source.height };
};

const toBlob = (input: Blob | ArrayBuffer | Uint8Array, mimeType: string) => {
  if (input instanceof Blob) return input;
  if (input instanceof ArrayBuffer) return new Blob([input], { type: mimeType });

  // Slice the exact view; a Uint8Array can otherwise expose unrelated bytes
  // from a larger backing buffer.
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return new Blob([copy], { type: mimeType });
};

const decodeWithImageElement = async (blob: Blob) => {
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";

  try {
    image.src = objectUrl;
    if (typeof image.decode === "function") {
      await image.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("图片解码失败。"));
      });
    }
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const decodeImage = async (
  input: ImageAdapterInput,
  mimeType: string,
): Promise<HTMLImageElement | ImageBitmap> => {
  if (isHtmlImageElement(input) || isImageBitmap(input)) {
    return input;
  }

  const blob = toBlob(input, mimeType);
  if (!blob.type.startsWith("image/")) {
    throw new ContentAdapterError(
      "UNSUPPORTED_FORMAT",
      `不支持的图片类型：${blob.type || "unknown"}`,
    );
  }

  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, {
        imageOrientation: "from-image",
        premultiplyAlpha: "default",
      });
    } catch {
      // Safari and some Chromium builds reject one of the optional flags. A
      // normal image element is slower to initialise but equally drawable.
    }
  }

  return decodeWithImageElement(blob);
};

const fitDimensions = (
  width: number,
  height: number,
  maxWidth = 240,
  maxHeight = 180,
) => {
  const scale = Math.min(
    1,
    Math.max(1, maxWidth) / Math.max(1, width),
    Math.max(1, maxHeight) / Math.max(1, height),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

export class ImageContentAdapter implements ContentAdapter {
  readonly id: string;
  readonly kind = "image" as const;

  private readonly listeners = new Set<ContentAdapterListener>();
  private readonly ownsSource: boolean;
  private source: HTMLImageElement | ImageBitmap | null;
  private frame: SourceFrame | null;
  private metadata: ContentMetadata;
  private readonly thumbnails = new Map<string, SourceThumbnail>();
  private disposed = false;

  private constructor(
    source: HTMLImageElement | ImageBitmap,
    options: ImageAdapterOptions,
    ownsSource: boolean,
  ) {
    const { width, height } = getImageDimensions(source);
    if (width < 1 || height < 1) {
      throw new ContentAdapterError(
        "LOAD_FAILED",
        "图片没有可用的像素尺寸。",
      );
    }

    this.id = options.id ?? createContentId("image");
    this.source = source;
    this.ownsSource = ownsSource;
    this.metadata = {
      id: this.id,
      kind: this.kind,
      title: options.title?.trim() || "未命名图片",
      mimeType: options.mimeType || DEFAULT_IMAGE_MIME_TYPE,
      pageCount: 1,
      currentPageIndex: 0,
      width,
      height,
      orientation: getContentOrientation(width, height),
      status: "ready",
    };
    this.frame = {
      id: this.id,
      kind: this.kind,
      source,
      width,
      height,
      pageIndex: 0,
      pageCount: 1,
      revision: 1,
      renderedAt: performance.now(),
    };
  }

  static async load(
    input: ImageAdapterInput,
    options: ImageAdapterOptions = {},
  ) {
    const inferredMimeType =
      input instanceof Blob && input.type ? input.type : options.mimeType;
    const inferredTitle =
      input instanceof File && input.name ? input.name : options.title;

    try {
      const source = await decodeImage(
        input,
        inferredMimeType || DEFAULT_IMAGE_MIME_TYPE,
      );
      const ownsSource = !isHtmlImageElement(input) && !isImageBitmap(input);
      return new ImageContentAdapter(
        source,
        {
          ...options,
          title: inferredTitle,
          mimeType: inferredMimeType || DEFAULT_IMAGE_MIME_TYPE,
        },
        ownsSource,
      );
    } catch (error) {
      if (error instanceof ContentAdapterError) throw error;
      throw new ContentAdapterError("LOAD_FAILED", "无法读取本地图片。", {
        cause: error,
      });
    }
  }

  getMetadata() {
    return { ...this.metadata };
  }

  getFrame() {
    return this.frame;
  }

  async prepareFrame(request: FrameRequest = {}) {
    this.assertReady();
    throwIfAborted(request.signal);
    return this.frame as SourceFrame;
  }

  async navigate(_action: ContentNavigationAction) {
    return this.prepareFrame();
  }

  async getThumbnail(
    pageIndex: number,
    request: ThumbnailRequest = {},
  ): Promise<SourceThumbnail> {
    this.assertReady();
    throwIfAborted(request.signal);
    if (pageIndex !== 0) {
      throw new ContentAdapterError(
        "PAGE_OUT_OF_RANGE",
        "图片内容只有一页。",
      );
    }
    const source = this.source as HTMLImageElement | ImageBitmap;
    const dimensions = fitDimensions(
      this.metadata.width,
      this.metadata.height,
      request.maxWidth,
      request.maxHeight,
    );
    const cacheKey = `${dimensions.width}x${dimensions.height}`;
    const cached = this.thumbnails.get(cacheKey);
    if (cached) return cached;

    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new ContentAdapterError(
        "RENDER_FAILED",
        "浏览器无法创建图片缩略图画布。",
      );
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const thumbnail = {
      source: canvas,
      width: canvas.width,
      height: canvas.height,
      pageIndex: 0,
    };
    this.thumbnails.set(cacheKey, thumbnail);
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

    if (
      this.ownsSource &&
      typeof ImageBitmap !== "undefined" &&
      this.source instanceof ImageBitmap
    ) {
      this.source.close();
    } else if (
      this.ownsSource &&
      typeof HTMLImageElement !== "undefined" &&
      this.source instanceof HTMLImageElement
    ) {
      this.source.removeAttribute("src");
    }
    this.source = null;
    this.frame = null;
    this.thumbnails.clear();
    this.metadata = { ...this.metadata, status: "disposed" };
    this.emit();
    this.listeners.clear();
  }

  private emit() {
    const metadata = this.getMetadata();
    for (const listener of this.listeners) listener(metadata);
  }

  private assertReady() {
    if (!this.disposed && this.source && this.frame) return;
    throw new ContentAdapterError("DISPOSED", "图片内容已经关闭。" );
  }
}
