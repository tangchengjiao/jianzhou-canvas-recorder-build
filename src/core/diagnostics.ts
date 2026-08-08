const STORAGE_KEY = "excalidraw-recorder:diagnostics:v1";
const MAX_ENTRIES = 180;
const MAX_STRING_LENGTH = 240;
const MAX_ARRAY_LENGTH = 24;
const MAX_OBJECT_DEPTH = 5;

const PRIVATE_KEY_PATTERN =
  /(?:api[-_]?key|authorization|bearer|cookie|credential|password|private[-_]?key|secret|token)/i;
const IDENTIFYING_KEY_PATTERN =
  /^(?:deviceId|directoryName|executable|fileName|filename|folderName|language|path|platform|recordingFilename|screenshotPath|sessionId|source|userAgent)$/i;
const WINDOWS_PATH_PATTERN = /(?:file:\/\/\/)?[a-z]:[\\/][^\s"'<>]+/gi;
const UNC_PATH_PATTERN = /\\\\[^\\/\s]+[\\/][^\s"'<>]+/g;
const USER_HOME_PATTERN = /\/(?:Users|home)\/[^/\s"'<>]+(?:\/[^\s"'<>]+)*/g;
const URL_PATTERN = /\b(?:https?|file):\/\/[^\s"'<>]+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_VALUE_PATTERN =
  /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])-[-_A-Za-z0-9]{12,}\b/gi;

export type DiagnosticLevel = "info" | "warning" | "error";

export type DiagnosticEntry = {
  at: string;
  event: string;
  level: DiagnosticLevel;
  data?: Record<string, unknown>;
};

const sanitizeText = (value: string) =>
  value
    .replace(WINDOWS_PATH_PATTERN, "[本地路径已移除]")
    .replace(UNC_PATH_PATTERN, "[网络路径已移除]")
    .replace(USER_HOME_PATTERN, "[用户目录已移除]")
    .replace(URL_PATTERN, "[链接已移除]")
    .replace(EMAIL_PATTERN, "[邮箱已移除]")
    .replace(SECRET_VALUE_PATTERN, "[凭据已移除]")
    .slice(0, MAX_STRING_LENGTH);

const sanitizeValue = (value: unknown, depth: number): unknown => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") return sanitizeText(value);
  if (depth >= MAX_OBJECT_DEPTH) return "[内容过深，已省略]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value !== "object") return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_KEY_PATTERN.test(key) || IDENTIFYING_KEY_PATTERN.test(key)) {
      continue;
    }
    const sanitized = sanitizeValue(item, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
};

export const sanitizeDiagnosticData = (
  data?: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (!data) return undefined;
  try {
    return sanitizeValue(data, 0) as Record<string, unknown>;
  } catch {
    return { note: "诊断数据无法脱敏" };
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
    ...(data ? { data: sanitizeDiagnosticData(data) } : {}),
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
    format: 2,
    privacy: "sanitized",
    environment: {
      secureContext: window.isSecureContext,
    },
    extra: sanitizeDiagnosticData(extra),
    entries: readDiagnostics().map((entry) => ({
      at: entry.at,
      event: sanitizeText(entry.event),
      level: entry.level,
      ...(entry.data ? { data: sanitizeDiagnosticData(entry.data) } : {}),
    })),
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

export const clearDiagnostics = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Clearing support data must never interrupt the app.
  }
};
