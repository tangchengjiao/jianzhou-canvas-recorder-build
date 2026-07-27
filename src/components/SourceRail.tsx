import { useId } from "react";
import "./SourceRail.css";

export type SourceKind = "whiteboard" | "pdf" | "image" | "markdown" | "html";

export type SourceRailPage = {
  /** Stable id for React and document-session persistence. */
  id: string;
  /** One-based page number shown to the presenter. */
  pageNumber: number;
  label?: string;
  thumbnailUrl?: string;
  thumbnailStatus?: "ready" | "loading" | "error";
};

export type SourceRailProps = {
  sourceKind: SourceKind;
  fileName?: string;
  pages?: readonly SourceRailPage[];
  currentPage?: number;
  loading?: boolean;
  loadingLabel?: string;
  error?: string | null;
  collapsed: boolean;
  /** Backwards-compatible master lock. Prefer the two scoped locks below. */
  disabled?: boolean;
  importDisabled?: boolean;
  navigationDisabled?: boolean;
  className?: string;
  onCollapsedChange: (collapsed: boolean) => void;
  onImportPdf: () => void;
  onImportPresentation: () => void;
  onImportImages: () => void;
  onImportMarkdown: () => void;
  onImportHtml: () => void;
  onReturnToWhiteboard: () => void;
  onSelectPage: (pageNumber: number) => void;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
};

const SOURCE_LABELS: Record<SourceKind, string> = {
  whiteboard: "白板",
  pdf: "PDF",
  image: "图片",
  markdown: "Markdown",
  html: "HTML 演示",
};

const clampIndex = (index: number, pageCount: number) =>
  Math.min(Math.max(index, 0), Math.max(0, pageCount - 1));

const pageAccessibleLabel = (
  page: SourceRailPage,
  selected: boolean,
) => {
  const title = page.label ? `，${page.label}` : "";
  return `第 ${page.pageNumber} 页${title}${selected ? "，当前页" : ""}`;
};

