import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./FloatingTeleprompter.css";

const STORAGE_KEY = "excalidraw-recorder:floating-teleprompter:v1";
const LEGACY_SCRIPT_KEY = "excalidraw-recorder:teleprompter-script";
const VIEWPORT_GAP = 12;
const DEFAULT_TOP_OFFSET = 76;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 220;
const MAX_WIDTH = 920;
const MAX_HEIGHT = 720;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 310;
const MINIMIZED_HEIGHT = 54;
const COMPACT_MIN_WIDTH = 220;
const COMPACT_MAX_WIDTH = 920;
const COMPACT_HEIGHT = 88;
const DEFAULT_COMPACT_WIDTH = 680;
const SPEED_MIN = 1;
const SPEED_MAX = 60;
const SPEED_SCALE = 0.25;
const DEFAULT_SPEED = 20;
const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 48;

type Geometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CompactGeometry = {
  x: number;
  y: number;
  width: number;
};

type PersistedState = Geometry & {
  script: string;
  speed: number;
  fontSize: number;
  opacity: number;
  compactOpacity: number;
  compactTextOpacity: number;
  compact: boolean;
  compactX: number;
  compactY: number;
  compactWidth: number;
  minimized: boolean;
};

type PointerSession = {
  kind: "drag" | "resize";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startGeometry: Geometry;
  compact: boolean;
  element: HTMLElement;
};

export type FloatingTeleprompterProps = {
  open: boolean;
  onClose: () => void;
  projectStateKey?: string | null;
  initialProjectState?: FloatingTeleprompterProjectState | null;
  onProjectStateChange?: (state: FloatingTeleprompterProjectState) => void;
};

export type FloatingTeleprompterProjectState = {
  text: string;
  scrollSpeed: number;
  opacity: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
};

const DEFAULT_SCRIPT =
  "在这里粘贴你的脚本……\n\n录制时，提词器只在监看界面显示，不会进入输出视频。你可以拖动标题栏，把文字放到更靠近镜头的位置。";

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

const viewportSize = () => ({
  width: Math.max(320, window.innerWidth),
  height: Math.max(240, window.innerHeight),
});

const topCenterGeometry = (
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  top = DEFAULT_TOP_OFFSET,
) => {
  const viewport = viewportSize();
  const fittedWidth = Math.min(width, viewport.width - VIEWPORT_GAP * 2);
  const fittedHeight = Math.min(
    height,
    viewport.height - top - VIEWPORT_GAP,
  );

  return {
    x: Math.round((viewport.width - fittedWidth) / 2),
    y: top,
    width: fittedWidth,
    height: fittedHeight,
  };
};

const clampGeometry = (
  geometry: Geometry,
  minimized: boolean,
): Geometry => {
  const viewport = viewportSize();
  const availableWidth = Math.max(280, viewport.width - VIEWPORT_GAP * 2);
  const availableHeight = Math.max(
    MINIMIZED_HEIGHT,
    viewport.height - VIEWPORT_GAP * 2,
  );
  const width = clamp(
    geometry.width,
    Math.min(MIN_WIDTH, availableWidth),
    Math.min(MAX_WIDTH, availableWidth),
  );
  const height = clamp(
    geometry.height,
    Math.min(MIN_HEIGHT, availableHeight),
    Math.min(MAX_HEIGHT, availableHeight),
  );
  const visibleHeight = minimized ? MINIMIZED_HEIGHT : height;

  return {
    x: clamp(geometry.x, VIEWPORT_GAP, viewport.width - width - VIEWPORT_GAP),
    y: clamp(
      geometry.y,
      VIEWPORT_GAP,
      viewport.height - visibleHeight - VIEWPORT_GAP,
    ),
    width,
    height,
  };
};

const centerCompactGeometry = (
  width = DEFAULT_COMPACT_WIDTH,
): CompactGeometry => {
  const viewport = viewportSize();
  const fittedWidth = Math.min(
    Math.max(COMPACT_MIN_WIDTH, width),
    viewport.width - VIEWPORT_GAP * 2,
  );
  return {
    x: Math.round((viewport.width - fittedWidth) / 2),
    y: Math.round((viewport.height - COMPACT_HEIGHT) / 2),
    width: fittedWidth,
  };
};

