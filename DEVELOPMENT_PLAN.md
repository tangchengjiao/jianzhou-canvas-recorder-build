# 本地 Excalidraw 自动运镜录制器：详细开发方案

更新时间：2026-07-15  
当前阶段：P0.8 可用 MVP 功能闭环与真实设备验收  
目标平台：Windows 11 优先，Windows 10 2004+ 尽力兼容

## 1. 产品定义

这是一个白板原生录制器，不是通用桌面录屏软件。

唯一核心任务：

> 打开本地 Excalidraw，粘贴提词稿，按下录制，边画边讲，得到带平滑特写的本地视频。

第一版的成功不取决于功能数量，而取决于四件事：

1. 绘图手感与原生 Excalidraw 一致。
2. 自动运镜只改变成片，不改变操作者画布。
3. 提词器、按钮和编辑 UI 永远不进入成片。
4. 录制稳定、音画同步、断网可用。

## 2. 已冻结的产品边界

### 首版包含

- 官方 Excalidraw 组件，而不是仿制白板。
- 16:9；默认 1280×720、30fps，1920×1080 为可选高负载模式。
- 麦克风，可选摄像头泡泡。
- 提词器：编辑、播放/暂停、速度、字号、透明度。
- 自动运镜：自由画笔、直线、箭头、矩形、椭圆、菱形。
- 成片预览。
- 本地自动保存画布和脚本。
- MP4 能力探测；WebM 可靠兜底。
- 无账号、无水印、无上传。

### 首版明确不做

- 录制任意桌面或其他应用窗口。
- 后期时间线、字幕、静音删除、AI 降噪、抠像。
- 云同步、协作、登录、支付、分享链接。
- 4K、直播、移动端。
- 修改或 fork Excalidraw 核心源码。

## 3. 用户流程

```text
启动应用
  → 自动恢复上次画布和提词稿
  → 选择麦克风 / 摄像头 / 运镜强度
  → 查看 16:9 成片预览
  → 三秒倒计时
  → 边画边讲，提词器可独立滚动
  → 暂停 / 继续 / 停止
  → 本地保存 MP4 或 WebM
```

## 4. 总体架构

```text
操作者界面
├─ Excalidraw 编辑画布
├─ 提词器
├─ 录制控制栏
└─ 成片预览

ExcalidrawAdapter
├─ 当前工具
├─ 指针事件
├─ 场景变化
└─ 元素提交状态
        ↓
CameraPlanner
├─ 语义触发过滤
├─ 安全区跟随
├─ 镜头限速与缓动
└─ 连续笔画合并
        ↓
RecordingCompositor（默认 1280×720、可选 1920×1080 Canvas）
├─ 背景与白板
├─ 虚拟镜头裁切
├─ 光标高亮
└─ 摄像头泡泡
        ↓
Encoder
├─ Canvas 视频轨
├─ 麦克风音频轨
├─ MP4/WebM 能力选择
└─ 本地分块写盘
```

提词器不属于 `RecordingCompositor` 的渲染树，因此不是“录完再遮掉”，而是从未成为视频像素。

## 5. 技术栈

| 层 | 选择 | 原因 |
|---|---|---|
| 桌面壳 | Tauri 2 | 使用系统 WebView2，包体与基础内存低于 Electron |
| Web P0 | Vite 8 + React 18.3 + TypeScript 7 | 与 Excalidraw 内部 Radix 依赖的 peer 范围完全一致，优先稳定性 |
| 白板 | `@excalidraw/excalidraw@0.18.1` | 官方稳定组件；固定版本避免 API 漂移 |
| 实时合成 | Canvas 2D | 能直接复制白板、裁切运镜、绘制摄像头与光标 |
| P0 编码 | MediaRecorder / WebM | VP8 稳定基线；完整帧提交后手动请求编码帧 |
| MVP 编码 | MediaBunny + WebCodecs，MediaRecorder 回退 | 尝试本地 MP4，同时保留兼容路径 |
| 持久化 | IndexedDB；桌面阶段迁移 Tauri FS | 支持离线画布与附件；后续改为项目文件 |

完全离线要求：Excalidraw 字体复制到应用资源目录；运行时禁止 CDN、遥测、登录服务和远程素材依赖。

## 6. 模块边界

### `ExcalidrawAdapter`

职责：

- 保存 `ExcalidrawImperativeAPI`。
- 读取 active tool、scroll、zoom 和 scene elements。
- 规范化 pointerdown/move/up。
- 区分创建元素与 selection/hand/resize/rotate。
- 等待 `newElement == null && multiElement == null` 后确认元素提交。
- 对外输出与 Excalidraw 版本无关的事件。

