import { Excalidraw } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CaptureRegionOverlay } from "./components/CaptureRegionOverlay";
import {
  DocumentStage,
  type DocumentFitMode,
  type DocumentGestureEvent,
  type DocumentStageHandle,
} from "./components/DocumentStage";
import { DocumentToolbar } from "./components/DocumentToolbar";
import { FloatingTeleprompter } from "./components/FloatingTeleprompter";
import {
  SourceRail,
  type SourceKind,
  type SourceRailPage,
} from "./components/SourceRail";
import {
  type AnnotationStroke,
  type PresentationTool,
} from "./content/annotations";
import {
  type ContentAdapter,
  type SourceFrame,
  type SourceThumbnail,
} from "./content/types";
import { createDefaultContentAdapterRegistry } from "./content/adapterRegistry";
import { CameraPlanner, type CameraStrength } from "./core/cameraPlanner";
import {
  findSceneCanvas,
  getExcalidrawSourceFrame,
  RecordingCompositor,
  type CompositorStats,
  type SceneSourceFrame,
  type WebcamPlacement,
  type WebcamPosition,
  type WebcamShape,
  type WebcamSize,
} from "./core/compositor";
import {
  downloadDiagnostics,
  installGlobalDiagnostics,
  recordDiagnostic,
} from "./core/diagnostics";
import {
  mapMediaInputError,
  MediaInputManager,
  type MediaInputDevices,
} from "./core/mediaInputs";
import {
  clearDocumentSession,
  clearDocumentSessionAndAsset,
  loadDocumentAsset,
  loadDocumentSession,
  loadProjectSnapshot,
  replaceDocumentAssetAndSession,
  saveDocumentSession,
  saveProjectSnapshot,
  type DocumentSession,
  type ProjectSnapshot,
} from "./core/projectStore";
import { CourseProjectCoordinator } from "./core/projectCoordinator";
import type { TeleprompterProjectState } from "./core/courseProject";
import {
  ASPECT_PRESETS,
  CANVAS_STYLES,
  createCaptureRegionForAspect,
  createCustomAspect,
  createOutputProfile,
  fitCaptureRegionToAspect,
  getAspectLabel,
  getAspectRatio,
  type AspectChoice,
  type CanvasStyle,
  type CaptureRegion,
} from "./core/outputProfile";
import {
  CanvasRecorder,
  createRecordingFilename,
  downloadRecording,
} from "./core/recorder";
import {
  canUseOPFSRecordingSink,
  deleteOPFSRecordingSession,
  estimateRecordingStorage,
  inspectOPFSRecordingJournals,
  readOPFSRecordingBytes,
  requestPersistentRecordingStorage,
  type OPFSRecordingInspection,
  type RecordingSinkStats,
  type RecordingStorageEstimate,
} from "./core/recordingSink";
import {
  chooseRecordingDirectory,
  clearRecordingDirectoryHandle,
  isDirectoryPickerSupported,
  loadRecordingDirectoryHandle,
  queryRecordingDirectoryPermission,
  requestRecordingDirectoryPermission,
  writeRecordingToDirectory,
  type RecordingDestinationMode,
  type RecordingDirectorySelection,
  type RecordingDirectoryPermission,
} from "./core/recordingDestination";
import {
  DEFAULT_DOCUMENT_PRESENTATION,
  type DocumentPresentationSettings,
} from "./shared/presentation";

type RecordingState =
  | "idle"
  | "preparing"
  | "countdown"
  | "recording"
  | "paused"
  | "finalizing";

type WorkspacePanel = "settings" | "preview" | null;
type QualityPresetId = "stable" | "high";

const contentAdapterRegistry = createDefaultContentAdapterRegistry();

const getImportedSourceLabel = (kind: Exclude<SourceKind, "whiteboard">) =>
  kind === "pdf"
    ? "PDF"
    : kind === "markdown"
      ? "Markdown"
      : kind === "html"
        ? "HTML 演示"
        : "图片";

type ActivePointer = {
  id: number;
  startX: number;
  startY: number;
};

type PublicPointer = {
  startX: number;
  startY: number;
  startViewportX: number;
  startViewportY: number;
  tool: string;
};

type LastRecording = {
  blob: Blob;
  url: string;
  filename: string;
  mimeType: string;
  durationSeconds: number;
  width: number;
  height: number;
};

type MicrophoneTestState = "idle" | "testing" | "ready" | "error";

const DRAWING_TOOLS = new Set([
  "freedraw",
  "line",
  "arrow",
  "rectangle",
  "ellipse",
  "diamond",
  "laser",
]);

const QUALITY_PRESETS = {
  stable: {
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 4_000_000,
    label: "稳定 720p（推荐）",
  },
  high: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 6_000_000,
    label: "高清 1080p（较高负载）",
  },
} satisfies Record<
  QualityPresetId,
  {
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    label: string;
  }
>;

const EMPTY_DEVICES: MediaInputDevices = {
  cameras: [],
  microphones: [],
};

const WEBCAM_LAYOUT_STORAGE_KEY = "excalidraw-recorder:webcam-layout:v1";
const RECORDING_DESTINATION_MODE_KEY =
  "excalidraw-recorder:recording-destination-mode:v1";
const DEFAULT_WEBCAM_POSITION: WebcamPosition = "bottom-right";

type SavedWebcamLayout = {
  position: WebcamPosition;
  placement: WebcamPlacement | null;
};

const isWebcamPosition = (value: unknown): value is WebcamPosition =>
  value === "top-left" ||
  value === "top-right" ||
  value === "bottom-left" ||
  value === "bottom-right";

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

const loadWebcamLayout = (): SavedWebcamLayout => {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(WEBCAM_LAYOUT_STORAGE_KEY) ?? "null",
    ) as Partial<SavedWebcamLayout> | null;
    const placement = parsed?.placement;
    return {
      position: isWebcamPosition(parsed?.position)
        ? parsed.position
        : DEFAULT_WEBCAM_POSITION,
      placement:
        placement &&
        Number.isFinite(placement.x) &&
        Number.isFinite(placement.y)
          ? { x: clampUnit(placement.x), y: clampUnit(placement.y) }
          : null,
    };
  } catch {
    return { position: DEFAULT_WEBCAM_POSITION, placement: null };
  }
};

const loadRecordingDestinationMode = (): RecordingDestinationMode =>
  localStorage.getItem(RECORDING_DESTINATION_MODE_KEY) === "folder"
    ? "folder"
    : "download";

const CAMERA_STRENGTH_LABEL: Record<CameraStrength, string> = {
  gentle: "柔和 1.25×",
  standard: "标准 1.4×",
  strong: "强调 1.6×",
};

const TOOL_LABELS: Record<string, string> = {
  selection: "选择",
  freedraw: "画笔",
  line: "直线",
  arrow: "箭头",
  rectangle: "矩形",
  ellipse: "椭圆",
  diamond: "菱形",
  text: "文字",
  image: "图片",
  eraser: "橡皮擦",
  hand: "抓手",
  laser: "激光笔",
  pointer: "指针",
  pen: "画笔",
  highlighter: "荧光笔",
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const formatDuration = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const formatBytes = (bytes: number | null) => {
  if (bytes === null || !Number.isFinite(bytes)) return "未知";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
};

const recoveryFileExtension = (mimeType: string) =>
  mimeType.includes("mp4") ? "mp4" : mimeType.includes("webm") ? "webm" : "bin";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const thumbnailToDataUrl = (thumbnail: SourceThumbnail) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(thumbnail.width));
  canvas.height = Math.max(1, Math.round(thumbnail.height));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(thumbnail.source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.76);
};

