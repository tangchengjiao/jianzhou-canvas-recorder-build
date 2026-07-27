const STORAGE_KEY = "excalidraw-recorder:diagnostics:v1";
const MAX_ENTRIES = 180;

export type DiagnosticLevel = "info" | "warning" | "error";

export type DiagnosticEntry = {
  at: string;
  event: string;
  level: DiagnosticLevel;
  data?: Record<string, unknown>;
};

const safeData = (data?: Record<string, unknown>) => {
  if (!data) return undefined;
  try {
    return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  } catch {
    return { note: "诊断数据无法序列化" };
  }
};

export const readDiagnostics = (): DiagnosticEntry[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as DiagnosticEntry[]) : [];
  } catch {
    return [];
  }
};

export const recordDiagnostic = (
  event: string,
  data?: Record<string, unknown>,
  level: DiagnosticLevel = "info",
) => {
  const entry: DiagnosticEntry = {
    at: new Date().toISOString(),
    event,
    level,
    ...(data ? { data: safeData(data) } : {}),
  };

  try {
    const entries = [...readDiagnostics(), entry].slice(-MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Diagnostics must never interrupt drawing or recording.
  }
  return entry;
};

export const installGlobalDiagnostics = () => {
  const handleWindowError = (event: ErrorEvent) => {
    recordDiagnostic(
      "window.error",
      {
        name: event.error instanceof Error ? event.error.name : "Error",
        message:
          event.error instanceof Error ? event.error.message : event.message,
        source: event.filename ? event.filename.split("/").pop() : undefined,
        line: event.lineno || undefined,
      },
      "error",
    );
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    recordDiagnostic(
      "window.unhandledrejection",
      {
        name: reason instanceof Error ? reason.name : "UnknownRejection",
        message: reason instanceof Error ? reason.message : String(reason),
      },
      "error",
    );
  };

  window.addEventListener("error", handleWindowError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  recordDiagnostic("app.session", {
    secureContext: window.isSecureContext,
    online: navigator.onLine,
    hardwareConcurrency: navigator.hardwareConcurrency,
    language: navigator.language,
  });

  return () => {
    window.removeEventListener("error", handleWindowError);
    window.removeEventListener(
      "unhandledrejection",
      handleUnhandledRejection,
    );
  };
};

export const downloadDiagnostics = (extra?: Record<string, unknown>) => {
  const report = {
    exportedAt: new Date().toISOString(),
    app: "excalidraw-recorder",
    format: 1,
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      secureContext: window.isSecureContext,
      hardwareConcurrency: navigator.hardwareConcurrency,
    },
    extra: safeData(extra),
    entries: readDiagnostics(),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `excalidraw-recorder-diagnostics_${Date.now()}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
