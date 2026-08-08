import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { transformWithOxc } from "vite";
import {
  assertPublicReleaseDirectory,
  assertPublicText,
} from "./release-privacy.mjs";

const root = resolve(import.meta.dirname, "..");
const diagnosticSource = await import("node:fs/promises").then(({ readFile }) =>
  readFile(join(root, "src", "core", "diagnostics.ts"), "utf8"),
);
const compiled = (
  await transformWithOxc(diagnosticSource, "diagnostics.ts", {
    lang: "ts",
  })
).code;
const diagnostics = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const sanitized = diagnostics.sanitizeDiagnosticData({
  fileName: "客户名单.html",
  directoryName: "私人课程",
  sessionId: "persistent-session-123",
  userAgent: "identifying-browser",
  message:
    "failed C:\\Users\\private-user\\Documents\\client.html https://example.invalid/?token=abc user@example.com sk-test_abcdefghijklmnop",
  nested: {
    apiKey: "super-secret-value",
    safeCode: "NotAllowedError",
  },
});
const serialized = JSON.stringify(sanitized);
for (const forbidden of [
  "客户名单",
  "私人课程",
  "persistent-session",
  "private-user",
  "example.invalid",
  "user@example.com",
  "super-secret-value",
  "sk-test_",
  "identifying-browser",
]) {
  assert(!serialized.includes(forbidden), `Diagnostic sanitizer leaked: ${forbidden}`);
}
assert.equal(sanitized.nested.safeCode, "NotAllowedError");

assert.doesNotThrow(() =>
  assertPublicText("safe.json", '{"status":"passed","secureContext":true}'),
);
assert.throws(
  () => assertPublicText("unsafe.json", '{"path":"C:\\\\Users\\\\builder\\\\file"}'),
  /private release data/,
);

const temporaryRoot = await mkdtemp(join(tmpdir(), "jianzhou-release-privacy-"));
try {
  const releaseDir = join(temporaryRoot, "release");
  await mkdir(releaseDir);
  await writeFile(join(releaseDir, "README.md"), "本地内测说明", "utf8");
  await writeFile(join(releaseDir, "release-manifest.json"), '{"safe":true}', "utf8");
  await assertPublicReleaseDirectory(releaseDir, [
    "README.md",
    "release-manifest.json",
  ]);
  await writeFile(join(releaseDir, "installed-desktop-smoke.png"), "private", "utf8");
  await assert.rejects(
    assertPublicReleaseDirectory(releaseDir, [
      "README.md",
      "release-manifest.json",
    ]),
    /Unsafe release contents/,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, diagnostics: "sanitized", release: "allowlisted" }));
