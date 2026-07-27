import {
  COURSE_PROJECT_SCHEMA_VERSION,
  CourseProjectSchemaError,
  createCourseProject,
  parseCourseProject,
  readCourseProject,
  tryReadCourseProject,
} from "./courseProject";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`CourseProject contract failed: ${message}`);
}

/**
 * Browser-callable schema smoke helper. It deliberately has no UI dependency,
 * so Playwright can invoke it through a dynamic Vite import.
 */
export const runCourseProjectSchemaContract = () => {
  const current = createCourseProject({
    id: "contract-project",
    title: "Contract project",
    now: 1_700_000_000_000,
  });
  const roundTrip = parseCourseProject(JSON.parse(JSON.stringify(current)));
  assert(roundTrip.schemaVersion === COURSE_PROJECT_SCHEMA_VERSION, "current version");
  assert(roundTrip.id === current.id, "JSON round trip preserves id");
  assert(roundTrip.outputProfile.width === 1280, "default output width");
  assert(roundTrip.outputProfile.height === 720, "default output height");

  const legacy = readCourseProject({
    id: "legacy-project",
    title: "Legacy project",
    savedAt: 1_700_000_000_500,
    assetId: "legacy-pdf",
    kind: "pdf",
    fileName: "lesson.pdf",
    mimeType: "application/pdf",
    currentPage: 1,
    pageCount: 3,
    fitMode: "contain",
    annotationsByPage: {},
    presentation: null,
    teleprompterText: "Hello",
  });
  assert(legacy.migratedFromVersion === 0, "legacy version is reported");
  assert(legacy.project.sources.length === 1, "legacy source is migrated");
  assert(legacy.project.sources[0].currentPageIndex === 1, "legacy page is preserved");
  assert(legacy.project.teleprompter.text === "Hello", "legacy script is preserved");

  const future = tryReadCourseProject({ schemaVersion: 99 });
  assert(!future.ok, "future version is rejected");
  if (future.ok) throw new Error("Unreachable future-version branch.");
  assert(future.readOnly, "future version requests read-only handling");
  assert(
    future.error instanceof CourseProjectSchemaError &&
      future.error.code === "UNSUPPORTED_NEWER_VERSION",
    "future version has a stable error code",
  );

  return {
    schemaVersion: COURSE_PROJECT_SCHEMA_VERSION,
    roundTripProjectId: roundTrip.id,
    migratedLegacySourceCount: legacy.project.sources.length,
    futureReadOnly: future.readOnly,
  };
};
