import { isControlledLocalImageReference } from "./markdown/parser";
import type {
  MarkdownAdapterOptions,
  MarkdownDiagnostic,
} from "./markdownAdapter";
import { MarkdownContentAdapter } from "./markdownAdapter";
import type {
  ContentAdapter,
  ContentAdapterListener,
  ContentMetadata,
  ContentNavigationAction,
  FrameRequest,
  SourceFrame,
  ThumbnailRequest,
} from "./types";
import { ContentAdapterError, createContentId, throwIfAborted } from "./types";

export type SafeHtmlDiagnostic = {
  code:
    | "ACTIVE_CONTENT_REMOVED"
    | "REMOTE_RESOURCE_REJECTED"
    | "ATTRIBUTES_STRIPPED"
    | "CONTENT_TRUNCATED"
    | "NODE_LIMIT_REACHED";
  severity: "info" | "warning" | "error";
  message: string;
  count?: number;
  reference?: string;
};

export type SafeHtmlAdapterOptions = Omit<
  MarkdownAdapterOptions,
  "id" | "title"
> & {
  id?: string;
  title?: string;
};

const MAX_HTML_LENGTH = 2_000_000;
const MAX_HTML_NODES = 20_000;
const ACTIVE_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "button",
  "video",
  "audio",
  "source",
  "track",
  "link",
  "meta",
  "base",
  "template",
  "noscript",
  "svg",
  "math",
  "canvas",
]);

const escapeMarkdown = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+.!>|-])/g, "\\$1")
    .replace(/\s+/g, " ");

const normalizeText = (value: string | null | undefined) =>
  escapeMarkdown(value ?? "").trim();

const inlineContent = (
  node: Node,
  diagnostics: SafeHtmlDiagnostic[],
  visit: () => boolean,
): string => {
  if (!visit()) return "";
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdown(node.nodeValue ?? "");
  if (!(node instanceof Element)) return "";
  const tag = node.tagName.toLowerCase();
  if (ACTIVE_TAGS.has(tag)) return "";
  if (tag === "br") return "\n";
  if (tag === "img") {
    const reference = node.getAttribute("src")?.trim() ?? "";
    const alt = normalizeText(node.getAttribute("alt")) || "未命名";
    if (!isControlledLocalImageReference(reference)) {
      diagnostics.push({
        code: "REMOTE_RESOURCE_REJECTED",
        severity: "warning",
        message: "远程、绝对路径或脚本图片已拒绝。",
        reference,
      });
      return `[图片已拒绝：${alt}]`;
    }
    return `![${alt}](${reference})`;
  }
  const children = [...node.childNodes]
    .map((child) => inlineContent(child, diagnostics, visit))
    .join("");
  if (!children) return "";
  if (tag === "strong" || tag === "b") return `**${children}**`;
  if (tag === "em" || tag === "i") return `*${children}*`;
  if (tag === "code") return `\`${children.replace(/`/g, "\\`")}\``;
  // Links retain visible text only. No target is opened or followed.
  return children;
};

