export type RecordingSinkState =
  | "idle"
  | "opening"
  | "open"
  | "finalizing"
  | "finalized"
  | "aborted"
  | "error";

export type RecordingSinkOpenOptions = {
  mimeType: string;
  sessionId?: string;
};

export type RecordingSinkStats = {
  kind: "memory" | "opfs";
  state: RecordingSinkState;
  sessionId: string | null;
  mimeType: string;
  bytesWritten: number;
  committedBytes: number;
  chunkCount: number;
  pendingWrites: number;
  peakPendingWrites: number;
  maxPendingWrites: number;
  elapsedMs: number;
  averageBytesPerSecond: number;
  actualBitrateBitsPerSecond: number;
  recoverableMetadata: boolean;
  lastError: string | null;
};

/**
 * A sink owns recording bytes after MediaRecorder emits them. Implementations
 * must serialize writes and reject when their bounded queue cannot keep up.
 */
export interface RecordingSink {
  open(options: RecordingSinkOpenOptions): Promise<void>;
  write(chunk: Blob): Promise<void>;
  finalize(): Promise<Blob>;
  abort(reason?: unknown): Promise<void>;
  stats(): RecordingSinkStats;
}

export class RecordingSinkUnavailableError extends Error {
  readonly code = "RECORDING_SINK_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "RecordingSinkUnavailableError";
  }
}

export class RecordingSinkBackpressureError extends Error {
  readonly code = "RECORDING_SINK_BACKPRESSURE";

  constructor(maxPendingWrites: number) {
    super(
      `Recording storage could not keep up (queue limit: ${maxPendingWrites} chunks).`,
    );
    this.name = "RecordingSinkBackpressureError";
  }
}

const toError = (value: unknown, fallback: string) => {
  if (value instanceof Error) return value;
  if (value instanceof DOMException) return new Error(value.message);
  return new Error(typeof value === "string" ? value : fallback);
};

const createSessionToken = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

class OrderedWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private writeFailure: Error | null = null;
  private admissionFailure: Error | null = null;
  private pending = 0;
  private peakPending = 0;

  constructor(private readonly maximumPendingWrites: number) {
    if (!Number.isInteger(maximumPendingWrites) || maximumPendingWrites < 1) {
      throw new RangeError("maxPendingWrites must be a positive integer.");
    }
  }

  reset() {
    if (this.pending !== 0) {
      throw new Error("Cannot reset a recording queue while writes are pending.");
    }
    this.tail = Promise.resolve();
    this.writeFailure = null;
    this.admissionFailure = null;
    this.peakPending = 0;
  }

  enqueue(operation: () => Promise<void> | void) {
    const existingFailure = this.failure;
    if (existingFailure) return Promise.reject(existingFailure);

    if (this.pending >= this.maximumPendingWrites) {
      const error = new RecordingSinkBackpressureError(
        this.maximumPendingWrites,
      );
      this.admissionFailure = error;
      return Promise.reject(error);
    }

    this.pending += 1;
    this.peakPending = Math.max(this.peakPending, this.pending);
    const queued = this.tail.then(async () => {
      if (this.writeFailure) throw this.writeFailure;
      try {
        await operation();
      } catch (error) {
        this.writeFailure = toError(error, "Recording storage write failed.");
        throw this.writeFailure;
      }
    });

    const accounted = queued.then(
      () => {
        this.pending -= 1;
      },
      (error) => {
        this.pending -= 1;
        throw error;
      },
    );
    // Keep the internal chain fulfilled so later operations can inspect the
    // stored failure instead of producing an unhandled rejection.
    this.tail = accounted.then(
      () => undefined,
      () => undefined,
    );
    return accounted;
  }

  async drain() {
    await this.tail;
    if (this.failure) throw this.failure;
  }

  async settle() {
    await this.tail;
  }

  get failure() {
    return this.writeFailure ?? this.admissionFailure;
  }

  get pendingWrites() {
    return this.pending;
  }

  get maxPendingWrites() {
    return this.maximumPendingWrites;
  }

  get peakPendingWrites() {
    return this.peakPending;
  }
}

