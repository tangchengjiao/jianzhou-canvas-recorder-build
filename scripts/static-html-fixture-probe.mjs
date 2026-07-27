import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePaths = process.argv.slice(2);
if (!fixturePaths.length) {
  throw new Error("Usage: node scripts/static-html-fixture-probe.mjs <html> [...html]");
}

const reservePort = () =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("Could not reserve a fixture probe port."));
        return;
      }
      server.close((error) =>
        error ? rejectPort(error) : resolvePort(address.port),
      );
    });
  });

const edgeCandidates = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
let executablePath = null;
for (const candidate of edgeCandidates) {
  try {
    await stat(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Continue.
  }
}
if (!executablePath) throw new Error("Microsoft Edge was not found.");

const port = await reservePort();
const url = `http://127.0.0.1:${port}`;
const viteProcess = spawn(
  process.execPath,
  [
    join(projectRoot, "node_modules", "vite", "bin", "vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: projectRoot, stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
);

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  const results = [];
  for (const fixturePath of fixturePaths) {
    const source = await readFile(fixturePath, "utf8");
    const result = await page.evaluate(async ({ source, title }) => {
      const { StaticHtmlContentAdapter } = await import(
        "/src/content/staticHtmlAdapter.ts"
      );
      const adapter = await StaticHtmlContentAdapter.load(source, { title });
      const metadata = adapter.getMetadata();
      const indices = [...new Set([
        0,
        Math.floor((metadata.pageCount - 1) / 2),
        metadata.pageCount - 1,
      ])];
      const frames = [];
      for (const pageIndex of indices) {
        const frame = await adapter.prepareFrame({
          pageIndex,
          maxWidth: 640,
          maxHeight: 360,
        });
        const context = frame.source.getContext("2d", { willReadFrequently: true });
        const pixels = context.getImageData(0, 0, frame.width, frame.height).data;
        let hash = 2166136261;
        let min = 255;
        let max = 0;
        for (let index = 0; index < pixels.length; index += 404) {
          const value = pixels[index];
          min = Math.min(min, value);
          max = Math.max(max, value);
          hash ^= value;
          hash = Math.imul(hash, 16777619);
        }
        frames.push({ pageIndex, hash: hash >>> 0, luminanceRange: max - min });
      }
      const output = { metadata, diagnostics: adapter.getDiagnostics(), frames };
      adapter.dispose();
      return output;
    }, { source, title: fixturePath.split(/[\\/]/).at(-1) });
    results.push({ fixturePath, ...result });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  viteProcess.kill();
}