const directRows = (table: Element) =>
  [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")];

const tableToMarkdown = (
  table: Element,
  diagnostics: SafeHtmlDiagnostic[],
  visit: () => boolean,
) => {
  const rows = directRows(table)
    .map((row) =>
      [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) =>
        inlineContent(cell, diagnostics, visit).replace(/\|/g, "\\|"),
      ),
    )
    .filter((row) => row.length > 0);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? ""),
  );
  return [
    `| ${normalized[0].join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
};

const blockContent = (
  element: Element,
  diagnostics: SafeHtmlDiagnostic[],
  visit: () => boolean,
): string[] => {
  if (!visit()) return [];
  const tag = element.tagName.toLowerCase();
  if (ACTIVE_TAGS.has(tag)) return [];
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const value = inlineContent(element, diagnostics, visit);
    return value ? [`${"#".repeat(level)} ${value}`] : [];
  }
  if (tag === "hr") return ["---"];
  if (tag === "pre") {
    const value = (element.textContent ?? "").replace(/~~~/g, "~ ~ ~").trim();
    return value ? [`~~~text\n${value}\n~~~`] : [];
  }
  if (tag === "blockquote") {
    const value = inlineContent(element, diagnostics, visit);
    return value
      ? [value.split("\n").map((line) => `> ${line}`).join("\n")]
      : [];
  }
  if (tag === "table") {
    const value = tableToMarkdown(element, diagnostics, visit);
    return value ? [value] : [];
  }
  if (tag === "ul" || tag === "ol") {
    return [...element.children]
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((child, index) => {
        const value = inlineContent(child, diagnostics, visit);
        return value ? `${tag === "ol" ? `${index + 1}.` : "-"} ${value}` : "";
      })
      .filter(Boolean);
  }

  const blockTags = new Set([
    "p",
    "div",
    "section",
    "article",
    "main",
    "header",
    "footer",
    "aside",
    "figure",
    "figcaption",
    "address",
    "details",
    "summary",
  ]);
  if (blockTags.has(tag)) {
    const nestedBlocks = [...element.children].flatMap((child) =>
      blockContent(child, diagnostics, visit),
    );
    if (nestedBlocks.length) return nestedBlocks;
    const value = inlineContent(element, diagnostics, visit);
    return value ? [value] : [];
  }
  const value = inlineContent(element, diagnostics, visit);
  return value ? [value] : [];
};

export const convertSafeHtmlToMarkdown = (source: string) => {
  if (typeof DOMParser === "undefined") {
    throw new ContentAdapterError(
      "UNSUPPORTED_FORMAT",
      "Safe HTML conversion requires a browser DOM parser.",
    );
  }
  const diagnostics: SafeHtmlDiagnostic[] = [];
  const raw = String(source ?? "");
  const bounded = raw.slice(0, MAX_HTML_LENGTH);
  if (bounded.length !== raw.length) {
    diagnostics.push({
      code: "CONTENT_TRUNCATED",
      severity: "error",
      message: `HTML 超过 ${MAX_HTML_LENGTH.toLocaleString()} 字符，超出部分已截断。`,
    });
  }
  const document = new DOMParser().parseFromString(bounded, "text/html");
  const activeCount = document.querySelectorAll([...ACTIVE_TAGS].join(",")).length;
  if (activeCount) {
    diagnostics.push({
      code: "ACTIVE_CONTENT_REMOVED",
      severity: "warning",
      count: activeCount,
      message: `已移除 ${activeCount} 个脚本、嵌入、表单或其他活动内容节点。`,
    });
  }
  const attributed = [...document.body.querySelectorAll("*")].filter((element) =>
    [...element.attributes].some((attribute) =>
      /^(?:on|style$|srcset$|formaction$)/i.test(attribute.name),
    ),
  ).length;
  if (attributed) {
    diagnostics.push({
      code: "ATTRIBUTES_STRIPPED",
      severity: "info",
      count: attributed,
      message: `已忽略 ${attributed} 个元素上的样式或事件属性。`,
    });
  }

  let visited = 0;
  let limitReported = false;
  const visit = () => {
    visited += 1;
    if (visited <= MAX_HTML_NODES) return true;
    if (!limitReported) {
      limitReported = true;
      diagnostics.push({
        code: "NODE_LIMIT_REACHED",
        severity: "error",
        count: MAX_HTML_NODES,
        message: `HTML 节点超过 ${MAX_HTML_NODES.toLocaleString()} 个，后续内容已忽略。`,
      });
    }
    return false;
  };
  const blocks = [...document.body.children].flatMap((element) =>
    blockContent(element, diagnostics, visit),
  );
  return {
    markdown: blocks.filter(Boolean).join("\n\n") || "HTML 文件没有可显示的安全内容。",
    diagnostics,
  };
};

const inputToText = async (input: string | Blob | ArrayBuffer | Uint8Array) => {
  if (typeof input === "string") return input;
  if (input instanceof Blob) return input.text();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
};

const htmlFrame = (frame: SourceFrame): SourceFrame => ({
  ...frame,
  kind: "html",
});

/** Controlled static HTML: parsed to text/blocks, never inserted into the DOM. */
export class SafeHtmlContentAdapter implements ContentAdapter {
  readonly id: string;
  readonly kind = "html" as const;
  private readonly listeners = new Set<ContentAdapterListener>();
  private readonly htmlDiagnostics: SafeHtmlDiagnostic[];
  private readonly inner: MarkdownContentAdapter;
  private unsubscribeInner: (() => void) | null = null;

  private constructor(
    id: string,
    inner: MarkdownContentAdapter,
    diagnostics: SafeHtmlDiagnostic[],
  ) {
    this.id = id;
    this.inner = inner;
    this.htmlDiagnostics = diagnostics;
    this.unsubscribeInner = inner.subscribe(() => this.emit());
  }

  static async load(
    input: string | Blob | ArrayBuffer | Uint8Array,
    options: SafeHtmlAdapterOptions = {},
  ) {
    throwIfAborted(options.signal);
    const source = await inputToText(input);
    throwIfAborted(options.signal);
    const converted = convertSafeHtmlToMarkdown(source);
    const id = options.id ?? createContentId("html");
    const inner = await MarkdownContentAdapter.load(converted.markdown, {
      ...options,
      id: `${id}:safe-layout`,
      title: options.title ??
        (typeof File !== "undefined" && input instanceof File
          ? input.name
          : "未命名 HTML"),
    });
    return new SafeHtmlContentAdapter(id, inner, converted.diagnostics);
  }

  getMetadata(): Readonly<ContentMetadata> {
    const metadata = this.inner.getMetadata();
    return {
      ...metadata,
      id: this.id,
      kind: this.kind,
      mimeType: "text/html",
      details: {
        ...metadata.details,
        htmlMode: "controlled-static-v1",
        htmlWarningCount: String(
          this.htmlDiagnostics.filter((item) => item.severity !== "info").length,
        ),
      },
    };
  }

  getFrame() {
    const frame = this.inner.getFrame();
    return frame ? htmlFrame(frame) : null;
  }

  async prepareFrame(request?: FrameRequest) {
    return htmlFrame(await this.inner.prepareFrame(request));
  }

  async navigate(action: ContentNavigationAction) {
    return htmlFrame(await this.inner.navigate(action));
  }

  getThumbnail(pageIndex: number, request?: ThumbnailRequest) {
    return this.inner.getThumbnail(pageIndex, request);
  }

  getDiagnostics(): readonly (SafeHtmlDiagnostic | MarkdownDiagnostic)[] {
    return [
      ...this.htmlDiagnostics.map((item) => ({ ...item })),
      ...this.inner.getDiagnostics(),
    ];
  }

  subscribe(listener: ContentAdapterListener) {
    this.listeners.add(listener);
    listener(this.getMetadata());
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.unsubscribeInner?.();
    this.unsubscribeInner = null;
    this.listeners.clear();
    this.inner.dispose();
  }

  private emit() {
    const metadata = this.getMetadata();
    this.listeners.forEach((listener) => listener(metadata));
  }
}
