import { invoke, isTauri } from "@tauri-apps/api/core";

import type {
  MediaInputError,
  MediaInputTarget,
} from "../core/mediaInputs";

export type MacMediaTarget = Extract<
  MediaInputTarget,
  "camera" | "microphone"
>;

export const isMacTauriRuntime = () =>
  isTauri() &&
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/i.test(navigator.userAgent);

export const openMacMediaPrivacySettings = (target: MacMediaTarget) =>
  invoke<void>("open_macos_media_settings", { target });

export const getMacMediaRecoveryMessage = (
  error: MediaInputError,
  target: MacMediaTarget,
) => {
  const label = target === "camera" ? "摄像头" : "麦克风";
  if (error.code === "permission-denied" || error.code === "security") {
    return `macOS 尚未允许本应用访问${label}。请打开“隐私与安全性 → ${label}”，开启“Jianzhou Canvas Recorder Beta”，然后完全退出并重新打开应用。`;
  }
  if (error.code === "device-busy") {
    return `${label}可能正被 FaceTime、Zoom、浏览器或其他录制软件占用。关闭占用程序后再重试。`;
  }
  if (error.code === "timeout") {
    return `等待${label}授权或启动超时。若系统弹出了权限窗口，请先选择“允许”，再点击重试。`;
  }
  if (error.code === "overconstrained") {
    return `${label}不支持当前设备参数，应用已尝试兼容模式；请切换到“系统默认”后重试。`;
  }
  return error.message;
};

