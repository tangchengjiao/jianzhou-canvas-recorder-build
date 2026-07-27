import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(projectRoot, "artifacts");
const reportPath = join(artifactsDirectory, "verify-report.json");
const startedAt = new Date();
const steps = [];

const reserveAvailablePort = () =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not reserve a local verification port."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(port);
      });
    });
  });

const previewUrl =
  process.env.VERIFY_URL ??
  `http://127.0.0.1:${await reserveAvailablePort()}`;

const nodeModuleScript = (...parts) =>
  join(projectRoot, "node_modules", ...parts);

const runNodeStep = (name, args, options = {}) =>
  new Promise((resolveStep, rejectStep) => {
    const stepStartedAt = Date.now();
    let settled = false;
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
      windowsHide: true,
    });
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      const result = {
        name,
        status: "failed",
        durationMs: Date.now() - stepStartedAt,
        error: `Timed out after ${timeoutMs}ms`,
      };
      steps.push(result);
      rejectStep(new Error(`${name} timed out.`));
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        name,
        status: "failed",
        durationMs: Date.now() - stepStartedAt,
        error: error.message,
      };
      steps.push(result);
      rejectStep(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        name,
        status: code === 0 ? "passed" : "failed",
        durationMs: Date.now() - stepStartedAt,
        exitCode: code,
        signal,
      };
      steps.push(result);
      if (code === 0) {
        resolveStep();
      } else {
        rejectStep(new Error(`${name} exited with code ${code}.`));
      }
    });
  });

const waitForPreview = async (url, child, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let processError = null;
  child.once("error", (error) => {
    processError = error;
  });
  child.once("exit", (code, signal) => {
    processError = new Error(
      `Preview exited before it became ready (code ${code}, signal ${signal}).`,
    );
  });
  while (Date.now() < deadline) {
    if (processError) throw processError;
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok) return;
      lastError = new Error(`Preview returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error("Preview did not become ready.");
};

const writeReport = async (status, error) => {
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        previewUrl,
        steps,
        ...(error ? { error: error.message } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

let previewProcess = null;
let failure = null;

try {
  await runNodeStep("typecheck", [
    nodeModuleScript("typescript", "bin", "tsc"),
    "-b",
    "--pretty",
    "false",
  ]);
  await runNodeStep("build", [
    nodeModuleScript("vite", "bin", "vite.js"),
    "build",
  ]);

  previewProcess = spawn(
    process.execPath,
    [
      nodeModuleScript("vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      new URL(previewUrl).port || "4173",
      "--strictPort",
    ],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );
  await waitForPreview(previewUrl, previewProcess);

  const smokeEnvironment = { SMOKE_URL: previewUrl };
  await runNodeStep("smoke:core", [join(projectRoot, "scripts", "smoke-test.mjs")], {
    env: smokeEnvironment,
  });
  await runNodeStep(
    "smoke:content",
    [join(projectRoot, "scripts", "content-smoke.mjs")],
    { env: smokeEnvironment },
  );
  await runNodeStep(
    "smoke:markdown",
    [join(projectRoot, "scripts", "markdown-smoke.mjs")],
    { env: smokeEnvironment },
  );
  await runNodeStep(
    "smoke:html",
    [join(projectRoot, "scripts", "safe-html-smoke.mjs")],
    { env: smokeEnvironment },
  );
  await runNodeStep(
    "smoke:sink",
    [join(projectRoot, "scripts", "recording-sink-smoke.mjs")],
    { env: smokeEnvironment },
  );
  await runNodeStep(
    "smoke:media",
    [join(projectRoot, "scripts", "media-smoke.mjs")],
    { env: smokeEnvironment },
  );
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  previewProcess?.kill();
  await writeReport(failure ? "failed" : "passed", failure);
}

if (failure) {
  console.error(`Verification failed. Report: ${reportPath}`);
  throw failure;
}

console.log(`Verification passed. Report: ${reportPath}`);
