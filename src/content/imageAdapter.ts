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
export const IMAGE_IMPORT_LIMITS = {
  maxBytes: 24_000_000,
  maxDimension: 12_000,
  maxPixels: 24_000_000,
  headerBytes: 512_000,
} as const;

type ImageDimensions = { width: number; height: number };

const uint24LittleEndian = (view: DataView, offset: number) =>
  view.getUint8(offset) |
  (view.getUint8(offset + 1) << 8) |
  (view.getUint8(offset + 2) << 16);

const parseJpegDimensions = (bytes: Uint8Array): ImageDimensions | null => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
};

const parseImageDimensions = (bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (
    bytes[0] === 0x89 &&
    ascii(1, 3) === "PNG" &&
    ascii(12, 4) === "IHDR"
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (ascii(0, 3) === "GIF") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (ascii(0, 2) === "BM" && bytes.length >= 26) {
    return {
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true)),
    };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP" && bytes.length >= 30) {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") {
      return {
        width: uint24LittleEndian(view, 24) + 1,
        height: uint24LittleEndian(view, 27) + 1,
      };
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
      const bits = view.getUint32(21, true);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
  }
  const jpeg = parseJpegDimensions(bytes);
  if (jpeg) return jpeg;

  // AVIF stores display dimensions in an ImageSpatialExtents (ispe) box.
  for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
    if (ascii(offset, 4) !== "ispe") continue;
    return {
      width: view.getUint32(offset + 8),
      height: view.getUint32(offset + 12),
    };
  }
  return null;
};

const assertImageBudget = (bytes: number, dimensions: ImageDimensions) => {
  if (bytes > IMAGE_IMPORT_LIMITS.maxBytes) {
    throw new ContentAdapterError(
      "INVALID_INPUT",
      `图片超过 ${(IMAGE_IMPORT_LIMITS.maxBytes / 1_000_000).toFixed(0)} MB 的轻量导入限制。`,
    );
  }
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > IMAGE_IMPORT_LIMITS.maxDimension ||
    dimensions.height > IMAGE_IMPORT_LIMITS.maxDimension ||
    dimensions.width * dimensions.height > IMAGE_IMPORT_LIMITS.maxPixels
  ) {
    throw new ContentAdapterError(
      "INVALID_INPUT",
      `图片像素尺寸过大；当前最多支持 ${IMAGE_IMPORT_LIMITS.maxDimension.toLocaleString()}px 单边、${(
        IMAGE_IMPORT_LIMITS.maxPixels / 1_000_000
      ).toFixed(0)} 百万像素。`,
    );
  }
};

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
  if (blob.size > IMAGE_IMPORT_LIMITS.maxBytes) {
    assertImageBudget(blob.size, { width: 1, height: 1 });
  }
  const header = new Uint8Array(
    await blob.slice(0, IMAGE_IMPORT_LIMITS.headerBytes).arrayBuffer(),
  );
  const encodedDimensions = parseImageDimensions(header);
  if (!encodedDimensions) {
    throw new ContentAdapterError(
      "INVALID_INPUT",
      "无法在解码前安全识别图片尺寸，请转换为 PNG、JPEG、WebP、GIF、BMP 或标准 AVIF 后重试。",
    );
  }
  assertImageBudget(blob.size, encodedDimensions);

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
    assertImageBudget(0, { width, height });

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
