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
      // Continue.
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
        rejectPort(new Error("Could not reserve a safe HTML smoke port."));
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
    if (process?.exitCode != null) throw new Error(`Vite exited with ${process.exitCode}.`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Starting.
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
    { cwd: projectRoot, stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
  );
  await waitForServer(smokeUrl, viteProcess);
}

const browser = await chromium.launch({
  executablePath: await resolveExecutable(),
  headless: true,
});

try {
  const page = await browser.newPage();
  const requests = [];
  const pageErrors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(smokeUrl, { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const { SafeHtmlContentAdapter, convertSafeHtmlToMarkdown } = await import(
      "/src/content/safeHtmlAdapter.ts"
    );
    const { StaticHtmlContentAdapter } = await import(
      "/src/content/staticHtmlAdapter.ts"
    );
    globalThis.__safeHtmlPwned = 0;
    const repeated = Array.from(
      { length: 48 },
      (_, index) => `<section><h2>本地课程 ${index + 1}</h2><p>这是 <strong>安全正文</strong> 与 <code>代码</code>。</p></section>`,
    ).join("");
    const source = `<!doctype html><html><head>
      <base href="https://example.invalid/">
      <style>body{background:url(https://example.invalid/style.png)}</style>
      <script>globalThis.__safeHtmlPwned=41</script>
      </head><body onclick="globalThis.__safeHtmlPwned=42">
      <h1>HTML 课程</h1>
      <iframe src="https://example.invalid/frame"></iframe>
      <form action="https://example.invalid/post"><input name="secret"></form>
      <img alt="远程图" src="https://example.invalid/tracker.png">
      <img alt="本地图" src="assets/local-cover.png" onerror="globalThis.__safeHtmlPwned=43">
      <table><tr><th>项目</th><th>状态</th></tr><tr><td>脚本</td><td>移除</td></tr></table>
      ${repeated}
      <object data="https://example.invalid/object"></object>
      </body></html>`;

    const converted = convertSafeHtmlToMarkdown(source);
    const resolverReferences = [];
    const adapter = await SafeHtmlContentAdapter.load(source, {
      title: "safe-html-smoke.html",
      mode: "document",
      orientation: "landscape",
      theme: "paper",
      resolveLocalImage: (reference) => {
        resolverReferences.push(reference);
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext("2d");
        context.fillStyle = "#6558d3";
        context.fillRect(0, 0, 320, 180);
        return canvas;
      },
    });
    const metadata = adapter.getMetadata();
    const first = await adapter.prepareFrame({ pageIndex: 0, maxWidth: 800, maxHeight: 450 });
    const second = await adapter.navigate({ type: "next" });
    const thumbnail = await adapter.getThumbnail(0, { maxWidth: 240, maxHeight: 180 });
    const pixelHash = (canvas) => {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      let colored = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) -
            Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) > 25) colored += 1;
        if ((index >> 2) % 101 === 0) {
          hash ^= pixels[index];
          hash = Math.imul(hash, 16777619);
          hash ^= pixels[index + 1];
          hash = Math.imul(hash, 16777619);
        }
      }
      return { hash: hash >>> 0, colored };
    };
    const output = {
      metadata,
      diagnostics: adapter.getDiagnostics(),
      conversionDiagnostics: converted.diagnostics,
      convertedMarkdown: converted.markdown,
      resolverReferences,
      scriptValue: globalThis.__safeHtmlPwned,
      frames: [pixelHash(first.source), pixelHash(second.source)],
      thumbnail: { width: thumbnail.width, height: thumbnail.height },
    };
    adapter.dispose();

    globalThis.__staticHtmlPwned = 0;
    const visualSource = `<!doctype html><html><head><style>
      html,body{margin:0;width:100%;height:100%;background:#17324d}
      .panel{position:absolute;left:160px;top:90px;width:640px;height:360px;
        border-radius:32px;background:#ff4f76;box-shadow:0 24px 70px rgba(0,0,0,.28)}
      .panel h1{margin:48px;color:#fff;font:700 72px/1.1 Arial,sans-serif}
    </style><script>globalThis.__staticHtmlPwned=1</script></head><body>
      <main class="panel" onclick="globalThis.__staticHtmlPwned=2"><h1>视觉 HTML</h1></main>
      <svg width="180" height="180" viewBox="0 0 180 180" style="position:absolute;right:80px;bottom:60px">
        <circle cx="90" cy="90" r="76" fill="#5ee6a8" />
      </svg>
    </body></html>`;
    const visualAdapter = await StaticHtmlContentAdapter.load(visualSource, {
      title: "static-visual-smoke.html",
      orientation: "landscape",
    });
    const visualMetadata = visualAdapter.getMetadata();
    const visualFrame = await visualAdapter.prepareFrame({ maxWidth: 800, maxHeight: 450 });
    const visualContext = visualFrame.source.getContext("2d", { willReadFrequently: true });
    const pixel = (x, y) => [...visualContext.getImageData(x, y, 1, 1).data];
    const visual = {
      metadata: visualMetadata,
      diagnostics: visualAdapter.getDiagnostics(),
      backgroundPixel: pixel(20, 20),
      panelPixel: pixel(100, 60),
      svgPixel: pixel(715, 375),
      scriptValue: globalThis.__staticHtmlPwned,
    };
    visualAdapter.dispose();

    const longSource = `<!doctype html><html><head><style>
      html,body{margin:0;background:#fff} section{height:500px;display:grid;place-items:center;font:700 64px Arial}
      .one{background:#f05d6f}.two{background:#5d7ff0}.three{background:#52c98b}.fade-in{opacity:0;transform:translateY(30px)}
    </style></head><body>
      <section class="one fade-in">第一屏</section><section class="two fade-in">第二屏</section><section class="three fade-in">第三屏</section>
    </body></html>`;
    const longAdapter = await StaticHtmlContentAdapter.load(longSource, {
      title: "long-page.html", width: 800, height: 500,
    });
    const longFirst = await longAdapter.prepareFrame({ pageIndex: 0, maxWidth: 800, maxHeight: 500 });
    const longSecond = await longAdapter.navigate({ type: "next" });
    const longResult = {
      metadata: longAdapter.getMetadata(),
      diagnostics: longAdapter.getDiagnostics(),
      frames: [pixelHash(longFirst.source), pixelHash(longSecond.source)],
    };
    longAdapter.dispose();

    const deckSource = `<!doctype html><html><head><style>
      html,body{margin:0;overflow:hidden;background:#05070b}#deck{width:800px;height:450px;position:relative}
      .slide{position:absolute;inset:0;width:800px;height:450px;display:none;place-items:center;font:700 64px Arial;color:white}
      .slide.active{display:grid}.red{background:#d83b55}.blue{background:#345bd6}.green{background:#208b62}
    </style><script>document.querySelector('.slide').classList.add('active')</script></head><body><main id="deck">
      <section class="slide red" data-slide="1">封面</section>
      <section class="slide blue" data-slide="2">方法</section>
      <section class="slide green" data-slide="3">结尾</section>
    </main></body></html>`;
    const deckAdapter = await StaticHtmlContentAdapter.load(deckSource, { title: "deck.html" });
    const deckFrames = [];
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const frame = await deckAdapter.prepareFrame({ pageIndex, maxWidth: 800, maxHeight: 450 });
      deckFrames.push(pixelHash(frame.source));
    }
    await deckAdapter.navigate({ type: "last" });
    const deckResult = {
      metadata: deckAdapter.getMetadata(),
      diagnostics: deckAdapter.getDiagnostics(),
      frames: deckFrames,
      scriptValue: globalThis.__staticHtmlPwned,
    };
    deckAdapter.dispose();
    return { ...output, visual, longResult, deckResult };
  });

  const codes = result.diagnostics.map((item) => item.code);
  assert(result.metadata.kind === "html", `Wrong kind: ${result.metadata.kind}`);
  assert(result.metadata.pageCount > 2, `HTML did not paginate: ${result.metadata.pageCount}`);
  assert(result.metadata.details?.htmlMode === "controlled-static-v1", "HTML safety mode missing.");
  assert(codes.includes("ACTIVE_CONTENT_REMOVED"), "Active HTML removal was not reported.");
  assert(codes.includes("REMOTE_RESOURCE_REJECTED"), "Remote resource rejection was not reported.");
  assert(codes.includes("ATTRIBUTES_STRIPPED"), "Attribute stripping was not reported.");
  assert(
    result.resolverReferences.length === 1 &&
      result.resolverReferences[0] === "assets/local-cover.png",
    `Unsafe image reached resolver: ${JSON.stringify(result.resolverReferences)}`,
  );
  assert(result.scriptValue === 0, `HTML executed active content: ${result.scriptValue}`);
  assert(
    result.visual.metadata.details?.htmlMode === "static-visual-v2",
    "Static visual HTML mode missing.",
  );
  assert(result.visual.scriptValue === 0, "Static visual HTML executed a script.");
  assert(
    result.visual.backgroundPixel[2] > result.visual.backgroundPixel[0],
    `Static HTML background CSS was lost: ${result.visual.backgroundPixel}`,
  );
  assert(
    result.visual.panelPixel[0] > 220 && result.visual.panelPixel[1] < 120,
    `Static HTML positioned panel was lost: ${result.visual.panelPixel}`,
  );
  assert(
    result.visual.svgPixel[1] > 180 && result.visual.svgPixel[0] < 150,
    `Static HTML SVG was lost: ${result.visual.svgPixel}`,
  );
  assert(
    result.longResult.metadata.pageCount === 3 &&
      result.longResult.metadata.details?.layoutMode === "scroll",
    `Long HTML pagination failed: ${JSON.stringify(result.longResult.metadata)}`,
  );
  assert(
    result.longResult.frames[0].hash !== result.longResult.frames[1].hash &&
      result.longResult.frames.every((frame) => frame.colored > 100),
    `Long HTML pages are blank or identical: ${JSON.stringify(result.longResult.frames)}`,
  );
  assert(
    result.deckResult.metadata.pageCount === 3 &&
      result.deckResult.metadata.currentPageIndex === 2 &&
      result.deckResult.metadata.details?.layoutMode === "slides",
    `HTML deck detection/navigation failed: ${JSON.stringify(result.deckResult.metadata)}`,
  );
  assert(
    new Set(result.deckResult.frames.map((frame) => frame.hash)).size === 3 &&
      result.deckResult.frames.every((frame) => frame.colored > 100),
    `HTML deck frames are blank or identical: ${JSON.stringify(result.deckResult.frames)}`,
  );
  assert(
    result.frames[0].hash !== result.frames[1].hash &&
      result.frames.every((frame) => frame.colored > 100),
    `HTML frames are blank or identical: ${JSON.stringify(result.frames)}`,
  );
  assert(
    !/iframe|object|globalThis\.__safeHtmlPwned/i.test(result.convertedMarkdown),
    "Removed active content leaked into the controlled document.",
  );
  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join(" | ")}`);
  const origin = new URL(smokeUrl).origin;
  const externalRequests = requests.filter((requestUrl) => {
    const parsed = new URL(requestUrl);
    return parsed.protocol !== "data:" && parsed.protocol !== "blob:" && parsed.origin !== origin;
  });
  assert(externalRequests.length === 0, `HTML caused external requests: ${externalRequests.join(", ")}`);

  console.log(JSON.stringify({
    ok: true,
    pages: result.metadata.pageCount,
    diagnosticCodes: codes,
    resolverReferences: result.resolverReferences,
    scriptExecuted: false,
    externalRequests: 0,
    frames: result.frames,
    staticVisual: result.visual,
  }, null, 2));
} finally {
  await browser.close();
  viteProcess?.kill();
}
