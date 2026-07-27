import type {
  MarkdownBlock,
  MarkdownDiagnostic,
  MarkdownInline,
  MarkdownMode,
  ParsedMarkdown,
} from "./types";

const MAX_SOURCE_LENGTH = 2_000_000;
const MAX_SECTIONS = 200;
const REMOTE_SCHEME = /^(?:https?:|data:|blob:|javascript:|vbscript:|file:|\\\\|\/\/)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const RAW_HTML = /<\/?(?:script|iframe|object|embed|style|link|meta|img|video|audio|svg|math|[a-z][\w-]*)\b[^>]*>/i;

export type ParseMarkdownOptions = {
  mode?: MarkdownMode;
};

export const isControlledLocalImageReference = (reference: string) => {
  const normalized = reference.trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return false;
  if (REMOTE_SCHEME.test(normalized) || ANY_SCHEME.test(normalized)) return false;
  if (normalized.startsWith("/") || normalized.startsWith("~")) return false;
  const cleanPath = normalized.split(/[?#]/, 1)[0];
  return cleanPath.split("/").every((segment) => segment !== "..");
};

const addDiagnostic = (
  diagnostics: MarkdownDiagnostic[],
  diagnostic: MarkdownDiagnostic,
) => {
  if (
    diagnostics.some(
      (existing) =>
        existing.code === diagnostic.code &&
        existing.line === diagnostic.line &&
        existing.reference === diagnostic.reference,
    )
  ) {
    return;
  }
  diagnostics.push(diagnostic);
};

const securityScan = (
  value: string,
  line: number,
  diagnostics: MarkdownDiagnostic[],
) => {
  if (RAW_HTML.test(value)) {
    addDiagnostic(diagnostics, {
      code: "RAW_HTML_AS_TEXT",
      severity: "warning",
      line,
      message: "原始 HTML 不会进入 DOM，已作为普通文本绘制。",
    });
  }
  if (/\b(?:javascript|vbscript)\s*:/i.test(value)) {
    addDiagnostic(diagnostics, {
      code: "UNSAFE_LINK_REJECTED",
      severity: "warning",
      line,
      message: "脚本型链接已禁用，只保留可见文本。",
    });
  }
};

const mergeStyle = (
  inlines: MarkdownInline[],
  style: Omit<MarkdownInline, "text">,
) =>
  inlines.map((inline) => ({
    ...inline,
    bold: inline.bold || style.bold || undefined,
    italic: inline.italic || style.italic || undefined,
    code: inline.code || style.code || undefined,
  }));

const pushPlain = (result: MarkdownInline[], text: string) => {
  if (!text) return;
  const previous = result.at(-1);
  if (previous && !previous.bold && !previous.italic && !previous.code) {
    previous.text += text;
  } else {
    result.push({ text });
  }
};

export const parseMarkdownInlines = (
  source: string,
  line: number,
  diagnostics: MarkdownDiagnostic[],
): MarkdownInline[] => {
  securityScan(source, line, diagnostics);
  const result: MarkdownInline[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const remaining = source.slice(cursor);
    const code = remaining.match(/^`([^`\n]+)`/);
    if (code) {
      result.push({ text: code[1], code: true });
      cursor += code[0].length;
      continue;
    }

    const strong = remaining.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)/);
    if (strong) {
      result.push(
        ...mergeStyle(parseMarkdownInlines(strong[1], line, diagnostics), {
          bold: true,
        }),
      );
      cursor += strong[0].length;
      continue;
    }

    const italic = remaining.match(/^(?:\*|_)([^*_\n]+?)(?:\*|_)/);
    if (italic) {
      result.push(
        ...mergeStyle(parseMarkdownInlines(italic[1], line, diagnostics), {
          italic: true,
        }),
      );
      cursor += italic[0].length;
      continue;
    }

    const image = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (image) {
      const reference = image[2].trim();
      addDiagnostic(diagnostics, {
        code: isControlledLocalImageReference(reference)
          ? "UNSUPPORTED_MARKDOWN"
          : "REMOTE_RESOURCE_REJECTED",
        severity: "warning",
        line,
        reference,
        message: isControlledLocalImageReference(reference)
          ? "行内图片暂不排版；请把图片语法单独放在一行。"
          : "远程、绝对路径或脚本图片已拒绝。",
      });
      pushPlain(result, `[图片：${image[1] || "未命名"}]`);
      cursor += image[0].length;
      continue;
    }

    const link = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (link) {
      const target = link[2].trim();
      if (REMOTE_SCHEME.test(target) || ANY_SCHEME.test(target)) {
        addDiagnostic(diagnostics, {
          code: /^(?:javascript|vbscript):/i.test(target)
            ? "UNSAFE_LINK_REJECTED"
            : "REMOTE_RESOURCE_REJECTED",
          severity: "warning",
          line,
          reference: target,
          message: "Markdown 链接不会打开或联网，已只保留链接文字。",
        });
        pushPlain(result, link[1]);
      } else {
        pushPlain(result, `${link[1]} (${target})`);
      }
      cursor += link[0].length;
      continue;
    }

    const escaped = remaining.match(/^\\([\\`*_{}\[\]()#+.!>|-])/);
    if (escaped) {
      pushPlain(result, escaped[1]);
      cursor += escaped[0].length;
      continue;
    }

    pushPlain(result, source[cursor]);
    cursor += 1;
  }

  return result.length ? result : [{ text: "" }];
};

const splitTableRow = (line: string) => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
};

