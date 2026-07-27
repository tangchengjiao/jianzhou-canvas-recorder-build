import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tauriConfig = JSON.parse(
  await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = tauriConfig.version;
const releaseName = `jianzhou-canvas-recorder-beta-${version}`;
const releaseDir = join(root, "artifacts", "releases", releaseName);
const installerDir = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
);

const installerCandidates = (await readdir(installerDir))
  .filter((name) => name.toLowerCase().endsWith("-setup.exe"))
  .sort();
if (installerCandidates.length !== 1) {
  throw new Error(
    `Expected one NSIS installer in ${installerDir}, found ${installerCandidates.length}.`,
  );
}

await mkdir(releaseDir, { recursive: true });

const installerSource = join(installerDir, installerCandidates[0]);
const installerName = `Jianzhou-Canvas-Recorder-Beta-${version}-Windows-x64-setup.exe`;
const filesToCopy = [
  [installerSource, installerName],
  [join(root, "DESKTOP_BETA.md"), "README-内测说明.md"],
  [join(root, "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md"],
  [join(root, "artifacts", "native-readiness.json"), "native-readiness.json"],
  [join(root, "artifacts", "verify-report.json"), "web-verify-report.json"],
  [
    join(root, "artifacts", "installed-desktop-smoke.json"),
    "installed-desktop-smoke.json",
  ],
  [
    join(root, "artifacts", "installed-desktop-smoke.png"),
    "installed-desktop-smoke.png",
  ],
];

for (const [source, destination] of filesToCopy) {
  await copyFile(source, join(releaseDir, destination));
}

const sha256 = async (path) =>
  createHash("sha256").update(await readFile(path)).digest("hex").toUpperCase();

const checksums = [];
for (const [, destination] of filesToCopy) {
  const path = join(releaseDir, destination);
  checksums.push({
    filename: destination,
    bytes: (await stat(path)).size,
    sha256: await sha256(path),
  });
}

await writeFile(
  join(releaseDir, "SHA256SUMS.txt"),
  `${checksums.map((item) => `${item.sha256}  ${item.filename}`).join("\n")}\n`,
  "utf8",
);

const webReport = JSON.parse(
  await readFile(join(root, "artifacts", "verify-report.json"), "utf8"),
);
const desktopReport = JSON.parse(
  await readFile(
    join(root, "artifacts", "installed-desktop-smoke.json"),
    "utf8",
  ),
);
const installer = checksums.find((item) => item.filename === installerName);

const manifest = {
  schemaVersion: 1,
  product: tauriConfig.productName,
  version,
  channel: "beta",
  createdAt: new Date().toISOString(),
  target: "windows-x86_64",
  installer: {
    filename: installer.filename,
    bytes: installer.bytes,
    sha256: installer.sha256,
    format: "nsis",
    signed: false,
  },
  runtime: {
    webview2InstallMode: "downloadBootstrapper",
  },
  validation: {
    webVerify: webReport.status,
    installedDesktopSmoke: desktopReport.ok === true ? "passed" : "failed",
    secureContext: desktopReport.capabilities?.secureContext === true,
    mediaRecorder: desktopReport.capabilities?.mediaRecorder === true,
    originPrivateFileSystem: desktopReport.capabilities?.opfs === true,
    folderDestination:
      desktopReport.capabilities?.folderDestinationEnabled === true,
    missingLocalFonts:
      desktopReport.offlineFonts?.missingLocalFontFallbacks?.length ?? null,
    unexpectedExternalRequests:
      desktopReport.offlineFonts?.unexpectedExternalResources?.length ?? null,
  },
  includedFiles: checksums.map((item) => basename(item.filename)),
};

await writeFile(
  join(releaseDir, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      releaseDir,
      installer,
      manifest,
    },
    null,
    2,
  ),
);