禁止：把录制、编码或 UI 逻辑写进适配器。

### `CameraPlanner`

输入：规范化指针、工具、元素 bounds、时间戳。  
输出：`zoom`、`focusX`、`focusY` 和 phase。

默认规则：

- 移动不足 8–12px：仍是 ARMED，不触发运镜。
- 推近倍率：标准档 1.4×。
- 推近：250–350ms。
- 中央安全区：可视区域约 60%。
- 追踪目标：10–15Hz；渲染插值：30fps。
- 松笔停留：900–1200ms。
- 拉远：350–500ms。
- 相邻短笔画：合并，不反复推近拉远。
- 长笔画：根据 bounds 降低倍率，避免裁切。

状态机：

```text
IDLE
  → ARMED
  → DRAWING
  → AWAIT_COMMIT
  → FOCUS / HOLD
  → RETURNING
  → IDLE
```

### `RecordingCompositor`

- 输出尺寸由稳定/高清预设控制，不受应用窗口变化影响。
- 从白板画面计算基准 crop，再应用虚拟镜头。
- 摄像头在恢复 world transform 后绘制，永不随画布放大。
- 光标以独立矢量圆绘制，放大后仍清晰。
- 每帧记录实际 camera snapshot，供未来重算。

### `Recorder`

- 统一开始、暂停、继续、停止状态。
- 运行时探测 MIME/codec，不硬编码浏览器能力。
- P0 每秒接收 WebM chunk；MVP 流式写 `.part`。
- 正常结束后 finalize 并改成最终文件名。
- 监听 recorder error、track ended、磁盘写入错误。

### `Teleprompter`

- 仅属于操作者 UI。
- 文本、速度、字号、透明度本地保存。
- 不占用 Excalidraw 布局宽度，以浮层形式呈现。
- 不抢占 Excalidraw 的 Space 抓手快捷键。

## 7. 数据模型

最终项目建议使用一个目录或 `.excalicast` 容器：

```text
project/
├─ project.json
├─ board.excalidraw
├─ script.md
├─ camera-events.jsonl
├─ autosave/
└─ recordings/
   ├─ 2026-07-15T120000.part
   └─ 2026-07-15T120000.webm
```

关键事件：

```ts
type CameraEvent = {
  t: number;
  kind: "pointerDown" | "pointerMove" | "pointerUp" | "commit";
  tool: "freedraw" | "line" | "arrow" | "shape";
  scene?: { x: number; y: number };
  viewport?: { x: number; y: number };
  elementId?: string;
  bounds?: [number, number, number, number];
  camera: { zoom: number; focusX: number; focusY: number };
};
```

即使首版没有时间线，也保留 sidecar，避免未来加入“录后调整缩放”时推倒重来。

## 8. 编码与画质策略

### P0

- `recordCanvas.captureStream(0)`；双缓冲完整帧提交后调用 `requestFrame()`。
- 麦克风音轨与 Canvas 视频轨合并为一个 MediaStream。
- 首选 VP8/Opus，其次 VP9/Opus，再交给浏览器默认选择。
- 内存聚合只允许短时验证，不作为长录正式方案。

### MVP

- 优先探测 H.264/AAC MP4。
- MediaBunny 负责 Canvas/音频输入与 mux；失败回退 WebM。
- 不捆绑 FFmpeg。
- Chunked/StreamTarget 写临时文件，遵守 backpressure。

### 清晰度约束

1080p 源放大 1.5×只剩约 720p 有效细节，因此：

- 默认倍率 1.35–1.4×。
- P1 验证 1440p 场景源 → 1080p 成片。
- 机器性能不足时优先降倍率，不降低到 15fps。

## 9. 失败与恢复

- 麦克风拒绝：继续录无声视频并明确提示。
- 麦克风中途拔出：视频继续，界面显示音轨已结束。
- Canvas 丢失/重建：暂停录制并提示重试，不能静默录黑屏。
- 页面崩溃：P0 当前录像可能损失；MVP 从 `.part` 和 session metadata 尝试恢复。
- 磁盘不足：立即停止新写入并保留已有分段。
- 休眠/唤醒：结束当前 segment，唤醒后新建 segment。
- 网络断开：不影响启动、绘制、提词器、录制和导出。

## 10. 阶段计划与验收

### P0：核心技术验证（2–3 个工作日）

任务：

