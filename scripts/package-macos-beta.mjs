import { execFileSync } from "node:child_process";
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

if (process.platform !== "darwin") {
  throw new Error("macOS release packaging must run on a macOS host.");
}

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(
  await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = config.version;
const targetRoot = join(
  root,
  "src-tauri",
  "target",
  "universal-apple-darwin",
  "release",
  "bundle",
);
const macosBundleDir = join(targetRoot, "macos");
const dmgBundleDir = join(targetRoot, "dmg");

const appNames = (await readdir(macosBundleDir))
  .filter((name) => name.endsWith(".app"))
  .sort();
const dmgNames = (await readdir(dmgBundleDir))
  .filter((name) => name.endsWith(".dmg"))
  .sort();
if (appNames.length !== 1 || dmgNames.length !== 1) {
  throw new Error(
    `Expected one .app and one .dmg, found ${appNames.length} app(s) and ${dmgNames.length} dmg(s).`,
  );
}

const appPath = join(macosBundleDir, appNames[0]);
const dmgPath = join(dmgBundleDir, dmgNames[0]);
const executablePath = join(
  appPath,
  "Contents",
  "MacOS",
  "jianzhou-canvas-recorder",
);

const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const architectures = run("/usr/bin/lipo", ["-archs", executablePath])
  .split(/\s+/)
  .filter(Boolean)
  .sort();
const expectedArchitectures = ["aarch64", "x86_64"];
if (
  architectures.length !== expectedArchitectures.length ||
  expectedArchitectures.some((architecture) => !architectures.includes(architecture))
) {
  throw new Error(
    `Expected a universal binary (${expectedArchitectures.join(", ")}), got ${architectures.join(", ")}.`,
  );
}

run("/usr/bin/codesign", [
  "--verify",
  "--deep",
  "--strict",
  "--verbose=2",
  appPath,
]);
run("/usr/bin/hdiutil", ["verify", dmgPath]);

const releaseName = `jianzhou-canvas-recorder-beta-${version}-macos-universal`;
const releaseDir = join(root, "artifacts", "macos", releaseName);
await mkdir(releaseDir, { recursive: true });

const dmgName = `Jianzhou-Canvas-Recorder-Beta-${version}-macOS-Universal.dmg`;
const appArchiveName = `Jianzhou-Canvas-Recorder-Beta-${version}-macOS-Universal.app.zip`;
const dmgDestination = join(releaseDir, dmgName);
const appArchiveDestination = join(releaseDir, appArchiveName);
await copyFile(dmgPath, dmgDestination);
execFileSync(
  "/usr/bin/ditto",
  [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    appArchiveDestination,
  ],
  { cwd: root, stdio: "inherit" },
);

for (const [source, destination] of [
  [join(root, "MACOS_BETA.md"), join(releaseDir, "README-内测说明.md")],
  [
    join(root, "THIRD_PARTY_NOTICES.md"),
    join(releaseDir, "THIRD_PARTY_NOTICES.md"),
  ],
]) {
  await copyFile(source, destination);
}

const sha256 = async (path) =>
  createHash("sha256").update(await readFile(path)).digest("hex").toUpperCase();
const releaseFiles = [
  dmgDestination,
  appArchiveDestination,
  join(releaseDir, "README-内测说明.md"),
  join(releaseDir, "THIRD_PARTY_NOTICES.md"),
];
const checksums = [];
for (const path of releaseFiles) {
  checksums.push({
    filename: basename(path),
    bytes: (await stat(path)).size,
    sha256: await sha256(path),
  });
}
await writeFile(
  join(releaseDir, "SHA256SUMS.txt"),
  `${checksums.map((item) => `${item.sha256}  ${item.filename}`).join("\n")}\n`,
  "utf8",
);

const manifest = {
  schemaVersion: 1,
  product: config.productName,
  version,
  channel: "beta",
  createdAt: new Date().toISOString(),
  target: "macos-universal",
  minimumSystemVersion: "12.0",
  architectures,
  bundle: {
    dmg: checksums.find((item) => item.filename === dmgName),
    appArchive: checksums.find((item) => item.filename === appArchiveName),
  },
  signing: {
    mode: "ad-hoc",
    notarized: false,
  },
  validation: {
    universalBinary: true,
    codeSignatureVerified: true,
    diskImageVerified: true,
  },
};
await writeFile(
  join(releaseDir, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify({ ok: true, releaseDir, manifest }, null, 2));