const clampCompactGeometry = (
  geometry: CompactGeometry,
): CompactGeometry => {
  const viewport = viewportSize();
  const availableWidth = Math.max(
    COMPACT_MIN_WIDTH,
    viewport.width - VIEWPORT_GAP * 2,
  );
  const width = clamp(
    geometry.width,
    Math.min(COMPACT_MIN_WIDTH, availableWidth),
    Math.min(COMPACT_MAX_WIDTH, availableWidth),
  );
  return {
    x: clamp(geometry.x, VIEWPORT_GAP, viewport.width - width - VIEWPORT_GAP),
    y: clamp(
      geometry.y,
      VIEWPORT_GAP,
      viewport.height - COMPACT_HEIGHT - VIEWPORT_GAP,
    ),
    width,
  };
};

const finiteNumber = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const loadState = (): PersistedState => {
  const geometry = topCenterGeometry();
  const compactGeometry = centerCompactGeometry();
  let legacyScript = DEFAULT_SCRIPT;
  try {
    legacyScript = localStorage.getItem(LEGACY_SCRIPT_KEY) ?? DEFAULT_SCRIPT;
  } catch {
    // Storage can be blocked in privacy-focused browser modes.
  }
  const fallback: PersistedState = {
    ...geometry,
    script: legacyScript,
    speed: DEFAULT_SPEED,
    fontSize: 28,
    opacity: 94,
    compactOpacity: 26,
    compactTextOpacity: 100,
    compact: false,
    compactX: compactGeometry.x,
    compactY: compactGeometry.y,
    compactWidth: compactGeometry.width,
    minimized: false,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const minimized = parsed.minimized === true;
    const restoredCompactGeometry = clampCompactGeometry({
      x: finiteNumber(parsed.compactX, compactGeometry.x),
      y: finiteNumber(parsed.compactY, compactGeometry.y),
      width: finiteNumber(parsed.compactWidth, compactGeometry.width),
    });
    const restoredGeometry = clampGeometry(
      {
        x: finiteNumber(parsed.x, geometry.x),
        y: finiteNumber(parsed.y, geometry.y),
        width: finiteNumber(parsed.width, geometry.width),
        height: finiteNumber(parsed.height, geometry.height),
      },
      minimized,
    );

    return {
      ...restoredGeometry,
      script: typeof parsed.script === "string" ? parsed.script : fallback.script,
      speed: clamp(
        finiteNumber(parsed.speed, fallback.speed),
        SPEED_MIN,
        SPEED_MAX,
      ),
      fontSize: clamp(
        finiteNumber(parsed.fontSize, fallback.fontSize),
        FONT_SIZE_MIN,
        FONT_SIZE_MAX,
      ),
      opacity: clamp(finiteNumber(parsed.opacity, fallback.opacity), 0, 100),
      compactOpacity: clamp(
        finiteNumber(parsed.compactOpacity, fallback.compactOpacity),
        0,
        70,
      ),
      compactTextOpacity: clamp(
        finiteNumber(
          parsed.compactTextOpacity,
          fallback.compactTextOpacity,
        ),
        0,
        100,
      ),
      compact: parsed.compact === true,
      compactX: restoredCompactGeometry.x,
      compactY: restoredCompactGeometry.y,
      compactWidth: restoredCompactGeometry.width,
      minimized: parsed.compact === true ? false : minimized,
    };
  } catch {
    return fallback;
  }
};

