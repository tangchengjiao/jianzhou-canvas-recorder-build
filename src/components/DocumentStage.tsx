import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { SourceFrame } from "../content/types";
import {
  clampNormalizedCoordinate,
  createAnnotationStrokeId,
  type AnnotationStroke,
  type NormalizedPoint,
  type PresentationTool,
} from "../content/annotations";
import "./DocumentStage.css";

export type DocumentFitMode = "contain" | "cover";

export type DocumentGesturePhase = "start" | "update" | "end" | "cancel";

export type DocumentGestureEvent = {
  phase: DocumentGesturePhase;
  /** Persistable stroke in page-v1 coordinates (or legacy stage-v1). */
  stroke: AnnotationStroke;
  /** Stage-normalized projection used only by cursor, laser and camera logic. */
  stageStroke: AnnotationStroke;
};

export type DocumentRenderFrame = {
  id: string;
  revision: number;
  width: number;
  height: number;
  stableLayers: readonly [HTMLCanvasElement, HTMLCanvasElement];
  transientLayer: HTMLCanvasElement;
};

export type DocumentStageHandle = {
  getRenderFrame: () => DocumentRenderFrame | null;
  clientToNormalized: (
    clientX: number,
    clientY: number,
    pressure?: number,
  ) => NormalizedPoint | null;
};

export type DocumentStageProps = {
  frame: SourceFrame | null;
  strokes: readonly AnnotationStroke[];
  tool: PresentationTool;
  fitMode: DocumentFitMode;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  onCommitStroke?: (stroke: AnnotationStroke) => void;
  /**
   * Emits the complete gesture lifecycle. Laser gestures are emitted here but
   * never passed to onCommitStroke, so callers can drive zoom/trails without
   * accidentally persisting them.
   */
  onGesture?: (event: DocumentGestureEvent) => void;
  /** Page-snapped navigation for long documents and static HTML decks. */
  onPageStep?: (direction: "previous" | "next") => void;
};

type CanvasSize = {
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
};

type ActiveGesture = {
  pointerId: number;
  stroke: AnnotationStroke;
};

export type DocumentDrawRect = {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  destinationX: number;
  destinationY: number;
  destinationWidth: number;
  destinationHeight: number;
};

const MAX_DPR = 2;
const MIN_POINT_DISTANCE = 0.0008;
const EMPTY_SIZE: CanvasSize = {
  width: 1,
  height: 1,
  cssWidth: 1,
  cssHeight: 1,
  dpr: 1,
};

const TOOL_STYLE: Record<
  Exclude<PresentationTool, "pointer">,
  Pick<AnnotationStroke, "color" | "width" | "opacity">
> = {
  laser: { color: "#ff2d55", width: 0.0065, opacity: 0.96 },
  pen: { color: "#e9384f", width: 0.0045, opacity: 0.96 },
  highlighter: { color: "#ffd84a", width: 0.022, opacity: 0.34 },
};

const finitePositive = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

const cloneStroke = (stroke: AnnotationStroke): AnnotationStroke => ({
  ...stroke,
  points: stroke.points.map((point) => ({ ...point })),
});

const getCanvasContext = (canvas: HTMLCanvasElement | null) =>
  canvas?.getContext("2d", { alpha: true }) ?? null;

const clearCanvas = (canvas: HTMLCanvasElement | null) => {
  const context = getCanvasContext(canvas);
  if (!context || !canvas) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
};

export const getDocumentDrawRect = (
  sourceWidth: number,
  sourceHeight: number,
  destinationWidth: number,
  destinationHeight: number,
  fitMode: DocumentFitMode,
): DocumentDrawRect => {
  const safeSourceWidth = finitePositive(sourceWidth, 1);
  const safeSourceHeight = finitePositive(sourceHeight, 1);
  const safeDestinationWidth = finitePositive(destinationWidth, 1);
  const safeDestinationHeight = finitePositive(destinationHeight, 1);
  const sourceAspect = safeSourceWidth / safeSourceHeight;
  const destinationAspect = safeDestinationWidth / safeDestinationHeight;

  if (fitMode === "cover") {
    if (sourceAspect > destinationAspect) {
      const visibleWidth = safeSourceHeight * destinationAspect;
      return {
        sourceX: (safeSourceWidth - visibleWidth) / 2,
        sourceY: 0,
        sourceWidth: visibleWidth,
        sourceHeight: safeSourceHeight,
        destinationX: 0,
        destinationY: 0,
        destinationWidth: safeDestinationWidth,
        destinationHeight: safeDestinationHeight,
      };
    }

    const visibleHeight = safeSourceWidth / destinationAspect;
    return {
      sourceX: 0,
      sourceY: (safeSourceHeight - visibleHeight) / 2,
      sourceWidth: safeSourceWidth,
      sourceHeight: visibleHeight,
      destinationX: 0,
      destinationY: 0,
      destinationWidth: safeDestinationWidth,
      destinationHeight: safeDestinationHeight,
    };
  }

  const scale = Math.min(
    safeDestinationWidth / safeSourceWidth,
    safeDestinationHeight / safeSourceHeight,
  );
  const fittedWidth = safeSourceWidth * scale;
  const fittedHeight = safeSourceHeight * scale;
  return {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: safeSourceWidth,
    sourceHeight: safeSourceHeight,
    destinationX: (safeDestinationWidth - fittedWidth) / 2,
    destinationY: (safeDestinationHeight - fittedHeight) / 2,
    destinationWidth: fittedWidth,
    destinationHeight: fittedHeight,
  };
};

