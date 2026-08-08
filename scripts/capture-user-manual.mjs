import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "docs", "assets", "user-manual");
await mkdir(output, { recursive: true });

const edgeCandidates = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
let executablePath = "";
for (const candidate of edgeCandidates) {
  try {
    await stat(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Try the next installed browser.
  }
}
if (!executablePath) throw new Error("Microsoft Edge was not found.");

const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Could not reserve a preview port."));
      return;
    }
    const value = address.port;
    server.close(() => resolvePort(value));
  });
});
const url = `http://127.0.0.1:${port}`;
const vite = spawn(
  process.execPath,
  [join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: root, stdio: "ignore", windowsHide: true },
);

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    // Vite is still starting.
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await page.evaluate(async () => {
    localStorage.clear();
    const databases = await indexedDB.databases();
    await Promise.all(databases.map((database) => database.name && new Promise((resolveDelete) => {
      const request = indexedDB.deleteDatabase(database.name);
      request.onsuccess = request.onerror = request.onblocked = () => resolveDelete();
    })));
  });
  await page.reload({ waitUntil: "networkidle" });

  const closeWorkspace = page.getByRole("button", { name: "关闭工作台" });
  if (await closeWorkspace.isVisible()) await closeWorkspace.click();
  await page.screenshot({ path: join(output, "01-overview.png") });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".workspace-panel[data-open='true']").waitFor();
  await page.screenshot({ path: join(output, "02-recording-settings.png") });
  await closeWorkspace.click();

  await page.getByRole("button", { name: "提词器", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "提词器脚本" });
  await prompt.fill(
    "欢迎使用见舟画布录制。\n\n今天我们用三分钟讲清楚课程的核心步骤。\n\n提词器只在监看界面显示，不会进入最终视频。",
  );
  await page.screenshot({ path: join(output, "03-teleprompter.png") });
  await page.getByRole("button", { name: "关闭提词器" }).click();

  await page.getByRole("button", { name: "展开讲解内容侧栏" }).click();
  await page.screenshot({ path: join(output, "04-content-import.png") });

  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 1280 720]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 137>>stream\n0.96 0.95 0.91 rg 0 0 1280 720 re f 0.02 0.35 0.33 rg 80 80 1120 560 re f BT /F1 54 Tf 1 1 1 rg 150 500 Td (COURSE DEMO) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000236 00000 n \n0000000423 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n493\n%%EOF",
    "ascii",
  );
  await page.locator('input[type="file"][accept^="application/pdf"]').setInputFiles({
    name: "课程演示示例.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.waitForFunction(() => document.querySelector(".app-shell")?.getAttribute("data-content-source") === "pdf");
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(output, "05-pdf-presentation.png") });
} finally {
  await browser.close();
  vite.kill();
}

console.log(JSON.stringify({ ok: true, output }));