const isTableDivider = (line: string) => {
  const cells = splitTableRow(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))
  );
};

const startsSpecialBlock = (line: string, nextLine: string | undefined) =>
  /^\s*(?:#{1,6}\s+|```|~~~|>\s?|[-+*]\s+|\d+[.)]\s+)/.test(line) ||
  /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line) ||
  /^\s*---\s*$/.test(line) ||
  (line.includes("|") && Boolean(nextLine && isTableDivider(nextLine)));

type NumberedLine = { value: string; line: number };

const splitSlides = (
  lines: NumberedLine[],
  diagnostics: MarkdownDiagnostic[],
) => {
  const sections: NumberedLine[][] = [[]];
  let fence: "```" | "~~~" | null = null;

  for (const entry of lines) {
    const fenceMatch = entry.value.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      const marker = fenceMatch[1] as "```" | "~~~";
      fence = fence === marker ? null : fence ?? marker;
    }
    if (!fence && /^\s*---\s*$/.test(entry.value)) {
      if (sections.length >= MAX_SECTIONS) {
        addDiagnostic(diagnostics, {
          code: "CONTENT_TRUNCATED",
          severity: "error",
          line: entry.line,
          message: `幻灯片最多支持 ${MAX_SECTIONS} 页，后续内容已截断。`,
        });
        break;
      }
      sections.push([]);
    } else {
      sections.at(-1)?.push(entry);
    }
  }
  return sections;
};

