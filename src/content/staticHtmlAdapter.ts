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

export type StaticHtmlDiagnostic = {
  code:
    | "ACTIVE_CONTENT_REMOVED"
    | "EVENT_HANDLER_REMOVED"
    | "EXTERNAL_RESOURCE_BLOCKED"
    | "LOCAL_RESOURCE_MISSING"
    | "MULTI_PAGE_LAYOUT_DETECTED"
    | "STATIC_FRAME_UNIFORM";
  severity: "info" | "warning" | "error";
  message: string;
  count?: number;
  reference?: string;
};

export type StaticHtmlLocalAssetResolver = (
  relativePath: string,
) => Promise<Blob | null>;

export type StaticHtmlAdapterOptions = {
  id?: string;
  title?: string;
  orientation?: "landscape" | "portrait";
  width?: number;
  height?: number;
  signal?: AbortSignal;
  resolveLocalAsset?: StaticHtmlLocalAssetResolver;
};

type NormalizedOptions = {
  title: string;
  width: number;
  height: number;
  signal?: AbortSignal;
  resolveLocalAsset?: StaticHtmlLocalAssetResolver;
};

type StaticHtmlLayout =
  | {
      mode: "slides";
      pageCount: number;
      width: number;
      height: number;
      activeDisplay: "block" | "flex" | "grid";
    }
  | {
      mode: "scroll";
      pageCount: number;
      width: number;
      height: number;
      scrollHeight: number;
    };

const MAX_HTML_LENGTH = 5_000_000;
const MAX_HTML_NODES = 30_000;
const MAX_CANVAS_DIMENSION = 4_096;
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_STATIC_PAGES = 200;
const SLIDE_MARKER_ATTRIBUTE = "data-excalidraw-recorder-slide";
const RENDER_STYLE_ATTRIBUTE = "data-excalidraw-recorder-render";
const ACTIVE_SELECTOR = [
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "textarea",
  "select",
  "button",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "template",
  "noscript",
  "base",
].join(",");

const finitePositive = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;

const normalizeOptions = (
  input: string | Blob | ArrayBuffer | Uint8Array,
  options: StaticHtmlAdapterOptions,
): NormalizedOptions => {
  const orientation = options.orientation ?? "landscape";
  const defaultWidth = orientation === "portrait" ? 900 : 1_600;
  const defaultHeight = orientation === "portrait" ? 1_600 : 900;
  const inferredTitle =
    typeof File !== "undefined" && input instanceof File ? input.name : options.title;
  return {
    title: inferredTitle?.trim() || "未命名 HTML 演示",
    width: Math.min(MAX_CANVAS_DIMENSION, finitePositive(options.width, defaultWidth)),
    height: Math.min(MAX_CANVAS_DIMENSION, finitePositive(options.height, defaultHeight)),
    signal: options.signal,
    resolveLocalAsset: options.resolveLocalAsset,
  };
};

const inputToText = async (input: string | Blob | ArrayBuffer | Uint8Array) => {
  if (typeof input === "string") return input;
  if (input instanceof Blob) return input.text();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取本地 HTML 资源。"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });

const isDataResource = (reference: string) =>
  /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)|font\/|application\/(?:font-|vnd\.ms-fontobject|octet-stream))/i.test(
    reference,
  );

const isFragmentReference = (reference: string) => reference.startsWith("#");

const isRelativeReference = (reference: string) =>
  Boolean(reference) &&
  !reference.startsWith("/") &&
  !reference.startsWith("\\") &&
  !reference.startsWith("//") &&
  !/^[a-z][a-z\d+.-]*:/i.test(reference);