const loadInitialData = async (): Promise<ExcalidrawInitialDataState> => {
  try {
    const snapshot = await loadProjectSnapshot();
    if (snapshot) {
      return {
        elements: snapshot.elements,
        files: snapshot.files,
        appState: snapshot.appState,
      };
    }
  } catch (error) {
    console.warn("Could not restore the local project", error);
  }

  return {
    appState: {
      viewBackgroundColor: "#ffffff",
    },
  };
};

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const documentStageRef = useRef<DocumentStageHandle>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement>(null);
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const cameraPlannerRef = useRef(new CameraPlanner());
  const compositorRef = useRef<RecordingCompositor | null>(null);
  const recorderRef = useRef(new CanvasRecorder());
  const mediaManagerRef = useRef(new MediaInputManager());
  const activePointerRef = useRef<ActivePointer | null>(null);
  const publicPointerRef = useRef<PublicPointer | null>(null);
  const drawingGestureRef = useRef(false);
  const cameraMonitorRef = useRef<HTMLVideoElement>(null);
  const cameraMonitorContainerRef = useRef<HTMLDivElement>(null);
  const webcamDragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const recordingStateRef = useRef<RecordingState>("idle");
  const cameraEnabledRef = useRef(false);
  const stopRecordingRef = useRef<((reason?: string) => Promise<void>) | null>(
    null,
  );
  const backgroundBlurTimerRef = useRef<number | null>(null);
  const backgroundStopPendingRef = useRef(false);
  const lastRecordingUrlRef = useRef<string | null>(null);
  const activeRecordingManifestIdRef = useRef<string | null>(null);
  const microphoneTestRef = useRef<{
    context: AudioContext;
    frameId: number;
    timeoutId: number;
  } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingProjectSnapshotRef = useRef<ProjectSnapshot | null>(null);
  const projectSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const countdownRunRef = useRef(0);
  const mountedRef = useRef(true);
  const contentAdapterRef = useRef<ContentAdapter | null>(null);
  const contentSourceKindRef = useRef<SourceKind>("whiteboard");
  const contentLoadRunRef = useRef(0);
  const contentNavigationRunRef = useRef(0);
  const documentSaveTimerRef = useRef<number | null>(null);
  const pendingDocumentSessionRef = useRef<DocumentSession | null>(null);
  const documentSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const markdownInputRef = useRef<HTMLInputElement>(null);
  const htmlInputRef = useRef<HTMLInputElement>(null);

  const flushProjectSnapshot = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const snapshot = pendingProjectSnapshotRef.current;
    pendingProjectSnapshotRef.current = null;
    if (!snapshot) return projectSaveChainRef.current;
    projectSaveChainRef.current = projectSaveChainRef.current
      .catch(() => undefined)
      .then(() => saveProjectSnapshot(snapshot))
      .catch((error) => {
        recordDiagnostic(
          "project.save.failed",
          { message: errorMessage(error) },
          "warning",
        );
      });
    return projectSaveChainRef.current;
  }, []);

  const flushDocumentSession = useCallback(() => {
    if (documentSaveTimerRef.current !== null) {
      window.clearTimeout(documentSaveTimerRef.current);
      documentSaveTimerRef.current = null;
    }
    const session = pendingDocumentSessionRef.current;
    pendingDocumentSessionRef.current = null;
    if (!session) return documentSaveChainRef.current;
    documentSaveChainRef.current = documentSaveChainRef.current
      .catch(() => undefined)
      .then(() => saveDocumentSession(session))
      .catch((error) => {
        recordDiagnostic(
          "content.save.failed",
          { message: errorMessage(error) },
          "warning",
        );
      });
    return documentSaveChainRef.current;
  }, []);

  const [panel, setPanel] = useState<WorkspacePanel>("settings");
  const [teleprompterOpen, setTeleprompterOpen] = useState(false);
  const [presentationFallbackOpen, setPresentationFallbackOpen] =
    useState(false);
  const [aspectChoice, setAspectChoice] = useState<AspectChoice>("16:9");
  const [customAspectWidth, setCustomAspectWidth] = useState(16);
  const [customAspectHeight, setCustomAspectHeight] = useState(9);
  const [canvasStyle, setCanvasStyle] =
    useState<CanvasStyle>("clean-white");
  const [captureRegionVisible, setCaptureRegionVisible] = useState(true);
  const [captureRegionEditing, setCaptureRegionEditing] = useState(false);
  const [stageSize, setStageSize] = useState(() => ({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  }));
  const [captureRegion, setCaptureRegion] = useState<CaptureRegion>(() =>
    createCaptureRegionForAspect(
      "16:9",
      Math.max(1, window.innerWidth),
      Math.max(1, window.innerHeight),
    ),
  );
  const [autoZoomEnabled, setAutoZoomEnabled] = useState(true);
  const [cameraStrength, setCameraStrength] =
    useState<CameraStrength>("standard");
  const [includeMicrophone, setIncludeMicrophone] = useState(false);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraMonitorStream, setCameraMonitorStream] =
    useState<MediaStream | null>(null);
  const [keepCameraAfterRecording, setKeepCameraAfterRecording] =
    useState(false);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const initialWebcamLayout = useMemo(loadWebcamLayout, []);
  const [webcamShape, setWebcamShape] = useState<WebcamShape>("circle");
  const [webcamSize, setWebcamSize] = useState<WebcamSize>("medium");
  const [webcamPosition, setWebcamPosition] =
    useState<WebcamPosition>(initialWebcamLayout.position);
  const [webcamPlacement, setWebcamPlacement] =
    useState<WebcamPlacement | null>(initialWebcamLayout.placement);
  const [webcamDragging, setWebcamDragging] = useState(false);
  const [webcamMirror, setWebcamMirror] = useState(true);
  const [devices, setDevices] = useState<MediaInputDevices>(EMPTY_DEVICES);
  const [qualityId, setQualityId] = useState<QualityPresetId>("stable");
  const [recordingState, setRecordingState] =
    useState<RecordingState>("idle");
  const [recordingSinkStatus, setRecordingSinkStatus] =
    useState<RecordingSinkStats | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [activeToolType, setActiveToolType] = useState("selection");
  const [compositorStatus, setCompositorStatus] =
    useState<CompositorStats | null>(null);
  const [lastRecording, setLastRecording] = useState<LastRecording | null>(null);
  const [microphoneTestState, setMicrophoneTestState] =
    useState<MicrophoneTestState>("idle");
  const [microphoneLevelDb, setMicrophoneLevelDb] = useState(-96);
  const [microphonePeakDb, setMicrophonePeakDb] = useState(-96);
  const [editorTheme, setEditorTheme] = useState<"light" | "dark">("light");
  const [notice, setNotice] = useState(
    "稳定模式已就绪。录制控制、提词器和预览都不会进入视频。",
  );
  const [contentSourceKind, setContentSourceKind] =
    useState<SourceKind>("whiteboard");
  const [contentFileName, setContentFileName] = useState("");
  const [documentFrame, setDocumentFrame] = useState<SourceFrame | null>(null);
  const [documentTool, setDocumentTool] =
    useState<PresentationTool>("laser");
  const [documentFitMode, setDocumentFitMode] =
    useState<DocumentFitMode>("contain");
  const [documentPresentationDraft, setDocumentPresentationDraft] =
    useState<DocumentPresentationSettings>(DEFAULT_DOCUMENT_PRESENTATION);
  const [activeDocumentPresentation, setActiveDocumentPresentation] =
    useState<DocumentPresentationSettings>(DEFAULT_DOCUMENT_PRESENTATION);
  const [documentAnnotations, setDocumentAnnotations] = useState<
    Record<number, AnnotationStroke[]>
  >({});
  const [sourceRailPages, setSourceRailPages] = useState<SourceRailPage[]>([]);
  const [sourceRailCollapsed, setSourceRailCollapsed] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [courseProjectReady, setCourseProjectReady] = useState(false);
  const [courseProjectId, setCourseProjectId] = useState<string | null>(null);
  const [courseProjectReadOnlyMessage, setCourseProjectReadOnlyMessage] =
    useState<string | null>(null);
  const [teleprompterInitialState, setTeleprompterInitialState] =
    useState<TeleprompterProjectState | null>(null);
  const [recoverySessions, setRecoverySessions] = useState<
    OPFSRecordingInspection[]
  >([]);
  const [recordingStorage, setRecordingStorage] =
    useState<RecordingStorageEstimate | null>(null);
  const [recordingDestinationMode, setRecordingDestinationMode] =
    useState<RecordingDestinationMode>(loadRecordingDestinationMode);
  const [recordingDirectory, setRecordingDirectory] =
    useState<RecordingDirectorySelection | null>(null);
  const [recordingDirectoryPermission, setRecordingDirectoryPermission] =
    useState<RecordingDirectoryPermission>(
      isDirectoryPickerSupported() ? "prompt" : "unsupported",
    );
  const [recordingDestinationBusy, setRecordingDestinationBusy] =
    useState(false);
  const [recoveryBusySessionId, setRecoveryBusySessionId] = useState<
    string | null
  >(null);
  const projectCoordinatorRef = useRef<CourseProjectCoordinator | null>(null);
  if (!projectCoordinatorRef.current) {
    projectCoordinatorRef.current = new CourseProjectCoordinator({
      onError: (error) => {
        recordDiagnostic(
          "course-project.save.failed",
          { message: error.message },
          "warning",
        );
        setNotice(`课程项目清单保存失败：${error.message}`);
      },
    });
  }

  const initialData = useMemo(() => loadInitialData(), []);
  const outputProfile = useMemo(
    () =>
      createOutputProfile({
        aspect: aspectChoice,
        resolution: qualityId === "stable" ? "720p" : "1080p",
        style: canvasStyle,
        captureRegion,
      }),
    [aspectChoice, canvasStyle, captureRegion, qualityId],
  );
  const quality = {
    ...QUALITY_PRESETS[qualityId],
    width: outputProfile.width,
    height: outputProfile.height,
  };
  const activelyRecording =
    recordingState === "recording" || recordingState === "paused";
  const preparing =
    recordingState === "preparing" || recordingState === "countdown";
  const controlsLocked = preparing || activelyRecording || recordingState === "finalizing";
  const presentationToolType =
    contentSourceKind === "whiteboard" ? activeToolType : documentTool;
  const activeToolSupportsZoom =
    contentSourceKind === "whiteboard"
      ? DRAWING_TOOLS.has(activeToolType)
      : documentTool !== "pointer";
  const activeToolLabel =
    TOOL_LABELS[presentationToolType] ?? presentationToolType;
  const microphoneLevelPercent = Math.max(
    0,
    Math.min(100, ((microphoneLevelDb + 60) / 60) * 100),
  );
  const outputFormatLabel = lastRecording?.mimeType.includes("mp4")
    ? "MP4"
    : lastRecording
      ? "WEBM"
      : "MP4 优先";
  const currentDocumentPageIndex = documentFrame?.pageIndex ?? 0;
  const currentDocumentStrokes =
    documentAnnotations[currentDocumentPageIndex] ?? [];
  const visibleNotice = courseProjectReadOnlyMessage
    ? `${courseProjectReadOnlyMessage} ${notice}`
    : notice;

  const refreshRecoveryCenter = useCallback(async () => {
    try {
      const estimate = await estimateRecordingStorage();
      setRecordingStorage(estimate);
      if (!estimate.supported) {
        setRecoverySessions([]);
        return estimate;
      }
      const sessions = await inspectOPFSRecordingJournals();
      setRecoverySessions(sessions);
      return estimate;
    } catch (error) {
      recordDiagnostic(
        "recording.recovery.inspect.failed",
        { message: errorMessage(error) },
        "warning",
      );
      return null;
    }
  }, []);

  useEffect(() => installGlobalDiagnostics(), []);

  useEffect(() => {
    void refreshRecoveryCenter();
  }, [refreshRecoveryCenter]);

  useEffect(() => {
    localStorage.setItem(
      RECORDING_DESTINATION_MODE_KEY,
      recordingDestinationMode,
    );
  }, [recordingDestinationMode]);

  useEffect(() => {
    if (!isDirectoryPickerSupported()) {
      setRecordingDirectoryPermission("unsupported");
      setRecordingDestinationMode("download");
      return;
    }
    let cancelled = false;
    void loadRecordingDirectoryHandle()
      .then(async (handle) => {
        if (cancelled) return;
        setRecordingDirectory(handle);
        if (!handle) {
          setRecordingDirectoryPermission("prompt");
          if (recordingDestinationMode === "folder") {
            setRecordingDestinationMode("download");
          }
          return;
        }
        const permission = await queryRecordingDirectoryPermission(handle);
        if (!cancelled) setRecordingDirectoryPermission(permission);
      })
      .catch((error) => {
        if (cancelled) return;
        setRecordingDirectory(null);
        setRecordingDirectoryPermission("prompt");
        setRecordingDestinationMode("download");
        recordDiagnostic(
          "recording.destination.restore.failed",
          { message: errorMessage(error) },
          "warning",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const coordinator = projectCoordinatorRef.current;
    if (!coordinator) return;
    let cancelled = false;
    void coordinator.initialize().then((result) => {
      if (cancelled) return;
      setCourseProjectReady(true);
      setCourseProjectId(result.project?.id ?? null);
      setCourseProjectReadOnlyMessage(result.readOnly ? result.message : null);
      if (!result.project) {
        if (result.message) {
          setNotice(result.message);
          recordDiagnostic(
            "course-project.read-only",
            { message: result.message },
            "warning",
          );
        }
        return;
      }

      const profile = result.project.outputProfile;
      setAspectChoice(profile.aspect);
      if (typeof profile.aspect !== "string") {
        setCustomAspectWidth(profile.aspect.width);
        setCustomAspectHeight(profile.aspect.height);
      }
      setCanvasStyle(profile.style);
      setQualityId(profile.resolution === "1080p" ? "high" : "stable");
      setCaptureRegion(profile.captureRegion);
      setTeleprompterInitialState(result.project.teleprompter);
      recordDiagnostic("course-project.ready", {
        id: result.project.id,
        mode: result.mode,
        sourceCount: result.project.sources.length,
        recordingCount: result.project.recordings.length,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!courseProjectReady || courseProjectReadOnlyMessage) return;
    projectCoordinatorRef.current?.setOutputProfile(outputProfile);
  }, [courseProjectReadOnlyMessage, courseProjectReady, outputProfile]);

  const handleTeleprompterProjectState = useCallback(
    (state: TeleprompterProjectState) => {
      if (!courseProjectReady || courseProjectReadOnlyMessage) return;
      const coordinator = projectCoordinatorRef.current;
      coordinator?.setTeleprompter(state);
      // The component already coalesces rapid drag/text changes for 120ms.
      // Flush this project-specific script/geometry immediately afterward so
      // closing or reloading the page cannot leave only the localStorage copy.
      void coordinator?.flush();
    },
    [courseProjectReadOnlyMessage, courseProjectReady],
  );

  useEffect(() => {
    recordingStateRef.current = recordingState;
  }, [recordingState]);

  useEffect(() => {
    if (
      recordingState !== "recording" &&
      recordingState !== "paused" &&
      recordingState !== "finalizing"
    ) {
      return;
    }
    const update = () =>
      setRecordingSinkStatus(recorderRef.current.getRecordingSinkStats());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [recordingState]);

  useEffect(() => {
    contentSourceKindRef.current = contentSourceKind;
    compositorRef.current?.requestSceneRefresh();
    cameraPlannerRef.current.reset();
  }, [contentSourceKind]);

  useEffect(() => {
    cameraEnabledRef.current = cameraEnabled;
  }, [cameraEnabled]);

  useEffect(() => {
    const video = cameraMonitorRef.current;
    if (!video) return;
    video.srcObject = cameraMonitorStream;
    if (cameraMonitorStream) {
      void video.play().catch((error) => {
        recordDiagnostic(
          "camera.monitor.failed",
          { message: errorMessage(error) },
          "warning",
        );
      });
    }
    return () => {
      video.pause();
      video.srcObject = null;
    };
  }, [cameraMonitorStream]);

  useEffect(() => {
    cameraPlannerRef.current.setEnabled(autoZoomEnabled);
  }, [autoZoomEnabled]);

  useEffect(() => {
    cameraPlannerRef.current.setStrength(cameraStrength);
  }, [cameraStrength]);

  useEffect(() => {
    compositorRef.current?.setWebcamConfig({
      enabled: cameraEnabled,
      shape: webcamShape,
      size: webcamSize,
      position: webcamPosition,
      placement: webcamPlacement,
      mirror: webcamMirror,
    });
    compositorRef.current?.requestSceneRefresh();
  }, [
    cameraEnabled,
    webcamMirror,
    webcamPlacement,
    webcamPosition,
    webcamShape,
    webcamSize,
  ]);

  useEffect(() => {
    try {
      localStorage.setItem(
        WEBCAM_LAYOUT_STORAGE_KEY,
        JSON.stringify({
          position: webcamPosition,
          placement: webcamPlacement,
        } satisfies SavedWebcamLayout),
      );
    } catch {
      // Position persistence is a convenience; recording remains available
      // when storage is blocked or full.
    }
  }, [webcamPlacement, webcamPosition]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateStageSize = () => {
      const bounds = stage.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        setStageSize({ width: bounds.width, height: bounds.height });
      }
    };
    updateStageSize();
    const observer = new ResizeObserver(updateStageSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const updateWebcamPlacementFromClient = useCallback(
    (clientX: number, clientY: number, offsetX: number, offsetY: number) => {
      const stage = stageRef.current;
      const monitor = cameraMonitorContainerRef.current;
      if (!stage || !monitor) return;
      const stageBounds = stage.getBoundingClientRect();
      const monitorBounds = monitor.getBoundingClientRect();
      const regionLeft = stageBounds.left + captureRegion.x * stageBounds.width;
      const regionTop = stageBounds.top + captureRegion.y * stageBounds.height;
      const regionWidth = Math.max(1, captureRegion.width * stageBounds.width);
      const regionHeight = Math.max(1, captureRegion.height * stageBounds.height);
      const halfWidth = Math.min(regionWidth / 2, monitorBounds.width / 2);
      const halfHeight = Math.min(regionHeight / 2, monitorBounds.height / 2);
      const minX = halfWidth / regionWidth;
      const maxX = 1 - minX;
      const minY = halfHeight / regionHeight;
      const maxY = 1 - minY;
      const normalizedX = (clientX - offsetX - regionLeft) / regionWidth;
      const normalizedY = (clientY - offsetY - regionTop) / regionHeight;
      setWebcamPlacement({
        x: maxX < minX ? 0.5 : Math.min(maxX, Math.max(minX, normalizedX)),
        y: maxY < minY ? 0.5 : Math.min(maxY, Math.max(minY, normalizedY)),
      });
    },
    [captureRegion],
  );

  const beginWebcamDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (controlsLocked || !cameraEnabled || event.button !== 0) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      webcamDragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - (bounds.left + bounds.width / 2),
        offsetY: event.clientY - (bounds.top + bounds.height / 2),
      };
      setWebcamDragging(true);
    },
    [cameraEnabled, controlsLocked],
  );

  const moveWebcamDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = webcamDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || controlsLocked) return;
      event.preventDefault();
      updateWebcamPlacementFromClient(
        event.clientX,
        event.clientY,
        drag.offsetX,
        drag.offsetY,
      );
    },
    [controlsLocked, updateWebcamPlacementFromClient],
  );

  const finishWebcamDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
      const drag = webcamDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!cancelled) {
        updateWebcamPlacementFromClient(
          event.clientX,
          event.clientY,
          drag.offsetX,
          drag.offsetY,
        );
        setNotice("摄像头位置已固定，并会同步进入成片。开始录制后将自动锁定。");
        recordDiagnostic("camera.placement.changed", { mode: "custom" });
      }
      webcamDragRef.current = null;
      setWebcamDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [updateWebcamPlacementFromClient],
  );

  useEffect(() => {
    // The selection is stored in normalized coordinates, but its physical
    // aspect also depends on the editor stage. Re-fit it after a window/DPI
    // resize so the compositor never has to stretch the selected content.
    setCaptureRegion((current) =>
      fitCaptureRegionToAspect(
        current,
        aspectChoice,
        Math.max(1, stageSize.width),
        Math.max(1, stageSize.height),
      ),
    );
  }, [aspectChoice, stageSize.height, stageSize.width]);

  useEffect(() => {
    const output = outputCanvasRef.current;
    if (!output) return;

    const compositor = new RecordingCompositor(
      output,
      () => {
        const sourceKind = contentSourceKindRef.current;
        if (sourceKind === "whiteboard") {
          return getExcalidrawSourceFrame(stageRef.current);
        }
        const documentSource = documentStageRef.current?.getRenderFrame();
        if (!documentSource) return null;
        return {
          ...documentSource,
          kind: sourceKind,
          backgroundColor: "#f4f3f7",
        } satisfies SceneSourceFrame;
      },
      cameraPlannerRef.current,
    );
    compositor.start();
    compositorRef.current = compositor;
    recordDiagnostic("compositor.started", {
      width: output.width,
      height: output.height,
    });

    return () => {
      compositor.stop();
      compositorRef.current = null;
    };
  }, []);

  useEffect(() => {
    compositorRef.current?.setPreviewActive(panel !== null);
  }, [panel]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;
    compositor.setCaptureRegion(captureRegion);
    compositor.setCanvasStyle(canvasStyle);
    compositor.requestSceneRefresh();
  }, [canvasStyle, captureRegion, outputProfile.height, outputProfile.width]);

  useEffect(() => {
    const update = () => {
      const compositor = compositorRef.current;
      if (compositor) setCompositorStatus(compositor.getStats());
    };
    update();
    const intervalId = window.setInterval(update, 250);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    compositorRef.current?.requestSceneRefresh();
    recordDiagnostic("output.quality", {
      preset: qualityId,
      width: quality.width,
      height: quality.height,
      fps: quality.fps,
    });
  }, [quality.fps, quality.height, quality.width, qualityId]);

  useEffect(() => {
    if (recordingState !== "recording") return;
    const intervalId = window.setInterval(
      () => setDurationSeconds((value) => value + 1),
      1_000,
    );
    return () => window.clearInterval(intervalId);
  }, [recordingState]);

  const refreshDevices = useCallback(async () => {
    try {
      const nextDevices = await mediaManagerRef.current.enumerate();
      if (mountedRef.current) setDevices(nextDevices);
    } catch (error) {
      recordDiagnostic(
        "media.enumerate.failed",
        { message: errorMessage(error) },
        "warning",
      );
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = mediaManagerRef.current.onDeviceChange((event) => {
        if (!mountedRef.current) return;
        if (event.devices) {
          setDevices(event.devices);
        } else {
          recordDiagnostic(
            "media.devicechange.failed",
            { message: event.error.message },
            "warning",
          );
        }
      });
    } catch (error) {
      recordDiagnostic(
        "media.devicechange.unsupported",
        { message: errorMessage(error) },
        "warning",
      );
    }
    return unsubscribe;
  }, [refreshDevices]);

  const startDrawingGesture = useCallback((tool?: string) => {
    if (drawingGestureRef.current) return;
    drawingGestureRef.current = true;
    compositorRef.current?.setDrawingActive(true);
    cameraPlannerRef.current.arm();
    recordDiagnostic("drawing.started", {
      tool: tool ?? excalidrawApiRef.current?.getAppState().activeTool.type,
    });
  }, []);

  const finishDrawingGesture = useCallback((tool?: string) => {
    if (!drawingGestureRef.current) return;
    drawingGestureRef.current = false;
    compositorRef.current?.setDrawingActive(false);
    cameraPlannerRef.current.release();
    recordDiagnostic("drawing.ended", {
      tool: tool ?? excalidrawApiRef.current?.getAppState().activeTool.type,
      camera: cameraPlannerRef.current.getSnapshot(),
    });
  }, []);

  const handlePointerUpdate = useCallback(
    (payload: {
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
    }) => {
      if (contentSourceKindRef.current !== "whiteboard") return;
      const api = excalidrawApiRef.current;
      const appState = api?.getAppState();
      const activeTool =
        payload.pointer.tool === "laser"
          ? "laser"
          : appState?.activeTool.type;
      if (payload.button === "up") {
        if (publicPointerRef.current?.tool === "laser") {
          compositorRef.current?.endLaserTrail();
        }
        publicPointerRef.current = null;
        finishDrawingGesture();
        return;
      }
      if (!activeTool || !DRAWING_TOOLS.has(activeTool)) return;

      const sceneCanvas = findSceneCanvas(stageRef.current);
      if (!appState || !sceneCanvas) return;
      const bounds = sceneCanvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const zoom = appState.zoom.value;
      const viewportX =
        (payload.pointer.x + appState.scrollX) * zoom + appState.offsetLeft;
      const viewportY =
        (payload.pointer.y + appState.scrollY) * zoom + appState.offsetTop;
      const normalized = compositorRef.current?.mapSourcePoint(
        (viewportX - bounds.left) / bounds.width,
        (viewportY - bounds.top) / bounds.height,
      );
      if (!normalized) return;
      compositorRef.current?.setCursor(normalized.x, normalized.y);

      if (!publicPointerRef.current) {
        publicPointerRef.current = {
          startX: payload.pointer.x,
          startY: payload.pointer.y,
          startViewportX: viewportX,
          startViewportY: viewportY,
          tool: activeTool,
        };
        startDrawingGesture();
        if (activeTool === "laser") {
          compositorRef.current?.beginLaserTrail(normalized.x, normalized.y);
        }
        return;
      }

      const distance = Math.hypot(
        viewportX - publicPointerRef.current.startViewportX,
        viewportY - publicPointerRef.current.startViewportY,
      );
      cameraPlannerRef.current.move(normalized.x, normalized.y, distance);
      if (publicPointerRef.current.tool === "laser") {
        compositorRef.current?.appendLaserPoint(normalized.x, normalized.y);
      }
    },
    [finishDrawingGesture, startDrawingGesture],
  );

  const handleDocumentGesture = useCallback(
    ({ phase, stroke, stageStroke }: DocumentGestureEvent) => {
      const first = stageStroke.points[0];
      const last = stageStroke.points[stageStroke.points.length - 1];
      if (!first || !last) return;
      const normalized = compositorRef.current?.mapSourcePoint(last.x, last.y);
      if (!normalized) return;

      compositorRef.current?.setCursor(normalized.x, normalized.y);
      if (phase === "start") {
        startDrawingGesture(stroke.tool);
        if (stroke.tool === "laser") {
          compositorRef.current?.beginLaserTrail(normalized.x, normalized.y);
        }
        return;
      }

      if (phase === "update") {
        const distance = Math.hypot(
          (last.x - first.x) * stageSize.width,
          (last.y - first.y) * stageSize.height,
        );
        cameraPlannerRef.current.move(normalized.x, normalized.y, distance);
        if (stroke.tool === "laser") {
          compositorRef.current?.appendLaserPoint(normalized.x, normalized.y);
        }
        return;
      }

      if (stroke.tool === "laser") compositorRef.current?.endLaserTrail();
      finishDrawingGesture(stroke.tool);
    },
    [
      finishDrawingGesture,
      stageSize.height,
      stageSize.width,
      startDrawingGesture,
    ],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const normalizedPointer = (event: PointerEvent) => {
      const sceneCanvas = findSceneCanvas(stage);
      if (!sceneCanvas) return null;
      const bounds = sceneCanvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      const point = {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      };
      return compositorRef.current?.mapSourcePoint(point.x, point.y) ?? point;
    };

    const isCanvasEvent = (event: PointerEvent) =>
      contentSourceKindRef.current === "whiteboard" &&
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof HTMLCanvasElement && stage.contains(target),
        );

    const onPointerDown = (event: PointerEvent) => {
      if (!isCanvasEvent(event) || event.button !== 0) return;
      const normalized = normalizedPointer(event);
      if (normalized) {
        compositorRef.current?.setCursor(normalized.x, normalized.y);
      }

      const activeTool = excalidrawApiRef.current?.getAppState().activeTool.type;
      if (!activeTool || !DRAWING_TOOLS.has(activeTool)) return;
      if (activeTool === "laser") return;

      activePointerRef.current = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      startDrawingGesture();
    };

    const onPointerMove = (event: PointerEvent) => {
      const normalized = normalizedPointer(event);
      if (normalized) {
        compositorRef.current?.setCursor(normalized.x, normalized.y);
      }

      const activePointer = activePointerRef.current;
      if (!activePointer || activePointer.id !== event.pointerId || !normalized) {
        return;
      }
      const distance = Math.hypot(
        event.clientX - activePointer.startX,
        event.clientY - activePointer.startY,
      );
      cameraPlannerRef.current.move(normalized.x, normalized.y, distance);
    };

    const finishPointer = (event: PointerEvent) => {
      if (activePointerRef.current?.id === event.pointerId) {
        activePointerRef.current = null;
      }
      if (publicPointerRef.current?.tool === "laser") {
        compositorRef.current?.endLaserTrail();
      }
      if (publicPointerRef.current) publicPointerRef.current = null;
      finishDrawingGesture();
    };

    const cancelAllPointers = () => {
      activePointerRef.current = null;
      publicPointerRef.current = null;
      compositorRef.current?.endLaserTrail();
      finishDrawingGesture();
    };

    const onPointerLeave = () => {
      if (!activePointerRef.current) {
        const snapshot = cameraPlannerRef.current.getSnapshot();
        compositorRef.current?.setCursor(
          snapshot.focusX,
          snapshot.focusY,
          false,
        );
      }
    };

    stage.addEventListener("pointerdown", onPointerDown, true);
    stage.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", finishPointer, true);
    window.addEventListener("pointercancel", finishPointer, true);
    window.addEventListener("blur", cancelAllPointers, true);
    stage.addEventListener("pointerleave", onPointerLeave, true);

    return () => {
      stage.removeEventListener("pointerdown", onPointerDown, true);
      stage.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", finishPointer, true);
      window.removeEventListener("pointercancel", finishPointer, true);
      window.removeEventListener("blur", cancelAllPointers, true);
      stage.removeEventListener("pointerleave", onPointerLeave, true);
    };
  }, [finishDrawingGesture, startDrawingGesture]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      countdownRunRef.current += 1;
      void flushProjectSnapshot();
      void flushDocumentSession();
      void projectCoordinatorRef.current?.flush();
      if (backgroundBlurTimerRef.current !== null) {
        window.clearTimeout(backgroundBlurTimerRef.current);
      }
      const microphoneTest = microphoneTestRef.current;
      if (microphoneTest) {
        window.cancelAnimationFrame(microphoneTest.frameId);
        window.clearTimeout(microphoneTest.timeoutId);
        void microphoneTest.context.close().catch(() => undefined);
      }
      if (lastRecordingUrlRef.current) {
        URL.revokeObjectURL(lastRecordingUrlRef.current);
      }
      recorderRef.current.abort();
      mediaManagerRef.current.dispose();
      void contentAdapterRef.current?.dispose();
      contentAdapterRef.current = null;
      compositorRef.current?.setFrameCommitListener(null);
    },
    [flushDocumentSession, flushProjectSnapshot],
  );

  const handleSceneChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      compositorRef.current?.requestSceneRefresh(appState.viewBackgroundColor);
      setEditorTheme(appState.theme);
      setActiveToolType(appState.activeTool.type);

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }

      const snapshot = {
        elements: [...elements],
        files: { ...files },
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom,
          theme: appState.theme,
          gridSize: appState.gridSize,
          gridStep: appState.gridStep,
          gridModeEnabled: appState.gridModeEnabled,
        },
        savedAt: Date.now(),
      };

      pendingProjectSnapshotRef.current = snapshot;
      if (
        courseProjectReady &&
        contentSourceKindRef.current === "whiteboard" &&
        !courseProjectReadOnlyMessage
      ) {
        projectCoordinatorRef.current?.touchWhiteboard();
      }
      saveTimerRef.current = window.setTimeout(() => {
        void flushProjectSnapshot();
      }, 650);
    },
    [courseProjectReadOnlyMessage, courseProjectReady, flushProjectSnapshot],
  );

  const populateSourceThumbnails = useCallback(
    async (adapter: ContentAdapter, runId: number) => {
      const pageCount = adapter.getMetadata().pageCount;
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        if (
          contentLoadRunRef.current !== runId ||
          contentAdapterRef.current !== adapter
        ) {
          return;
        }
        try {
          const thumbnail = await adapter.getThumbnail(pageIndex, {
            maxWidth: 184,
            maxHeight: 126,
          });
          const thumbnailUrl = thumbnailToDataUrl(thumbnail);
          if (
            contentLoadRunRef.current !== runId ||
            contentAdapterRef.current !== adapter
          ) {
            return;
          }
          setSourceRailPages((pages) =>
            pages.map((page) =>
              page.pageNumber === pageIndex + 1
                ? { ...page, thumbnailUrl, thumbnailStatus: "ready" }
                : page,
            ),
          );
        } catch {
          if (contentLoadRunRef.current !== runId) return;
          setSourceRailPages((pages) =>
            pages.map((page) =>
              page.pageNumber === pageIndex + 1
                ? { ...page, thumbnailStatus: "error" }
                : page,
            ),
          );
        }
      }
    },
    [],
  );

  const openDocumentBlob = useCallback(
    async (
      blob: Blob,
      kind: Exclude<SourceKind, "whiteboard">,
      fileName: string,
      options?: { session?: DocumentSession; persistAsset?: boolean },
    ) => {
      const runId = ++contentLoadRunRef.current;
      setContentLoading(true);
      setContentError(null);
      setNotice(`正在载入 ${getImportedSourceLabel(kind)}…`);

      try {
        const session = options?.session;
        const file =
          blob instanceof File
            ? blob
            : new File([blob], fileName, {
                type: blob.type || session?.mimeType || "application/octet-stream",
              });
        const requestedPresentation =
          session?.presentation ?? documentPresentationDraft;
        const adapter = await contentAdapterRegistry.open(file, {
          adapterId: session?.assetId,
          presentation:
            kind === "markdown" || kind === "html"
              ? requestedPresentation
              : undefined,
        });
        if (adapter.kind !== kind) {
          await adapter.dispose();
          throw new Error(
            `文件内容识别为 ${adapter.kind}，与所选的 ${kind} 导入入口不一致。`,
          );
        }

        let frame = adapter.getFrame() ?? (await adapter.prepareFrame());
        if (session && session.currentPage > 0 && adapter.getMetadata().pageCount > 1) {
          frame = await adapter.navigate({
            type: "page",
            pageIndex: session.currentPage,
          });
        }
        if (contentLoadRunRef.current !== runId) {
          await adapter.dispose();
          return;
        }

        const previousAdapter = contentAdapterRef.current;
        const previousAssetId = previousAdapter?.id;
        const nextFitMode = session?.fitMode ?? "contain";
        const nextAnnotations = session
          ? Object.fromEntries(
              Object.entries(session.annotationsByPage).map(([page, strokes]) => [
                Number(page),
                strokes,
              ]),
            )
          : {};
        if (options?.persistAsset !== false) {
          if (documentSaveTimerRef.current !== null) {
            window.clearTimeout(documentSaveTimerRef.current);
            documentSaveTimerRef.current = null;
          }
          // Do not allow a debounced save for the previous document to race
          // and overwrite the new atomically committed asset/session pair.
          pendingDocumentSessionRef.current = null;
          await documentSaveChainRef.current.catch(() => undefined);
          await replaceDocumentAssetAndSession(
            blob,
            {
              assetId: adapter.id,
              kind,
              fileName,
              mimeType: adapter.getMetadata().mimeType,
              currentPage: frame.pageIndex,
              fitMode: nextFitMode,
              annotationsByPage: nextAnnotations,
              presentation:
                kind === "markdown" || kind === "html"
                  ? requestedPresentation
                  : undefined,
              savedAt: Date.now(),
            },
            previousAssetId,
          );
        }
        if (contentLoadRunRef.current !== runId) {
          await adapter.dispose();
          return;
        }

        contentAdapterRef.current = adapter;
        setContentSourceKind(kind);
        setContentFileName(fileName);
        setDocumentFrame(frame);
        setDocumentFitMode(nextFitMode);
        if (kind === "markdown" || kind === "html") {
          setActiveDocumentPresentation(requestedPresentation);
          setDocumentPresentationDraft(requestedPresentation);
        }
        setDocumentAnnotations(nextAnnotations);
        setDocumentTool("laser");
        setSourceRailCollapsed(false);
        setSourceRailPages(
          Array.from(
            { length: adapter.getMetadata().pageCount },
            (_, pageIndex) => ({
              id: `${adapter.id}:page:${pageIndex}`,
              pageNumber: pageIndex + 1,
              label:
                kind === "image" ? fileName : `第 ${pageIndex + 1} 页`,
              thumbnailStatus: "loading" as const,
            }),
          ),
        );
        setNotice(
          kind === "image"
            ? "图片已载入。可使用激光笔、画笔或荧光笔讲解。"
            : `${getImportedSourceLabel(kind)} 已载入，共 ${adapter.getMetadata().pageCount} 页。可翻页、批注并直接录制。`,
        );
        recordDiagnostic("content.opened", {
          kind,
          pageCount: adapter.getMetadata().pageCount,
          fileName,
        });
        cameraPlannerRef.current.reset();
        compositorRef.current?.requestSceneRefresh();
        void populateSourceThumbnails(adapter, runId);
        if (previousAdapter && previousAdapter !== adapter) {
          void previousAdapter.dispose();
        }
      } catch (error) {
        if (contentLoadRunRef.current !== runId) return;
        const message = errorMessage(error);
        setContentError(message);
        setNotice(`内容载入失败：${message}`);
        recordDiagnostic("content.open.failed", { kind, message }, "error");
      } finally {
        if (contentLoadRunRef.current === runId) setContentLoading(false);
      }
    },
    [documentPresentationDraft, populateSourceThumbnails],
  );

  const handleDocumentFile = useCallback(
    (kind: Exclude<SourceKind, "whiteboard">, file: File | undefined) => {
      if (!file || controlsLocked) return;
      const registration = contentAdapterRegistry.resolve(file);
      if (!registration || registration.kind !== kind) {
        const message = `请选择有效的 ${getImportedSourceLabel(kind)} 文件。`;
        setContentError(message);
        setNotice(message);
        return;
      }
      void openDocumentBlob(file, kind, file.name);
    },
    [controlsLocked, openDocumentBlob],
  );

  const returnToWhiteboard = useCallback(() => {
    if (controlsLocked) return;
    const adapter = contentAdapterRef.current;
    const assetId = adapter?.id;
    contentLoadRunRef.current += 1;
    contentNavigationRunRef.current += 1;
    contentAdapterRef.current = null;
    void adapter?.dispose();
    setContentSourceKind("whiteboard");
    setContentFileName("");
    setDocumentFrame(null);
    setDocumentAnnotations({});
    setSourceRailPages([]);
    setContentError(null);
    setContentLoading(false);
    cameraPlannerRef.current.reset();
    compositorRef.current?.clearLaserTrail();
    compositorRef.current?.requestSceneRefresh();
    if (documentSaveTimerRef.current !== null) {
      window.clearTimeout(documentSaveTimerRef.current);
      documentSaveTimerRef.current = null;
    }
    pendingDocumentSessionRef.current = null;
    if (courseProjectReady && !courseProjectReadOnlyMessage) {
      projectCoordinatorRef.current?.setWhiteboardActive({
        removeDocumentAssetId: assetId,
      });
    }
    const clearOperation = documentSaveChainRef.current
      .catch(() => undefined)
      .then(() => clearDocumentSessionAndAsset(assetId));
    documentSaveChainRef.current = clearOperation.catch((error) => {
      recordDiagnostic(
        "content.clear.failed",
        { message: errorMessage(error) },
        "warning",
      );
    });
    setNotice("已返回 Excalidraw 白板。原白板内容保持不变。 ");
  }, [controlsLocked, courseProjectReadOnlyMessage, courseProjectReady]);

  const navigateDocument = useCallback(async (pageNumber: number) => {
    const adapter = contentAdapterRef.current;
    if (!adapter || adapter.getMetadata().pageCount <= 1) return;
    const pageIndex = Math.min(
      adapter.getMetadata().pageCount - 1,
      Math.max(0, Math.round(pageNumber) - 1),
    );
    if (pageIndex === adapter.getMetadata().currentPageIndex) return;
    const runId = ++contentNavigationRunRef.current;
    setContentLoading(true);
    setContentError(null);
    try {
      const frame = await adapter.navigate({ type: "page", pageIndex });
      if (
        runId !== contentNavigationRunRef.current ||
        contentAdapterRef.current !== adapter
      ) {
        return;
      }
      setDocumentFrame(frame);
      cameraPlannerRef.current.reset();
      compositorRef.current?.clearLaserTrail();
      compositorRef.current?.requestSceneRefresh();
      setNotice(`已切换到第 ${pageIndex + 1} 页。`);
      recordDiagnostic("content.page.changed", {
        pageIndex,
        pageCount: frame.pageCount,
      });
    } catch (error) {
      if (runId !== contentNavigationRunRef.current) return;
      const message = errorMessage(error);
      setContentError(message);
      setNotice(`翻页失败：${message}`);
    } finally {
      if (runId === contentNavigationRunRef.current) setContentLoading(false);
    }
  }, []);

  const commitDocumentStroke = useCallback((stroke: AnnotationStroke) => {
    setDocumentAnnotations((current) => ({
      ...current,
      [stroke.pageIndex]: [...(current[stroke.pageIndex] ?? []), stroke],
    }));
    compositorRef.current?.requestSceneRefresh();
  }, []);

  const undoDocumentStroke = useCallback(() => {
    const pageIndex = documentFrame?.pageIndex ?? 0;
    setDocumentAnnotations((current) => ({
      ...current,
      [pageIndex]: (current[pageIndex] ?? []).slice(0, -1),
    }));
    compositorRef.current?.requestSceneRefresh();
  }, [documentFrame?.pageIndex]);

  const clearDocumentStrokes = useCallback(() => {
    const pageIndex = documentFrame?.pageIndex ?? 0;
    setDocumentAnnotations((current) => ({ ...current, [pageIndex]: [] }));
    compositorRef.current?.requestSceneRefresh();
  }, [documentFrame?.pageIndex]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await loadDocumentSession();
        if (!session || cancelled || contentAdapterRef.current) return;
        const asset = await loadDocumentAsset(session.assetId);
        if (!asset || cancelled) {
          await clearDocumentSession();
          return;
        }
        await openDocumentBlob(asset, session.kind, session.fileName, {
          session,
          persistAsset: false,
        });
      } catch (error) {
        if (cancelled) return;
        recordDiagnostic(
          "content.restore.failed",
          { message: errorMessage(error) },
          "warning",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openDocumentBlob]);

  useEffect(() => {
    if (contentSourceKind === "whiteboard" || !documentFrame) return;
    const adapter = contentAdapterRef.current;
    if (!adapter) return;
    if (documentSaveTimerRef.current !== null) {
      window.clearTimeout(documentSaveTimerRef.current);
    }
    const session: DocumentSession = {
      assetId: adapter.id,
      kind: contentSourceKind,
      fileName: contentFileName,
      mimeType: adapter.getMetadata().mimeType,
      currentPage: documentFrame.pageIndex,
      fitMode: documentFitMode,
      annotationsByPage: Object.fromEntries(
        Object.entries(documentAnnotations).map(([page, strokes]) => [
          page,
          strokes,
        ]),
      ),
      presentation:
        contentSourceKind === "markdown" || contentSourceKind === "html"
          ? activeDocumentPresentation
          : undefined,
      savedAt: Date.now(),
    };
    if (courseProjectReady && !courseProjectReadOnlyMessage) {
      projectCoordinatorRef.current?.setDocumentSource({
        assetId: adapter.id,
        kind: contentSourceKind,
        fileName: contentFileName,
        mimeType: adapter.getMetadata().mimeType,
        pageCount: adapter.getMetadata().pageCount,
        currentPageIndex: documentFrame.pageIndex,
        fitMode: documentFitMode,
        annotationsByPage: session.annotationsByPage,
        presentation: session.presentation,
      });
    }
    pendingDocumentSessionRef.current = session;
    documentSaveTimerRef.current = window.setTimeout(() => {
      void flushDocumentSession();
    }, 420);
    return () => {
      if (documentSaveTimerRef.current !== null) {
        window.clearTimeout(documentSaveTimerRef.current);
        documentSaveTimerRef.current = null;
      }
    };
  }, [
    contentFileName,
    contentSourceKind,
    courseProjectReadOnlyMessage,
    courseProjectReady,
    documentAnnotations,
    documentFitMode,
    documentFrame,
    activeDocumentPresentation,
    flushDocumentSession,
  ]);

  useEffect(() => {
    if (contentSourceKind === "whiteboard") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "PageDown" || event.key === "ArrowRight") {
        event.preventDefault();
        void navigateDocument((documentFrame?.pageIndex ?? 0) + 2);
      } else if (event.key === "PageUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        void navigateDocument(documentFrame?.pageIndex ?? 0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contentSourceKind, documentFrame?.pageIndex, navigateDocument]);

  useEffect(() => {
    if (contentSourceKind === "whiteboard") return;
    cameraPlannerRef.current.reset();
    compositorRef.current?.requestSceneRefresh();
  }, [contentSourceKind, documentFitMode]);

  const stopCamera = useCallback(
    (reason: string, showNotice = true) => {
      mediaManagerRef.current.stopCamera();
      compositorRef.current?.setWebcamSource(null);
      compositorRef.current?.setWebcamConfig({ enabled: false });
      setCameraMonitorStream(null);
      setCameraEnabled(false);
      if (showNotice) setNotice("摄像头已关闭。");
      recordDiagnostic("camera.stopped", { reason });
    },
    [],
  );

  const setCamera = useCallback(
    async (enabled: boolean, deviceId = selectedCameraId) => {
      if (!enabled) {
        stopCamera("manual");
        return;
      }

      setCameraBusy(true);
      setNotice("正在检查摄像头…");
      try {
        const session = await mediaManagerRef.current.startCamera(
          deviceId || undefined,
        );
        if (!mountedRef.current) return;
        compositorRef.current?.setWebcamSource(session.video);
        compositorRef.current?.setWebcamConfig({ enabled: true });
        setCameraMonitorStream(session.stream);
        setCameraEnabled(true);
        setPanel("preview");
        setNotice("摄像头监看已开启；输出预览中的画面会进入成片。");
        recordDiagnostic("camera.started", {
          width: session.track.getSettings().width,
          height: session.track.getSettings().height,
          fps: session.track.getSettings().frameRate,
        });
        session.track.addEventListener(
          "ended",
          () => {
            if (!mountedRef.current) return;
            compositorRef.current?.setWebcamSource(null);
            setCameraMonitorStream(null);
            setCameraEnabled(false);
            setNotice("摄像头连接已结束，请重新开启。");
            recordDiagnostic("camera.ended", undefined, "warning");
          },
          { once: true },
        );
        void refreshDevices();
      } catch (error) {
        if (!mountedRef.current) return;
        const mapped = mapMediaInputError(error, "camera");
        compositorRef.current?.setWebcamSource(null);
        setCameraMonitorStream(null);
        setCameraEnabled(false);
        setNotice(mapped.message);
        recordDiagnostic(
          "camera.failed",
          { code: mapped.code, message: mapped.message },
          "error",
        );
      } finally {
        if (mountedRef.current) setCameraBusy(false);
      }
    },
    [refreshDevices, selectedCameraId, stopCamera],
  );

  const stopMicrophoneTest = useCallback(
    (nextState: MicrophoneTestState = "ready") => {
      const current = microphoneTestRef.current;
      microphoneTestRef.current = null;
      if (current) {
        window.cancelAnimationFrame(current.frameId);
        window.clearTimeout(current.timeoutId);
        void current.context.close().catch(() => undefined);
      }
      mediaManagerRef.current.releaseMicrophone();
      setMicrophoneTestState(nextState);
      recordDiagnostic("microphone.test.stopped", {
        state: nextState,
      });
    },
    [],
  );

  const startMicrophoneTest = useCallback(async () => {
    if (microphoneTestRef.current) {
      stopMicrophoneTest("ready");
      return;
    }

    setMicrophoneTestState("testing");
    setMicrophoneLevelDb(-96);
    setMicrophonePeakDb(-96);
    setNotice("正在监听麦克风电平，测试不会保存声音…");
    try {
      const session = await mediaManagerRef.current.acquireMicrophone(
        selectedMicrophoneId || undefined,
      );
      if (!mountedRef.current) {
        mediaManagerRef.current.releaseMicrophone();
        return;
      }

      const context = new AudioContext();
      const source = context.createMediaStreamSource(session.stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let lastUiUpdate = 0;
      let frameId = 0;

      const sample = (now: number) => {
        analyser.getFloatTimeDomainData(samples);
        let sumSquares = 0;
        for (const value of samples) sumSquares += value * value;
        const rms = Math.sqrt(sumSquares / samples.length);
        const db = Math.max(-96, 20 * Math.log10(Math.max(rms, 0.000016)));
        if (now - lastUiUpdate >= 90) {
          lastUiUpdate = now;
          setMicrophoneLevelDb(db);
          setMicrophonePeakDb((current) => Math.max(current, db));
        }
        frameId = window.requestAnimationFrame(sample);
        if (microphoneTestRef.current) {
          microphoneTestRef.current.frameId = frameId;
        }
      };

      frameId = window.requestAnimationFrame(sample);
      const timeoutId = window.setTimeout(
        () => stopMicrophoneTest("ready"),
        6_000,
      );
      microphoneTestRef.current = { context, frameId, timeoutId };
      setNotice("请正常说话；绿色区域表示音量适合录制。");
      recordDiagnostic("microphone.test.started", {
        sampleRate: session.track.getSettings().sampleRate,
        channelCount: session.track.getSettings().channelCount,
      });
      void refreshDevices();
    } catch (error) {
      const mapped = mapMediaInputError(error, "microphone");
      mediaManagerRef.current.releaseMicrophone();
      setMicrophoneTestState("error");
      setNotice(mapped.message);
      recordDiagnostic(
        "microphone.test.failed",
        { code: mapped.code, message: mapped.message },
        "warning",
      );
    }
  }, [refreshDevices, selectedMicrophoneId, stopMicrophoneTest]);

  const cancelPreparation = useCallback(() => {
    countdownRunRef.current += 1;
    mediaManagerRef.current.releaseMicrophone();
    recorderRef.current.abort();
    compositorRef.current?.setRecordingActive(false);
    compositorRef.current?.setFrameCommitListener(null);
    setRecordingState("idle");
    setNotice("已取消录制准备。");
    recordDiagnostic("recording.preparation.cancelled");
  }, []);

  const handleRuntimeRecorderError = useCallback((error: Error) => {
    const manifestId = activeRecordingManifestIdRef.current;
    const sinkStats = recorderRef.current.getRecordingSinkStats();
    setRecordingSinkStatus(sinkStats);
    if (manifestId && !courseProjectReadOnlyMessage) {
      projectCoordinatorRef.current?.updateRecording(manifestId, {
        status: "failed",
        storage:
          sinkStats?.kind === "opfs"
            ? { kind: "opfs", reference: sinkStats.sessionId }
            : { kind: "download", reference: null },
        bytesWritten: sinkStats?.committedBytes ?? 0,
        completedAt: Date.now(),
        errorMessage: error.message,
      });
      void projectCoordinatorRef.current?.flush();
    }
    activeRecordingManifestIdRef.current = null;
    recorderRef.current.abort();
    mediaManagerRef.current.releaseMicrophone();
    compositorRef.current?.setRecordingActive(false);
    compositorRef.current?.setFrameCommitListener(null);
    setRecordingState("idle");
    if (!keepCameraAfterRecording) stopCamera("recording-error", false);
    setNotice(`录制意外中断：${error.message}`);
    recordDiagnostic(
      "recording.runtime.failed",
      { name: error.name, message: error.message, sink: sinkStats },
      "error",
    );
    void refreshRecoveryCenter();
  }, [
    courseProjectReadOnlyMessage,
    keepCameraAfterRecording,
    refreshRecoveryCenter,
    stopCamera,
  ]);

  const beginRecording = useCallback(async () => {
    const output = outputCanvasRef.current;
    if (recordingState !== "idle" || !output) return;

    if (recordingDestinationMode === "folder") {
      if (!recordingDirectory) {
        setNotice("指定保存文件夹不可用，请在“保存与恢复”中重新选择，或切换为浏览器下载。" );
        return;
      }
      try {
        const granted = await requestRecordingDirectoryPermission(
          recordingDirectory,
        );
        setRecordingDirectoryPermission(granted ? "granted" : "denied");
        if (!granted) {
          setNotice(
            `需要“${recordingDirectory.name}”文件夹的写入权限；请重新授权或切换为浏览器下载。`,
          );
          return;
        }
      } catch (error) {
        setRecordingDirectoryPermission("denied");
        setNotice(`无法使用指定保存文件夹：${errorMessage(error)}`);
        return;
      }
    }

    if (microphoneTestRef.current) stopMicrophoneTest("idle");

    const thisRun = ++countdownRunRef.current;
    let microphoneWarning = "";
    let storageWarning = "";
    let audioTrack: MediaStreamTrack | null = null;
    setDurationSeconds(0);
    setRecordingState("preparing");
    recordDiagnostic("recording.preparing", {
      quality: qualityId,
      microphoneRequested: includeMicrophone,
      cameraEnabled,
    });

    const storageEstimate = await refreshRecoveryCenter();
    if (canUseOPFSRecordingSink()) {
      const tenMinuteReserve = Math.max(
        256 * 1024 * 1024,
        Math.ceil((quality.bitrate * 600 * 1.25) / 8),
      );
      if (
        storageEstimate?.availableBytes !== null &&
        storageEstimate?.availableBytes !== undefined &&
        storageEstimate.availableBytes < tenMinuteReserve
      ) {
        setRecordingState("idle");
        setNotice(
          `可用录制空间仅 ${formatBytes(storageEstimate.availableBytes)}，低于安全预留 ${formatBytes(tenMinuteReserve)}。请在“保存与恢复”中清理旧会话后再录制。`,
        );
        recordDiagnostic(
          "recording.storage.insufficient",
          {
            availableBytes: storageEstimate.availableBytes,
            requiredBytes: tenMinuteReserve,
          },
          "error",
        );
        return;
      }
    } else {
      storageWarning = "当前浏览器不支持流式落盘，将使用仅适合短录制的内存模式。";
      recordDiagnostic("recording.storage.memory-fallback", undefined, "warning");
    }

    if (includeMicrophone) {
      setNotice("正在预检麦克风；完成后才会开始倒计时…");
      try {
        const session = await mediaManagerRef.current.acquireMicrophone(
          selectedMicrophoneId || undefined,
        );
        audioTrack = session.track;
        recordDiagnostic("microphone.ready", {
          sampleRate: session.track.getSettings().sampleRate,
          channelCount: session.track.getSettings().channelCount,
        });
        void refreshDevices();
      } catch (error) {
        const mapped = mapMediaInputError(error, "microphone");
        microphoneWarning = `${mapped.message} 已继续无声录制。`;
        recordDiagnostic(
          "microphone.failed",
          { code: mapped.code, message: mapped.message },
          "warning",
        );
      }
    }

    if (countdownRunRef.current !== thisRun) {
      mediaManagerRef.current.releaseMicrophone();
      return;
    }

    setRecordingState("countdown");
    setNotice(
      [microphoneWarning, storageWarning].filter(Boolean).join(" ") ||
        "倒计时结束后开始录制。",
    );
    for (let value = 3; value >= 1; value -= 1) {
      setCountdown(value);
      await wait(1_000);
      if (countdownRunRef.current !== thisRun) return;
    }

    setNotice("正在启动录制器…");
    compositorRef.current?.resetSessionStats();
    compositorRef.current?.setRecordingActive(true);
    try {
      const result = await recorderRef.current.start(output, {
        audioTrack,
        videoBitsPerSecond: quality.bitrate,
        onError: handleRuntimeRecorderError,
      });
      mediaManagerRef.current.releaseMicrophone();
      if (countdownRunRef.current !== thisRun) {
        recorderRef.current.abort();
        compositorRef.current?.setRecordingActive(false);
        compositorRef.current?.setFrameCommitListener(null);
        return;
      }

      compositorRef.current?.setFrameCommitListener(() =>
        recorderRef.current.requestFrame(),
      );
      if (!courseProjectReadOnlyMessage) {
        activeRecordingManifestIdRef.current =
          projectCoordinatorRef.current?.beginRecording({
            mimeType: result.mimeType,
            outputProfile,
          }) ?? null;
      }
      setRecordingState("recording");
      setNotice(
        microphoneWarning ||
          `正在录制 ${result.mimeType.replace("video/", "")} · ${quality.width}×${quality.height}。`,
      );
      recordDiagnostic("recording.started", {
        mimeType: result.mimeType,
        width: quality.width,
        height: quality.height,
        fps: quality.fps,
        microphoneIncluded: Boolean(audioTrack),
        cameraIncluded: cameraEnabled,
      });
    } catch (error) {
      mediaManagerRef.current.releaseMicrophone();
      recorderRef.current.abort();
      compositorRef.current?.setRecordingActive(false);
      compositorRef.current?.setFrameCommitListener(null);
      if (countdownRunRef.current !== thisRun) return;
      setRecordingState("idle");
      setNotice(`无法开始录制：${errorMessage(error)}`);
      recordDiagnostic(
        "recording.start.failed",
        { message: errorMessage(error) },
        "error",
      );
    }
  }, [
    cameraEnabled,
    courseProjectReadOnlyMessage,
    handleRuntimeRecorderError,
    includeMicrophone,
    quality.bitrate,
    quality.fps,
    quality.height,
    quality.width,
    qualityId,
    recordingDestinationMode,
    recordingDirectory,
    recordingState,
    refreshDevices,
    refreshRecoveryCenter,
    selectedMicrophoneId,
    stopMicrophoneTest,
    outputProfile,
  ]);

  const togglePause = useCallback(() => {
    if (recordingState === "recording") {
      recorderRef.current.pause();
      setRecordingState("paused");
      setNotice("录制已暂停，画布仍可编辑。");
      recordDiagnostic("recording.paused");
      return;
    }
    if (recordingState === "paused") {
      recorderRef.current.resume();
      setRecordingState("recording");
      setNotice("录制已继续。");
      recordDiagnostic("recording.resumed");
    }
  }, [recordingState]);

  const stopRecording = useCallback(async (reason = "manual") => {
    if (recordingState !== "recording" && recordingState !== "paused") return;
    const manifestId = activeRecordingManifestIdRef.current;
    if (manifestId && !courseProjectReadOnlyMessage) {
      projectCoordinatorRef.current?.updateRecording(manifestId, {
        status: "finalizing",
        durationMs: durationSeconds * 1_000,
      });
    }
    setRecordingState("finalizing");
    setNotice("正在封装视频并进行本地回看准备…");
    compositorRef.current?.setFrameCommitListener(null);
    try {
      const blob = await recorderRef.current.stop();
      const sinkStats = recorderRef.current.getRecordingSinkStats();
      setRecordingSinkStatus(sinkStats);
      const filename = createRecordingFilename(blob);
      let savedDirectoryName: string | null = null;
      let destinationFallbackMessage = "";
      if (recordingDestinationMode === "folder" && recordingDirectory) {
        try {
          const permission = await queryRecordingDirectoryPermission(
            recordingDirectory,
          );
          setRecordingDirectoryPermission(permission);
          if (permission !== "granted") {
            throw new Error("文件夹写入权限已失效");
          }
          const saved = await writeRecordingToDirectory(
            recordingDirectory,
            blob,
            filename,
          );
          savedDirectoryName = saved.directoryName;
        } catch (error) {
          downloadRecording(blob, filename);
          destinationFallbackMessage = `指定文件夹保存失败（${errorMessage(error)}），已改用浏览器下载。`;
          recordDiagnostic(
            "recording.destination.write.failed",
            {
              directoryName: recordingDirectory.name,
              message: errorMessage(error),
            },
            "warning",
          );
        }
      } else {
        downloadRecording(blob, filename);
      }
      if (lastRecordingUrlRef.current) {
        URL.revokeObjectURL(lastRecordingUrlRef.current);
      }
      const url = URL.createObjectURL(blob);
      lastRecordingUrlRef.current = url;
      setLastRecording({
        blob,
        url,
        filename,
        mimeType: blob.type || "video/webm",
        durationSeconds,
        width: quality.width,
        height: quality.height,
      });
      if (manifestId && !courseProjectReadOnlyMessage) {
        projectCoordinatorRef.current?.updateRecording(manifestId, {
          fileName: filename,
          mimeType: blob.type || "video/webm",
          status: "complete",
          storage:
            savedDirectoryName
              ? {
                  kind: "desktop-file",
                  reference: `${savedDirectoryName}/${filename}`,
                }
              : sinkStats?.kind === "opfs"
              ? { kind: "opfs", reference: sinkStats.sessionId }
              : { kind: "download", reference: null },
          completedAt: Date.now(),
          durationMs: durationSeconds * 1_000,
          bytesWritten: sinkStats?.committedBytes || blob.size,
          errorMessage: null,
        });
        await projectCoordinatorRef.current?.flush();
      }
      setNotice(
        destinationFallbackMessage ||
          `已保存 ${filename} 到${
            savedDirectoryName
              ? `“${savedDirectoryName}”文件夹`
              : "浏览器下载"
          }（${formatDuration(durationSeconds)}，${(
            blob.size /
            1024 /
            1024
          ).toFixed(1)} MB）。`,
      );
      recordDiagnostic("recording.saved", {
        filename,
        durationSeconds,
        bytes: blob.size,
        mimeType: blob.type,
        sink: sinkStats,
        destination: savedDirectoryName
          ? { kind: "folder", directoryName: savedDirectoryName }
          : { kind: "download", fallback: Boolean(destinationFallbackMessage) },
        reason,
        compositor: compositorRef.current?.getStats(),
      });
    } catch (error) {
      if (manifestId && !courseProjectReadOnlyMessage) {
        projectCoordinatorRef.current?.updateRecording(manifestId, {
          status: "failed",
          completedAt: Date.now(),
          durationMs: durationSeconds * 1_000,
          errorMessage: errorMessage(error),
        });
        await projectCoordinatorRef.current?.flush();
      }
      setNotice(`结束录制失败：${errorMessage(error)}`);
      recordDiagnostic(
        "recording.stop.failed",
        { message: errorMessage(error) },
        "error",
      );
    } finally {
      activeRecordingManifestIdRef.current = null;
      compositorRef.current?.setRecordingActive(false);
      mediaManagerRef.current.releaseMicrophone();
      if (!keepCameraAfterRecording || reason !== "manual") {
        stopCamera(`recording-${reason}`, false);
      }
      setRecordingState("idle");
      void refreshRecoveryCenter();
    }
  }, [
    courseProjectReadOnlyMessage,
    durationSeconds,
    keepCameraAfterRecording,
    quality.height,
    quality.width,
    recordingDestinationMode,
    recordingDirectory,
    recordingState,
    refreshRecoveryCenter,
    stopCamera,
  ]);

  stopRecordingRef.current = stopRecording;

  useEffect(() => {
    const stopForHiddenPage = (reason: "page-hidden" | "pagehide") => {
      // IndexedDB cannot be guaranteed after pagehide, but starting the latest
      // queued writes here closes the common debounce-loss window. Tauri will
      // later replace this with an atomic host flush before CloseRequested.
      void flushProjectSnapshot();
      void flushDocumentSession();
      void projectCoordinatorRef.current?.flush();
      if (backgroundStopPendingRef.current) return;
      const state = recordingStateRef.current;
      if (state === "recording" || state === "paused") {
        backgroundStopPendingRef.current = true;
        recordDiagnostic("recording.background-stop", { reason }, "warning");
        void stopRecordingRef.current?.(reason).finally(() => {
          backgroundStopPendingRef.current = false;
        });
        return;
      }
      if (cameraEnabledRef.current) stopCamera(reason);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopForHiddenPage("page-hidden");
      }
    };
    const onBlur = () => {
      if (backgroundBlurTimerRef.current !== null) {
        window.clearTimeout(backgroundBlurTimerRef.current);
      }
      backgroundBlurTimerRef.current = window.setTimeout(() => {
        backgroundBlurTimerRef.current = null;
        if (
          !document.hasFocus() &&
          cameraEnabledRef.current &&
          recordingStateRef.current === "idle"
        ) {
          // An idle preview must not keep the physical camera active after the
          // user switches applications. During an active recording, ordinary
          // focus changes are ignored; a genuinely hidden page is handled by
          // visibilitychange above and finalized safely.
          stopCamera("window-blur");
        }
      }, 1_500);
    };
    const onFocus = () => {
      if (backgroundBlurTimerRef.current !== null) {
        window.clearTimeout(backgroundBlurTimerRef.current);
        backgroundBlurTimerRef.current = null;
      }
    };
    const onPageHide = () => {
      stopForHiddenPage("pagehide");
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      onFocus();
    };
  }, [flushDocumentSession, flushProjectSnapshot, stopCamera]);

  const openPanel = (next: Exclude<WorkspacePanel, null>) => {
    setPanel((current) => (current === next ? null : next));
  };

  const selectAspect = useCallback(
    (next: AspectChoice) => {
      if (controlsLocked) return;
      if (typeof next !== "string") {
        setCustomAspectWidth(next.width);
        setCustomAspectHeight(next.height);
      }
      setAspectChoice(next);
      setCaptureRegion(
        createCaptureRegionForAspect(
          next,
          Math.max(1, stageSize.width),
          Math.max(1, stageSize.height),
        ),
      );
      setCaptureRegionVisible(true);
      setCaptureRegionEditing(true);
    },
    [controlsLocked, stageSize.height, stageSize.width],
  );

  const resetCaptureRegion = useCallback(() => {
    setCaptureRegion(
      createCaptureRegionForAspect(
        aspectChoice,
        Math.max(1, stageSize.width),
        Math.max(1, stageSize.height),
      ),
    );
    setCaptureRegionVisible(true);
    setCaptureRegionEditing(true);
  }, [aspectChoice, stageSize.height, stageSize.width]);

  const dismissLastRecording = () => {
    if (lastRecordingUrlRef.current) {
      URL.revokeObjectURL(lastRecordingUrlRef.current);
      lastRecordingUrlRef.current = null;
    }
    setLastRecording(null);
  };

  const exportRecoverySession = async (session: OPFSRecordingInspection) => {
    setRecoveryBusySessionId(session.sessionId);
    try {
      const blob = await readOPFSRecordingBytes(session.sessionId);
      const extension = recoveryFileExtension(session.mimeType);
      const completeContainer = session.status === "finalized";
      const filename = `excalidraw-recovery-${session.sessionId}.${extension}${
        completeContainer ? "" : ".part"
      }`;
      downloadRecording(blob, filename);
      setNotice(
        completeContainer
          ? `已导出完整录制文件 ${filename}。`
          : `已导出异常中断的原始分片 ${filename}；它可能需要后续修复，不能保证可直接播放。`,
      );
      recordDiagnostic("recording.recovery.exported", {
        sessionId: session.sessionId,
        status: session.status,
        bytes: blob.size,
      });
    } catch (error) {
      setNotice(`导出恢复分片失败：${errorMessage(error)}`);
      recordDiagnostic(
        "recording.recovery.export.failed",
        { sessionId: session.sessionId, message: errorMessage(error) },
        "error",
      );
    } finally {
      setRecoveryBusySessionId(null);
    }
  };

  const removeRecoverySession = async (session: OPFSRecordingInspection) => {
    const confirmed = window.confirm(
      `确定删除本地录制会话“${session.sessionId}”及其 ${formatBytes(session.actualFileBytes)} 数据吗？此操作无法撤销。`,
    );
    if (!confirmed) return;
    setRecoveryBusySessionId(session.sessionId);
    try {
      await deleteOPFSRecordingSession(session.sessionId);
      setNotice("本地录制会话已清理。");
      await refreshRecoveryCenter();
    } catch (error) {
      setNotice(`清理录制会话失败：${errorMessage(error)}`);
    } finally {
      setRecoveryBusySessionId(null);
    }
  };

  const selectRecordingDirectory = async () => {
    if (controlsLocked || recordingDestinationBusy) return;
    setRecordingDestinationBusy(true);
    try {
      const handle = await chooseRecordingDirectory();
      setRecordingDirectory(handle);
      setRecordingDestinationMode("folder");
      setRecordingDirectoryPermission("granted");
      setNotice(`录制完成后将直接保存到“${handle.name}”文件夹。`);
      recordDiagnostic("recording.destination.selected", {
        directoryName: handle.name,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setNotice(`无法选择保存文件夹：${errorMessage(error)}`);
      recordDiagnostic(
        "recording.destination.select.failed",
        { message: errorMessage(error) },
        "warning",
      );
    } finally {
      setRecordingDestinationBusy(false);
    }
  };

  const authorizeRecordingDirectory = async () => {
    if (!recordingDirectory || controlsLocked || recordingDestinationBusy) return;
    setRecordingDestinationBusy(true);
    try {
      const granted = await requestRecordingDirectoryPermission(
        recordingDirectory,
      );
      setRecordingDirectoryPermission(granted ? "granted" : "denied");
      setNotice(
        granted
          ? `“${recordingDirectory.name}”文件夹写入权限已恢复。`
          : "未获得文件夹写入权限；录制仍可使用浏览器下载保存。",
      );
    } catch (error) {
      setRecordingDirectoryPermission("denied");
      setNotice(`无法恢复文件夹权限：${errorMessage(error)}`);
    } finally {
      setRecordingDestinationBusy(false);
    }
  };

  const useBrowserDownloadDestination = () => {
    setRecordingDestinationMode("download");
    setNotice("录制完成后将使用浏览器下载保存，可由浏览器询问或管理下载位置。");
  };

  const forgetRecordingDirectory = async () => {
    if (controlsLocked || recordingDestinationBusy) return;
    setRecordingDestinationBusy(true);
    try {
      await clearRecordingDirectoryHandle();
      setRecordingDirectory(null);
      setRecordingDirectoryPermission(
        isDirectoryPickerSupported() ? "prompt" : "unsupported",
      );
      setRecordingDestinationMode("download");
      setNotice("已清除指定文件夹，恢复为浏览器下载保存。" );
    } catch (error) {
      setNotice(`无法清除保存位置：${errorMessage(error)}`);
    } finally {
      setRecordingDestinationBusy(false);
    }
  };

  const enablePersistentRecordingStorage = async () => {
    try {
      const granted = await requestPersistentRecordingStorage();
      await refreshRecoveryCenter();
      setNotice(
        granted
          ? "浏览器已允许持久化录制存储。"
          : "浏览器未授予持久存储；录制仍可使用，但空间紧张时浏览器可能回收旧数据。",
      );
    } catch (error) {
      setNotice(`申请持久存储失败：${errorMessage(error)}`);
    }
  };

  return (
    <main
      className="app-shell"
      data-editor-theme={editorTheme}
      data-recording-state={recordingState}
      data-active-tool={presentationToolType}
      data-content-source={contentSourceKind}
      data-course-project-ready={courseProjectReady ? "true" : "false"}
      data-course-project-id={courseProjectId ?? ""}
      data-course-project-mode={
        courseProjectReadOnlyMessage ? "read-only" : "read-write"
      }
    >
      <div className="excalidraw-stage" ref={stageRef}>
        <div
          className="excalidraw-source"
          data-active={contentSourceKind === "whiteboard"}
          aria-hidden={contentSourceKind !== "whiteboard"}
        >
          <Excalidraw
            initialData={initialData}
            excalidrawAPI={(api) => {
              excalidrawApiRef.current = api;
            }}
            onChange={handleSceneChange}
            onPointerUpdate={handlePointerUpdate}
            langCode="zh-CN"
            autoFocus={contentSourceKind === "whiteboard"}
            UIOptions={{
              canvasActions: {
                saveToActiveFile: false,
                loadScene: false,
                export: false,
                toggleTheme: true,
              },
            }}
          />
        </div>
        {contentSourceKind !== "whiteboard" && (
          <DocumentStage
            ref={documentStageRef}
            frame={documentFrame}
            strokes={currentDocumentStrokes}
            tool={documentTool}
            fitMode={documentFitMode}
            disabled={recordingState === "finalizing" || contentLoading}
            onCommitStroke={commitDocumentStroke}
            onGesture={handleDocumentGesture}
            onPageStep={(direction) =>
              void navigateDocument(
                direction === "next"
                  ? (documentFrame?.pageIndex ?? 0) + 2
                  : documentFrame?.pageIndex ?? 0,
              )
            }
            ariaLabel={`${getImportedSourceLabel(contentSourceKind)}讲解舞台`}
          />
        )}
        {captureRegionVisible && (
          <CaptureRegionOverlay
            region={captureRegion}
            aspectRatio={getAspectRatio(aspectChoice)}
            label={`录制区域 ${getAspectLabel(aspectChoice)}`}
            disabled={controlsLocked || !captureRegionEditing}
            onChange={setCaptureRegion}
          />
        )}
        {cameraEnabled && cameraMonitorStream && (
          <div
            ref={cameraMonitorContainerRef}
            className={`camera-monitor ${
              webcamPlacement
                ? "camera-monitor--custom"
                : `camera-monitor--${webcamPosition}`
            } camera-monitor--${webcamSize}${
              panel ? " camera-monitor--panel-clear" : ""
            }${
              contentSourceKind !== "whiteboard" && !sourceRailCollapsed
                ? " camera-monitor--rail-clear"
                : ""
            }`}
            style={
              webcamPlacement
                ? {
                    left: `${(captureRegion.x + webcamPlacement.x * captureRegion.width) * 100}%`,
                    top: `${(captureRegion.y + webcamPlacement.y * captureRegion.height) * 100}%`,
                  }
                : undefined
            }
            data-shape={webcamShape}
            data-ready={compositorStatus?.webcamReady ? "true" : "false"}
            data-draggable={!controlsLocked ? "true" : "false"}
            data-dragging={webcamDragging ? "true" : "false"}
            aria-label="摄像头监看画面，可拖动调整成片位置"
            title={controlsLocked ? "录制期间位置已锁定" : "拖动调整摄像头在成片中的位置"}
            onPointerDown={beginWebcamDrag}
            onPointerMove={moveWebcamDrag}
            onPointerUp={(event) => finishWebcamDrag(event)}
            onPointerCancel={(event) => finishWebcamDrag(event, true)}
            onLostPointerCapture={(event) => finishWebcamDrag(event, true)}
          >
            <video
              ref={cameraMonitorRef}
              muted
              autoPlay
              playsInline
              draggable={false}
              className={webcamMirror ? "is-mirrored" : ""}
            />
            <span>
              {compositorStatus?.webcamReady ? "已进入成片" : "正在同步成片"}
            </span>
          </div>
        )}
      </div>

      <input
        ref={pdfInputRef}
        className="content-file-input"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          handleDocumentFile("pdf", event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={markdownInputRef}
        className="content-file-input"
        type="file"
        accept="text/markdown,text/x-markdown,.md,.markdown"
        onChange={(event) => {
          handleDocumentFile("markdown", event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={htmlInputRef}
        className="content-file-input"
        type="file"
        accept="text/html,application/xhtml+xml,.html,.htm"
        onChange={(event) => {
          handleDocumentFile("html", event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={imageInputRef}
        className="content-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        onChange={(event) => {
          handleDocumentFile("image", event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />

      <SourceRail
        sourceKind={contentSourceKind}
        fileName={contentFileName}
        pages={sourceRailPages}
        currentPage={documentFrame ? documentFrame.pageIndex + 1 : undefined}
        loading={contentLoading}
        error={contentError}
        collapsed={sourceRailCollapsed}
        importDisabled={controlsLocked}
        navigationDisabled={contentLoading || recordingState === "finalizing"}
        onCollapsedChange={setSourceRailCollapsed}
        onImportPdf={() => pdfInputRef.current?.click()}
        onImportPresentation={() => setPresentationFallbackOpen(true)}
        onImportImages={() => imageInputRef.current?.click()}
        onImportMarkdown={() => markdownInputRef.current?.click()}
        onImportHtml={() => htmlInputRef.current?.click()}
        onReturnToWhiteboard={returnToWhiteboard}
        onSelectPage={(pageNumber) => void navigateDocument(pageNumber)}
        onPreviousPage={() =>
          void navigateDocument(documentFrame?.pageIndex ?? 0)
        }
        onNextPage={() =>
          void navigateDocument((documentFrame?.pageIndex ?? 0) + 2)
        }
      />

      {presentationFallbackOpen && (
        <section
          className="recording-result presentation-fallback"
          role="dialog"
          aria-modal="true"
          aria-label="PPT 导入说明"
        >
          <div className="recording-result__card presentation-fallback__card">
            <header>
              <div>
                <strong>PPT / PPTX 先转换为 PDF</strong>
                <span>当前本地 Web 版本不会执行 Office 文件或宏</span>
              </div>
              <span className="format-badge">安全兜底</span>
            </header>
            <div className="presentation-fallback__content">
              <p>
                浏览器不能可靠调用 PowerPoint 或 LibreOffice 完成离线转换。请在原软件中选择“导出 / 另存为 PDF”，再回到这里导入。
              </p>
              <ol>
                <li>在 PowerPoint、WPS 或 Keynote 中打开演示文稿。</li>
                <li>导出为 PDF；动画、转场和内嵌视频会变成静态页面。</li>
                <li>点击下方“选择导出的 PDF”，继续翻页、批注、运镜和录制。</li>
              </ol>
              <p className="settings-note">
                后续桌面版会优先调用本机 PowerPoint，其次可选 LibreOffice；没有转换器时仍保留此流程。
              </p>
            </div>
            <footer>
              <button type="button" onClick={() => setPresentationFallbackOpen(false)}>
                暂不导入
              </button>
              <button
                className="recording-result__done"
                type="button"
                onClick={() => {
                  setPresentationFallbackOpen(false);
                  pdfInputRef.current?.click();
                }}
              >
                选择导出的 PDF
              </button>
            </footer>
          </div>
        </section>
      )}

      {contentSourceKind !== "whiteboard" && (
        <DocumentToolbar
          tool={documentTool}
          fitMode={documentFitMode}
          disabled={recordingState === "finalizing" || contentLoading}
          canUndo={currentDocumentStrokes.length > 0}
          canClear={currentDocumentStrokes.length > 0}
          onToolChange={setDocumentTool}
          onUndo={undoDocumentStroke}
          onClear={clearDocumentStrokes}
          onFitModeChange={setDocumentFitMode}
        />
      )}

      <FloatingTeleprompter
        open={teleprompterOpen}
        onClose={() => setTeleprompterOpen(false)}
        projectStateKey={courseProjectId}
        initialProjectState={teleprompterInitialState}
        onProjectStateChange={handleTeleprompterProjectState}
      />

      <div className="recorder-dock">
        <section className="recorder-controls" aria-label="录制控制">
          {recordingState === "idle" ? (
            <>
              <div className="dock-state" aria-label="当前录制状态">
                <span aria-hidden="true" />
                未录制
              </div>
              <button
                className={`dock-button ${panel ? "is-active" : ""}`}
                type="button"
                onClick={() => openPanel(panel ?? "settings")}
                aria-pressed={panel !== null}
              >
                设置
              </button>
              <button
                className={`dock-button ${teleprompterOpen ? "is-active" : ""}`}
                type="button"
                onClick={() => setTeleprompterOpen((value) => !value)}
                aria-pressed={teleprompterOpen}
              >
                提词器
              </button>
              <button
                className="record-button"
                type="button"
                onClick={() => void beginRecording()}
                disabled={cameraBusy || contentLoading}
              >
                开始录制
              </button>
            </>
          ) : activelyRecording ? (
            <>
              <div className="recording-clock" role="timer" aria-label="录制时长">
                {formatDuration(durationSeconds)}
              </div>
              <button className="dock-button" type="button" onClick={togglePause}>
                {recordingState === "paused" ? "继续" : "暂停"}
              </button>
              <button
                className="stop-button"
                type="button"
                onClick={() => void stopRecording()}
              >
                结束
              </button>
            </>
          ) : preparing ? (
            <>
              <div className="preparing-label">
                {recordingState === "countdown" ? `倒计时 ${countdown}` : "检查设备"}
              </div>
              <button className="dock-button" type="button" onClick={cancelPreparation}>
                取消
              </button>
            </>
          ) : (
            <button className="dock-button" type="button" disabled>
              正在保存…
            </button>
          )}
        </section>

        <div className="recorder-status" role="status" title={visibleNotice}>
          {visibleNotice}
        </div>

        {recordingState === "countdown" && (
          <div className="countdown-badge" role="timer" aria-label={`倒计时 ${countdown}`}>
            {countdown}
          </div>
        )}
      </div>

      <aside
        className="workspace-panel"
        data-open={panel !== null}
        aria-hidden={panel === null}
        aria-label="录制工作台"
      >
        <header className="workspace-panel__header">
          <nav aria-label="工作台页面">
            <button
              type="button"
              className={panel === "settings" ? "is-active" : ""}
              onClick={() => setPanel("settings")}
              aria-pressed={panel === "settings"}
            >
              录制设置
            </button>
            <button
              type="button"
              className={panel === "preview" ? "is-active" : ""}
              onClick={() => setPanel("preview")}
              aria-pressed={panel === "preview"}
            >
              大图预览
            </button>
          </nav>
          <button
            className="icon-button"
            type="button"
            onClick={() => setPanel(null)}
            aria-label="关闭工作台"
          >
            关闭
          </button>
        </header>

        <section className="settings-panel" hidden={panel !== "settings"}>
          <div className="settings-section studio-section">
            <div className="settings-heading">
              <strong>画幅</strong>
              <span>{quality.width} × {quality.height}</span>
            </div>
            <div className="aspect-grid" role="group" aria-label="选择录制画幅">
              {ASPECT_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className={aspectChoice === preset.id ? "is-active" : ""}
                  onClick={() => selectAspect(preset.id)}
                  disabled={controlsLocked}
                  aria-pressed={aspectChoice === preset.id}
                >
                  <span>{preset.label}</span>
                  <small>{preset.hint}</small>
                </button>
              ))}
              <button
                type="button"
                className={typeof aspectChoice !== "string" ? "is-active" : ""}
                onClick={() =>
                  selectAspect(
                    createCustomAspect(customAspectWidth, customAspectHeight),
                  )
                }
                disabled={controlsLocked}
                aria-pressed={typeof aspectChoice !== "string"}
              >
                <span>自定义</span>
                <small>W:H</small>
              </button>
            </div>
            <div className="custom-aspect-row">
              <label>
                宽
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={customAspectWidth}
                  onChange={(event) => setCustomAspectWidth(Number(event.target.value))}
                  disabled={controlsLocked}
                />
              </label>
              <span aria-hidden="true">:</span>
              <label>
                高
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={customAspectHeight}
                  onChange={(event) => setCustomAspectHeight(Number(event.target.value))}
                  disabled={controlsLocked}
                />
              </label>
              <button
                type="button"
                className="secondary-button secondary-button--compact"
                onClick={() =>
                  selectAspect(
                    createCustomAspect(customAspectWidth, customAspectHeight),
                  )
                }
                disabled={controlsLocked}
              >
                应用
              </button>
            </div>
            <p className="settings-note">
              自定义画幅会安全限制在 1:4 至 4:1，避免创建过大的录制画布。
            </p>
          </div>

          <div className="settings-section studio-section">
            <div className="settings-heading">
              <strong>选区</strong>
              <span>仅虚线框内进入成片</span>
            </div>
            <div className="selection-actions">
              <button
                className="toggle-row"
                type="button"
                onClick={() => {
                  setCaptureRegionVisible((value) => {
                    if (value) setCaptureRegionEditing(false);
                    return !value;
                  });
                }}
                aria-pressed={captureRegionVisible}
                disabled={controlsLocked}
              >
                <span>显示录制区域</span>
                <b>{captureRegionVisible ? "开启" : "关闭"}</b>
              </button>
              <button
                className={`secondary-button secondary-button--compact ${
                  captureRegionEditing ? "is-active" : ""
                }`}
                type="button"
                onClick={() => {
                  setCaptureRegionVisible(true);
                  setCaptureRegionEditing((value) => !value);
                }}
                aria-pressed={captureRegionEditing}
                disabled={controlsLocked}
              >
                {captureRegionEditing ? "完成选区" : "编辑选区"}
              </button>
              <button
                className="secondary-button secondary-button--compact"
                type="button"
                onClick={resetCaptureRegion}
                disabled={controlsLocked}
              >
                居中重置
              </button>
            </div>
            <p className="settings-note">
              点击“编辑选区”后可拖动与缩放；完成后白板会恢复正常绘制。选区框与控制界面不会进入视频。
            </p>
          </div>

          <div className="settings-section studio-section">
            <div className="settings-heading">
              <strong>风格</strong>
              <span>仅改变最终输出背景</span>
            </div>
            <div className="canvas-style-grid" role="group" aria-label="画布风格">
              {CANVAS_STYLES.map((style) => (
                <button
                  type="button"
                  key={style.id}
                  className={canvasStyle === style.id ? "is-active" : ""}
                  onClick={() => setCanvasStyle(style.id)}
                  disabled={controlsLocked}
                  aria-pressed={canvasStyle === style.id}
                >
                  <span style={{ background: style.preview }} aria-hidden="true" />
                  <b>{style.label}</b>
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section studio-section">
            <div className="settings-heading">
              <strong>文档呈现</strong>
              <span>用于 Markdown；HTML 演示仅使用方向</span>
            </div>
            <label className="field-row">
              <span>分页方式</span>
              <select
                value={documentPresentationDraft.mode}
                onChange={(event) =>
                  setDocumentPresentationDraft((current) => ({
                    ...current,
                    mode: event.target.value as DocumentPresentationSettings["mode"],
                  }))
                }
                disabled={controlsLocked}
              >
                <option value="document">连续文档自动分页</option>
                <option value="slides">按标题/分隔符切成幻灯片</option>
              </select>
            </label>
            <label className="field-row">
              <span>页面方向</span>
              <select
                value={documentPresentationDraft.orientation}
                onChange={(event) =>
                  setDocumentPresentationDraft((current) => ({
                    ...current,
                    orientation: event.target
                      .value as DocumentPresentationSettings["orientation"],
                  }))
                }
                disabled={controlsLocked}
              >
                <option value="landscape">横版（网页 / 课程 PPT）</option>
                <option value="portrait">竖版（手机课程 / 长文档）</option>
              </select>
            </label>
            <label className="field-row">
              <span>内容主题</span>
              <select
                value={documentPresentationDraft.theme}
                onChange={(event) =>
                  setDocumentPresentationDraft((current) => ({
                    ...current,
                    theme: event.target
                      .value as DocumentPresentationSettings["theme"],
                  }))
                }
                disabled={controlsLocked}
              >
                <option value="paper">纸白</option>
                <option value="warm">暖纸</option>
                <option value="midnight">深夜</option>
              </select>
            </label>
            <p className="settings-note">
              Markdown 会使用分页、方向与主题；静态 HTML 保留文件自己的 CSS，只使用横向或纵向画面方向。调整已打开内容需要重新导入。
            </p>
          </div>

          <div className="settings-section">
            <div className="settings-heading">
              <strong>录制稳定性</strong>
              <span>默认使用低负载模式</span>
            </div>
            <label className="field-row">
              <span>输出画质</span>
              <select
                value={qualityId}
                onChange={(event) =>
                  setQualityId(event.target.value as QualityPresetId)
                }
                disabled={controlsLocked}
              >
                {(Object.keys(QUALITY_PRESETS) as QualityPresetId[]).map((id) => (
                  <option value={id} key={id}>
                    {QUALITY_PRESETS[id].label}
                  </option>
                ))}
              </select>
            </label>
            <p className="settings-note">
              优先使用 H.264/AAC MP4；当前浏览器不支持时自动回退 WebM。1080p
              会明显增加浏览器、显卡和内存压力。
            </p>
          </div>

          <div className="settings-section">
            <div className="settings-heading">
              <strong>自动运镜</strong>
              <span>仅改变输出预览与成片</span>
            </div>
            <button
              className="toggle-row"
              type="button"
              onClick={() => setAutoZoomEnabled((value) => !value)}
              aria-pressed={autoZoomEnabled}
            >
              <span>划线时自动放大</span>
              <b>{autoZoomEnabled ? "开启" : "关闭"}</b>
            </button>
            <label className="field-row">
              <span>运镜强度</span>
              <select
                value={cameraStrength}
                onChange={(event) =>
                  setCameraStrength(event.target.value as CameraStrength)
                }
                disabled={!autoZoomEnabled}
              >
                {(Object.keys(CAMERA_STRENGTH_LABEL) as CameraStrength[]).map(
                  (strength) => (
                    <option key={strength} value={strength}>
                      {CAMERA_STRENGTH_LABEL[strength]}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>

          <div className="settings-section">
            <div className="settings-heading">
              <strong>麦克风</strong>
              <span>默认关闭，录制前预检</span>
            </div>
            <button
              className="toggle-row"
              type="button"
              onClick={() => setIncludeMicrophone((value) => !value)}
              aria-pressed={includeMicrophone}
              disabled={controlsLocked}
            >
              <span>录制麦克风</span>
              <b>{includeMicrophone ? "开启" : "关闭"}</b>
            </button>
            <label className="field-row">
              <span>输入设备</span>
              <select
                value={selectedMicrophoneId}
                onChange={(event) => setSelectedMicrophoneId(event.target.value)}
                disabled={!includeMicrophone || controlsLocked}
              >
                <option value="">系统默认</option>
                {devices.microphones.map((device) => (
                  <option value={device.deviceId} key={`mic-${device.deviceId}`}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void startMicrophoneTest()}
              disabled={!includeMicrophone || controlsLocked}
            >
              {microphoneTestState === "testing"
                ? "停止麦克风测试"
                : "测试麦克风 6 秒"}
            </button>
            {microphoneTestState !== "idle" && (
              <div className="microphone-meter" data-state={microphoneTestState}>
                <div className="microphone-meter__track" aria-hidden="true">
                  <span style={{ width: `${microphoneLevelPercent}%` }} />
                </div>
                <span>
                  当前 {microphoneLevelDb.toFixed(0)} dB · 峰值{" "}
                  {microphonePeakDb.toFixed(0)} dB
                </span>
              </div>
            )}
            {includeMicrophone && (
              <p className="settings-warning">
                已关闭浏览器降噪、回声消除和自动增益，并优先使用 48kHz 单声道；这能降低负载，但不能保证绕过系统 Fortemedia/Realtek 驱动。
              </p>
            )}
          </div>

          <div className="settings-section">
            <div className="settings-heading">
              <strong>摄像头画中画</strong>
              <span>640×360 低负载采集</span>
            </div>
            <button
              className="toggle-row"
              type="button"
              onClick={() => void setCamera(!cameraEnabled)}
              aria-pressed={cameraEnabled}
              disabled={cameraBusy || controlsLocked}
            >
              <span>{cameraBusy ? "正在连接…" : "加入摄像头"}</span>
              <b>{cameraEnabled ? "开启" : "关闭"}</b>
            </button>
            <label className="field-row">
              <span>摄像头</span>
              <select
                value={selectedCameraId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setSelectedCameraId(nextId);
                  if (cameraEnabled) void setCamera(true, nextId);
                }}
                disabled={cameraBusy || controlsLocked}
              >
                <option value="">系统默认</option>
                {devices.cameras.map((device) => (
                  <option value={device.deviceId} key={`camera-${device.deviceId}`}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-grid">
              <label>
                形状
                <select
                  value={webcamShape}
                  onChange={(event) =>
                    setWebcamShape(event.target.value as WebcamShape)
                  }
                >
                  <option value="circle">圆形</option>
                  <option value="square">圆角方形</option>
                </select>
              </label>
              <label>
                大小
                <select
                  value={webcamSize}
                  onChange={(event) =>
                    setWebcamSize(event.target.value as WebcamSize)
                  }
                >
                  <option value="small">小</option>
                  <option value="medium">中</option>
                  <option value="large">大</option>
                </select>
              </label>
            </div>
            <label className="field-row">
              <span>位置</span>
              <select
                value={webcamPlacement ? "custom" : webcamPosition}
                onChange={(event) => {
                  if (event.target.value === "custom") return;
                  setWebcamPlacement(null);
                  setWebcamPosition(event.target.value as WebcamPosition);
                }}
                disabled={controlsLocked}
              >
                {webcamPlacement && (
                  <option value="custom">自定义（已拖动）</option>
                )}
                <option value="top-left">左上</option>
                <option value="top-right">右上</option>
                <option value="bottom-left">左下</option>
                <option value="bottom-right">右下</option>
              </select>
            </label>
            <button
              className="toggle-row"
              type="button"
              onClick={() => setWebcamMirror((value) => !value)}
              aria-pressed={webcamMirror}
            >
              <span>镜像画面</span>
              <b>{webcamMirror ? "开启" : "关闭"}</b>
            </button>
            <button
              className="toggle-row"
              type="button"
              onClick={() => setKeepCameraAfterRecording((value) => !value)}
              aria-pressed={keepCameraAfterRecording}
              disabled={controlsLocked}
            >
              <span>录制结束后保持预览</span>
              <b>{keepCameraAfterRecording ? "开启" : "关闭"}</b>
            </button>
            <p className="settings-note">
              可直接拖动摄像头监看画面；松手后位置会保存并同步进入成片，开始录制后自动锁定。监看层不是 Excalidraw 元素。默认在录制结束、切换标签页，或未录制时离开当前窗口后关闭摄像头。
            </p>
          </div>

          <div className="settings-section settings-section--last">
            <div className="settings-heading">
              <strong>保存与恢复</strong>
              <span>仅本地，不上传</span>
            </div>
            <label className="field-row">
              <span>成片保存位置</span>
              <select
                value={recordingDestinationMode}
                onChange={(event) => {
                  if (event.target.value === "download") {
                    useBrowserDownloadDestination();
                    return;
                  }
                  if (recordingDirectory) {
                    setRecordingDestinationMode("folder");
                    if (recordingDirectoryPermission !== "granted") {
                      void authorizeRecordingDirectory();
                    }
                    return;
                  }
                  void selectRecordingDirectory();
                }}
                disabled={controlsLocked || recordingDestinationBusy}
              >
                <option value="download">浏览器下载</option>
                <option
                  value="folder"
                  disabled={!isDirectoryPickerSupported()}
                >
                  指定文件夹
                </option>
              </select>
            </label>
            {recordingDirectory && (
              <div className="recording-destination">
                <div>
                  <span>当前文件夹</span>
                  <strong>{recordingDirectory.name}</strong>
                  <small>
                    {recordingDirectoryPermission === "granted"
                      ? "可直接写入"
                      : recordingDirectoryPermission === "denied"
                        ? "写入权限已拒绝"
                        : "下次使用时需要授权"}
                  </small>
                </div>
                <div className="recording-destination__actions">
                  <button
                    type="button"
                    onClick={() => void selectRecordingDirectory()}
                    disabled={controlsLocked || recordingDestinationBusy}
                  >
                    更换
                  </button>
                  {recordingDirectoryPermission !== "granted" && (
                    <button
                      type="button"
                      onClick={() => void authorizeRecordingDirectory()}
                      disabled={controlsLocked || recordingDestinationBusy}
                    >
                      重新授权
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void forgetRecordingDirectory()}
                    disabled={controlsLocked || recordingDestinationBusy}
                  >
                    清除
                  </button>
                </div>
              </div>
            )}
            {!recordingDirectory && isDirectoryPickerSupported() && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void selectRecordingDirectory()}
                disabled={controlsLocked || recordingDestinationBusy}
              >
                {recordingDestinationBusy ? "正在选择…" : "选择保存文件夹"}
              </button>
            )}
            {!isDirectoryPickerSupported() && (
              <p className="settings-warning">
                当前浏览器不支持直接写入指定文件夹，将继续使用浏览器下载。可在浏览器下载设置中开启“每次询问保存位置”。
              </p>
            )}
            <div className="storage-summary">
              <span>
                <b>录制落盘</b>
                {recordingStorage?.supported ? "OPFS 流式写入" : "短录制内存模式"}
              </span>
              <span>
                <b>可用空间</b>
                {formatBytes(recordingStorage?.availableBytes ?? null)}
              </span>
              <span>
                <b>持久存储</b>
                {recordingStorage?.persisted === true
                  ? "已允许"
                  : recordingStorage?.supported
                    ? "未保证"
                    : "不可用"}
              </span>
            </div>
            {recordingStorage?.supported && recordingStorage.persisted !== true && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void enablePersistentRecordingStorage()}
                disabled={controlsLocked}
              >
                申请持久化录制存储
              </button>
            )}
            <p className="settings-note">
              录制数据会先边录边写入浏览器安全存储，防止长录制占满内存；停止后按上面的保存位置输出成片。优先保存为 <b>.mp4</b>，
              不支持时保存为 <b>.webm</b>。录制前会预留至少 10 分钟空间。
            </p>
            <div className="recovery-heading">
              <strong>本机会话</strong>
              <button
                type="button"
                onClick={() => void refreshRecoveryCenter()}
                disabled={controlsLocked}
              >
                刷新
              </button>
            </div>
            {recoverySessions.length === 0 ? (
              <p className="recovery-empty">
                暂无可恢复或已完成的本地录制会话。
              </p>
            ) : (
              <div className="recovery-list">
                {recoverySessions.map((session) => {
                  const busy = recoveryBusySessionId === session.sessionId;
                  const statusLabel =
                    session.status === "finalized"
                      ? "完整"
                      : session.status === "writing"
                        ? "异常中断"
                        : session.status === "failed"
                          ? "写入失败"
                          : "已中止";
                  return (
                    <article className="recovery-item" key={session.sessionId}>
                      <div className="recovery-item__summary">
                        <span data-status={session.status}>{statusLabel}</span>
                        <div>
                          <strong>{formatBytes(session.actualFileBytes)}</strong>
                          <small>
                            {new Date(session.updatedAt).toLocaleString("zh-CN")}
                          </small>
                        </div>
                      </div>
                      <div className="recovery-item__actions">
                        <button
                          type="button"
                          onClick={() => void exportRecoverySession(session)}
                          disabled={busy || !session.partialDataAvailable || controlsLocked}
                        >
                          {session.status === "finalized" ? "导出视频" : "导出原始分片"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeRecoverySession(session)}
                          disabled={busy || controlsLocked}
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {recoverySessions.some((session) => session.status !== "finalized") && (
              <p className="settings-warning">
                “原始分片”只表示已有字节成功落盘；异常中断的 MP4/WebM
                容器可能不完整，当前版本不承诺可直接播放。请先导出保留，再尝试后续修复。
              </p>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                downloadDiagnostics({
                  recordingState,
                  quality: qualityId,
                  microphoneEnabled: includeMicrophone,
                  cameraEnabled,
                  compositor: compositorRef.current?.getStats(),
                });
                setNotice("诊断日志 JSON 已保存到浏览器下载目录。");
              }}
            >
              导出诊断日志
            </button>
          </div>
        </section>

        <section
          className="preview-panel"
          data-expanded={panel === "preview"}
          aria-label="输出预览"
        >
          <div className="preview-heading">
            <div>
              <strong>输出预览</strong>
              <span>
                {quality.width} × {quality.height} · {quality.fps}fps
              </span>
            </div>
            <span className="format-badge">{outputFormatLabel}</span>
          </div>
          <div className="preview-status" aria-label="输出状态">
            <span data-state={compositorStatus?.stableSceneCommits ? "ready" : "waiting"}>
              画布 {compositorStatus?.stableSceneCommits ? "已同步" : "连接中"}
            </span>
            <span data-state={activeToolSupportsZoom ? "ready" : "neutral"}>
              {activeToolLabel} {activeToolSupportsZoom ? "可触发运镜" : "不触发运镜"}
            </span>
            <span data-state={recordingSinkStatus?.state === "error" ? "waiting" : recordingSinkStatus ? "ready" : "neutral"}>
              存储 {recordingSinkStatus?.kind === "opfs" ? "流式落盘" : recordingSinkStatus ? "短录内存" : "待机"}
              {recordingSinkStatus
                ? ` · ${formatBytes(recordingSinkStatus.bytesWritten)} · 队列 ${recordingSinkStatus.pendingWrites}/${recordingSinkStatus.maxPendingWrites}`
                : ""}
            </span>
            <span data-state={compositorStatus?.cameraZoom && compositorStatus.cameraZoom > 1.02 ? "active" : "neutral"}>
              运镜 {(compositorStatus?.cameraZoom ?? 1).toFixed(2)}× ·{" "}
              {compositorStatus?.cameraPhase ?? "idle"}
            </span>
            <span data-state={cameraEnabled ? (compositorStatus?.webcamReady ? "ready" : "waiting") : "neutral"}>
              摄像头{" "}
              {cameraEnabled
                ? compositorStatus?.webcamReady
                  ? "已入画"
                  : "同步中"
                : "关闭"}
            </span>
          </div>
          <div className="output-preview">
            <canvas
              ref={outputCanvasRef}
              width={quality.width}
              height={quality.height}
              style={{
                aspectRatio: `${quality.width} / ${quality.height}`,
              }}
              aria-label="最终视频输出画面"
            />
          </div>
          <p className="preview-help">
            只有画布框内的合成画面会进入视频。状态标签、工作台、提词器和录制按钮只用于监看。
          </p>
        </section>
      </aside>
      {lastRecording && (
        <section
          className="recording-result"
          role="dialog"
          aria-modal="true"
          aria-label="录制完成回看"
        >
          <div className="recording-result__card">
            <header>
              <div>
                <strong>录制完成，可以先回看</strong>
                <span>
                  {lastRecording.filename} · {formatDuration(lastRecording.durationSeconds)} ·{" "}
                  {(lastRecording.blob.size / 1024 / 1024).toFixed(1)} MB
                </span>
              </div>
              <span className="format-badge">
                {lastRecording.mimeType.includes("mp4") ? "MP4" : "WEBM"}
              </span>
            </header>
            <video
              src={lastRecording.url}
              controls
              preload="metadata"
              style={{
                aspectRatio: `${lastRecording.width} / ${lastRecording.height}`,
              }}
              onLoadedMetadata={() =>
                recordDiagnostic("recording.review.ready", {
                  filename: lastRecording.filename,
                  mimeType: lastRecording.mimeType,
                })
              }
              onError={() =>
                recordDiagnostic(
                  "recording.review.failed",
                  { filename: lastRecording.filename },
                  "warning",
                )
              }
            />
            <p>
              请重点确认划线、自动放大和右下角摄像头。视频已自动下载；这里的播放器只读取本地 Blob，不会上传。
            </p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  downloadRecording(lastRecording.blob, lastRecording.filename)
                }
              >
                再次下载
              </button>
              <button
                className="recording-result__done"
                type="button"
                onClick={dismissLastRecording}
              >
                回看完成
              </button>
            </footer>
          </div>
        </section>
      )}
    </main>
  );
}