const parseSection = (
  lines: NumberedLine[],
  mode: MarkdownMode,
  diagnostics: MarkdownDiagnostic[],
) => {
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const current = lines[index];
    const value = current.value;
    if (!value.trim()) {
      index += 1;
      continue;
    }

    const fence = value.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      const startLine = current.line;
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[index].value)) {
        body.push(lines[index].value);
        index += 1;
      }
      if (index < lines.length) index += 1;
      else {
        addDiagnostic(diagnostics, {
          code: "UNSUPPORTED_MARKDOWN",
          severity: "warning",
          line: startLine,
          message: "代码块缺少结束围栏，已渲染到当前内容结尾。",
        });
      }
      blocks.push({
        type: "code",
        language: fence[2] || "text",
        value: body.join("\n"),
        line: startLine,
      });
      continue;
    }

    const image = value.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (image) {
      const reference = image[2].trim();
      if (isControlledLocalImageReference(reference)) {
        blocks.push({
          type: "image",
          alt: image[1].trim() || "本地图片",
          reference,
          line: current.line,
        });
      } else {
        addDiagnostic(diagnostics, {
          code: "REMOTE_RESOURCE_REJECTED",
          severity: "warning",
          line: current.line,
          reference,
          message: "仅允许由本地资源解析器提供的项目相对图片。",
        });
        blocks.push({
          type: "paragraph",
          inlines: [{ text: `[图片已拒绝：${image[1] || reference}]` }],
          line: current.line,
        });
      }
      index += 1;
      continue;
    }

    const heading = value.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inlines: parseMarkdownInlines(heading[2], current.line, diagnostics),
        line: current.line,
      });
      index += 1;
      continue;
    }

    const quote = value.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({
        type: "quote",
        inlines: parseMarkdownInlines(quote[1], current.line, diagnostics),
        line: current.line,
      });
      index += 1;
      continue;
    }

    const unordered = value.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = value.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (unordered || ordered) {
      blocks.push({
        type: "list-item",
        ordered: Boolean(ordered),
        ordinal: ordered ? Number(ordered[1]) : 0,
        inlines: parseMarkdownInlines(
          ordered ? ordered[2] : unordered?.[1] ?? "",
          current.line,
          diagnostics,
        ),
        line: current.line,
      });
      index += 1;
      continue;
    }

    if (value.includes("|") && lines[index + 1] && isTableDivider(lines[index + 1].value)) {
      const header = splitTableRow(value);
      const rows: string[][] = [];
      const startLine = current.line;
      index += 2;
      while (index < lines.length && lines[index].value.includes("|") && lines[index].value.trim()) {
        const row = splitTableRow(lines[index].value);
        rows.push(Array.from({ length: header.length }, (_, cell) => row[cell] ?? ""));
        index += 1;
      }
      blocks.push({ type: "table", table: { header, rows }, line: startLine });
      continue;
    }

    if (mode === "document" && /^\s*---\s*$/.test(value)) {
      blocks.push({ type: "rule", line: current.line });
      index += 1;
      continue;
    }

    const paragraphLines = [value.trim()];
    const startLine = current.line;
    index += 1;
    while (
      index < lines.length &&
      lines[index].value.trim() &&
      !startsSpecialBlock(lines[index].value, lines[index + 1]?.value)
    ) {
      paragraphLines.push(lines[index].value.trim());
      index += 1;
    }
    const paragraph = paragraphLines.join(" ");
    blocks.push({
      type: "paragraph",
      inlines: parseMarkdownInlines(paragraph, startLine, diagnostics),
      line: startLine,
    });
  }

  return blocks;
};

/**
 * A deliberately bounded Markdown subset for deterministic course frames.
 * This is not, and does not claim to be, a complete CommonMark parser.
 */
export const parseControlledMarkdown = (
  source: string,
  options: ParseMarkdownOptions = {},
): ParsedMarkdown => {
  const mode = options.mode ?? "document";
  const diagnostics: MarkdownDiagnostic[] = [];
  const normalized = String(source ?? "").replace(/\r\n?/g, "\n");
  const bounded = normalized.slice(0, MAX_SOURCE_LENGTH);
  if (bounded.length !== normalized.length) {
    diagnostics.push({
      code: "CONTENT_TRUNCATED",
      severity: "error",
      message: `Markdown 超过 ${MAX_SOURCE_LENGTH.toLocaleString()} 字符，超出部分已截断。`,
    });
  }

  const lines = bounded.split("\n").map((value, index) => ({
    value,
    line: index + 1,
  }));
  const rawSections =
    mode === "slides" ? splitSlides(lines, diagnostics) : [lines];
  const sections = rawSections.map((section) =>
    parseSection(section, mode, diagnostics),
  );

  return {
    mode,
    sections: sections.length ? sections : [[]],
    diagnostics,
  };
};