const resolveStaticResource = async (
  rawReference: string,
  resolver: StaticHtmlLocalAssetResolver | undefined,
  diagnostics: StaticHtmlDiagnostic[],
) => {
  const reference = rawReference.trim().replace(/^['"]|['"]$/g, "");
  if (!reference || isFragmentReference(reference) || isDataResource(reference)) {
    return reference;
  }
  if (isRelativeReference(reference) && resolver) {
    const blob = await resolver(reference);
    if (blob) return blobToDataUrl(blob);
    diagnostics.push({
      code: "LOCAL_RESOURCE_MISSING",
      severity: "warning",
      message: `找不到 HTML 引用的本地资源：${reference}`,
      reference,
    });
    return "";
  }
  diagnostics.push({
    code: "EXTERNAL_RESOURCE_BLOCKED",
    severity: "warning",
    message: `已阻止 HTML 联网或越界读取资源：${reference}`,
    reference,
  });
  return "";
};

const sanitizeCss = async (
  rawCss: string,
  resolver: StaticHtmlLocalAssetResolver | undefined,
  diagnostics: StaticHtmlDiagnostic[],
) => {
  let css = rawCss
    .replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])\s*;?/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/javascript\s*:/gi, "");
  const matches = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)];
  if (!matches.length) return css;
  let rebuilt = "";
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? cursor;
    rebuilt += css.slice(cursor, index);
    const resolved = await resolveStaticResource(
      match[2] ?? "",
      resolver,
      diagnostics,
    );
    rebuilt += resolved ? `url("${resolved.replace(/"/g, "%22")}")` : "none";
    cursor = index + match[0].length;
  }
  rebuilt += css.slice(cursor);
  css = rebuilt;
  return css;
};

const sanitizeStaticHtml = async (
  source: string,
  options: NormalizedOptions,
) => {
  if (typeof DOMParser === "undefined") {
    throw new ContentAdapterError(
      "UNSUPPORTED_FORMAT",
      "当前浏览器不支持静态 HTML 解析。",
    );
  }
  if (source.length > MAX_HTML_LENGTH) {
    throw new ContentAdapterError(
      "INVALID_INPUT",
      `HTML 文件超过 ${(MAX_HTML_LENGTH / 1_000_000).toFixed(0)} MB 文本限制。`,
    );
  }
  const document = new DOMParser().parseFromString(source, "text/html");
  const diagnostics: StaticHtmlDiagnostic[] = [];
  const nodeCount = document.querySelectorAll("*").length;
  if (nodeCount > MAX_HTML_NODES) {
    throw new ContentAdapterError(
      "INVALID_INPUT",
      `HTML 节点超过 ${MAX_HTML_NODES.toLocaleString()} 个，暂不适合轻量录制。`,
    );
  }

  const activeNodes = [...document.querySelectorAll(ACTIVE_SELECTOR)];
  activeNodes.forEach((node) => node.remove());
  if (activeNodes.length) {
    diagnostics.push({
      code: "ACTIVE_CONTENT_REMOVED",
      severity: "warning",
      count: activeNodes.length,
      message: `已移除 ${activeNodes.length} 个脚本、嵌入、表单或媒体节点；静态样式与正文保持不变。`,
    });
  }

  let removedEventHandlers = 0;
  for (const element of [...document.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction") {
        element.removeAttribute(attribute.name);
        removedEventHandlers += 1;
      }
    }
    if (element instanceof HTMLAnchorElement) {
      element.removeAttribute("href");
      element.removeAttribute("target");
    }
  }
  if (removedEventHandlers) {
    diagnostics.push({
      code: "EVENT_HANDLER_REMOVED",
      severity: "info",
      count: removedEventHandlers,
      message: `已关闭 ${removedEventHandlers} 个事件处理器，HTML 不会执行交互脚本。`,
    });
  }

  for (const meta of [...document.querySelectorAll("meta[http-equiv]")]) meta.remove();

  for (const link of [...document.querySelectorAll("link")]) {
    const rel = link.getAttribute("rel")?.toLowerCase() ?? "";
    const href = link.getAttribute("href") ?? "";
    if (rel.includes("stylesheet") && href && options.resolveLocalAsset) {
      const resolved = await options.resolveLocalAsset(href);
      if (resolved) {
        const style = document.createElement("style");
        style.textContent = await sanitizeCss(
          await resolved.text(),
          options.resolveLocalAsset,
          diagnostics,
        );
        link.replaceWith(style);
        continue;
      }
    }
    if (href) {
      diagnostics.push({
        code: "EXTERNAL_RESOURCE_BLOCKED",
        severity: "warning",
        message: `已忽略外部样式或图标资源：${href}`,
        reference: href,
      });
    }
    link.remove();
  }

  for (const style of [...document.querySelectorAll("style")]) {
    style.textContent = await sanitizeCss(
      style.textContent ?? "",
      options.resolveLocalAsset,
      diagnostics,
    );
  }
  for (const element of [...document.querySelectorAll<HTMLElement>("[style]")]) {
    element.setAttribute(
      "style",
      await sanitizeCss(
        element.getAttribute("style") ?? "",
        options.resolveLocalAsset,
        diagnostics,
      ),
    );
  }

  const resourceAttributes: Array<[string, string]> = [
    ["img[src]", "src"],
    ["svg image[href]", "href"],
    ["svg image[xlink\\:href]", "xlink:href"],
    ["[poster]", "poster"],
  ];
  for (const [selector, attribute] of resourceAttributes) {
    for (const element of [...document.querySelectorAll(selector)]) {
      const reference = element.getAttribute(attribute) ?? "";
      const resolved = await resolveStaticResource(
        reference,
        options.resolveLocalAsset,
        diagnostics,
      );
      if (resolved) element.setAttribute(attribute, resolved);
      else element.removeAttribute(attribute);
    }
  }

  document.documentElement.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const staticStateStyle = document.createElement("style");
  staticStateStyle.setAttribute("data-excalidraw-recorder", "static-state");
  staticStateStyle.textContent = `
    *,*::before,*::after{animation:none!important;transition:none!important}
    .fade-in,.fadeIn,.animate-in,[data-aos]{opacity:1!important;visibility:visible!important;transform:none!important}
  `;
  document.head.append(staticStateStyle);
  return { document, diagnostics };
};