type CanvasPoint = { x: number; y: number };

const pagePointToCanvas = (
  point: Pick<NormalizedPoint, "x" | "y">,
  drawRect: DocumentDrawRect,
  sourceWidth: number,
  sourceHeight: number,
): CanvasPoint => ({
  x:
    drawRect.destinationX +
    ((point.x * sourceWidth - drawRect.sourceX) / drawRect.sourceWidth) *
      drawRect.destinationWidth,
  y:
    drawRect.destinationY +
    ((point.y * sourceHeight - drawRect.sourceY) / drawRect.sourceHeight) *
      drawRect.destinationHeight,
});

const canvasPointToPage = (
  point: CanvasPoint,
  drawRect: DocumentDrawRect,
  sourceWidth: number,
  sourceHeight: number,
): Pick<NormalizedPoint, "x" | "y"> => ({
  x: clampNormalizedCoordinate(
    (drawRect.sourceX +
      ((point.x - drawRect.destinationX) / drawRect.destinationWidth) *
        drawRect.sourceWidth) /
      sourceWidth,
  ),
  y: clampNormalizedCoordinate(
    (drawRect.sourceY +
      ((point.y - drawRect.destinationY) / drawRect.destinationHeight) *
        drawRect.sourceHeight) /
      sourceHeight,
  ),
});

