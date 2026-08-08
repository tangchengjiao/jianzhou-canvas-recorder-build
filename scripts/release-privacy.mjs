import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const RAW_PRIVATE_ARTIFACT =
  /(?:native-readiness|installed-desktop-smoke|verify-report|smoke.*\.(?:png|jpe?g))$/i;
const LOCAL_PATH =
  /(?:[A-Za-z]:[\\/](?:Users[\\/][^\\/\s"']+|[^\s"']+)|\/(?:Users|home)\/[^/\s"']+)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const CREDENTIAL =
  /(?:api[-_]?key|authorization|bearer|password|private[-_]?key|secret|token)\s*[=:]\s*["']?[^\s"']{8,}/i;
const SECRET_VALUE =
  /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])-[-_A-Za-z0-9]{12,}\b/i;
const TEXT_EXTENSIONS = new Set([".json", ".md", ".txt"]);

export const assertPublicText = (label, text) => {
  const violations = [];
  if (LOCAL_PATH.test(text)) violations.push("absolute user or machine path");
  if (EMAIL.test(text)) violations.push("email address");
  if (CREDENTIAL.test(text) || SECRET_VALUE.test(text)) {
    violations.push("credential-like value");
  }
  if (violations.length) {
    throw new Error(`${label} contains private release data: ${violations.join(", ")}.`);
  }
};

export const assertPublicReleaseDirectory = async (
  releaseDir,
  expectedFileNames,
) => {
  const expected = new Set(expectedFileNames);
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  const unexpected = actual.filter(
    (name) => !expected.has(name) || RAW_PRIVATE_ARTIFACT.test(name),
  );
  const missing = [...expected].filter((name) => !actual.includes(name));
  if (unexpected.length || missing.length || entries.some((entry) => !entry.isFile())) {
    throw new Error(
      `Unsafe release contents. Unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}.`,
    );
  }

  for (const name of actual) {
    if (!TEXT_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    assertPublicText(name, await readFile(join(releaseDir, name), "utf8"));
  }
};