const recordingRateStats = (bytes: number, openedAt: number) => {
  const elapsedMs = openedAt > 0 ? Math.max(1, Date.now() - openedAt) : 0;
  const averageBytesPerSecond =
    elapsedMs > 0 ? (bytes * 1_000) / elapsedMs : 0;
  return {
    elapsedMs,
    averageBytesPerSecond,
    actualBitrateBitsPerSecond: averageBytesPerSecond * 8,
  };
};

const assertWritableState = (state: RecordingSinkState) => {
  if (state !== "open") {
    throw new Error(`Recording sink is not writable (state: ${state}).`);
  }
};

export type MemoryRecordingSinkOptions = {
  maxPendingWrites?: number;
};

/** Short-recording compatibility sink. Bytes remain in memory until stop. */
export class MemoryRecordingSink implements RecordingSink {
  private readonly queue: OrderedWriteQueue;
  private state: RecordingSinkState = "idle";
  private chunks: Blob[] = [];
  private sessionId: string | null = null;
  private mimeType = "";
  private bytesWritten = 0;
  private chunkCount = 0;
  private lastError: Error | null = null;
  private openedAt = 0;

  constructor(options: MemoryRecordingSinkOptions = {}) {
    this.queue = new OrderedWriteQueue(options.maxPendingWrites ?? 32);
  }

  async open(options: RecordingSinkOpenOptions) {
    if (this.state === "open" || this.state === "finalizing") {
      throw new Error(`Recording sink is already active (state: ${this.state}).`);
    }
    this.queue.reset();
    this.state = "open";
    this.chunks = [];
    this.sessionId = options.sessionId ?? createSessionToken();
    this.mimeType = options.mimeType;
    this.bytesWritten = 0;
    this.chunkCount = 0;
    this.lastError = null;
    this.openedAt = Date.now();
  }

  write(chunk: Blob) {
    try {
      assertWritableState(this.state);
    } catch (error) {
      return Promise.reject(error);
    }
    if (chunk.size === 0) return Promise.resolve();

    const operation = this.queue.enqueue(() => {
      this.chunks.push(chunk);
      this.bytesWritten += chunk.size;
      this.chunkCount += 1;
    });
    void operation.catch((error) => this.captureFailure(error));
    return operation;
  }

  async finalize() {
    if (this.state !== "open" && this.state !== "error") {
      throw new Error(`Recording sink cannot finalize from ${this.state}.`);
    }
    this.state = "finalizing";
    try {
      await this.queue.drain();
      const result = new Blob(this.chunks, { type: this.mimeType });
      this.state = "finalized";
      return result;
    } catch (error) {
      this.captureFailure(error);
      throw this.lastError;
    }
  }

  async abort(reason?: unknown) {
    await this.queue.settle();
    if (reason) this.lastError = toError(reason, "Recording was aborted.");
    this.state = "aborted";
    this.chunks = [];
  }

  stats(): RecordingSinkStats {
    return {
      kind: "memory",
      state: this.state,
      sessionId: this.sessionId,
      mimeType: this.mimeType,
      bytesWritten: this.bytesWritten,
      committedBytes: this.state === "finalized" ? this.bytesWritten : 0,
      chunkCount: this.chunkCount,
      pendingWrites: this.queue.pendingWrites,
      peakPendingWrites: this.queue.peakPendingWrites,
      maxPendingWrites: this.queue.maxPendingWrites,
      ...recordingRateStats(this.bytesWritten, this.openedAt),
      recoverableMetadata: false,
      lastError: this.lastError?.message ?? null,
    };
  }

  private captureFailure(value: unknown) {
    this.lastError = toError(value, "Recording storage write failed.");
    this.state = "error";
  }
}

export type OPFSRecordingJournalStatus =
  | "writing"
  | "finalized"
  | "failed"
  | "aborted";

