export type DocumentPresentationMode = "document" | "slides";
export type DocumentPresentationOrientation = "landscape" | "portrait";
export type DocumentPresentationTheme = "paper" | "midnight" | "warm";

export type DocumentPresentationSettings = {
  mode: DocumentPresentationMode;
  orientation: DocumentPresentationOrientation;
  theme: DocumentPresentationTheme;
};

export const DEFAULT_DOCUMENT_PRESENTATION: DocumentPresentationSettings = {
  mode: "document",
  orientation: "landscape",
  theme: "paper",
};

export const parseDocumentPresentationSettings = (
  value: unknown,
): DocumentPresentationSettings | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DocumentPresentationSettings>;
  if (
    (candidate.mode !== "document" && candidate.mode !== "slides") ||
    (candidate.orientation !== "landscape" &&
      candidate.orientation !== "portrait") ||
    (candidate.theme !== "paper" &&
      candidate.theme !== "midnight" &&
      candidate.theme !== "warm")
  ) {
    return null;
  }
  return {
    mode: candidate.mode,
    orientation: candidate.orientation,
    theme: candidate.theme,
  };
};
