import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const edgeCandidates = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

const resolveExecutable = async () => {
  for (const candidate of edgeCandidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next installation.
    }
  }
  throw new Error("Microsoft Edge was not found. Set EDGE_PATH and retry.");
};

const reservePort = () =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not reserve a recording sink smoke port."));
        return;
      }
      server.close((error) =>
        error ? rejectPort(error) : resolvePort(address.port),
      );
    });
  });

const waitForServer = async (url, process, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process?.exitCode != null) {
      throw new Error(`Vite exited early with code ${process.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Timed out waiting for ${url}.`);
};

let viteProcess = null;
const smokeUrl = process.env.SMOKE_URL ?? `http://127.0.0.1:${await reservePort()}`;
if (!process.env.SMOKE_URL) {
  viteProcess = spawn(
    process.execPath,
    [
      join(projectRoot, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      new URL(smokeUrl).port,
      "--strictPort",
    ],
    {
      cwd: projectRoot,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );
  await waitForServer(smokeUrl, viteProcess);
}

const browser = await chromium.launch({
  executablePath: await resolveExecutable(),
  headless: true,
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(smokeUrl, { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const {
      MemoryRecordingSink,
      OPFSRecordingSink,
      deleteOPFSRecordingSession,
      estimateRecordingStorage,
      inspectOPFSRecordingJournals,
      readOPFSRecordingBytes,
    } = await import("/src/core/recordingSink.ts");
    const {
      clearRecordingDirectoryHandle,
      loadRecordingDirectoryHandle,
      saveRecordingDirectoryHandle,
      writeRecordingToDirectory,
    } = await import("/src/core/recordingDestination.ts");

    const memory = new MemoryRecordingSink({ maxPendingWrites: 4 });
    await memory.open({ mimeType: "text/plain", sessionId: "memory-order" });
    await Promise.all([
      memory.write(new Blob(["first-"])),
      memory.write(new Blob(["second-"])),
      memory.write(new Blob(["third"])),
    ]);
    const memoryBlob = await memory.finalize();

    const pressure = new MemoryRecordingSink({ maxPendingWrites: 2 });
    await pressure.open({ mimeType: "text/plain", sessionId: "pressure" });
    const pressureResults = await Promise.allSettled([
      pressure.write(new Blob(["one"])),
      pressure.write(new Blob(["two"])),
      pressure.write(new Blob(["three"])),
    ]);
    const pressureStats = pressure.stats();
    await pressure.abort("expected smoke backpressure");

    const directoryName = `sink-smoke-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const finalizedSessionId = "ordered-finalized";
    const interruptedSessionId = "interrupted-partial";
    let output;

    try {
      const opfs = new OPFSRecordingSink({
        directoryName,
        maxPendingWrites: 4,
      });
      await opfs.open({
        mimeType: "text/plain",
        sessionId: finalizedSessionId,
      });
      await opfs.write(new Blob(["alpha-"]));
      await opfs.write(new Blob(["beta-"]));
      await opfs.write(new Blob(["gamma"]));
      const opfsBlob = await opfs.finalize();
      const finalizedStats = opfs.stats();

      const interrupted = new OPFSRecordingSink({ directoryName });
      await interrupted.open({
        mimeType: "text/plain",
        sessionId: interruptedSessionId,
      });
      await interrupted.write(new Blob(["recoverable bytes only"]));
      await interrupted.abort("simulated interruption");
      const interruptedStats = interrupted.stats();

      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(directoryName);
      const destinationDirectory = await directory.getDirectoryHandle(
        "direct-output",
        { create: true },
      );
      await saveRecordingDirectoryHandle(destinationDirectory);
      const restoredDestination = await loadRecordingDirectoryHandle();
      if (!restoredDestination) throw new Error("Directory handle was not restored.");
      const directSave = await writeRecordingToDirectory(
        restoredDestination,
        new Blob(["direct recording bytes"], { type: "video/mp4" }),
        "direct-save.mp4",
      );
      const directFile = await (
        await destinationDirectory.getFileHandle("direct-save.mp4")
      ).getFile();
      const directText = await directFile.text();
      await clearRecordingDirectoryHandle();
      const destinationAfterClear = await loadRecordingDirectoryHandle();
      const corruptHandle = await directory.getFileHandle(
        "corrupt.journal.json",
        { create: true },
      );
      const corruptWriter = await corruptHandle.createWritable();
      await corruptWriter.write('{"schemaVersion":1,"status":"invented"}');
      await corruptWriter.close();

      const inspections = await inspectOPFSRecordingJournals(directoryName);
      const recoveredBlob = await readOPFSRecordingBytes(
        interruptedSessionId,
        directoryName,
      );
      const recoveredText = await recoveredBlob.text();
      const storageEstimate = await estimateRecordingStorage();
      await deleteOPFSRecordingSession(interruptedSessionId, directoryName);
      const inspectionsAfterDelete = await inspectOPFSRecordingJournals(directoryName);
      output = {
        secureContext: globalThis.isSecureContext,
        memoryText: await memoryBlob.text(),
        memoryStats: memory.stats(),
        pressureResults: pressureResults.map((entry) =>
          entry.status === "fulfilled"
            ? "fulfilled"
            : entry.reason?.code ?? entry.reason?.name ?? "rejected",
        ),
        pressureStats,
        opfsText: await opfsBlob.text(),
        finalizedStats,
        interruptedStats,
        recoveredText,
        storageEstimate,
        directSave,
        directText,
        destinationCleared: destinationAfterClear === null,
        inspectionsAfterDelete: inspectionsAfterDelete.map((entry) => entry.sessionId),
        inspections: inspections.map((inspection) => ({
          sessionId: inspection.sessionId,
          status: inspection.status,
          durability: inspection.durability,
          bytesAccepted: inspection.bytesAccepted,
          committedBytes: inspection.committedBytes,
          actualFileBytes: inspection.actualFileBytes,
          partialDataAvailable: inspection.partialDataAvailable,
        })),
      };
    } finally {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(directoryName, { recursive: true }).catch(() => undefined);
    }
    return output;
  });

  assert(result.secureContext === true, "OPFS smoke did not run in a secure context.");
  assert(result.memoryText === "first-second-third", `Memory order failed: ${result.memoryText}`);
  assert(
    result.memoryStats.state === "finalized" &&
      result.memoryStats.bytesWritten === result.memoryText.length &&
      result.memoryStats.peakPendingWrites === 3 &&
      result.memoryStats.actualBitrateBitsPerSecond > 0,
    `Memory stats failed: ${JSON.stringify(result.memoryStats)}`,
  );
  assert(
    result.pressureResults.filter((value) => value === "fulfilled").length === 2 &&
      result.pressureResults.includes("RECORDING_SINK_BACKPRESSURE") &&
      result.pressureStats.maxPendingWrites === 2,
    `Bounded queue failed: ${JSON.stringify(result.pressureResults)}`,
  );
  assert(result.opfsText === "alpha-beta-gamma", `OPFS order failed: ${result.opfsText}`);
  assert(
    result.directText === "direct recording bytes" &&
      result.directSave.filename === "direct-save.mp4" &&
      result.destinationCleared === true,
    `Direct recording destination failed: ${JSON.stringify(result.directSave)}`,
  );
  assert(
    result.finalizedStats.state === "finalized" &&
      result.finalizedStats.committedBytes === result.finalizedStats.bytesWritten,
    `OPFS finalize stats failed: ${JSON.stringify(result.finalizedStats)}`,
  );
  const finalized = result.inspections.find(
    (entry) => entry.sessionId === "ordered-finalized",
  );
  const interrupted = result.inspections.find(
    (entry) => entry.sessionId === "interrupted-partial",
  );
  assert(
    finalized?.status === "finalized" &&
      finalized.durability === "committed" &&
      finalized.actualFileBytes > 0,
    `Finalized journal failed: ${JSON.stringify(finalized)}`,
  );
  assert(
    interrupted?.status === "failed" &&
      interrupted.partialDataAvailable === true &&
      result.interruptedStats.recoverableMetadata === true,
    `Interrupted journal failed: ${JSON.stringify({ interrupted, stats: result.interruptedStats })}`,
  );
  assert(result.inspections.length === 2, "Malformed journal was not ignored.");
  assert(
    result.recoveredText === "recoverable bytes only",
    `Recovery export failed: ${result.recoveredText}`,
  );
  assert(
    result.storageEstimate.supported === true &&
      typeof result.storageEstimate.availableBytes === "number",
    `Storage estimate failed: ${JSON.stringify(result.storageEstimate)}`,
  );
  assert(
    result.inspectionsAfterDelete.length === 1 &&
      result.inspectionsAfterDelete[0] === "ordered-finalized",
    `Recovery deletion failed: ${JSON.stringify(result.inspectionsAfterDelete)}`,
  );
  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join(" | ")}`);

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} finally {
  await browser.close();
  viteProcess?.kill();
}