export type OPFSRecordingJournal = {
  schemaVersion: 1;
  sessionId: string;
  mimeType: string;
  status: OPFSRecordingJournalStatus;
  partFileName: string;
  journalFileName: string;
  bytesAccepted: number;
  committedBytes: number;
  chunkCount: number;
  /**
   * `pending-stream-close` is not crash-durable. `committed` means OPFS has a
   * readable byte file, not that an interrupted media container is playable.
   */
  durability: "pending-stream-close" | "committed";
  createdAt: string;
  updatedAt: string;
  error?: { name: string; message: string };
};

export type OPFSRecordingInspection = OPFSRecordingJournal & {
  actualFileBytes: number;
  partialDataAvailable: boolean;
};

export type RecordingStorageEstimate = {
  supported: boolean;
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  availableBytes: number | null;
};

export type OPFSRecordingSinkOptions = {
  maxPendingWrites?: number;
  directoryName?: string;
};

const DEFAULT_OPFS_DIRECTORY = "excalidraw-recorder-recordings";

/** Pure capability probe; it never requests permission or touches storage. */
export const canUseOPFSRecordingSink = () =>
  globalThis.isSecureContext === true &&
  typeof navigator !== "undefined" &&
  typeof navigator.storage?.getDirectory === "function";

/**
 * Long recordings use bounded OPFS streaming whenever the runtime exposes it.
 * Memory remains an explicit compatibility fallback for unsupported browsers,
 * tests, and very short captures; an OPFS open/write failure is never silently
 * converted into an unbounded in-memory session.
 */
export const createPreferredRecordingSink = (): RecordingSink =>
  canUseOPFSRecordingSink()
    ? new OPFSRecordingSink()
    : new MemoryRecordingSink();

const getOPFSDirectory = async (directoryName: string) => {
  if (globalThis.isSecureContext !== true) {
    throw new RecordingSinkUnavailableError(
      "OPFS recording requires a secure context (localhost or the desktop app).",
    );
  }
  if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
    throw new RecordingSinkUnavailableError(
      "This browser does not support Origin Private File System recording.",
    );
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(directoryName, { create: true });
};

const sanitizeSessionId = (value: string) => {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  return safe || createSessionToken();
};

const isSafeJournalReference = (journal: OPFSRecordingJournal) =>
  journal.sessionId === sanitizeSessionId(journal.sessionId) &&
  journal.partFileName === `${journal.sessionId}.part` &&
  journal.journalFileName === `${journal.sessionId}.journal.json`;

const serializeError = (value: unknown) => {
  const error = toError(value, "Recording storage failed.");
  return { name: error.name, message: error.message };
};

/**
 * Bounded, sequential OPFS sink. The writable stream stays open for efficient
 * long writes and is closed on finalize/orderly failure. A browser or process
 * crash before close may leave only the journal; no playable recovery is
 * promised for an unfinalized media container.
 */
export class OPFSRecordingSink implements RecordingSink {
  private readonly queue: OrderedWriteQueue;
  private readonly directoryName: string;
  private state: RecordingSinkState = "idle";
  private directory: FileSystemDirectoryHandle | null = null;
  private partHandle: FileSystemFileHandle | null = null;
  private journalHandle: FileSystemFileHandle | null = null;
  private writable: FileSystemWritableFileStream | null = null;
  private sessionId: string | null = null;
  private mimeType = "";
  private partFileName = "";
  private journalFileName = "";
  private bytesWritten = 0;
  private committedBytes = 0;
  private chunkCount = 0;
  private createdAt = "";
  private lastError: Error | null = null;
  private failurePersistence: Promise<void> | null = null;
  private openedAt = 0;

  constructor(options: OPFSRecordingSinkOptions = {}) {
    this.queue = new OrderedWriteQueue(options.maxPendingWrites ?? 8);
    this.directoryName = options.directoryName ?? DEFAULT_OPFS_DIRECTORY;
  }