- [x] 建立 Vite/React/TypeScript 工程骨架。
- [x] 固定 Excalidraw 版本和本地字体复制脚本。
- [x] 加载官方 Excalidraw。
- [x] 独立 720p 稳定成片 Canvas；1080p 可选。
- [x] 提词器浮层与滚动。
- [x] 绘图工具过滤和基础自动运镜。
- [x] MediaRecorder WebM、麦克风预检与完整错误清理。
- [x] 摄像头画中画与设备选择。
- [x] 双缓冲与手动送帧，消除录制期间黑白闪烁。
- [x] 类型检查、生产构建与浏览器自动冒烟测试。

验收：

1. 录制结果中没有提词器、工具栏和设置面板。
2. 成片运镜时，编辑画布和笔迹不跳动。
3. selection、hand、画布平移不触发自动放大。
4. 720p30 两分钟录制可播放；1080p 和真实麦克风音画同步进入后续验收。
5. 断网刷新后 Excalidraw 字体和画布仍可加载。

### P1：可用 MVP（5–8 个工作日）

- 摄像头泡泡高级样式、曝光与延迟压测。
- [x] 16:9、4:3、3:4、9:16、1:1、自定义画幅与录制选区。
- [x] 五种输出画布风格。
- [x] 麦克风设备选择和音量表。
- [x] 可移动、缩放、最小化并记忆位置的提词器。
- [x] 激光笔可见轨迹与自动运镜。
- 可靠元素 commit 检测与 bounds framing。
- [x] 自动运镜三档、手动锁定/复位。
- 项目打开、另存、`.excalidraw` 导入导出。
- [x] MediaRecorder MP4 能力探测与 WebM 回退。
- 录制 chunks 流式写盘。
- 20–30 分钟稳定性验证。

验收：

- 20 分钟内存不随录像线性无界增长。
- 音画偏移目标小于 150ms。
- 常见长线、箭头和连续短笔画不被镜头裁断。
- Windows 自带播放器、VLC、剪映至少两者能直接打开成片。

### P2：桌面化与稳定（3–5 个工作日）

- 安装 Rust、MSVC Build Tools、Windows SDK。
- Tauri 2 壳、安装包和便携构建。
- 本地项目文件、`.part` 和 session recovery。
- 独立 always-on-top 提词器窗口（可选）。
- DPI 100/125/150/200%、窗口缩放、睡眠恢复测试。
- 自动更新关闭或改为显式手动更新，确保纯本地。

## 11. 测试矩阵

| 维度 | 最少覆盖 |
|---|---|
| 工具 | freedraw、line、arrow、rectangle、selection、hand、eraser |
| 输入 | 鼠标、触控板；数位笔留到 P1 |
| 比例 | 16:9；P1 增加 9:16 |
| DPI | 100%、125%、150%、200% |
| 音频 | 默认麦克风、USB 麦克风、拒绝权限、拔出设备 |
| 时长 | 2 分钟、20 分钟、30 分钟 |
| 状态 | 暂停继续、窗口缩放、最小化、休眠唤醒、磁盘不足 |
| 兼容 | Edge/WebView2；P0 可用 Chrome 复核 |

## 12. 当前环境结论

已具备：Node 24、npm、pnpm、Bun、Git、WebView2。  
尚缺：Rust、Cargo、MSVC Build Tools、Windows SDK。

因此当前正确顺序是：先完成 Web P0，验证白板复制、提词器隔离、1080p30、麦克风和自动运镜；通过验收后再安装桌面构建工具。这样不会在核心体验尚未验证前先投入原生打包成本。

## 13. P0 实测记录（2026-07-15）

自动化浏览器冒烟测试已完成以下真实链路：

- 官方 Excalidraw 静态层与交互层均成功加载并进入输出合成器。
- 输出画布默认 1280×720，支持切换 1920×1080。
- 修改提词器内容前后，输出画布 PNG 像素完全一致。
- freedraw 落笔时镜头从 1.000× 平滑到 1.399×，状态为 `drawing`。
- 松手保持后镜头降到 1.037× 并进入 `returning`。
- selection 拖拽由工具过滤器排除，不触发放大。
- 修复后本机 Chrome 完整录制链路成功下载 VP8 1280×720 WebM；ffprobe 读取 72 帧。
- 录制期间黑屏在改用手动 `requestFrame()` 后不再复现。
- 页面运行期间无未捕获异常；生产构建通过。

尚未完成、不能视为已验收的项目：2 分钟/20 分钟长录、真实麦克风音画同步、
不同 DPI 与睡眠恢复。这些进入 P1 稳定性批次。
