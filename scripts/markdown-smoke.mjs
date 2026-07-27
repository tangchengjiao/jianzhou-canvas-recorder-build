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
      // Try the next known installation.
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
        rejectPort(new Error("Could not reserve a Markdown smoke port."));
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
      // Server is still starting.
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
  const requestedUrls = [];
  const pageErrors = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(smokeUrl, { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const { MarkdownContentAdapter } = await import(
      "/src/content/markdownAdapter.ts"
    );
    const { isControlledLocalImageReference } = await import(
      "/src/content/markdown/parser.ts"
    );

    globalThis.__markdownPwned = 0;
    const source = `# 中文课程标题

这是一个 **稳定的粗体**、*斜体* 与 \`行内代码\` 段落。

- 第一项
- 第二项

> 只在 Canvas 中绘制的引用。

<script>globalThis.__markdownPwned = 99</script>

---

## 数据页

| 项目 | 结果 |
| --- | --- |
| 本地渲染 | 通过 |
| 网络请求 | 零 |

![远程图片](https://example.invalid/tracker.png)

[脚本链接](javascript:globalThis.__markdownPwned=42)

<iframe src="https://example.invalid"></iframe>

---

## 本地资源页

![本地测试图](assets/lesson-cover.png)

\`\`\`html
<object data="https://example.invalid/object"></object>
\`\`\``;

    const resolverReferences = [];
    const adapter = await MarkdownContentAdapter.load(source, {
      mode: "slides",
      orientation: "landscape",
      theme: "midnight",
      title: "Markdown smoke",
      resolveLocalImage: (reference) => {
        resolverReferences.push(reference);
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 240;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ef4444";
        context.fillRect(0, 0, 240, 240);
        context.fillStyle = "#3b82f6";
        context.fillRect(240, 0, 240, 240);
        return canvas;
      },
    });

    const pixelHash = (source) => {
      const canvas = source;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      let nonBackgroundPixels = 0;
      const first = [pixels[0], pixels[1], pixels[2]];
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          Math.abs(pixels[index] - first[0]) > 8 ||
          Math.abs(pixels[index + 1] - first[1]) > 8 ||
          Math.abs(pixels[index + 2] - first[2]) > 8
        ) {
          nonBackgroundPixels += 1;
        }
        if ((index >> 2) % 97 === 0) {
          hash ^= pixels[index];
          hash = Math.imul(hash, 16777619);
          hash ^= pixels[index + 1];
          hash = Math.imul(hash, 16777619);
          hash ^= pixels[index + 2];
          hash = Math.imul(hash, 16777619);
        }
      }
      return { hash: hash >>> 0, nonBackgroundPixels };
    };

    const metadata = adapter.getMetadata();
    const first = await adapter.prepareFrame({ pageIndex: 0, maxWidth: 800, maxHeight: 450 });
    const second = await adapter.navigate({ type: "next" });
    const third = await adapter.prepareFrame({ pageIndex: 2, maxWidth: 800, maxHeight: 450 });
    const thumbnail = await adapter.getThumbnail(2, { maxWidth: 240, maxHeight: 180 });
    const diagnostics = adapter.getDiagnostics();

    const abortController = new AbortController();
    abortController.abort("smoke-cancel");
    let cancellationCode = null;
    try {
      await adapter.prepareFrame({ signal: abortController.signal });
    } catch (error) {
      cancellationCode = error?.code ?? error?.name ?? null;
    }

    const longDocument = Array.from(
      { length: 90 },
      (_, index) =>
        `## 自动分页 ${index + 1}\n\n这是纵向文档模式的中文段落，用于验证固定画布上的安全分页。`,
    ).join("\n\n");
    const documentAdapter = await MarkdownContentAdapter.load(longDocument, {
      mode: "document",
      orientation: "portrait",
      theme: "warm",
    });
    const documentMetadata = documentAdapter.getMetadata();
    const portraitFrame = await documentAdapter.prepareFrame({ pageIndex: 1 });

    const output = {
      metadata,
      pageHashes: [pixelHash(first.source), pixelHash(second.source), pixelHash(third.source)],
      thumbnail: { width: thumbnail.width, height: thumbnail.height },
      diagnosticCodes: diagnostics.map((item) => item.code),
      diagnostics,
      resolverReferences,
      scriptValue: globalThis.__markdownPwned,
      cancellationCode,
      document: {
        pageCount: documentMetadata.pageCount,
        orientation: documentMetadata.orientation,
        frame: { width: portraitFrame.width, height: portraitFrame.height },
      },
      referencePolicy: {
        relative: isControlledLocalImageReference("assets/cover.png"),
        traversal: isControlledLocalImageReference("../secret.png"),
        remote: isControlledLocalImageReference("https://example.com/a.png"),
        script: isControlledLocalImageReference("javascript:alert(1)"),
        drive: isControlledLocalImageReference("C:\\secret.png"),
      },
    };
    adapter.dispose();
    documentAdapter.dispose();
    return output;
  });

  assert(result.metadata.pageCount === 3, `Expected 3 slides: ${JSON.stringify(result.metadata)}`);
  assert(result.metadata.kind === "markdown", "Adapter did not report Markdown kind.");
  assert(result.metadata.details?.markdownSubset === "controlled-v1", "Subset contract missing.");
  assert(
    new Set(result.pageHashes.map((item) => item.hash)).size === 3 &&
      result.pageHashes.every((item) => item.nonBackgroundPixels > 1_000),
    `Pages were blank or pixel-identical: ${JSON.stringify(result.pageHashes)}`,
  );
  assert(
    result.thumbnail.width <= 240 && result.thumbnail.height <= 180,
    `Thumbnail bounds failed: ${JSON.stringify(result.thumbnail)}`,
  );
  for (const code of ["RAW_HTML_AS_TEXT", "REMOTE_RESOURCE_REJECTED", "UNSAFE_LINK_REJECTED"]) {
    assert(result.diagnosticCodes.includes(code), `Missing diagnostic ${code}.`);
  }
  assert(
    result.resolverReferences.length === 1 &&
      result.resolverReferences[0] === "assets/lesson-cover.png",
    `Unsafe references reached local resolver: ${JSON.stringify(result.resolverReferences)}`,
  );
  assert(result.scriptValue === 0, `Markdown executed script; value=${result.scriptValue}.`);
  assert(result.cancellationCode === "ABORTED", `Cancellation failed: ${result.cancellationCode}`);
  assert(
    result.document.pageCount > 3 &&
      result.document.orientation === "portrait" &&
      result.document.frame.height > result.document.frame.width,
    `Document pagination/orientation failed: ${JSON.stringify(result.document)}`,
  );
  assert(
    result.referencePolicy.relative === true &&
      result.referencePolicy.traversal === false &&
      result.referencePolicy.remote === false &&
      result.referencePolicy.script === false &&
      result.referencePolicy.drive === false,
    `Local image boundary failed: ${JSON.stringify(result.referencePolicy)}`,
  );
  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join(" | ")}`);

  const origin = new URL(smokeUrl).origin;
  const externalRequests = requestedUrls.filter((requestUrl) => {
    const requested = new URL(requestUrl);
    return (
      requested.protocol !== "data:" &&
      requested.protocol !== "blob:" &&
      requested.origin !== origin
    );
  });
  assert(
    externalRequests.length === 0,
    `Markdown caused external requests: ${externalRequests.join(", ")}`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        pages: result.metadata.pageCount,
        documentPages: result.document.pageCount,
        diagnostics: result.diagnosticCodes,
        resolverReferences: result.resolverReferences,
        pageHashes: result.pageHashes,
        scriptExecuted: false,
        externalRequests: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  viteProcess?.kill();
}