export function SourceRail({
  sourceKind,
  fileName,
  pages = [],
  currentPage,
  loading = false,
  loadingLabel = "正在载入内容…",
  error,
  collapsed,
  disabled = false,
  importDisabled = false,
  navigationDisabled = false,
  className = "",
  onCollapsedChange,
  onImportPdf,
  onImportPresentation,
  onImportImages,
  onImportMarkdown,
  onImportHtml,
  onReturnToWhiteboard,
  onSelectPage,
  onPreviousPage,
  onNextPage,
}: SourceRailProps) {
  const titleId = useId();
  const sortedPages = [...pages].sort(
    (left, right) => left.pageNumber - right.pageNumber,
  );
  const requestedPage = currentPage ?? sortedPages[0]?.pageNumber;
  const selectedIndex = sortedPages.findIndex(
    (page) => page.pageNumber === requestedPage,
  );
  const safeSelectedIndex =
    selectedIndex >= 0 ? selectedIndex : clampIndex(0, sortedPages.length);
  const selectedPage = sortedPages[safeSelectedIndex];
  const canNavigate = sourceKind !== "whiteboard" && sortedPages.length > 0;
  const canGoPrevious = canNavigate && safeSelectedIndex > 0;
  const canGoNext =
    canNavigate && safeSelectedIndex < sortedPages.length - 1;
  const sourceLabel = SOURCE_LABELS[sourceKind];
  const displayName =
    sourceKind === "whiteboard"
      ? "Excalidraw 画布"
      : fileName?.trim() || `未命名${sourceLabel}内容`;

  const moveToPreviousPage = () => {
    if (!canGoPrevious) return;
    if (onPreviousPage) {
      onPreviousPage();
      return;
    }
    onSelectPage(sortedPages[safeSelectedIndex - 1].pageNumber);
  };

  const moveToNextPage = () => {
    if (!canGoNext) return;
    if (onNextPage) {
      onNextPage();
      return;
    }
    onSelectPage(sortedPages[safeSelectedIndex + 1].pageNumber);
  };

  return (
    <aside
      className={`source-rail ${className}`.trim()}
      data-collapsed={collapsed}
      data-source-kind={sourceKind}
      aria-labelledby={titleId}
      aria-busy={loading}
    >
      <header className="source-rail__header">
        <div className="source-rail__identity">
          <div className="source-rail__title-line">
            <h2 id={titleId}>讲解内容</h2>
            <span className="source-rail__kind">{sourceLabel}</span>
          </div>
          {!collapsed && <p title={displayName}>{displayName}</p>}
        </div>
        <button
          className="source-rail__collapse"
          type="button"
          onClick={() => onCollapsedChange(!collapsed)}
          aria-expanded={!collapsed}
          aria-controls={`${titleId}-content`}
          aria-label={collapsed ? "展开讲解内容侧栏" : "折叠讲解内容侧栏"}
        >
          {collapsed ? "内容" : "隐藏"}
        </button>
      </header>

      <div
        id={`${titleId}-content`}
        className="source-rail__content"
        hidden={collapsed}
      >
        <section className="source-rail__imports" aria-label="导入讲解内容">
          <button
            type="button"
            onClick={onImportPdf}
            disabled={disabled || importDisabled || loading}
          >
            导入 PDF
          </button>
          <button
            type="button"
            onClick={onImportImages}
            disabled={disabled || importDisabled || loading}
          >
            导入图片
          </button>
          <button
            className="source-rail__presentation-button"
            type="button"
            onClick={onImportPresentation}
            disabled={disabled || importDisabled || loading}
          >
            导入 PPT / PPTX
          </button>
          <button
            type="button"
            onClick={onImportMarkdown}
            disabled={disabled || importDisabled || loading}
          >
            导入 Markdown
          </button>
          <button
            type="button"
            onClick={onImportHtml}
            disabled={disabled || importDisabled || loading}
          >
            导入 HTML 演示
          </button>
          {sourceKind !== "whiteboard" && (
            <button
              className="source-rail__whiteboard-button"
              type="button"
              onClick={onReturnToWhiteboard}
              disabled={disabled || importDisabled || loading}
            >
              回到 Excalidraw 白板
            </button>
          )}
        </section>

        {(loading || error) && (
          <div className="source-rail__messages" aria-live="polite">
            {loading && (
              <p className="source-rail__loading" role="status">
                {loadingLabel}
              </p>
            )}
            {error && (
              <p className="source-rail__error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        {sourceKind === "whiteboard" ? (
          <section className="source-rail__empty" aria-label="当前内容源">
            <strong>自由讲解模式</strong>
            <p>当前使用 Excalidraw。可导入 PDF、图片、Markdown 或静态 HTML 演示；PPT/PPTX 会引导到静态 PDF 讲解链路。</p>
          </section>
        ) : (
          <section
            className="source-rail__pages"
            aria-label={`${sourceLabel}页面`}
          >
            <div className="source-rail__section-heading">
              <h3>{sourceKind === "image" ? "图片" : "页面"}</h3>
              <span>
                {selectedPage?.pageNumber ?? 0} / {sortedPages.length}
              </span>
            </div>

            {sortedPages.length > 0 ? (
              <ol className="source-rail__page-list">
                {sortedPages.map((page) => {
                  const selected = page.pageNumber === selectedPage?.pageNumber;
                  const thumbnailStatus =
                    page.thumbnailStatus ??
                    (page.thumbnailUrl ? "ready" : "loading");

                  return (
                    <li key={page.id}>
                      <button
                        className="source-rail__page-button"
                        type="button"
                        data-selected={selected}
                        aria-current={selected ? "page" : undefined}
                        aria-label={pageAccessibleLabel(page, selected)}
                        onClick={() => onSelectPage(page.pageNumber)}
                        disabled={disabled || navigationDisabled}
                      >
                        <span
                          className="source-rail__thumbnail"
                          data-state={thumbnailStatus}
                          aria-hidden="true"
                        >
                          {thumbnailStatus === "ready" && page.thumbnailUrl ? (
                            <img src={page.thumbnailUrl} alt="" draggable={false} />
                          ) : (
                            <span>
                              {thumbnailStatus === "error"
                                ? "预览失败"
                                : "生成中"}
                            </span>
                          )}
                        </span>
                        <span className="source-rail__page-copy">
                          <strong>第 {page.pageNumber} 页</strong>
                          <small>{page.label || "未命名页面"}</small>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="source-rail__no-pages" role="status">
                {loading ? "正在准备页面…" : "当前文件没有可显示的页面。"}
              </p>
            )}
          </section>
        )}
      </div>

      {!collapsed && sourceKind !== "whiteboard" && (
        <nav className="source-rail__pagination" aria-label="页面导航">
          <button
            type="button"
            onClick={moveToPreviousPage}
            disabled={disabled || navigationDisabled || loading || !canGoPrevious}
          >
            上一页
          </button>
          <output aria-live="polite" aria-atomic="true">
            第 {selectedPage?.pageNumber ?? 0} / {sortedPages.length} 页
          </output>
          <button
            type="button"
            onClick={moveToNextPage}
            disabled={disabled || navigationDisabled || loading || !canGoNext}
          >
            下一页
          </button>
        </nav>
      )}
    </aside>
  );
}
