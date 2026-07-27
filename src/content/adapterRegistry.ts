import { ImageContentAdapter } from "./imageAdapter";
import { MarkdownContentAdapter } from "./markdownAdapter";
import { PdfContentAdapter } from "./pdfAdapter";
import { StaticHtmlContentAdapter } from "./staticHtmlAdapter";
import {
  ContentAdapterError,
  type ContentAdapter,
  type ContentKind,
} from "./types";
import type { DocumentPresentationSettings } from "../shared/presentation";

export type LocalAssetResolution = {
  blob: Blob;
  mimeType?: string;
};

export type ContentAdapterOpenContext = {
  /** Stable project asset id used while restoring a persisted source. */
  adapterId?: string;
  /** Layout chosen by the presenter for controlled document formats. */
  presentation?: DocumentPresentationSettings;
  /**
   * Resolves a project-relative reference such as `images/chart.png`.
   * Implementations must keep the lookup inside the selected project root.
   */
  resolveLocalAsset?: (
    relativePath: string,
    sourceFile: File,
  ) => Promise<LocalAssetResolution | null>;
  signal?: AbortSignal;
};

export type ContentAdapterRegistration = {
  /** Stable identifier used in diagnostics and migration reports. */
  id: string;
  kind: ContentKind;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  priority?: number;
  accepts?: (file: File) => boolean;
  open: (
    file: File,
    context: ContentAdapterOpenContext,
  ) => Promise<ContentAdapter>;
};

const normalizeExtension = (value: string) =>
  value.trim().toLowerCase().replace(/^\./, "");

const getFileExtension = (fileName: string) => {
  const cleanName = fileName.trim().toLowerCase();
  const dot = cleanName.lastIndexOf(".");
  return dot > -1 && dot < cleanName.length - 1
    ? cleanName.slice(dot + 1)
    : "";
};

const matchesMimeType = (actual: string, expected: string) => {
  const normalizedActual = actual.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  if (!normalizedActual || !normalizedExpected) return false;
  if (normalizedExpected.endsWith("/*")) {
    return normalizedActual.startsWith(normalizedExpected.slice(0, -1));
  }
  return normalizedActual === normalizedExpected;
};

const assertRegistration = (registration: ContentAdapterRegistration) => {
  if (!registration.id.trim()) {
    throw new TypeError("A content adapter registration id is required.");
  }
  if (!registration.extensions.length && !registration.mimeTypes.length) {
    throw new TypeError(
      `Content adapter registration "${registration.id}" needs an extension or MIME matcher.`,
    );
  }
};

/**
 * Central format router. App code asks this registry to open a local file and
 * no longer carries PDF/image/Markdown conditionals in event handlers.
 */
export class ContentAdapterRegistry {
  private readonly registrations = new Map<
    string,
    ContentAdapterRegistration
  >();

  register(registration: ContentAdapterRegistration): () => void {
    assertRegistration(registration);
    const id = registration.id.trim();
    if (this.registrations.has(id)) {
      throw new TypeError(`Content adapter "${id}" is already registered.`);
    }
    const normalized: ContentAdapterRegistration = {
      ...registration,
      id,
      extensions: registration.extensions.map(normalizeExtension),
      mimeTypes: registration.mimeTypes.map((value) =>
        value.trim().toLowerCase(),
      ),
    };
    this.registrations.set(id, normalized);
    return () => {
      if (this.registrations.get(id) === normalized) {
        this.registrations.delete(id);
      }
    };
  }

  list(): readonly ContentAdapterRegistration[] {
    return this.sortedRegistrations();
  }

  resolve(file: File): ContentAdapterRegistration | null {
    const extension = getFileExtension(file.name);
    const mimeType = file.type.trim().toLowerCase();
    return (
      this.sortedRegistrations().find((registration) => {
        if (registration.accepts && !registration.accepts(file)) return false;
        const mimeMatch = registration.mimeTypes.some((candidate) =>
          matchesMimeType(mimeType, candidate),
        );
        const extensionMatch =
          Boolean(extension) && registration.extensions.includes(extension);
        return mimeMatch || extensionMatch;
      }) ?? null
    );
  }

