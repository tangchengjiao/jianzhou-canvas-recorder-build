import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(
  "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
);
// Excalidraw resolves font URLs as `fonts/<family>/<file>` relative to
// EXCALIDRAW_ASSET_PATH, so preserve the `fonts` directory in the public tree.
const assetRoot = resolve("public/excalidraw-assets");
const target = resolve(assetRoot, "fonts");

await rm(assetRoot, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

console.log(`Copied local Excalidraw fonts to ${target}`);