  async open(options: RecordingSinkOpenOptions) {
    if (this.state === "open" || this.state === "finalizing") {
      throw new Error(`Recording sink is already active (state: ${this.state}).`);
    }
    await this.failurePersistence;
    this.queue.reset();
    this.resetSessionFields();
    this.state = "opening";
    this.sessionId = sanitizeSessionId(
      options.sessionId ?? `recording-${Date.now()}-${createSessionToken()}`,
    );
    this.mimeType = options.mimeType;
    this.partFileName = `${this.sessionId}.part`;
    this.journalFileName = `${this.sessionId}.journal.json`;
    this.createdAt = new Date().toISOString();
    this.openedAt = Date.now();

    try {
      this.directory = await getOPFSDirectory(this.directoryName);
      this.partHandle = await this.directory.getFileHandle(this.partFileName, {
        create: true,
      });
      this.journalHandle = await this.directory.getFileHandle(
        this.journalFileName,
        { create: true },
      );
      this.writable = await this.partHandle.createWritable({
        keepExistingData: false,
      });
      await this.writeJournal("writing", "pending-stream-close");
      this.state = "open";
    } catch (error) {
      this.captureFailure(error);
      // captureFailure owns close + final journal persistence. Running those
      // operations again here would race two createWritable() calls against
      // the same journal file.
      await this.failurePersistence;
      throw this.lastError;
    }
  }

  write(chunk: Blob) {
    try {
      assertWritableState(this.state);
    } catch (error) {
      return Promise.reject(error);
    }
    if (chunk.size === 0) return Promise.resolve();

    const operation = this.queue.enqueue(async () => {
      if (!this.writable) throw new Error("OPFS writable stream is unavailable.");
      await this.writable.write(chunk);
      this.bytesWritten += chunk.size;
      this.chunkCount += 1;
      await this.writeJournal("writing", "pending-stream-close");
    });
    void operation.catch((error) => this.captureFailure(error));
    return operation;
  }

  async finalize() {
    if (this.state !== "open" && this.state !== "error") {
      throw new Error(`Recording sink cannot finalize from ${this.state}.`);
    }
    if (this.state === "error") {
      await this.failurePersistence;
      throw this.lastError ?? new Error("OPFS recording storage failed.");
    }

    this.state = "finalizing";
    try {
      await this.queue.drain();
      await this.closeAndCommit();
      const file = await this.requirePartHandle().getFile();
      this.committedBytes = file.size;
      await this.writeJournal("finalized", "committed");
      this.state = "finalized";
      // slice() supplies the negotiated media type without copying the file
      // into a recorder-owned Blob[] or retaining every MediaRecorder chunk.
      return file.slice(0, file.size, this.mimeType);
    } catch (error) {
      this.captureFailure(error);
      await this.failurePersistence;
      throw this.lastError;
    }
  }

  async abort(reason?: unknown) {
    await this.queue.settle();
    if (reason) this.lastError = toError(reason, "Recording was aborted.");
    try {
      await this.closeAndCommit();
      await this.refreshCommittedBytes();
      await this.writeJournal(
        this.lastError ? "failed" : "aborted",
        "committed",
        this.lastError,
      );
    } catch (error) {
      this.lastError ??= toError(error, "Could not close OPFS recording data.");
    }
    this.state = this.lastError ? "error" : "aborted";
  }

  stats(): RecordingSinkStats {
    return {
      kind: "opfs",
      state: this.state,
      sessionId: this.sessionId,
      mimeType: this.mimeType,
      bytesWritten: this.bytesWritten,
      committedBytes: this.committedBytes,
      chunkCount: this.chunkCount,
      pendingWrites: this.queue.pendingWrites,
      peakPendingWrites: this.queue.peakPendingWrites,
      maxPendingWrites: this.queue.maxPendingWrites,
      ...recordingRateStats(this.bytesWritten, this.openedAt),
      recoverableMetadata:
        this.committedBytes > 0 &&
        (this.state === "error" || this.state === "aborted"),
      lastError: this.lastError?.message ?? null,
    };
  }