export function FloatingTeleprompter({
  open,
  onClose,
  projectStateKey,
  initialProjectState,
  onProjectStateChange,
}: FloatingTeleprompterProps) {
  const [state, setState] = useState<PersistedState>(loadState);
  const [playing, setPlaying] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pointerSessionRef = useRef<PointerSession | null>(null);

  useEffect(() => {
    if (!projectStateKey || !initialProjectState) return;
    setState((current) => ({
      ...current,
      ...clampGeometry(
        {
          x: initialProjectState.position.x,
          y: initialProjectState.position.y,
          width: initialProjectState.size.width,
          height: initialProjectState.size.height,
        },
        current.minimized,
      ),
      script: initialProjectState.text,
      speed: clamp(
        initialProjectState.scrollSpeed,
        SPEED_MIN,
        SPEED_MAX,
      ),
      opacity: clamp(initialProjectState.opacity * 100, 0, 100),
    }));
    // Project data is an initialization snapshot. Local edits after this point
    // flow outward through onProjectStateChange instead of being overwritten.
  }, [projectStateKey]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // The teleprompter still works when storage is unavailable.
      }
      onProjectStateChange?.({
        text: state.script,
        scrollSpeed: state.speed,
        opacity: state.opacity / 100,
        position: { x: state.x, y: state.y },
        size: { width: state.width, height: state.height },
      });
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [onProjectStateChange, state]);

  useEffect(() => {
    if (open) return;
    setPlaying(false);
    pointerSessionRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!playing || state.minimized || !open) return;

    let frameId = 0;
    let previousTime = performance.now();
    let accumulatedScrollTop = textareaRef.current?.scrollTop ?? 0;
    const pixelsPerSecond = state.speed * SPEED_SCALE;
    const scroll = (time: number) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const elapsedSeconds = Math.min(0.1, (time - previousTime) / 1_000);
      previousTime = time;
      // Keep our own sub-pixel position. Some textarea implementations round
      // scrollTop on read, which used to discard every slow (<16) frame.
      accumulatedScrollTop += pixelsPerSecond * elapsedSeconds;
      textarea.scrollTop = accumulatedScrollTop;

      const maximumScrollTop = Math.max(
        0,
        textarea.scrollHeight - textarea.clientHeight,
      );
      const reachedEnd = accumulatedScrollTop >= maximumScrollTop - 2;
      if (reachedEnd) {
        setPlaying(false);
        return;
      }

      frameId = requestAnimationFrame(scroll);
    };

    frameId = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frameId);
  }, [open, playing, state.minimized, state.speed]);

  useEffect(() => {
    if (!open || !state.compact) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !event.altKey || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setPlaying((current) => !current);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [open, state.compact]);

  useLayoutEffect(() => {
    const handleViewportResize = () => {
      setState((current) => ({
        ...current,
        ...clampGeometry(current, current.minimized),
        ...(() => {
          const compact = clampCompactGeometry({
            x: current.compactX,
            y: current.compactY,
            width: current.compactWidth,
          });
          return {
            compactX: compact.x,
            compactY: compact.y,
            compactWidth: compact.width,
          };
        })(),
      }));
    };

    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, []);

  const startPointerSession = (
    kind: PointerSession["kind"],
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0 || pointerSessionRef.current) return;
    if (
      kind === "drag" &&
      !state.compact &&
      (event.target as HTMLElement).closest("button, input, textarea, select")
    ) {
      return;
    }

    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    pointerSessionRef.current = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startGeometry: state.compact
        ? {
            x: state.compactX,
            y: state.compactY,
            width: state.compactWidth,
            height: COMPACT_HEIGHT,
          }
        : {
            x: state.x,
            y: state.y,
            width: state.width,
            height: state.height,
          },
      compact: state.compact,
      element,
    };
    event.preventDefault();
  };

  const movePointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - session.startClientX;
    const deltaY = event.clientY - session.startClientY;
    setState((current) => {
      if (session.compact) {
        const compact = clampCompactGeometry({
          x: session.startGeometry.x + deltaX,
          y: session.startGeometry.y + deltaY,
          width: session.startGeometry.width,
        });
        return {
          ...current,
          compactX: compact.x,
          compactY: compact.y,
          compactWidth: compact.width,
        };
      }
      let next: Geometry;
      if (session.kind === "drag") {
        next = {
          ...session.startGeometry,
          x: session.startGeometry.x + deltaX,
          y: session.startGeometry.y + deltaY,
        };
      } else {
        const viewport = viewportSize();
        const availableWidth =
          viewport.width - session.startGeometry.x - VIEWPORT_GAP;
        const availableHeight =
          viewport.height - session.startGeometry.y - VIEWPORT_GAP;
        next = {
          ...session.startGeometry,
          width: clamp(
            session.startGeometry.width + deltaX,
            Math.min(MIN_WIDTH, availableWidth),
            Math.min(MAX_WIDTH, availableWidth),
          ),
          height: clamp(
            session.startGeometry.height + deltaY,
            Math.min(MIN_HEIGHT, availableHeight),
            Math.min(MAX_HEIGHT, availableHeight),
          ),
        };
      }

      return {
        ...current,
        ...clampGeometry(next, current.minimized),
      };
    });
    event.preventDefault();
  };

  const endPointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    pointerSessionRef.current = null;
    if (session.element.hasPointerCapture(event.pointerId)) {
      session.element.releasePointerCapture(event.pointerId);
    }
  };

  const handleLostPointerCapture = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (pointerSessionRef.current?.pointerId === event.pointerId) {
      pointerSessionRef.current = null;
    }
  };

  const resetScroll = () => {
    setPlaying(false);
    if (textareaRef.current) textareaRef.current.scrollTop = 0;
  };

  const moveNearCamera = () => {
    setState((current) => ({
      ...current,
      ...clampGeometry(
        topCenterGeometry(current.width, current.height, VIEWPORT_GAP),
        current.minimized,
      ),
    }));
  };

  const toggleMinimized = () => {
    setPlaying(false);
    setState((current) => {
      const minimized = !current.minimized;
      return {
        ...current,
        minimized,
        ...clampGeometry(current, minimized),
      };
    });
  };

  const toggleCompact = () => {
    setPlaying(false);
    setState((current) => ({
      ...current,
      compact: !current.compact,
      minimized: false,
    }));
  };

  if (!open) return null;

  const panelStyle = {
    left: state.compact ? state.compactX : state.x,
    top: state.compact ? state.compactY : state.y,
    width: state.compact ? state.compactWidth : state.width,
    height: state.compact
      ? COMPACT_HEIGHT
      : state.minimized
        ? MINIMIZED_HEIGHT
        : state.height,
    "--teleprompter-opacity":
      (state.compact ? state.compactOpacity : state.opacity) / 100,
    "--teleprompter-text-opacity": state.compactTextOpacity / 100,
  } as CSSProperties;
  const effectivePixelsPerSecond = state.speed * SPEED_SCALE;
  const speedDescription =
    state.speed <= 8
      ? "极慢"
      : state.speed <= 20
        ? "舒缓"
        : state.speed <= 36
          ? "标准"
          : "快速";

  return (
    <aside
      className="floating-teleprompter"
      data-minimized={state.minimized}
      data-compact={state.compact}
      data-low-opacity={
        (state.compact ? state.compactOpacity : state.opacity) <= 45
      }
      data-background-clear={
        (state.compact ? state.compactOpacity : state.opacity) === 0
      }
      data-pointer-passthrough={state.compact}
      data-monitor-only="true"
      data-recording-exclude="true"
      style={panelStyle}
      aria-label="提词器（仅监看，不进入录制）"
    >
      {!state.compact && <header
        className="floating-teleprompter__titlebar"
        onPointerDown={(event) => startPointerSession("drag", event)}
        onPointerMove={movePointerSession}
        onPointerUp={endPointerSession}
        onPointerCancel={endPointerSession}
        onLostPointerCapture={handleLostPointerCapture}
      >
        <div className="floating-teleprompter__identity">
          <strong>提词器</strong>
          <span>仅监看 · 不进入录制</span>
        </div>

        <div className="floating-teleprompter__window-actions">
          <button type="button" onClick={moveNearCamera} title="移动到屏幕顶部中央">
            靠近镜头
          </button>
          <button
            type="button"
            onClick={toggleCompact}
            title="切换为可自由移动的双行字幕条"
          >
            精简阅读
          </button>
          <button
            className="floating-teleprompter__window-action"
            type="button"
            onClick={toggleMinimized}
            aria-label={state.minimized ? "展开提词器" : "最小化提词器"}
            title={state.minimized ? "展开" : "最小化"}
          >
            {state.minimized ? "展开" : "最小化"}
          </button>
          <button
            className="floating-teleprompter__window-action floating-teleprompter__close"
            type="button"
            onClick={onClose}
            aria-label="关闭提词器"
            title="关闭"
          >
            关闭
          </button>
        </div>
      </header>}

      {!state.minimized && !state.compact && (
        <>
          <div className="floating-teleprompter__controls">
            <button
              className="floating-teleprompter__play"
              type="button"
              onClick={() => setPlaying((current) => !current)}
            >
              {playing ? "暂停" : "播放"}
            </button>
            <button type="button" onClick={resetScroll}>
              回到开头
            </button>

            <label>
              <span>
                速度 {speedDescription} · {effectivePixelsPerSecond.toFixed(1)} px/s
              </span>
              <input
                type="range"
                min={SPEED_MIN}
                max={SPEED_MAX}
                step="1"
                value={state.speed}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    speed: Number(event.target.value),
                  }))
                }
                aria-label="滚动速度"
              />
            </label>

            <label>
              <span>字号 {state.fontSize}</span>
              <input
                type="range"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={state.fontSize}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    fontSize: Number(event.target.value),
                  }))
                }
                aria-label="文字大小"
              />
            </label>

            <label>
              <span>窗口背景 {state.opacity}%</span>
              <input
                type="range"
                min="0"
                max="100"
                value={state.opacity}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    opacity: Number(event.target.value),
                  }))
                }
                aria-label="完整窗口背景浓度"
              />
            </label>

            <label>
              <span>精简背景 {state.compactOpacity}%</span>
              <input
                type="range"
                min="0"
                max="70"
                value={state.compactOpacity}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    compactOpacity: Number(event.target.value),
                  }))
                }
                aria-label="精简阅读背景浓度"
              />
            </label>

            <label>
              <span>精简文字 {state.compactTextOpacity}%</span>
              <input
                type="range"
                min="0"
                max="100"
                value={state.compactTextOpacity}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    compactTextOpacity: Number(event.target.value),
                  }))
                }
                aria-label="精简阅读文字浓度"
              />
            </label>

            <label>
              <span>精简宽度 {Math.round(state.compactWidth)}</span>
              <input
                type="range"
                min={COMPACT_MIN_WIDTH}
                max={COMPACT_MAX_WIDTH}
                step="10"
                value={state.compactWidth}
                onChange={(event) =>
                  setState((current) => {
                    const compact = clampCompactGeometry({
                      x: current.compactX,
                      y: current.compactY,
                      width: Number(event.target.value),
                    });
                    return {
                      ...current,
                      compactX: compact.x,
                      compactY: compact.y,
                      compactWidth: compact.width,
                    };
                  })
                }
                aria-label="精简阅读字幕条宽度"
              />
            </label>
          </div>

          <textarea
            ref={textareaRef}
            className="floating-teleprompter__script"
            value={state.script}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                script: event.target.value,
              }))
            }
            readOnly={playing}
            spellCheck={false}
            style={{ fontSize: state.fontSize }}
            aria-label="提词器脚本"
            placeholder="在这里粘贴你的脚本……"
          />

          <div
            className="floating-teleprompter__resize-handle"
            role="separator"
            aria-label="调整提词器大小"
            aria-orientation="horizontal"
            onPointerDown={(event) => startPointerSession("resize", event)}
            onPointerMove={movePointerSession}
            onPointerUp={endPointerSession}
            onPointerCancel={endPointerSession}
            onLostPointerCapture={handleLostPointerCapture}
          >
            <span aria-hidden="true">缩放</span>
          </div>
        </>
      )}

      {state.compact && (
        <>
          <textarea
            ref={textareaRef}
            className="floating-teleprompter__compact-script"
            value={state.script}
            readOnly
            spellCheck={false}
            tabIndex={-1}
            style={{
              fontSize: Math.max(
                FONT_SIZE_MIN,
                Math.min(28, state.fontSize),
              ),
            }}
            aria-label="提词器双行阅读内容"
          />
          <div className="floating-teleprompter__compact-actions">
            <button
              type="button"
              className="floating-teleprompter__compact-drag"
              title="拖动字幕条"
              onPointerDown={(event) => startPointerSession("drag", event)}
              onPointerMove={movePointerSession}
              onPointerUp={endPointerSession}
              onPointerCancel={endPointerSession}
              onLostPointerCapture={handleLostPointerCapture}
            >
              移动
            </button>
            <button
              type="button"
              onClick={() => setPlaying((current) => !current)}
              title="播放或暂停（Alt + 空格）"
            >
              {playing ? "暂停" : "播放"}
            </button>
            <button type="button" onClick={toggleCompact} title="恢复完整提词器">
              完整
            </button>
            <button type="button" onClick={onClose} title="关闭提词器">
              关闭
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
