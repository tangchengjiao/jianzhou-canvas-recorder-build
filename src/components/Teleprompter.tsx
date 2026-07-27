import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "excalidraw-recorder:teleprompter-script";

type TeleprompterProps = {
  onClose: () => void;
};

export function Teleprompter({ onClose }: TeleprompterProps) {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [script, setScript] = useState(() =>
    localStorage.getItem(STORAGE_KEY) ??
    "在此粘贴你的脚本…\n\n录制时，这个提词器只对你可见，不会出现在输出视频里。",
  );
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(34);
  const [opacity, setOpacity] = useState(92);
  const [fontSize, setFontSize] = useState(24);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, script);
  }, [script]);

  useEffect(() => {
    if (!playing) return;

    let frameId = 0;
    let previous = performance.now();
    const step = (now: number) => {
      const textArea = textAreaRef.current;
      if (!textArea) return;

      const deltaSeconds = Math.min(0.1, (now - previous) / 1_000);
      previous = now;
      textArea.scrollTop += speed * deltaSeconds;

      const reachedEnd =
        textArea.scrollTop + textArea.clientHeight >=
        textArea.scrollHeight - 2;
      if (reachedEnd) {
        setPlaying(false);
        return;
      }
      frameId = requestAnimationFrame(step);
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [playing, speed]);

  const reset = () => {
    setPlaying(false);
    if (textAreaRef.current) textAreaRef.current.scrollTop = 0;
  };

  return (
    <aside
      className="teleprompter"
      style={{ "--panel-opacity": `${opacity}%` } as React.CSSProperties}
      aria-label="提词器"
    >
      <div className="teleprompter__header">
        <div>
          <strong>提词器</strong>
          <span>仅你可见 · 不进入录制</span>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="关闭提词器"
        >
          关闭
        </button>
      </div>

      <div className="teleprompter__controls">
        <button
          className="prompt-play"
          type="button"
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? "暂停" : "播放"}
        </button>
        <button className="ghost-button" type="button" onClick={reset}>
          回到开头
        </button>
        <label>
          速度
          <input
            type="range"
            min="8"
            max="90"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
        </label>
      </div>

      <textarea
        ref={textAreaRef}
        className="teleprompter__script"
        value={script}
        onChange={(event) => setScript(event.target.value)}
        readOnly={playing}
        spellCheck={false}
        style={{ fontSize }}
        aria-label="提词器脚本"
      />

      <div className="teleprompter__footer">
        <label>
          字号 {fontSize}
          <input
            type="range"
            min="18"
            max="42"
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          />
        </label>
        <label>
          透明度 {opacity}%
          <input
            type="range"
            min="70"
            max="100"
            value={opacity}
            onChange={(event) => setOpacity(Number(event.target.value))}
          />
        </label>
      </div>
    </aside>
  );
}