  supports(file: File) {
    return this.resolve(file) !== null;
  }

  async open(
    file: File,
    context: ContentAdapterOpenContext = {},
  ): Promise<ContentAdapter> {
    if (!(file instanceof File)) {
      throw new ContentAdapterError(
        "INVALID_INPUT",
        "A local File is required to open course content.",
      );
    }
    if (context.signal?.aborted) {
      throw new ContentAdapterError("ABORTED", "Opening content was cancelled.", {
        cause: context.signal.reason,
      });
    }
    const registration = this.resolve(file);
    if (!registration) {
      const extension = getFileExtension(file.name);
      throw new ContentAdapterError(
        "UNSUPPORTED_FORMAT",
        extension
          ? `The .${extension} format is not supported by an installed content adapter.`
          : "The selected file format is not supported by an installed content adapter.",
      );
    }
    try {
      return await registration.open(file, context);
    } catch (error) {
      if (error instanceof ContentAdapterError) throw error;
      throw new ContentAdapterError(
        "LOAD_FAILED",
        `The ${registration.kind} adapter could not open "${file.name}".`,
        { cause: error },
      );
    }
  }

  private sortedRegistrations() {
    return [...this.registrations.values()].sort(
      (left, right) => (right.priority ?? 0) - (left.priority ?? 0),
    );
  }
}

export const createDefaultContentAdapterRegistry = () => {
  const registry = new ContentAdapterRegistry();
  registry.register({
    id: "builtin-pdf",
    kind: "pdf",
    extensions: ["pdf"],
    mimeTypes: ["application/pdf"],
    priority: 20,
    open: (file, context) =>
      PdfContentAdapter.load(file, {
        id: context.adapterId,
        title: file.name,
        maxFrameWidth: 1_920,
        maxFrameHeight: 1_920,
        pageCacheSize: 3,
        thumbnailCacheSize: 24,
      }),
  });
  registry.register({
    id: "builtin-static-html",
    kind: "html",
    extensions: ["html", "htm"],
    mimeTypes: ["text/html", "application/xhtml+xml"],
    priority: 16,
    open: (file, context) =>
      StaticHtmlContentAdapter.load(file, {
        id: context.adapterId,
        title: file.name,
        signal: context.signal,
        orientation: context.presentation?.orientation,
        resolveLocalAsset: context.resolveLocalAsset
          ? async (relativePath) =>
              (await context.resolveLocalAsset?.(relativePath, file))?.blob ?? null
          : undefined,
      }),
  });
  registry.register({
    id: "builtin-markdown",
    kind: "markdown",
    extensions: ["md", "markdown"],
    mimeTypes: ["text/markdown", "text/x-markdown"],
    priority: 15,
    open: (file, context) =>
      MarkdownContentAdapter.load(file, {
        id: context.adapterId,
        title: file.name,
        signal: context.signal,
        ...context.presentation,
        resolveLocalImage: context.resolveLocalAsset
          ? async (relativePath) =>
              (await context.resolveLocalAsset?.(relativePath, file))?.blob ??
              null
          : undefined,
      }),
  });
  registry.register({
    id: "builtin-image",
    kind: "image",
    extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
    mimeTypes: ["image/*"],
    priority: 10,
    // SVG is document markup rather than a passive bitmap. It needs its own
    // sanitizer before it can join this allow-list.
    accepts: (file) =>
      getFileExtension(file.name) !== "svg" &&
      file.type.trim().toLowerCase() !== "image/svg+xml",
    open: (file, context) =>
      ImageContentAdapter.load(file, {
        id: context.adapterId,
        title: file.name,
        mimeType: file.type || undefined,
      }),
  });
  return registry;
};
