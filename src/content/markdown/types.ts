export type MarkdownMode = "document" | "slides";

export type MarkdownPageOrientation = "landscape" | "portrait";

export type MarkdownThemeName = "paper" | "midnight" | "warm";

export type MarkdownDiagnosticSeverity = "info" | "warning" | "error";

export type MarkdownDiagnostic = {
  code:
    | "RAW_HTML_AS_TEXT"
    | "REMOTE_RESOURCE_REJECTED"
    | "UNSAFE_LINK_REJECTED"
    | "LOCAL_IMAGE_UNAVAILABLE"
    | "LOCAL_IMAGE_UNSUPPORTED"
    | "UNSUPPORTED_MARKDOWN"
    | "SLIDE_OVERFLOW"
    | "CONTENT_TRUNCATED";
  severity: MarkdownDiagnosticSeverity;
  message: string;
  line?: number;
  pageIndex?: number;
  reference?: string;
};

export type MarkdownInlineStyle = {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

export type MarkdownInline = MarkdownInlineStyle & {
  text: string;
};

export type MarkdownTable = {
  header: string[];
  rows: string[][];
};

export type MarkdownBlock =
  | { type: "heading"; level: number; inlines: MarkdownInline[]; line: number }
  | { type: "paragraph"; inlines: MarkdownInline[]; line: number }
  | {
      type: "list-item";
      ordered: boolean;
      ordinal: number;
      inlines: MarkdownInline[];
      line: number;
    }
  | { type: "quote"; inlines: MarkdownInline[]; line: number }
  | { type: "code"; language: string; value: string; line: number }
  | { type: "table"; table: MarkdownTable; line: number }
  | { type: "image"; alt: string; reference: string; line: number }
  | { type: "rule"; line: number };

export type ParsedMarkdown = {
  mode: MarkdownMode;
  sections: MarkdownBlock[][];
  diagnostics: MarkdownDiagnostic[];
};

export type MarkdownResolvedImage =
  | CanvasImageSource
  | Blob
  | null
  | undefined;

/**
 * Only controlled, project-relative references are passed to this resolver.
 * It must read from the caller's local project/asset store and must not fetch.
 */
export type MarkdownLocalImageResolver = (
  reference: string,
  context: { signal?: AbortSignal },
) => Promise<MarkdownResolvedImage> | MarkdownResolvedImage;

export type MarkdownTheme = {
  name: MarkdownThemeName;
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  codeBackground: string;
  fontFamily: string;
  monoFontFamily: string;
};

export type MarkdownLayoutOptions = {
  mode: MarkdownMode;
  width: number;
  height: number;
  orientation: MarkdownPageOrientation;
  theme: MarkdownTheme;
  padding: number;
  baseFontSize: number;
  lineHeight: number;
  signal?: AbortSignal;
  resolveLocalImage?: MarkdownLocalImageResolver;
};

export type MarkdownDrawCommand =
  | {
      type: "text";
      text: string;
      x: number;
      y: number;
      font: string;
      color: string;
      maxWidth?: number;
    }
  | {
      type: "fill";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      radius?: number;
    }
  | {
      type: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      width: number;
    }
  | {
      type: "image";
      source: CanvasImageSource;
      x: number;
      y: number;
      width: number;
      height: number;
    };

export type MarkdownLayoutPage = {
  commands: MarkdownDrawCommand[];
  sourceSectionIndex: number;
};

export type MarkdownLayout = {
  pages: MarkdownLayoutPage[];
  diagnostics: MarkdownDiagnostic[];
  ownedBitmaps: ImageBitmap[];
};
