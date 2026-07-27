import { useCallback, useEffect, useRef, useState } from "react";
import type { PresentationTool } from "../content/annotations";
import type { DocumentFitMode } from "./DocumentStage";
import "./DocumentToolbar.css";

export type DocumentToolbarProps = {
  tool: PresentationTool;
  fitMode: DocumentFitMode;
  disabled?: boolean;
  canUndo?: boolean;
  canClear?: boolean;
  className?: string;
  onToolChange: (tool: PresentationTool) => void;
  onUndo: () => void;
  onClear: () => void;
  onFitModeChange: (fitMode: DocumentFitMode) => void;
};

const TOOLS: ReadonlyArray<{
  id: PresentationTool;
  label: string;
  description: string;
}> = [
  { id: "pointer", label: "指针", description: "浏览内容，不添加批注" },
  { id: "laser", label: "激光笔", description: "临时指示并触发运镜" },
  { id: "pen", label: "画笔", description: "添加持久画笔批注" },
  { id: "highlighter", label: "荧光笔", description: "添加半透明重点标记" },
];

export function DocumentToolbar({
  tool,
  fitMode,
  disabled = false,
  canUndo = false,
  canClear = false,
  className = "",
  onToolChange,
  onUndo,
  onClear,
  onFitModeChange,
}: DocumentToolbarProps) {
  const [visible, setVisible] = useState(true);
  const [pinned, setPinned] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const hoveringRef = useRef(false);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(
    (delay = 1_600) => {
      clearHideTimer();
      if (pinned || hoveringRef.current) return;
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        setVisible(false);
      }, delay);
    },
    [clearHideTimer, pinned],
  );

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide(2_200);
  }, [scheduleHide]);

  useEffect(() => {
    setVisible(true);
    scheduleHide();
    return clearHideTimer;
  }, [clearHideTimer, fitMode, scheduleHide, tool]);

  useEffect(() => {
    if (pinned) {
      clearHideTimer();
      setVisible(true);
    } else {
      scheduleHide();
    }
  }, [clearHideTimer, pinned, scheduleHide]);

  if (!visible) {
    const activeLabel = TOOLS.find((item) => item.id === tool)?.label ?? "工具";
    return (
      <button
        className="document-toolbar-handle"
        type="button"
        onClick={reveal}
        onPointerEnter={reveal}
        aria-label={`显示文档讲解工具，当前为${activeLabel}`}
        title="显示讲解工具"
      >
        <span aria-hidden="true" />
        {activeLabel} · 工具
      </button>
    );
  }

  return (
    <div
      className={`document-toolbar ${className}`.trim()}
      role="toolbar"
      aria-label="文档讲解工具"
      aria-disabled={disabled}
      data-pinned={pinned}
      onPointerEnter={() => {
        hoveringRef.current = true;
        clearHideTimer();
      }}
      onPointerLeave={() => {
        hoveringRef.current = false;
        scheduleHide(900);
      }}
      onFocusCapture={clearHideTimer}
      onBlurCapture={() => scheduleHide(900)}
    >
      <div className="document-toolbar__group" role="group" aria-label="批注工具">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="document-toolbar__tool"
            data-tool={item.id}
            aria-pressed={tool === item.id}
            aria-label={`${item.label}：${item.description}`}
            title={item.description}
            disabled={disabled}
            onClick={() => {
              onToolChange(item.id);
              scheduleHide();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <span className="document-toolbar__divider" aria-hidden="true" />

      <div className="document-toolbar__group" role="group" aria-label="批注操作">
        <button
          type="button"
          aria-label="撤销当前页最后一条批注"
          title="撤销当前页最后一条批注"
          disabled={disabled || !canUndo}
          onClick={onUndo}
        >
          撤销
        </button>
        <button
          className="document-toolbar__clear"
          type="button"
          aria-label="清空当前页全部批注"
          title="清空当前页全部批注"
          disabled={disabled || !canClear}
          onClick={onClear}
        >
          清空
        </button>
      </div>

      <span className="document-toolbar__divider" aria-hidden="true" />

      <div
        className="document-toolbar__group document-toolbar__fit"
        role="group"
        aria-label="内容适配方式"
      >
        <button
          type="button"
          aria-pressed={fitMode === "contain"}
          aria-label="完整显示内容，允许留边"
          title="完整显示，允许留边"
          disabled={disabled}
          onClick={() => onFitModeChange("contain")}
        >
          完整显示
        </button>
        <button
          type="button"
          aria-pressed={fitMode === "cover"}
          aria-label="填满舞台，允许裁切"
          title="填满舞台，允许裁切"
          disabled={disabled}
          onClick={() => onFitModeChange("cover")}
        >
          填满
        </button>
      </div>

      <span className="document-toolbar__divider" aria-hidden="true" />

      <button
        className="document-toolbar__pin"
        type="button"
        aria-pressed={pinned}
        aria-label={pinned ? "取消固定工具栏" : "固定工具栏"}
        title={pinned ? "取消固定" : "固定工具栏"}
        onClick={() => setPinned((value) => !value)}
      >
        {pinned ? "已固定" : "固定"}
      </button>
    </div>
  );
}