const parsePixelValue = (value: string | null | undefined) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_CANVAS_DIMENSION
    ? parsed
    : null;
};

const findCssRuleDimensions = (document: Document, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rulePattern = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "i");
  for (const style of [...document.querySelectorAll("style")]) {
    const body = (style.textContent ?? "").match(rulePattern)?.[1];
    if (!body) continue;
    const width = parsePixelValue(body.match(/(?:^|;)\s*width\s*:\s*([\d.]+)px/i)?.[1]);
    const height = parsePixelValue(body.match(/(?:^|;)\s*height\s*:\s*([\d.]+)px/i)?.[1]);
    if (width && height) return { width, height };
  }
  return null;
};

const findActiveSlideDisplay = (document: Document) => {
  for (const style of [...document.querySelectorAll("style")]) {
    const css = style.textContent ?? "";
    const rules = [
      ...css.matchAll(/([^{}]*(?:\.slide|\[data-slide\])[^{}]*\.active[^{}]*)\{([^}]*)\}/gi),
    ];
    for (const rule of rules) {
      const display = rule[2]?.match(/(?:^|;)\s*display\s*:\s*(block|flex|grid)\b/i)?.[1]
        ?.toLowerCase();
      if (display === "flex" || display === "grid" || display === "block") {
        return display;
      }
    }
  }
  return "block";
};

const getElementDimensions = (element: Element | null) => {
  if (!(element instanceof HTMLElement)) return null;
  const width =
    parsePixelValue(element.style.width) ?? parsePixelValue(element.getAttribute("width"));
  const height =
    parsePixelValue(element.style.height) ?? parsePixelValue(element.getAttribute("height"));
  return width && height ? { width, height } : null;
};

const detectSlideElements = (document: Document) => {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>("[data-slide], .slide"),
  ];
  const candidateSet = new Set(candidates);
  const outermost = candidates.filter((candidate) => {
    let ancestor = candidate.parentElement;
    while (ancestor) {
      if (candidateSet.has(ancestor)) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });
  return outermost.length >= 2 ? outermost : [];
};

