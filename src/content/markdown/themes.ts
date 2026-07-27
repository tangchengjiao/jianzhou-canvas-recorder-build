import type {
  MarkdownPageOrientation,
  MarkdownTheme,
  MarkdownThemeName,
} from "./types";

export const MARKDOWN_THEMES: Readonly<Record<MarkdownThemeName, MarkdownTheme>> = {
  paper: {
    name: "paper",
    background: "#f5f3ee",
    surface: "#ffffff",
    text: "#25232b",
    muted: "#6f6a76",
    accent: "#6558d3",
    border: "#d9d4df",
    codeBackground: "#f0edf5",
    fontFamily:
      'Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    monoFontFamily:
      '"SFMono-Regular", Consolas, "Liberation Mono", "Microsoft YaHei", monospace',
  },
  midnight: {
    name: "midnight",
    background: "#11131a",
    surface: "#191c26",
    text: "#f4f5fb",
    muted: "#a8adbd",
    accent: "#9f95ff",
    border: "#34394a",
    codeBackground: "#0d0f15",
    fontFamily:
      'Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    monoFontFamily:
      '"SFMono-Regular", Consolas, "Liberation Mono", "Microsoft YaHei", monospace',
  },
  warm: {
    name: "warm",
    background: "#efe5d7",
    surface: "#fffaf2",
    text: "#342a24",
    muted: "#7c6d61",
    accent: "#cb5c3f",
    border: "#e3cdb9",
    codeBackground: "#f5e8db",
    fontFamily:
      'Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    monoFontFamily:
      '"SFMono-Regular", Consolas, "Liberation Mono", "Microsoft YaHei", monospace',
  },
};

export const getMarkdownPageSize = (
  orientation: MarkdownPageOrientation,
  width?: number,
  height?: number,
) => {
  const defaults =
    orientation === "portrait"
      ? { width: 1_080, height: 1_440 }
      : { width: 1_600, height: 900 };
  const safeWidth = Math.min(
    4_096,
    Math.max(480, Math.round(Number.isFinite(width) ? (width as number) : defaults.width)),
  );
  const safeHeight = Math.min(
    4_096,
    Math.max(480, Math.round(Number.isFinite(height) ? (height as number) : defaults.height)),
  );
  return { width: safeWidth, height: safeHeight };
};
