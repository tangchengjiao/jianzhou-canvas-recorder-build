import { isTauri } from "@tauri-apps/api/core";
import { join, videoDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

export type RecordingDestinationMode = "download" | "folder";
export type RecordingDirectoryPermission =
  | "granted"
  | "prompt"
  | "denied"
  | "unsupported";

type PermissionCapableHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) =>
    Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) =>
    Promise<PermissionState>;
};

export type NativeRecordingDirectory = {
  readonly kind: "tauri-directory";
  readonly name: string;
  readonly path: string;
};

export type RecordingDirectorySelection =
  | FileSystemDirectoryHandle
  | NativeRecordingDirectory;

const isNativeRecordingDirectory = (
  handle: RecordingDirectorySelection,
): handle is NativeRecordingDirectory =>
  "kind" in handle && handle.kind === "tauri-directory";

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: "read" | "readwrite";
      startIn?: FileSystemHandle | "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
    }) => Promise<FileSystemDirectoryHandle>;
  };

const DATABASE_NAME = "excalidraw-recorder-preferences";
const STORE_NAME = "file-handles";
const DIRECTORY_KEY = "recording-output-directory";
const DATABASE_VERSION = 1;

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("无法打开保存位置配置。"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });

const runStoreRequest = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) => {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("保存位置配置操作失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("保存位置配置事务已中止。"));
    });
  } finally {
    database.close();
  }
};

export const isDirectoryPickerSupported = () =>
  isTauri() ||
  typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";

export const chooseRecordingDirectory = async () => {
  if (isTauri()) {
    const selected = await open({
      title: "选择录制文件保存文件夹",
      directory: true,
      multiple: false,
      recursive: false,
      defaultPath: await videoDir().catch(() => undefined),
    });
    if (!selected) throw new DOMException("用户取消了文件夹选择。", "AbortError");
    const normalized = selected.replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/);
    return {
      kind: "tauri-directory",
      path: selected,
      name: segments.at(-1) || selected,
    } satisfies NativeRecordingDirectory;
  }
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("当前浏览器不支持直接保存到指定文件夹。请使用最新版 Edge 或 Chrome。");
  const handle = await picker({
    id: "excalidraw-recorder-output",
    mode: "readwrite",
    startIn: "videos",
  });
  await saveRecordingDirectoryHandle(handle);
  return handle;
};

export const saveRecordingDirectoryHandle = (
  handle: RecordingDirectorySelection,
) => {
  // Tauri dialog scopes intentionally expire when the desktop app exits.
  // Re-selecting the folder on the next launch avoids permanent broad fs scope.
  if (isNativeRecordingDirectory(handle)) return Promise.resolve();
  return runStoreRequest("readwrite", (store) => store.put(handle, DIRECTORY_KEY));
};

export const loadRecordingDirectoryHandle = () => {
  if (isTauri()) return Promise.resolve(null);
  return runStoreRequest<FileSystemDirectoryHandle | undefined>(
    "readonly",
    (store) => store.get(DIRECTORY_KEY),
  ).then((handle) => handle ?? null);
};

export const clearRecordingDirectoryHandle = () =>
  runStoreRequest("readwrite", (store) => store.delete(DIRECTORY_KEY));

export const queryRecordingDirectoryPermission = async (
  handle: RecordingDirectorySelection,
): Promise<RecordingDirectoryPermission> => {
  if (isNativeRecordingDirectory(handle)) return "granted";
  const permissionHandle = handle as PermissionCapableHandle;
  if (!permissionHandle.queryPermission) return "granted";
  return permissionHandle.queryPermission({ mode: "readwrite" });
};

export const requestRecordingDirectoryPermission = async (
  handle: RecordingDirectorySelection,
) => {
  if (isNativeRecordingDirectory(handle)) return true;
  const permissionHandle = handle as PermissionCapableHandle;
  const current = await queryRecordingDirectoryPermission(handle);
  if (current === "granted") return true;
  if (!permissionHandle.requestPermission) return false;
  return (
    (await permissionHandle.requestPermission({ mode: "readwrite" })) ===
    "granted"
  );
};

export const writeRecordingToDirectory = async (
  handle: RecordingDirectorySelection,
  blob: Blob,
  filename: string,
) => {
  if (isNativeRecordingDirectory(handle)) {
    if (filename !== filename.replace(/[\\/:*?"<>|]/g, "_")) {
      throw new Error("录制文件名包含不安全字符。");
    }
    const outputPath = await join(handle.path, filename);
    await writeFile(outputPath, new Uint8Array(await blob.arrayBuffer()));
    return { filename, directoryName: handle.name, bytes: blob.size };
  }
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
  return { filename, directoryName: handle.name, bytes: blob.size };
};