  private captureFailure(value: unknown) {
    this.lastError ??= toError(value, "OPFS recording storage failed.");
    this.state = "error";
    if (!this.failurePersistence) {
      this.failurePersistence = (async () => {
        await this.queue.settle();
        await this.closeAndCommit().catch(() => undefined);
        await this.refreshCommittedBytes().catch(() => undefined);
        await this.writeJournal(
          "failed",
          "committed",
          this.lastError,
        ).catch(() => undefined);
      })();
    }
  }

  private async closeAndCommit() {
    const writable = this.writable;
    this.writable = null;
    if (writable) await writable.close();
  }

  private async refreshCommittedBytes() {
    if (!this.partHandle) return;
    this.committedBytes = (await this.partHandle.getFile()).size;
  }

  private requirePartHandle() {
    if (!this.partHandle) throw new Error("OPFS recording file is unavailable.");
    return this.partHandle;
  }

  private async writeJournal(
    status: OPFSRecordingJournalStatus,
    durability: OPFSRecordingJournal["durability"],
    error?: unknown,
  ) {
    if (!this.journalHandle || !this.sessionId) return;
    const now = new Date().toISOString();
    const journal: OPFSRecordingJournal = {
      schemaVersion: 1,
      sessionId: this.sessionId,
      mimeType: this.mimeType,
      status,
      partFileName: this.partFileName,
      journalFileName: this.journalFileName,
      bytesAccepted: this.bytesWritten,
      committedBytes: this.committedBytes,
      chunkCount: this.chunkCount,
      durability,
      createdAt: this.createdAt,
      updatedAt: now,
      ...(error ? { error: serializeError(error) } : {}),
    };
    const writer = await this.journalHandle.createWritable({
      keepExistingData: false,
    });
    try {
      await writer.write(JSON.stringify(journal));
      await writer.close();
    } catch (writeError) {
      await writer.abort(writeError).catch(() => undefined);
      throw writeError;
    }
  }

  private resetSessionFields() {
    this.directory = null;
    this.partHandle = null;
    this.journalHandle = null;
    this.writable = null;
    this.sessionId = null;
    this.mimeType = "";
    this.partFileName = "";
    this.journalFileName = "";
    this.bytesWritten = 0;
    this.committedBytes = 0;
    this.chunkCount = 0;
    this.createdAt = "";
    this.lastError = null;
    this.failurePersistence = null;
    this.openedAt = 0;
  }
}

const isJournal = (value: unknown): value is OPFSRecordingJournal => {
  if (!value || typeof value !== "object") return false;
  const journal = value as Partial<OPFSRecordingJournal>;
  return (
    journal.schemaVersion === 1 &&
    typeof journal.sessionId === "string" &&
    typeof journal.partFileName === "string" &&
    typeof journal.journalFileName === "string" &&
    typeof journal.mimeType === "string" &&
    (journal.status === "writing" ||
      journal.status === "finalized" ||
      journal.status === "failed" ||
      journal.status === "aborted") &&
    typeof journal.bytesAccepted === "number" &&
    Number.isFinite(journal.bytesAccepted) &&
    journal.bytesAccepted >= 0 &&
    typeof journal.committedBytes === "number" &&
    Number.isFinite(journal.committedBytes) &&
    journal.committedBytes >= 0 &&
    typeof journal.chunkCount === "number" &&
    Number.isInteger(journal.chunkCount) &&
    journal.chunkCount >= 0 &&
    (journal.durability === "pending-stream-close" ||
      journal.durability === "committed") &&
    typeof journal.createdAt === "string" &&
    !Number.isNaN(Date.parse(journal.createdAt)) &&
    typeof journal.updatedAt === "string" &&
    !Number.isNaN(Date.parse(journal.updatedAt))
  );
};

