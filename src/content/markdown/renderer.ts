import type {
  MarkdownBlock,
  MarkdownDiagnostic,
  MarkdownDrawCommand,
  MarkdownInline,
  MarkdownLayout,
  MarkdownLayoutOptions,
  MarkdownLayoutPage,
} from "./types";

type InlinePiece = {
  text: string;
  font: string;
  color: string;
  width: number;
};

type InlineLine = {
  pieces: InlinePiece[];
  width: number;
};

type ResolvedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
};

const SAFE_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
]);

const checkAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return;
  throw new DOMException("Markdown rendering was cancelled.", "AbortError");
};

const sourceDimensions = (source: CanvasImageSource) => {
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
    return {
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height,
    };
  }
  if (typeof SVGImageElement !== "undefined" && source instanceof SVGImageElement) {
    return { width: source.width.baseVal.value, height: source.height.baseVal.value };
  }
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
    return { width: source.displayWidth, height: source.displayHeight };
  }
  if ("width" in source && "height" in source) {
    return {
      width: Number(source.width),
      height: Number(source.height),
    };
  }
  return { width: 0, height: 0 };
};

const isCanvasImageSource = (value: unknown): value is CanvasImageSource => {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) ||
      (typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas) ||
      (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement) ||
      (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) ||
      (typeof HTMLVideoElement !== "undefined" && value instanceof HTMLVideoElement) ||
      (typeof VideoFrame !== "undefined" && value instanceof VideoFrame),
  );
};

const font = (
  size: number,
  family: string,
  options: { bold?: boolean; italic?: boolean } = {},
) =>
  `${options.italic ? "italic " : ""}${options.bold ? "700 " : "400 "}${Math.round(
    size,
  )}px ${family}`;

const inlineFont = (
  inline: MarkdownInline,
  size: number,
  options: MarkdownLayoutOptions,
) =>
  font(size, inline.code ? options.theme.monoFontFamily : options.theme.fontFamily, {
    bold: inline.bold,
    italic: inline.italic,
  });

const splitUnits = (text: string) =>
  text.match(/\s+|[\u2e80-\u9fff\uf900-\ufaff]|[^\s\u2e80-\u9fff\uf900-\ufaff]+/gu) ?? [];

const pushLine = (lines: InlineLine[], pieces: InlinePiece[], width: number) => {
  lines.push({ pieces: [...pieces], width });
  pieces.length = 0;
};

const wrapInlines = (
  context: CanvasRenderingContext2D,
  inlines: MarkdownInline[],
  maxWidth: number,
  size: number,
  color: string,
  options: MarkdownLayoutOptions,
) => {
  const lines: InlineLine[] = [];
  const pieces: InlinePiece[] = [];
  let lineWidth = 0;

  const append = (text: string, itemFont: string, itemColor: string) => {
    context.font = itemFont;
    const width = context.measureText(text).width;
    if (lineWidth > 0 && lineWidth + width > maxWidth && text.trim()) {
      pushLine(lines, pieces, lineWidth);
      lineWidth = 0;
    }
    if (width <= maxWidth || text.length <= 1) {
      if (!pieces.length && !text.trim()) return;
      pieces.push({ text, font: itemFont, color: itemColor, width });
      lineWidth += width;
      return;
    }
    for (const character of Array.from(text)) {
      context.font = itemFont;
      const characterWidth = context.measureText(character).width;
      if (lineWidth > 0 && lineWidth + characterWidth > maxWidth) {
        pushLine(lines, pieces, lineWidth);
        lineWidth = 0;
      }
      pieces.push({
        text: character,
        font: itemFont,
        color: itemColor,
        width: characterWidth,
      });
      lineWidth += characterWidth;
    }
  };

  for (const inline of inlines) {
    const itemFont = inlineFont(inline, size, options);
    const itemColor = inline.code ? options.theme.accent : color;
    for (const unit of splitUnits(inline.text)) append(unit, itemFont, itemColor);
  }
  if (pieces.length || !lines.length) pushLine(lines, pieces, lineWidth);
  return lines;
};

const plainTextInlines = (text: string): MarkdownInline[] => [{ text }];