const drawStroke = (
  context: CanvasRenderingContext2D,
  stroke: AnnotationStroke,
  width: number,
  height: number,
  frame: SourceFrame,
  drawRect: DocumentDrawRect,
) => {
  const points = stroke.points;
  if (points.length === 0) return;

  const pageCoordinates = stroke.coordinateSpace === "page-v1";
  const toCanvasPoint = (point: NormalizedPoint) =>
    pageCoordinates
      ? pagePointToCanvas(point, drawRect, frame.width, frame.height)
      : { x: point.x * width, y: point.y * height };
  const pageScale = Math.min(
    drawRect.destinationWidth / drawRect.sourceWidth,
    drawRect.destinationHeight / drawRect.sourceHeight,
  );
  const shortEdge = Math.max(
    1,
    pageCoordinates
      ? Math.min(frame.width, frame.height) * pageScale
      : Math.min(width, height),
  );
  const lineWidth = Math.max(1, stroke.width * shortEdge);
  context.save();
  context.globalAlpha = Math.min(1, Math.max(0, stroke.opacity));
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (stroke.tool === "laser") {
    context.shadowColor = "rgba(255, 45, 85, 0.52)";
    context.shadowBlur = Math.max(5, lineWidth * 1.4);
  }

  if (points.length === 1) {
    const point = toCanvasPoint(points[0]);
    context.beginPath();
    context.arc(
      point.x,
      point.y,
      Math.max(1.5, lineWidth / 2),
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
    return;
  }

  const firstPoint = toCanvasPoint(points[0]);
  context.beginPath();
  context.moveTo(firstPoint.x, firstPoint.y);
  for (let index = 1; index < points.length; index += 1) {
    const previous = toCanvasPoint(points[index - 1]);
    const point = toCanvasPoint(points[index]);
    const midpointX = (previous.x + point.x) / 2;
    const midpointY = (previous.y + point.y) / 2;
    context.quadraticCurveTo(
      previous.x,
      previous.y,
      midpointX,
      midpointY,
    );
  }
  const lastPoint = toCanvasPoint(points[points.length - 1]);
  context.lineTo(lastPoint.x, lastPoint.y);
  context.stroke();
  context.restore();
};

const shouldAppendPoint = (
  points: readonly NormalizedPoint[],
  point: NormalizedPoint,
) => {
  const previous = points[points.length - 1];
  if (!previous) return true;
  return Math.hypot(point.x - previous.x, point.y - previous.y) >= MIN_POINT_DISTANCE;
};

export const DocumentStage = forwardRef<
  DocumentStageHandle,
  DocumentStageProps
>(function DocumentStage(
  {
    frame,
    strokes,
    tool,
    fitMode,
    disabled = false,
    className = "",
    ariaLabel = "文档讲解舞台",
    onCommitStroke,
    onGesture,
    onPageStep,
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const committedCanvasRef = useRef<HTMLCanvasElement>(null);
  const transientCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeGestureRef = useRef<ActiveGesture | null>(null);
  const frameRef = useRef(frame);
  const fitModeRef = useRef(fitMode);
  const commitCallbackRef = useRef(onCommitStroke);
  const gestureCallbackRef = useRef(onGesture);
  const revisionRef = useRef(0);
  const baseReadyRef = useRef(false);
  const wheelAccumulatorRef = useRef(0);
  const lastWheelStepRef = useRef(0);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>(EMPTY_SIZE);

  frameRef.current = frame;
  fitModeRef.current = fitMode;
  commitCallbackRef.current = onCommitStroke;
  gestureCallbackRef.current = onGesture;

  const updateCanvasSize = useCallback(() => {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const dpr = Math.min(
      MAX_DPR,
      Math.max(1, finitePositive(window.devicePixelRatio, 1)),
    );
    const next: CanvasSize = {
      width: Math.max(1, Math.round(bounds.width * dpr)),
      height: Math.max(1, Math.round(bounds.height * dpr)),
      cssWidth: bounds.width,
      cssHeight: bounds.height,
      dpr,
    };
    setCanvasSize((current) =>
      current.width === next.width &&
      current.height === next.height &&
      current.cssWidth === next.cssWidth &&
      current.cssHeight === next.cssHeight &&
      current.dpr === next.dpr
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    updateCanvasSize();
    const root = rootRef.current;
    if (!root) return;

    const observer = new ResizeObserver(updateCanvasSize);
    observer.observe(root);
    window.addEventListener("resize", updateCanvasSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateCanvasSize);
    };
  }, [updateCanvasSize]);

  useLayoutEffect(() => {
    const canvas = baseCanvasRef.current;
    const context = getCanvasContext(canvas);
    if (!canvas || !context) return;

    baseReadyRef.current = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f4f3f7";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!frame) {
      revisionRef.current += 1;
      return;
    }

    const drawRect = getDocumentDrawRect(
      frame.width,
      frame.height,
      canvas.width,
      canvas.height,
      fitMode,
    );
    if (fitMode === "contain") {
      context.save();
      context.shadowColor = "rgba(31, 27, 42, 0.18)";
      context.shadowBlur = Math.max(10, Math.min(canvas.width, canvas.height) * 0.018);
      context.shadowOffsetY = Math.max(3, canvas.height * 0.006);
      context.fillStyle = "#ffffff";
      context.fillRect(
        drawRect.destinationX,
        drawRect.destinationY,
        drawRect.destinationWidth,
        drawRect.destinationHeight,
      );
      context.restore();
    }

    try {
      context.drawImage(
        frame.source,
        drawRect.sourceX,
        drawRect.sourceY,
        drawRect.sourceWidth,
        drawRect.sourceHeight,
        drawRect.destinationX,
        drawRect.destinationY,
        drawRect.destinationWidth,
        drawRect.destinationHeight,
      );
      baseReadyRef.current = true;
    } catch {
      // A stale ImageBitmap can be closed while an adapter changes pages. The
      // next prepared SourceFrame revision redraws this layer safely.
      baseReadyRef.current = false;
    }
    revisionRef.current += 1;
  }, [canvasSize.height, canvasSize.width, fitMode, frame]);

  useLayoutEffect(() => {
    const canvas = committedCanvasRef.current;
    const context = getCanvasContext(canvas);
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame) {
      revisionRef.current += 1;
      return;
    }
    const drawRect = getDocumentDrawRect(
      frame.width,
      frame.height,
      canvas.width,
      canvas.height,
      fitMode,
    );
    for (const stroke of strokes) {
      if (stroke.tool === "laser") continue;
      drawStroke(
        context,
        stroke,
        canvas.width,
        canvas.height,
        frame,
        drawRect,
      );
    }
    revisionRef.current += 1;
  }, [canvasSize.height, canvasSize.width, fitMode, frame, strokes]);

  const pointFromClient = useCallback(
    (clientX: number, clientY: number, pressure = 0.5) => {
      const canvas = transientCanvasRef.current;
      const currentFrame = frameRef.current;
      const bounds = canvas?.getBoundingClientRect();
      if (
        !canvas ||
        !currentFrame ||
        !bounds ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) {
        return null;
      }
      const canvasPoint = {
        x: ((clientX - bounds.left) / bounds.width) * canvas.width,
        y: ((clientY - bounds.top) / bounds.height) * canvas.height,
      };
      const drawRect = getDocumentDrawRect(
        currentFrame.width,
        currentFrame.height,
        canvas.width,
        canvas.height,
        fitModeRef.current,
      );
      const insideVisibleContent =
        canvasPoint.x >= drawRect.destinationX &&
        canvasPoint.x <= drawRect.destinationX + drawRect.destinationWidth &&
        canvasPoint.y >= drawRect.destinationY &&
        canvasPoint.y <= drawRect.destinationY + drawRect.destinationHeight;
      if (!insideVisibleContent) return null;
      const pagePoint = canvasPointToPage(
        canvasPoint,
        drawRect,
        currentFrame.width,
        currentFrame.height,
      );
      return {
        ...pagePoint,
        pressure: Math.min(
          1,
          Math.max(0, Number.isFinite(pressure) ? pressure : 0.5),
        ),
        at: performance.now(),
      } satisfies NormalizedPoint;
    },
    [],
  );

  const drawTransientStroke = useCallback((stroke: AnnotationStroke | null) => {
    const canvas = transientCanvasRef.current;
    const context = getCanvasContext(canvas);
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const currentFrame = frameRef.current;
    if (!stroke || !currentFrame) return;
    const drawRect = getDocumentDrawRect(
      currentFrame.width,
      currentFrame.height,
      canvas.width,
      canvas.height,
      fitModeRef.current,
    );
    drawStroke(
      context,
      stroke,
      canvas.width,
      canvas.height,
      currentFrame,
      drawRect,
    );
  }, []);

  const emitGesture = useCallback(
    (phase: DocumentGesturePhase, stroke: AnnotationStroke) => {
      const persistableStroke = cloneStroke(stroke);
      const currentFrame = frameRef.current;
      const canvas = transientCanvasRef.current;
      let stageStroke = cloneStroke(stroke);
      if (
        persistableStroke.coordinateSpace === "page-v1" &&
        currentFrame &&
        canvas
      ) {
        const drawRect = getDocumentDrawRect(
          currentFrame.width,
          currentFrame.height,
          canvas.width,
          canvas.height,
          fitModeRef.current,
        );
        stageStroke = {
          ...persistableStroke,
          coordinateSpace: "stage-v1",
          points: persistableStroke.points.map((point) => {
            const canvasPoint = pagePointToCanvas(
              point,
              drawRect,
              currentFrame.width,
              currentFrame.height,
            );
            return {
              ...point,
              x: clampNormalizedCoordinate(canvasPoint.x / canvas.width),
              y: clampNormalizedCoordinate(canvasPoint.y / canvas.height),
            };
          }),
        };
      }
      gestureCallbackRef.current?.({
        phase,
        stroke: persistableStroke,
        stageStroke,
      });
    },
    [],
  );

  const endActiveGesture = useCallback(
    (phase: "end" | "cancel") => {
      const active = activeGestureRef.current;
      if (!active) return;
      activeGestureRef.current = null;
      drawTransientStroke(null);
      const finalStroke = cloneStroke(active.stroke);
      emitGesture(phase, finalStroke);
      if (
        phase === "end" &&
        (finalStroke.tool === "pen" || finalStroke.tool === "highlighter")
      ) {
        commitCallbackRef.current?.(finalStroke);
      }
    },
    [drawTransientStroke, emitGesture],
  );

  useEffect(() => {
    endActiveGesture("cancel");
  }, [disabled, endActiveGesture, frame?.id, frame?.pageIndex, tool]);

  useEffect(
    () => () => {
      activeGestureRef.current = null;
      clearCanvas(transientCanvasRef.current);
    },
    [],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      getRenderFrame: () => {
        const currentFrame = frameRef.current;
        const base = baseCanvasRef.current;
        const committed = committedCanvasRef.current;
        const transient = transientCanvasRef.current;
        if (
          !currentFrame ||
          !baseReadyRef.current ||
          !base ||
          !committed ||
          !transient ||
          base.width !== committed.width ||
          base.width !== transient.width ||
          base.height !== committed.height ||
          base.height !== transient.height
        ) {
          return null;
        }
        return {
          id: `${currentFrame.id}:${currentFrame.pageIndex}`,
          revision: currentFrame.revision * 1_000_000 + revisionRef.current,
          width: base.width,
          height: base.height,
          stableLayers: [base, committed] as const,
          transientLayer: transient,
        };
      },
      clientToNormalized: pointFromClient,
    }),
    [pointFromClient],
  );

  const appendPointerSamples = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    const active = activeGestureRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const nativeSamples =
      event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    const nextPoints = [...active.stroke.points];
    for (const sample of nativeSamples) {
      const point = pointFromClient(
        sample.clientX,
        sample.clientY,
        sample.pressure || 0.5,
      );
      if (point && shouldAppendPoint(nextPoints, point)) nextPoints.push(point);
    }
    if (nextPoints.length === active.stroke.points.length) return;
    active.stroke = { ...active.stroke, points: nextPoints };
    drawTransientStroke(active.stroke);
    emitGesture("update", active.stroke);
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (
      disabled ||
      !frame ||
      tool === "pointer" ||
      event.button !== 0 ||
      activeGestureRef.current
    ) {
      return;
    }
    const point = pointFromClient(
      event.clientX,
      event.clientY,
      event.pressure || 0.5,
    );
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const style = TOOL_STYLE[tool];
    const stroke: AnnotationStroke = {
      id: createAnnotationStrokeId(),
      pageIndex: frame.pageIndex,
      tool,
      ...style,
      coordinateSpace: "page-v1",
      points: [point],
      createdAt: Date.now(),
    };
    activeGestureRef.current = { pointerId: event.pointerId, stroke };
    drawTransientStroke(stroke);
    emitGesture("start", stroke);
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (!activeGestureRef.current) return;
    event.preventDefault();
    appendPointerSamples(event);
  };

  const finishPointer = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    phase: "end" | "cancel",
  ) => {
    const active = activeGestureRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (phase === "end") appendPointerSamples(event);
    endActiveGesture(phase);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.key !== "Escape" || !activeGestureRef.current) return;
    event.preventDefault();
    endActiveGesture("cancel");
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (
      disabled ||
      !frame ||
      frame.pageCount <= 1 ||
      !onPageStep ||
      activeGestureRef.current ||
      Math.abs(event.deltaY) <= Math.abs(event.deltaX)
    ) {
      return;
    }
    event.preventDefault();
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
    wheelAccumulatorRef.current += event.deltaY * multiplier;
    const now = performance.now();
    if (
      Math.abs(wheelAccumulatorRef.current) < 48 ||
      now - lastWheelStepRef.current < 420
    ) {
      return;
    }
    const direction = wheelAccumulatorRef.current > 0 ? "next" : "previous";
    wheelAccumulatorRef.current = 0;
    lastWheelStepRef.current = now;
    onPageStep(direction);
  };

  const canvasAttributes = {
    width: canvasSize.width,
    height: canvasSize.height,
  };
  const interactive = !disabled && Boolean(frame) && tool !== "pointer";

  return (
    <div
      ref={rootRef}
      className={`document-stage ${className}`.trim()}
      data-fit-mode={fitMode}
      data-tool={tool}
      data-disabled={disabled}
      data-source-width={frame?.width ?? 0}
      data-source-height={frame?.height ?? 0}
      data-source-orientation={
        frame ? (frame.height > frame.width ? "portrait" : "landscape") : "none"
      }
      role="application"
      aria-label={ariaLabel}
      onWheel={handleWheel}
    >
      <canvas
        ref={baseCanvasRef}
        className="document-stage__canvas document-stage__canvas--base"
        {...canvasAttributes}
        aria-hidden="true"
      />
      <canvas
        ref={committedCanvasRef}
        className="document-stage__canvas document-stage__canvas--committed"
        {...canvasAttributes}
        aria-hidden="true"
      />
      <canvas
        ref={transientCanvasRef}
        className="document-stage__canvas document-stage__canvas--transient"
        {...canvasAttributes}
        tabIndex={disabled ? -1 : 0}
        aria-label={
          interactive
            ? `${ariaLabel}，当前工具：${tool === "laser" ? "激光笔" : tool === "pen" ? "画笔" : "荧光笔"}`
            : `${ariaLabel}，当前为浏览模式`
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event, "end")}
        onPointerCancel={(event) => finishPointer(event, "cancel")}
        onLostPointerCapture={(event) => finishPointer(event, "cancel")}
        onKeyDown={handleKeyDown}
      />
      {!frame && (
        <div className="document-stage__empty" role="status">
          <strong>尚未载入讲解内容</strong>
          <span>请导入 PDF 或图片，或者返回 Excalidraw 白板。</span>
        </div>
      )}
    </div>
  );
});