export const estimateRecordingStorage = async (): Promise<RecordingStorageEstimate> => {
  if (!canUseOPFSRecordingSink()) {
    return {
      supported: false,
      persisted: null,
      usageBytes: null,
      quotaBytes: null,
      availableBytes: null,
    };
  }

  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate?.().catch(() => ({} as StorageEstimate)) ??
      Promise.resolve({} as StorageEstimate),
    navigator.storage.persisted?.().catch(() => false) ?? Promise.resolve(false),
  ]);
  const usageBytes =
    typeof estimate.usage === "number" && Number.isFinite(estimate.usage)
      ? Math.max(0, estimate.usage)
      : null;
  const quotaBytes =
    typeof estimate.quota === "number" && Number.isFinite(estimate.quota)
      ? Math.max(0, estimate.quota)
      : null;

  return {
    supported: true,
    persisted,
    usageBytes,
    quotaBytes,
    availableBytes:
      usageBytes !== null && quotaBytes !== null
        ? Math.max(0, quotaBytes - usageBytes)
        : null,
  };
};

/** Requests durable browser storage from an explicit user gesture. */
export const requestPersistentRecordingStorage = async () => {
  if (!canUseOPFSRecordingSink() || typeof navigator.storage.persist !== "function") {
    return false;
  }
  return navigator.storage.persist();
};

/**
 * Reads durable metadata after a reload. `partialDataAvailable` only proves
 * that bytes exist; an interrupted MP4/WebM container may still be unplayable.
 */
export const inspectOPFSRecordingJournals = async (
  directoryName = DEFAULT_OPFS_DIRECTORY,
): Promise<OPFSRecordingInspection[]> => {
  const directory = await getOPFSDirectory(directoryName);
  const inspections: OPFSRecordingInspection[] = [];

  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".journal.json")) continue;
    try {
      const file = await handle.getFile();
      const parsed: unknown = JSON.parse(await file.text());
      if (
        !isJournal(parsed) ||
        !isSafeJournalReference(parsed) ||
        parsed.journalFileName !== name
      ) {
        continue;
      }
      let actualFileBytes = 0;
      try {
        const partHandle = await directory.getFileHandle(parsed.partFileName);
        actualFileBytes = (await partHandle.getFile()).size;
      } catch {
        // A missing partial file remains visible as metadata with zero bytes.
      }
      inspections.push({
        ...parsed,
        actualFileBytes,
        partialDataAvailable: actualFileBytes > 0,
      });
    } catch {
      // One corrupt journal must not hide other inspectable sessions.
    }
  }

  return inspections.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

const findInspectableSession = async (
  sessionId: string,
  directoryName: string,
) => {
  const safeSessionId = sanitizeSessionId(sessionId);
  if (safeSessionId !== sessionId) {
    throw new Error("Invalid recording recovery session identifier.");
  }
  const inspection = (await inspectOPFSRecordingJournals(directoryName)).find(
    (entry) => entry.sessionId === safeSessionId,
  );
  if (!inspection) throw new Error("Recording recovery session was not found.");
  return inspection;
};

/**
 * Returns the exact OPFS media bytes for export. Interrupted containers may be
 * incomplete and are deliberately returned without claiming playability.
 */
export const readOPFSRecordingBytes = async (
  sessionId: string,
  directoryName = DEFAULT_OPFS_DIRECTORY,
) => {
  const inspection = await findInspectableSession(sessionId, directoryName);
  if (!inspection.partialDataAvailable) {
    throw new Error("This recovery session has no media bytes to export.");
  }
  const directory = await getOPFSDirectory(directoryName);
  const handle = await directory.getFileHandle(inspection.partFileName);
  const file = await handle.getFile();
  return file.slice(0, file.size, inspection.mimeType || "application/octet-stream");
};

/** Deletes only the exact part/journal pair owned by a validated session. */
export const deleteOPFSRecordingSession = async (
  sessionId: string,
  directoryName = DEFAULT_OPFS_DIRECTORY,
) => {
  const inspection = await findInspectableSession(sessionId, directoryName);
  const directory = await getOPFSDirectory(directoryName);
  await Promise.all([
    directory.removeEntry(inspection.partFileName).catch((error) => {
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      throw error;
    }),
    directory.removeEntry(inspection.journalFileName).catch((error) => {
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      throw error;
    }),
  ]);
};