const resolveImages = async (
  sections: MarkdownBlock[][],
  options: MarkdownLayoutOptions,
  diagnostics: MarkdownDiagnostic[],
) => {
  const resolved = new Map<string, ResolvedImage | null>();
  const ownedBitmaps: ImageBitmap[] = [];
  const imageBlocks = sections.flat().filter(
    (block): block is Extract<MarkdownBlock, { type: "image" }> => block.type === "image",
  );

  for (const block of imageBlocks) {
    checkAborted(options.signal);
    if (resolved.has(block.reference)) continue;
    if (!options.resolveLocalImage) {
      diagnostics.push({
        code: "LOCAL_IMAGE_UNAVAILABLE",
        severity: "warning",
        line: block.line,
        reference: block.reference,
        message: "没有配置本地图片解析器，已绘制安全占位符。",
      });
      resolved.set(block.reference, null);
      continue;
    }

    try {
      const value = await options.resolveLocalImage(block.reference, {
        signal: options.signal,
      });
      checkAborted(options.signal);
      let source: CanvasImageSource | null = null;
      if (value instanceof Blob) {
        if (!SAFE_RASTER_MIME_TYPES.has(value.type.toLowerCase())) {
          diagnostics.push({
            code: "LOCAL_IMAGE_UNSUPPORTED",
            severity: "warning",
            line: block.line,
            reference: block.reference,
            message: "本地图片必须是 PNG/JPEG/WebP/GIF/AVIF/BMP；SVG 等主动格式已拒绝。",
          });
        } else if (typeof createImageBitmap === "function") {
          const bitmap = await createImageBitmap(value);
          ownedBitmaps.push(bitmap);
          source = bitmap;
        }
      } else if (isCanvasImageSource(value)) {
        source = value;
      }

      const dimensions = source ? sourceDimensions(source) : { width: 0, height: 0 };
      if (source && dimensions.width > 0 && dimensions.height > 0) {
        resolved.set(block.reference, { source, ...dimensions });
      } else {
        if (!diagnostics.some(
          (item) =>
            item.reference === block.reference && item.code === "LOCAL_IMAGE_UNSUPPORTED",
        )) {
          diagnostics.push({
            code: "LOCAL_IMAGE_UNAVAILABLE",
            severity: "warning",
            line: block.line,
            reference: block.reference,
            message: "本地图片解析器没有返回可绘制的栅格资源。",
          });
        }
        resolved.set(block.reference, null);
      }
    } catch (error) {
      checkAborted(options.signal);
      diagnostics.push({
        code: "LOCAL_IMAGE_UNAVAILABLE",
        severity: "warning",
        line: block.line,
        reference: block.reference,
        message: `本地图片读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
      resolved.set(block.reference, null);
    }
  }

  return { resolved, ownedBitmaps };
};

class LayoutBuilder {
  readonly pages: MarkdownLayoutPage[] = [];
  private current!: MarkdownLayoutPage;
  private y = 0;
  private overflowReported = new Set<number>();

  constructor(
    private readonly context: CanvasRenderingContext2D,
    private readonly options: MarkdownLayoutOptions,
    private readonly diagnostics: MarkdownDiagnostic[],
    private readonly images: Map<string, ResolvedImage | null>,
  ) {}

  addSection(blocks: MarkdownBlock[], sourceSectionIndex: number) {
    if (this.options.mode === "slides" || !this.pages.length) {
      this.newPage(sourceSectionIndex);
    }
    if (!blocks.length) {
      this.addEmptyState();
      return;
    }
    for (const block of blocks) {
      checkAborted(this.options.signal);
      this.addBlock(block, sourceSectionIndex);
    }
  }

  private newPage(sourceSectionIndex: number) {
    this.current = { commands: [], sourceSectionIndex };
    this.pages.push(this.current);
    this.y = this.options.padding;
  }

  private addEmptyState() {
    const size = this.options.baseFontSize;
    this.current.commands.push({
      type: "text",
      text: "空白页",
      x: this.options.padding,
      y: this.options.padding + size,
      font: font(size, this.options.theme.fontFamily),
      color: this.options.theme.muted,
    });
  }

  private availableWidth(indent = 0) {
    return Math.max(120, this.options.width - this.options.padding * 2 - indent);
  }

  private ensureSpace(height: number, sectionIndex: number, sourceLine?: number) {
    const bottom = this.options.height - this.options.padding;
    if (this.y + height <= bottom) return;
    if (this.options.mode === "document") {
      this.newPage(sectionIndex);
      return;
    }
    if (!this.overflowReported.has(sectionIndex)) {
      this.overflowReported.add(sectionIndex);
      this.diagnostics.push({
        code: "SLIDE_OVERFLOW",
        severity: "warning",
        line: sourceLine,
        pageIndex: this.pages.length - 1,
        message: "该幻灯片内容超出安全画布，底部内容可能被裁切。",
      });
    }
  }

  private addInlineLines(
    inlines: MarkdownInline[],
    sectionIndex: number,
    settings: {
      x?: number;
      width?: number;
      size: number;
      lineHeight: number;
      color?: string;
      sourceLine?: number;
      firstPrefix?: string;
      prefixFont?: string;
      prefixColor?: string;
      beforeLine?: (lineY: number, lineIndex: number) => void;
    },
  ) {
    const x = settings.x ?? this.options.padding;
    const available = settings.width ?? this.availableWidth(x - this.options.padding);
    const prefixWidth = settings.firstPrefix
      ? (() => {
          this.context.font = settings.prefixFont ?? font(settings.size, this.options.theme.fontFamily);
          return this.context.measureText(settings.firstPrefix).width + settings.size * 0.35;
        })()
      : 0;
    const lines = wrapInlines(
      this.context,
      inlines,
      Math.max(80, available - prefixWidth),
      settings.size,
      settings.color ?? this.options.theme.text,
      this.options,
    );

    lines.forEach((line, lineIndex) => {
      this.ensureSpace(settings.lineHeight, sectionIndex, settings.sourceLine);
      const baseline = this.y + settings.size;
      settings.beforeLine?.(this.y, lineIndex);
      let currentX = x;
      if (lineIndex === 0 && settings.firstPrefix) {
        this.current.commands.push({
          type: "text",
          text: settings.firstPrefix,
          x: currentX,
          y: baseline,
          font: settings.prefixFont ?? font(settings.size, this.options.theme.fontFamily),
          color: settings.prefixColor ?? this.options.theme.accent,
        });
        currentX += prefixWidth;
      }
      for (const piece of line.pieces) {
        this.current.commands.push({
          type: "text",
          text: piece.text,
          x: currentX,
          y: baseline,
          font: piece.font,
          color: piece.color,
        });
        currentX += piece.width;
      }
      this.y += settings.lineHeight;
    });
  }

  private addBlock(block: MarkdownBlock, sectionIndex: number) {
    switch (block.type) {
      case "heading": {
        const scale = [0, 2.05, 1.62, 1.34, 1.14, 1, 0.9][block.level] ?? 1;
        const size = Math.round(this.options.baseFontSize * scale);
        const lineHeight = Math.round(size * 1.28);
        this.ensureSpace(lineHeight + size * 0.45, sectionIndex, block.line);
        this.addInlineLines(block.inlines, sectionIndex, {
          size,
          lineHeight,
          sourceLine: block.line,
          color: block.level <= 2 ? this.options.theme.text : this.options.theme.accent,
        });
        this.y += Math.round(size * 0.45);
        break;
      }
      case "paragraph": {
        this.addInlineLines(block.inlines, sectionIndex, {
          size: this.options.baseFontSize,
          lineHeight: this.options.lineHeight,
          sourceLine: block.line,
        });
        this.y += Math.round(this.options.baseFontSize * 0.65);
        break;
      }
      case "list-item": {
        const indent = this.options.baseFontSize * 1.4;
        this.addInlineLines(block.inlines, sectionIndex, {
          x: this.options.padding + indent,
          width: this.availableWidth(indent),
          size: this.options.baseFontSize,
          lineHeight: this.options.lineHeight,
          sourceLine: block.line,
          firstPrefix: block.ordered ? `${block.ordinal}.` : "•",
          prefixFont: font(this.options.baseFontSize, this.options.theme.fontFamily, {
            bold: true,
          }),
        });
        this.y += Math.round(this.options.baseFontSize * 0.25);
        break;
      }
      case "quote": {
        const indent = this.options.baseFontSize * 1.15;
        this.addInlineLines(block.inlines, sectionIndex, {
          x: this.options.padding + indent,
          width: this.availableWidth(indent),
          size: this.options.baseFontSize,
          lineHeight: this.options.lineHeight,
          color: this.options.theme.muted,
          sourceLine: block.line,
          beforeLine: (lineY) => {
            this.current.commands.push({
              type: "fill",
              x: this.options.padding,
              y: lineY - 4,
              width: this.availableWidth(),
              height: this.options.lineHeight + 8,
              color: this.options.theme.codeBackground,
              radius: 8,
            });
            this.current.commands.push({
              type: "fill",
              x: this.options.padding,
              y: lineY - 4,
              width: 7,
              height: this.options.lineHeight + 8,
              color: this.options.theme.accent,
              radius: 4,
            });
          },
        });
        this.y += Math.round(this.options.baseFontSize * 0.65);
        break;
      }
      case "code": {
        const size = Math.round(this.options.baseFontSize * 0.82);
        const lineHeight = Math.round(size * 1.5);
        const sourceLines = [`${block.language || "text"}`, ...(block.value.split("\n") || [""])];
        for (let index = 0; index < sourceLines.length; index += 1) {
          const color = index === 0 ? this.options.theme.accent : this.options.theme.text;
          this.addInlineLines(plainTextInlines(sourceLines[index] || " "), sectionIndex, {
            x: this.options.padding + size,
            width: this.availableWidth(size * 2),
            size,
            lineHeight,
            color,
            sourceLine: block.line,
            beforeLine: (lineY) => {
              this.current.commands.push({
                type: "fill",
                x: this.options.padding,
                y: lineY - 3,
                width: this.availableWidth(),
                height: lineHeight + 6,
                color: this.options.theme.codeBackground,
                radius: 5,
              });
            },
          });
        }
        this.y += Math.round(size * 0.75);
        break;
      }
      case "table": {
        this.addTable(block, sectionIndex);
        break;
      }
      case "image": {
        this.addImage(block, sectionIndex);
        break;
      }
      case "rule": {
        const gap = this.options.baseFontSize * 1.6;
        this.ensureSpace(gap, sectionIndex, block.line);
        this.current.commands.push({
          type: "line",
          x1: this.options.padding,
          y1: this.y + gap / 2,
          x2: this.options.width - this.options.padding,
          y2: this.y + gap / 2,
          color: this.options.theme.border,
          width: 3,
        });
        this.y += gap;
        break;
      }
    }
  }

  private addTable(
    block: Extract<MarkdownBlock, { type: "table" }>,
    sectionIndex: number,
  ) {
    const columns = Math.max(1, block.table.header.length);
    const width = this.availableWidth();
    const columnWidth = width / columns;
    const size = Math.max(16, Math.round(this.options.baseFontSize * 0.74));
    const rowHeight = Math.round(size * 2.55);
    const rows = [block.table.header, ...block.table.rows];

    rows.forEach((row, rowIndex) => {
      this.ensureSpace(rowHeight, sectionIndex, block.line);
      const top = this.y;
      this.current.commands.push({
        type: "fill",
        x: this.options.padding,
        y: top,
        width,
        height: rowHeight,
        color: rowIndex === 0 ? this.options.theme.codeBackground : this.options.theme.surface,
      });
      for (let column = 0; column < columns; column += 1) {
        const x = this.options.padding + column * columnWidth;
        this.current.commands.push({
          type: "line",
          x1: x,
          y1: top,
          x2: x,
          y2: top + rowHeight,
          color: this.options.theme.border,
          width: 2,
        });
        const text = (row[column] ?? "").slice(0, 180);
        const lines = wrapInlines(
          this.context,
          plainTextInlines(text),
          columnWidth - size,
          size,
          this.options.theme.text,
          this.options,
        ).slice(0, 2);
        lines.forEach((line, lineIndex) => {
          let textX = x + size / 2;
          const baseline = top + size * (1.25 + lineIndex * 1.05);
          for (const piece of line.pieces) {
            this.current.commands.push({
              type: "text",
              text: piece.text,
              x: textX,
              y: baseline,
              font: rowIndex === 0
                ? font(size, this.options.theme.fontFamily, { bold: true })
                : piece.font,
              color: piece.color,
            });
            textX += piece.width;
          }
        });
      }
      this.current.commands.push({
        type: "line",
        x1: this.options.padding + width,
        y1: top,
        x2: this.options.padding + width,
        y2: top + rowHeight,
        color: this.options.theme.border,
        width: 2,
      });
      this.current.commands.push({
        type: "line",
        x1: this.options.padding,
        y1: top,
        x2: this.options.padding + width,
        y2: top,
        color: this.options.theme.border,
        width: 2,
      });
      this.y += rowHeight;
    });
    this.current.commands.push({
      type: "line",
      x1: this.options.padding,
      y1: this.y,
      x2: this.options.width - this.options.padding,
      y2: this.y,
      color: this.options.theme.border,
      width: 2,
    });
    this.y += this.options.baseFontSize;
  }

  private addImage(
    block: Extract<MarkdownBlock, { type: "image" }>,
    sectionIndex: number,
  ) {
    const resolved = this.images.get(block.reference);
    const availableWidth = this.availableWidth();
    const maxHeight = Math.round(this.options.height * 0.46);
    const captionHeight = Math.round(this.options.baseFontSize * 1.7);
    if (!resolved) {
      const height = Math.min(240, maxHeight);
      this.ensureSpace(height + captionHeight, sectionIndex, block.line);
      this.current.commands.push({
        type: "fill",
        x: this.options.padding,
        y: this.y,
        width: availableWidth,
        height,
        color: this.options.theme.codeBackground,
        radius: 16,
      });
      this.current.commands.push({
        type: "text",
        text: `本地图片不可用：${block.alt}`,
        x: this.options.padding + this.options.baseFontSize,
        y: this.y + height / 2,
        font: font(this.options.baseFontSize, this.options.theme.fontFamily),
        color: this.options.theme.muted,
      });
      this.y += height + captionHeight;
      return;
    }

    const scale = Math.min(
      availableWidth / resolved.width,
      maxHeight / resolved.height,
      1,
    );
    const width = Math.max(1, Math.round(resolved.width * scale));
    const height = Math.max(1, Math.round(resolved.height * scale));
    this.ensureSpace(height + captionHeight, sectionIndex, block.line);
    const x = this.options.padding + (availableWidth - width) / 2;
    this.current.commands.push({
      type: "image",
      source: resolved.source,
      x,
      y: this.y,
      width,
      height,
    });
    this.y += height + Math.round(this.options.baseFontSize * 0.4);
    this.current.commands.push({
      type: "text",
      text: block.alt,
      x,
      y: this.y + this.options.baseFontSize,
      font: font(Math.round(this.options.baseFontSize * 0.72), this.options.theme.fontFamily),
      color: this.options.theme.muted,
    });
    this.y += captionHeight;
  }
}

export const buildMarkdownLayout = async (
  sections: MarkdownBlock[][],
  baseDiagnostics: readonly MarkdownDiagnostic[],
  options: MarkdownLayoutOptions,
): Promise<MarkdownLayout> => {
  checkAborted(options.signal);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建 Markdown 测量画布。");
  const diagnostics = baseDiagnostics.map((item) => ({ ...item }));
  const { resolved, ownedBitmaps } = await resolveImages(
    sections,
    options,
    diagnostics,
  );
  checkAborted(options.signal);
  const builder = new LayoutBuilder(context, options, diagnostics, resolved);
  sections.forEach((blocks, index) => builder.addSection(blocks, index));
  return {
    pages: builder.pages.length
      ? builder.pages
      : [{ commands: [], sourceSectionIndex: 0 }],
    diagnostics,
    ownedBitmaps,
  };
};

const roundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, safeRadius);
};

export const renderMarkdownPage = (
  page: MarkdownLayoutPage,
  options: MarkdownLayoutOptions,
  outputWidth: number,
  outputHeight: number,
) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(outputWidth));
  canvas.height = Math.max(1, Math.round(outputHeight));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("浏览器无法创建 Markdown 页面画布。");
  const scaleX = canvas.width / options.width;
  const scaleY = canvas.height / options.height;
  context.fillStyle = options.theme.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(scaleX, scaleY);
  context.fillStyle = options.theme.surface;
  context.fillRect(0, 0, options.width, options.height);
  context.beginPath();
  context.rect(0, 0, options.width, options.height);
  context.clip();
  context.textBaseline = "alphabetic";
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  for (const command of page.commands) {
    if (command.type === "text") {
      context.font = command.font;
      context.fillStyle = command.color;
      context.fillText(command.text, command.x, command.y, command.maxWidth);
    } else if (command.type === "fill") {
      context.fillStyle = command.color;
      if (command.radius) {
        roundedRect(
          context,
          command.x,
          command.y,
          command.width,
          command.height,
          command.radius,
        );
        context.fill();
      } else {
        context.fillRect(command.x, command.y, command.width, command.height);
      }
    } else if (command.type === "line") {
      context.beginPath();
      context.moveTo(command.x1, command.y1);
      context.lineTo(command.x2, command.y2);
      context.strokeStyle = command.color;
      context.lineWidth = command.width;
      context.stroke();
    } else {
      context.drawImage(
        command.source,
        command.x,
        command.y,
        command.width,
        command.height,
      );
    }
  }
  context.restore();
  return canvas;
};
