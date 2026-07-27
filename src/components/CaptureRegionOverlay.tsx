import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
} from "react";
import {
  clampCaptureRegion,
  type CaptureRegion,
} from "../core/outputProfile";
import "./CaptureRegionOverlay.css";

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type SizeDriver = "auto" | "width" | "height";

type Interaction = {
  pointerId: number;
  kind: "move" | "resize";
  handle?: ResizeHandle;
  startClientX: number;
  startClientY: number;
  startRegion: CaptureRegion;
  stageWidth: number;
  stageHeight: number;
};

export type CaptureRegionOverlayProps = {
  /** Rectangle coordinates are normalized to the editor stage (0..1). */
  region: CaptureRegion;
  /** Physical output width divided by output height. */
  aspectRatio: number;
  label: string;
  disabled?: boolean;
  onChange: (region: CaptureRegion) => void;
};

const HANDLES: readonly ResizeHandle[] = [
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
  "nw",
];

const HANDLE_DIRECTIONS: Record<ResizeHandle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
  nw: { x: -1, y: -1 },
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const safeAspectRatio = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

const fitAspectSize = (
  candidateWidth: number,
  candidateHeight: number,
  startWidth: number,
  startHeight: number,
  ratio: number,
  maximumWidth: number,
  maximumHeight: number,
  driver: SizeDriver,
) => {
  const maxHeight = Math.max(
    0,
    Math.min(maximumHeight, maximumWidth / ratio),
  );
  const minimumHeight = Math.min(
    maxHeight,
    Math.max(32, 48 / ratio),
  );

  let desiredHeight: number;
  if (driver === "width") {
    desiredHeight = candidateWidth / ratio;
  } else if (driver === "height") {
    desiredHeight = candidateHeight;
  } else {
    const horizontalChange = Math.abs(candidateWidth - startWidth);
    const verticalChange = Math.abs(candidateHeight - startHeight) * ratio;
    desiredHeight =
      horizontalChange >= verticalChange
        ? candidateWidth / ratio
        : candidateHeight;
  }

  const height = clamp(desiredHeight, minimumHeight, maxHeight);
  return { width: height * ratio, height };
};

const resizeRegion = (
  interaction: Interaction,
  handle: ResizeHandle,
  clientX: number,
  clientY: number,
  requestedAspectRatio: number,
): CaptureRegion => {
  const stageWidth = Math.max(1, interaction.stageWidth);
  const stageHeight = Math.max(1, interaction.stageHeight);
  const start = interaction.startRegion;
  const left = start.x * stageWidth;
  const top = start.y * stageHeight;
  const startWidth = start.width * stageWidth;
  const startHeight = start.height * stageHeight;
  const right = left + startWidth;
  const bottom = top + startHeight;
  const centerX = left + startWidth / 2;
  const centerY = top + startHeight / 2;
  const deltaX = clientX - interaction.startClientX;
  const deltaY = clientY - interaction.startClientY;
  const direction = HANDLE_DIRECTIONS[handle];
  const ratio = safeAspectRatio(
    requestedAspectRatio,
    startWidth / Math.max(1, startHeight),
  );

  let resizedLeft = left;
  let resizedTop = top;
  let resizedWidth = startWidth;
  let resizedHeight = startHeight;

  if (direction.x !== 0 && direction.y !== 0) {
    const fixedX = direction.x > 0 ? left : right;
    const fixedY = direction.y > 0 ? top : bottom;
    const maximumWidth = direction.x > 0 ? stageWidth - fixedX : fixedX;
    const maximumHeight = direction.y > 0 ? stageHeight - fixedY : fixedY;
    const size = fitAspectSize(
      startWidth + direction.x * deltaX,
      startHeight + direction.y * deltaY,
      startWidth,
      startHeight,
      ratio,
      maximumWidth,
      maximumHeight,
      "auto",
    );

    resizedWidth = size.width;
    resizedHeight = size.height;
    resizedLeft = direction.x > 0 ? fixedX : fixedX - resizedWidth;
    resizedTop = direction.y > 0 ? fixedY : fixedY - resizedHeight;
  } else if (direction.x !== 0) {
    const fixedX = direction.x > 0 ? left : right;
    const maximumWidth = direction.x > 0 ? stageWidth - fixedX : fixedX;
    const maximumHeight = 2 * Math.min(centerY, stageHeight - centerY);
    const size = fitAspectSize(
      startWidth + direction.x * deltaX,
      startHeight,
      startWidth,
      startHeight,
      ratio,
      maximumWidth,
      maximumHeight,
      "width",
    );

    resizedWidth = size.width;
    resizedHeight = size.height;
    resizedLeft = direction.x > 0 ? fixedX : fixedX - resizedWidth;
    resizedTop = centerY - resizedHeight / 2;
  } else {
    const fixedY = direction.y > 0 ? top : bottom;
    const maximumWidth = 2 * Math.min(centerX, stageWidth - centerX);
    const maximumHeight = direction.y > 0 ? stageHeight - fixedY : fixedY;
    const size = fitAspectSize(
      startWidth,
      startHeight + direction.y * deltaY,
      startWidth,
      startHeight,
      ratio,
      maximumWidth,
      maximumHeight,
      "height",
    );

    resizedWidth = size.width;
    resizedHeight = size.height;
    resizedLeft = centerX - resizedWidth / 2;
    resizedTop = direction.y > 0 ? fixedY : fixedY - resizedHeight;
  }

  return clampCaptureRegion({
    x: resizedLeft / stageWidth,
    y: resizedTop / stageHeight,
    width: resizedWidth / stageWidth,
    height: resizedHeight / stageHeight,
  });
};

