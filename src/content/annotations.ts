export type PresentationTool =
  | "pointer"
  | "laser"
  | "pen"
  | "highlighter";

/** A point normalized to the coordinate space declared by its stroke. */
export type NormalizedPoint = {
  x: number;
  y: number;
  /** Pointer pressure normalized to 0..1. Mouse input normally uses 0.5. */
  pressure: number;
  /** Monotonic timestamp from performance.now(), in milliseconds. */
  at: number;
};

/**
 * Legacy strokes were normalized to the complete stage. New strokes use the
 * full source page so they remain attached to document content when contain,
 * cover, window size or device pixel ratio changes.
 */
export type AnnotationCoordinateSpace = "stage-v1" | "page-v1";

export type AnnotationStroke = {
  id: string;
  /** Zero-based page index owned by the active content adapter. */
  pageIndex: number;
  /** Pointer never creates a stroke; laser strokes are intentionally transient. */
  tool: Exclude<PresentationTool, "pointer">;
  color: string;
  /** Line width as a fraction of the stage's shorter edge. */
  width: number;
  opacity: number;
  /** Missing values are legacy stage-v1 data from IndexedDB database v2. */
  coordinateSpace?: AnnotationCoordinateSpace;
  points: readonly NormalizedPoint[];
  createdAt: number;
};

export const clampNormalizedCoordinate = (value: number) =>
  Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

export const createAnnotationStrokeId = () => {
  const randomPart =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `annotation-${randomPart}`;
};