const measureScrollableHeight = async (
  sourceDocument: Document,
  width: number,
  height: number,
  signal?: AbortSignal,
) => {
  throwIfAborted(signal);
  const measurementDocument = sourceDocument.cloneNode(true) as Document;
  const style = measurementDocument.createElement("style");
  style.setAttribute(RENDER_STYLE_ATTRIBUTE, "measure");
  style.textContent = `
    html{width:${width}px!important;height:auto!important;min-height:${height}px!important;overflow:visible!important}
    body{height:auto!important;min-height:${height}px!important;overflow:visible!important}
  `;
  measurementDocument.head.append(style);

  const iframe = globalThis.document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;visibility:hidden;pointer-events:none;border:0;`;
  const loaded = new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
  });
  iframe.srcdoc = new XMLSerializer().serializeToString(
    measurementDocument.documentElement,
  );
  globalThis.document.body.append(iframe);
  try {
    await Promise.race([
      loaded,
      new Promise<void>((resolve) => window.setTimeout(resolve, 1_200)),
    ]);
    throwIfAborted(signal);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const measuredDocument = iframe.contentDocument;
    const measuredHeight = Math.max(
      height,
      measuredDocument?.documentElement.scrollHeight ?? 0,
      measuredDocument?.body?.scrollHeight ?? 0,
      measuredDocument?.documentElement.getBoundingClientRect().height ?? 0,
      measuredDocument?.body?.getBoundingClientRect().height ?? 0,
    );
    return Math.min(height * MAX_STATIC_PAGES, Math.ceil(measuredHeight));
  } finally {
    iframe.remove();
  }
};

const detectStaticLayout = async (
  document: Document,
  options: NormalizedOptions,
  diagnostics: StaticHtmlDiagnostic[],
): Promise<StaticHtmlLayout> => {
  const slides = detectSlideElements(document);
  if (slides.length) {
    slides.forEach((slide, index) =>
      slide.setAttribute(SLIDE_MARKER_ATTRIBUTE, String(index)),
    );
    const deck = document.querySelector("#deck");
    const dimensions =
      getElementDimensions(deck) ??
      findCssRuleDimensions(document, "#deck") ??
      findCssRuleDimensions(document, ".slide") ?? {
        width: options.width,
        height: options.height,
      };
    diagnostics.push({
      code: "MULTI_PAGE_LAYOUT_DETECTED",
      severity: "info",
      count: slides.length,
      message: `已识别为 HTML 幻灯片，共 ${slides.length} 页。`,
    });
    return {
      mode: "slides",
      pageCount: Math.min(MAX_STATIC_PAGES, slides.length),
      width: Math.round(dimensions.width),
      height: Math.round(dimensions.height),
      activeDisplay: findActiveSlideDisplay(document),
    };
  }

  const scrollHeight = await measureScrollableHeight(
    document,
    options.width,
    options.height,
    options.signal,
  );
  const pageCount = Math.max(
    1,
    Math.min(MAX_STATIC_PAGES, Math.ceil(scrollHeight / options.height)),
  );
  if (pageCount > 1) {
    diagnostics.push({
      code: "MULTI_PAGE_LAYOUT_DETECTED",
      severity: "info",
      count: pageCount,
      message: `已识别为长网页，共拆分为 ${pageCount} 个讲解画面。`,
    });
  }
  return {
    mode: "scroll",
    pageCount,
    width: options.width,
    height: options.height,
    scrollHeight,
  };
};

const createPageDocument = (
  sourceDocument: Document,
  layout: StaticHtmlLayout,
  pageIndex: number,
) => {
  const pageDocument = sourceDocument.cloneNode(true) as Document;
  pageDocument.querySelectorAll(`[${RENDER_STYLE_ATTRIBUTE}]`).forEach((node) =>
    node.remove(),
  );
  const style = pageDocument.createElement("style");
  style.setAttribute(RENDER_STYLE_ATTRIBUTE, "page");
  if (layout.mode === "slides") {
    const selected = pageDocument.querySelector<HTMLElement>(
      `[${SLIDE_MARKER_ATTRIBUTE}="${pageIndex}"]`,
    );
    selected?.classList.add("active", "visible");
    for (const slide of [
      ...pageDocument.querySelectorAll<HTMLElement>(`[${SLIDE_MARKER_ATTRIBUTE}]`),
    ]) {
      if (slide !== selected) slide.replaceChildren();
    }
    style.textContent = `
      html,body{width:${layout.width}px!important;height:${layout.height}px!important;overflow:hidden!important}
      [${SLIDE_MARKER_ATTRIBUTE}]{display:none!important}
      [${SLIDE_MARKER_ATTRIBUTE}="${pageIndex}"]{display:${layout.activeDisplay}!important;opacity:1!important;visibility:visible!important;transform:none!important}
    `;
  } else {
    const offset = pageIndex * layout.height;
    style.textContent = `
      html{width:${layout.width}px!important;height:${layout.height}px!important;overflow:hidden!important}
      body{width:auto!important;height:auto!important;min-height:${layout.scrollHeight}px!important;overflow:visible!important;position:relative!important;top:-${offset}px!important}
    `;
  }
  pageDocument.head.append(style);
  return pageDocument;
};

const getOutputDimensions = (
  sourceWidth: number,
  sourceHeight: number,
  request: Pick<FrameRequest, "maxWidth" | "maxHeight" | "scale">,
) => {
  const maxWidth = finitePositive(request.maxWidth, sourceWidth);
  const maxHeight = finitePositive(request.maxHeight, sourceHeight);
  let scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  scale *= finitePositive(request.scale, 1);
  let width = Math.max(1, Math.round(sourceWidth * scale));
  let height = Math.max(1, Math.round(sourceHeight * scale));
  const guard = Math.min(
    1,
    MAX_CANVAS_DIMENSION / width,
    MAX_CANVAS_DIMENSION / height,
    Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height)),
  );
  width = Math.max(1, Math.round(width * guard));
  height = Math.max(1, Math.round(height * guard));
  return { width, height };
};

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("浏览器无法生成静态 HTML 画面。"));
    image.src = url;
  });

const renderDocument = async (
  sourceDocument: Document,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
) => {
  const serialized = new XMLSerializer().serializeToString(sourceDocument.documentElement);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth}" height="${sourceHeight}" viewBox="0 0 ${sourceWidth} ${sourceHeight}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  // A data URL keeps the rasterized canvas origin-clean. A blob URL containing
  // foreignObject taints Chromium canvases and would break captureStream().
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法创建 HTML 录制画布。" );
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.drawImage(image, 0, 0, outputWidth, outputHeight);
  return canvas;
};

const isNearlyUniformCanvas = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  const columns = 10;
  const rows = 7;
  let minLuminance = 255;
  let maxLuminance = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(
        canvas.width - 1,
        Math.max(0, Math.round(((column + 0.5) / columns) * canvas.width)),
      );
      const y = Math.min(
        canvas.height - 1,
        Math.max(0, Math.round(((row + 0.5) / rows) * canvas.height)),
      );
      const pixel = context.getImageData(x, y, 1, 1).data;
      const luminance = 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
      minLuminance = Math.min(minLuminance, luminance);
      maxLuminance = Math.max(maxLuminance, luminance);
    }
  }
  return maxLuminance - minLuminance < 2;
};

const releaseCanvas = (canvas: HTMLCanvasElement | null) => {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
};

/**
 * Static, high-fidelity HTML presentation renderer. It preserves HTML/CSS/SVG
 * while removing scripts and network access, then rasterizes one local frame
 * that can flow through the existing recorder compositor.
 */
export class StaticHtmlContentAdapter implements ContentAdapter {
  readonly id: string;
  readonly kind = "html" as const;
  private readonly listeners = new Set<ContentAdapterListener>();
  private readonly frameCache = new Map<string, SourceFrame>();
  private readonly thumbnailCache = new Map<string, SourceThumbnail>();
  private readonly sanitizedDocument: Document;
  private readonly options: NormalizedOptions;
  private readonly diagnostics: StaticHtmlDiagnostic[];
  private readonly layout: StaticHtmlLayout;
  private readonly uniformPagesReported = new Set<number>();
  private metadata: ContentMetadata;
  private currentFrame: SourceFrame | null = null;
  private revision = 0;
  private disposed = false;

  private constructor(
    id: string,
    sanitizedDocument: Document,
    options: NormalizedOptions,
    diagnostics: StaticHtmlDiagnostic[],
    layout: StaticHtmlLayout,
  ) {
    this.id = id;
    this.sanitizedDocument = sanitizedDocument;
    this.options = options;
    this.diagnostics = diagnostics;
    this.layout = layout;
    this.metadata = {
      id,
      kind: this.kind,
      title: options.title,
      mimeType: "text/html",
      pageCount: layout.pageCount,
      currentPageIndex: 0,
      width: layout.width,
      height: layout.height,
      orientation: getContentOrientation(layout.width, layout.height),
      status: "ready",
      details: {
        htmlMode: "static-visual-v2",
        layoutMode: layout.mode,
        scripts: "disabled",
        externalNetwork: "disabled",
        warningCount: String(
          diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length,
        ),
      },
    };
  }

  static async load(
    input: string | Blob | ArrayBuffer | Uint8Array,
    options: StaticHtmlAdapterOptions = {},
  ) {
    const normalized = normalizeOptions(input, options);
    throwIfAborted(normalized.signal);
    const source = await inputToText(input);
    throwIfAborted(normalized.signal);
    const sanitized = await sanitizeStaticHtml(source, normalized);
    throwIfAborted(normalized.signal);
    const layout = await detectStaticLayout(
      sanitized.document,
      normalized,
      sanitized.diagnostics,
    );
    throwIfAborted(normalized.signal);
    return new StaticHtmlContentAdapter(
      options.id ?? createContentId("html"),
      sanitized.document,
      normalized,
      sanitized.diagnostics,
      layout,
    );
  }

  getMetadata() {
    return { ...this.metadata, details: { ...this.metadata.details } };
  }

  getFrame() {
    return this.currentFrame;
  }

  getDiagnostics() {
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async prepareFrame(request: FrameRequest = {}) {
    this.assertReady();
    throwIfAborted(request.signal);
    const pageIndex = request.pageIndex ?? this.metadata.currentPageIndex;
    this.assertPage(pageIndex);
    const dimensions = getOutputDimensions(
      this.layout.width,
      this.layout.height,
      request,
    );
    const key = `${pageIndex}:${dimensions.width}x${dimensions.height}`;
    let frame = this.touch(this.frameCache, key);
    if (!frame) {
      const pageDocument = createPageDocument(
        this.sanitizedDocument,
        this.layout,
        pageIndex,
      );
      const canvas = await renderDocument(
        pageDocument,
        this.layout.width,
        this.layout.height,
        dimensions.width,
        dimensions.height,
      );
      this.reportUniformFrame(pageIndex, canvas);
      frame = {
        id: this.id,
        kind: this.kind,
        source: canvas,
        width: canvas.width,
        height: canvas.height,
        pageIndex,
        pageCount: this.layout.pageCount,
        revision: ++this.revision,
        renderedAt: performance.now(),
      };
      this.frameCache.set(key, frame);
      this.trimCache(this.frameCache, 8, (item) =>
        releaseCanvas(item.source as HTMLCanvasElement),
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
    const dimensions = getOutputDimensions(this.layout.width, this.layout.height, {
      maxWidth: request.maxWidth ?? 240,
      maxHeight: request.maxHeight ?? 180,
    });
    const key = `${pageIndex}:${dimensions.width}x${dimensions.height}`;
    const cached = this.touch(this.thumbnailCache, key);
    if (cached) return cached;
    const pageDocument = createPageDocument(
      this.sanitizedDocument,
      this.layout,
      pageIndex,
    );
    const canvas = await renderDocument(
      pageDocument,
      this.layout.width,
      this.layout.height,
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
    this.trimCache(this.thumbnailCache, 32, (item) =>
      releaseCanvas(item.source as HTMLCanvasElement),
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
    this.frameCache.forEach((frame) => releaseCanvas(frame.source as HTMLCanvasElement));
    this.thumbnailCache.forEach((thumbnail) =>
      releaseCanvas(thumbnail.source as HTMLCanvasElement),
    );
    this.frameCache.clear();
    this.thumbnailCache.clear();
    this.currentFrame = null;
    this.metadata = { ...this.metadata, status: "disposed" };
    this.emit();
    this.listeners.clear();
  }

  private emit() {
    const metadata = this.getMetadata();
    this.listeners.forEach((listener) => listener(metadata));
  }

  private assertReady() {
    if (!this.disposed) return;
    throw new ContentAdapterError("DISPOSED", "静态 HTML 演示已经关闭。" );
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
      `HTML 页码超出范围：${pageIndex}`,
    );
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

  private reportUniformFrame(pageIndex: number, canvas: HTMLCanvasElement) {
    if (
      this.uniformPagesReported.has(pageIndex) ||
      !isNearlyUniformCanvas(canvas)
    ) {
      return;
    }
    const pageDocument = createPageDocument(
      this.sanitizedDocument,
      this.layout,
      pageIndex,
    );
    const visibleText = pageDocument.body?.textContent?.trim() ?? "";
    const visualCount = pageDocument.querySelectorAll("img,svg,figure,table").length;
    if (visibleText.length < 20 && visualCount === 0) return;
    this.uniformPagesReported.add(pageIndex);
    this.diagnostics.push({
      code: "STATIC_FRAME_UNIFORM",
      severity: "warning",
      reference: String(pageIndex + 1),
      message: `HTML 第 ${pageIndex + 1} 页渲染结果接近纯色，可能仍有依赖脚本的隐藏内容。`,
    });
  }
}