export function CaptureRegionOverlay({
  region,
  aspectRatio,
  label,
  disabled = false,
  onChange,
}: CaptureRegionOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const safeRegion = clampCaptureRegion(region);

  const beginInteraction = (
    event: ReactPointerEvent<HTMLElement>,
    kind: Interaction["kind"],
    handle?: ResizeHandle,
  ) => {
    if (disabled || event.button !== 0) return;
    const overlayBounds = overlayRef.current?.getBoundingClientRect();
    if (!overlayBounds || overlayBounds.width <= 0 || overlayBounds.height <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    interactionRef.current = {
      pointerId: event.pointerId,
      kind,
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRegion: safeRegion,
      stageWidth: overlayBounds.width,
      stageHeight: overlayBounds.height,
    };
  };

  const updateInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    if (interaction.kind === "move") {
      const deltaX =
        (event.clientX - interaction.startClientX) / interaction.stageWidth;
      const deltaY =
        (event.clientY - interaction.startClientY) / interaction.stageHeight;
      onChange({
        ...interaction.startRegion,
        x: clamp(
          interaction.startRegion.x + deltaX,
          0,
          1 - interaction.startRegion.width,
        ),
        y: clamp(
          interaction.startRegion.y + deltaY,
          0,
          1 - interaction.startRegion.height,
        ),
      });
      return;
    }

    if (interaction.handle) {
      onChange(
        resizeRegion(
          interaction,
          interaction.handle,
          event.clientX,
          event.clientY,
          aspectRatio,
        ),
      );
    }
  };

  const endInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    onChange(interaction.startRegion);
    endInteraction(event);
  };

  const handleKeyboardMove = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const deltas: Partial<Record<typeof event.key, [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[event.key];
    if (!delta) return;

    event.preventDefault();
    event.stopPropagation();
    onChange({
      ...safeRegion,
      x: clamp(safeRegion.x + delta[0], 0, 1 - safeRegion.width),
      y: clamp(safeRegion.y + delta[1], 0, 1 - safeRegion.height),
    });
  };

  const interactionHandlers = {
    onPointerMove: updateInteraction,
    onPointerUp: endInteraction,
    onPointerCancel: cancelInteraction,
  };
  const selectionStyle: CSSProperties = {
    left: `${safeRegion.x * 100}%`,
    top: `${safeRegion.y * 100}%`,
    width: `${safeRegion.width * 100}%`,
    height: `${safeRegion.height * 100}%`,
  };

  return (
    <div
      ref={overlayRef}
      className="capture-region-overlay"
      data-disabled={disabled}
      data-recorder-overlay="capture-region"
      aria-disabled={disabled}
    >
      <div
        className="capture-region-overlay__selection"
        style={selectionStyle}
        role="group"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label}。拖动可移动选区，拖动控制点可调整大小。`}
        onKeyDown={handleKeyboardMove}
        onPointerDown={(event) => beginInteraction(event, "move")}
        {...interactionHandlers}
      >
        <span className="capture-region-overlay__label">{label}</span>
        {HANDLES.map((handle) => (
          <span
            key={handle}
            className="capture-region-overlay__handle"
            data-handle={handle}
            aria-hidden="true"
            onPointerDown={(event) =>
              beginInteraction(event, "resize", handle)
            }
            {...interactionHandlers}
          />
        ))}
      </div>
    </div>
  );
}
