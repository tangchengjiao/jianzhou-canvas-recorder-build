# Excalidraw Recorder 产品化执行路线图

> 最后更新：2026-07-15  
> 文档地位：这是后续开发、验收和发布的唯一权威路线图。`DEVELOPMENT_PLAN.md` 与 `STABILITY_REPORT.md` 保留为历史设计和故障复盘，不再代表最终完成度。

## 1. 结论与完成定义

产品定位不是通用录屏器，而是一个 Windows 优先、完全本地的“课程讲解录制工作台”：用户导入或创建内容，在统一舞台上讲解、批注、自动运镜，并得到可直接回看和进入常见剪辑软件的成片。

最终首发版必须同时满足：

1. 支持 Excalidraw、图片、PDF、Markdown/受控 HTML；PPT/PPTX 通过可靠转换入口进入 PDF 链路。
2. 提词器可移动、缩放、置顶，并从未进入录制合成树。
3. 自由书写与激光笔的轨迹都进入成片，并触发平滑自动放大；选择、抓手和普通平移不误触发。
4. 支持 16:9、4:3、3:4、9:16、1:1、自定义比例、录制选区和内置画布风格。
5. 摄像头、麦克风、预览、暂停/继续、录后回看、诊断和失败提示形成完整闭环。
6. 长录制不把全部数据持续堆在内存中；崩溃或磁盘写入失败时，尽可能保留已完成分段。
7. 默认输出 MP4（H.264/AAC）或提供明确兼容回退，文件能被 Windows 播放器、VLC 和至少一种主流剪辑软件直接打开。
8. 以受限权限的 Tauri 2 Windows 应用交付，提供安装包、隐私说明、第三方许可、可恢复项目与可导出诊断包。
9. 所有核心操作离线可用，不上传用户画布、文档、脚本、音视频或诊断。
10. 自动化、真机、长时、DPI、休眠恢复和安装包验收全部通过后，才可以称为“可交给其他人使用”。

当前版本是已通过浏览器自动化验证的本地 Web MVP，不满足第 6、7（全兼容）、8、10 条，因此不能提前标记为正式版。

## 2. 当前基线（冻结，不推倒重来）

### 已实现并验证

- 官方 `@excalidraw/excalidraw@0.18.1`，字体和 PDF Worker 均为本地资源。
- Excalidraw、图片、PDF、Markdown、安全 HTML；分页、逐页批注、刷新恢复和统一 Adapter registry。
- 文档指针、激光笔、画笔、荧光笔；激光轨迹和书写轨迹进入预览/成片并触发自动运镜。
- 可移动/缩放/最小化的提词器；提词器、工具栏和设置不进入合成 Canvas。
- 麦克风、摄像头画中画、设备释放策略、录前倒计时、暂停/继续、录后回看。
- 多比例、录制选区、720p/1080p、五种输出背景。
- 双缓冲合成和手动送帧，避免早期黑白闪烁问题。
- MP4 能力探测与 WebM 回退；诊断 JSON。
- `typecheck`、生产构建以及白板/内容/Markdown/安全 HTML/存储/媒体 smoke 均已通过；媒体 smoke 还会用 `ffprobe` 解码验证。

### 已知未完成

- Web 版已将 `MediaRecorder` chunk 通过有界队列流式写入 OPFS；仍未经过 30 分钟/2 小时内存稳态验收，也没有可播放完整 segment 的崩溃恢复保证。
- 页面坐标批注、退出前 flush、资产/会话原子替换和版本化课程清单已完成；仍只有单一当前项目，尚无项目列表、另存为和便携包。
- Markdown 与安全 HTML 已实现；相对本地图像仍需桌面项目目录权限，任意本地网页隔离预览和 PPT/PPTX 转换入口尚未实现。
- 还不是 Tauri 应用；没有原生文件流、安装器、签名、受限 capability 或独立提词器窗口。
- 尚未完成 30 分钟/2 小时长录、真实 USB 麦克风、摄像头热拔插、100%–200% DPI、休眠唤醒、低磁盘等矩阵。
- 当前开发机没有 Rust/Cargo、MSVC 构建链、Windows SDK/`signtool` 或 LibreOffice；已有 Node/pnpm、WebView2、FFmpeg/ffprobe，并已检测到 Microsoft PowerPoint。

## 3. 不再反复摇摆的架构决策

### 3.1 内容统一为“可绘制帧”，不是把每种格式写进录制器

所有内容实现 `ContentAdapter`：

```text
Excalidraw ─┐
Image ──────┤
PDF ────────┤        ┌─ base frame
Markdown ───┼─> ContentAdapter ─> SceneSourceFrame ─> RecordingCompositor
Safe HTML ──┤        ├─ committed annotations
WebView ────┘        └─ transient laser/pen
```

录制器只消费已经准备好的帧，不理解 PDF、PPT 或 HTML。这样自动运镜、选区、摄像头和编码只维护一套。

同时把三个概念拆开，避免把 `ContentKind` 扩展成无法维护的万能枚举：

```ts
type AssetFormat = "excalidraw" | "image" | "pdf" | "markdown" | "html" | "ppt" | "pptx";
type SurfaceMode = "paged" | "scroll" | "live";
type RenderEngine = "excalidraw" | "image-bitmap" | "pdfjs" | "markdown" | "webview2" | "converted-pdf";
```

导入路由返回原始资产、可选衍生资产、Adapter、能力、安全等级和转换诊断；例如 PPTX 是原始格式，PowerPoint/PDF 是转换与渲染引擎，它本身不需要成为录制器认识的新舞台类型。

### 3.2 PPT/PPTX 不在浏览器中重新实现 PowerPoint

首发采用“转换为 PDF，再进入现有 PDF Adapter”：

1. Windows 检测到 Microsoft PowerPoint 时，调用 PowerPoint 的 `ExportAsFixedFormat` 输出 PDF。这与 PowerPoint 的“另存为 PDF/XPS”使用同一能力，静态版式保真度最高。
2. 没有 PowerPoint、但用户已安装 LibreOffice 时，可选择 headless 转 PDF，并明确提示兼容性可能不同。
3. 两者都没有时，给出一步式说明，让用户在原软件导出 PDF 后导入；绝不让“缺少转换器”导致整个应用不可用。

首发不承诺保留动画、转场、内嵌视频和宏。需要动画的 PPT 属于后续“原生演示捕获”课题，不阻塞静态课程讲解。

### 3.3 HTML 分为两种产品能力

“任意 HTML”并不等于“可以安全画进 Canvas”。`drawImage()` 不能绘制 iframe；基于 DOM 的伪截图对 CSS、字体、跨域图片、Canvas/WebGL 和视频都有缺口。因此分层：

- **受控文档模式（首发）**：Markdown 和安全 HTML 子集转换为我们自己的页面 DOM；禁用脚本、外部网络和表单，使用内置主题，渲染为稳定静态帧。适合横版/竖版课程页面。
- **隔离网页模式（桌面增强）**：任意本地网页只在独立、无 Tauri 权限的 WebView2 中运行，默认阻断网络、导航、下载、弹窗和 host object。`CapturePreview` 只作为页面稳定后的静态/低动态快照源，不承诺 30fps 动画。
- **协作式 HTML 演示协议（后续）**：若要高质量 HTML 动画录制，由页面主动按约定输出 slide、camera focus 和可捕获 Canvas，而不是尝试抓取任意网页。

导入文件绝不与拥有文件系统权限的应用主窗口同源运行；也不同时授予 iframe `allow-scripts` 和 `allow-same-origin`。

### 3.4 项目使用目录，便携包只用于交换

桌面版默认项目结构：

```text
Course Project/
├─ project.json
├─ sources/
├─ annotations/
├─ scripts/
├─ autosave/
├─ recordings/
└─ diagnostics/
```

- `project.json` 是带 `schemaVersion` 的清单，不内嵌大型 Blob。
- 资产使用不可变 ID + 校验值；批注按 source/page 分离。
- 正在编辑时使用目录，便于增量保存和崩溃恢复。
- `.excalicast` 是显式“导出便携项目”的 ZIP 容器，不作为实时写入格式。
- Web MVP 继续用 IndexedDB，但通过同一 Repository 接口访问。

### 3.5 长录制先解决写盘，再替换编码器

稳定路线分两层，不一次性重写：

1. 建立 `RecordingSink`：每个 `dataavailable` chunk 立即排队写入，队列有上限、背压和错误传播；内存 Sink 只允许短录/测试。
2. Web MVP 可使用 OPFS Worker 验证写盘协议；正式桌面版由 Rust `RecordingSession` 通过原始二进制 IPC 接收 chunk，写 `source.media.part` 和原子 journal。
3. 现有 MediaRecorder 仍是第一阶段默认编码器，以减少回归；`timeslice` 产生的单个 chunk 不被假定为可独立播放。
4. 桌面生产路径同时把流送入经过许可证审计的 FFmpeg sidecar，实时生成 fragmented MP4；正常结束后 remux 为 faststart MP4，并用 ffprobe/完整解码验证。最终文件验证成功前不删除 source recovery 文件。
5. MediaBunny + WebCodecs 保留为“小包体、无 sidecar”的备选 Spike；只有音频编码、同步、长录和兼容矩阵优于桌面路径时才升级为默认，不在首发中同时维护两个未经证明的主路径。
6. 关闭、崩溃或休眠时以 segment 为边界；启动时扫描未完成 journal，让用户恢复、保留或删除。

只有 30 分钟和 2 小时实测证明内存不随文件大小线性增长，才能删除“实验性”标签。

### 3.6 桌面壳使用最小权限

- Tauri 2 使用显式 capabilities；主窗口只拥有实际需要的 dialog/fs 权限，并将 fs scope 限制到已打开项目或用户明确选择的路径。
- HTML 内容 WebView 不继承主窗口 capability；不暴露 shell、sidecar、文件系统或任意 command。
- CSP 不允许 CDN 或未授权连接；网络默认关闭。
- Windows 轻量安装器使用系统 Evergreen WebView2；另行提供体积更大的离线安装器，不把 Fixed Version Runtime 塞进默认包。
- 首发自动更新保持关闭，直至具备代码签名证书和更新签名密钥；先提供签名的手动安装包。

## 4. 核心模块与边界

```text
Application UI
├─ Project Library / Workspace
├─ Source Rail / Presenter Controls
├─ Floating or Desktop Teleprompter
└─ Recording Review / Recovery Center

Product Kernel
├─ CourseProjectModel + migrations
├─ ProjectRepository (IndexedDB / Tauri FS)
├─ AssetRepository
├─ HostBridge (Web / Tauri)
└─ CapabilityService

Presentation Engine
├─ ContentAdapter registry
├─ AnnotationEngine
├─ CameraPlanner
└─ RecordingCompositor

Media Pipeline
├─ MediaInputManager
├─ Capture Encoder (MediaRecorder; MediaBunny Spike)
├─ RecordingSink (Memory / OPFS / Tauri file)
├─ Rust RecordingSession + SessionJournal
├─ FFmpeg fMP4 finalizer / Recovery
└─ RecordingCatalog

Desktop Services
├─ Dialog / scoped file access
├─ PPT conversion gateway
├─ isolated HTML WebView
└─ installer / signing / diagnostics
```

硬边界：UI 不直接调用 IndexedDB、Tauri command 或 PowerPoint；录制器不访问 React；内容 Adapter 不持有麦克风、摄像头或编码器；导入 HTML 不获得桌面权限。

## 5. 版本化项目模型

最小清单字段：

```ts
type CourseProject = {
  schemaVersion: number;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeSourceId: string;
  sources: Array<{
    id: string;
    kind: "excalidraw" | "image" | "pdf" | "markdown" | "html";
    title: string;
    mimeType: string;
    assetId?: string;
    currentPage: number;
    fitMode: "contain" | "cover";
  }>;
  teleprompter: { scriptAssetId?: string; speed: number; fontSize: number };
  outputProfile: OutputProfile;
  recordings: RecordingManifest[];
};
```

规则：

- 所有读取都经过校验和迁移；未知的新版本只读打开，绝不静默覆盖。
- 保存采用“写临时文件 → flush → 原子替换 manifest”；IndexedDB 使用单事务。
- 大型资产和录像只存引用、大小、MIME、校验值，不塞入 JSON。
- 每次 schema 变更必须附带旧版本 fixture、迁移测试和降级说明。

## 6. 分阶段执行与门禁

### Phase 0：冻结稳定基线 — 已完成

交付：当前 Web MVP、备份、三套 smoke、诊断和已知限制清单。

门禁：现有 `typecheck`、`build`、`smoke`、`smoke:content`、`smoke:media` 必须持续通过。任何后续阶段破坏该门禁，先修复回归再继续。

### Phase 1：产品内核 — 已完成并通过统一验证

任务：

- [x] 建立 `CourseProject` schema、运行时校验、迁移器、默认项目工厂。
- [x] 抽象 `ProjectRepository` 和 `AssetRepository`；适配现有 IndexedDB，兼容数据库 v1/v2。
- [x] 建立 `HostBridge` 与 capability 探测，Web 实现明确返回不支持的桌面能力。
- [x] 建立 adapter registry，内容 kind 与可用能力不再散落在 `App.tsx`。
- [x] 把文档新批注改为页面坐标，正确处理 contain/cover/crop；旧舞台坐标带版本兼容读取。
- [x] 页面隐藏/关闭前 flush 最新 snapshot；资产、引用更新和孤儿回收进入一致事务。
- [x] 将当前输出配置、脚本、活动内容和批注元数据纳入项目清单；保留旧数据自动迁移。
- [x] 增加项目模型/迁移/刷新恢复自动化测试。

验收：旧版浏览器数据升级后画布、PDF/图片、当前页和批注不丢；新旧 schema fixture 全通过；不能识别的 schema 不被写坏。

回滚：Repository 仍能读旧 `projects/current`、`contentSessions/current`；新清单写入独立 store，在完成切换前不删除旧数据。

### Phase 2：课程内容包 — 当前执行阶段

任务：

- [ ] Markdown Adapter：分页约定、内置横/竖主题、本地图片、代码块和表格。
  - 已完成受控语法、横/竖渲染、主题、代码块、表格、App 导入与恢复；本地图片 resolver 已有安全边界，但仍需 Phase 5 的项目目录选择器提供实际相对文件。
- [x] Safe HTML Adapter：解析白名单内容、忽略样式，剥离脚本、事件属性、远程 URL、表单和嵌入对象；绝不插入页面 DOM。
- [x] 为 Markdown/HTML 复用逐页批注、激光笔、自动运镜、缩略图和刷新恢复。
- [ ] 桌面转换接口与 UI：PowerPoint → PDF；可选 LibreOffice → PDF；手动导出 PDF 兜底。
  - Web 版的 PPT/PPTX 入口与“导出 PDF 后继续导入”说明已完成并通过交互 smoke；自动转换仍等待桌面 HostBridge。
- [ ] 转换报告显示使用的引擎、输出路径、页数、警告与日志，不伪装为原生 PPT 播放。

验收：横/竖 Markdown、恶意 HTML fixture、带本地图像/中文字体/代码表格的文档通过；转换后的 PPT 页数和尺寸正确；没有外部网络请求；脚本无法执行。

回滚：任何解析/转换失败都不修改项目，只显示错误并保留“导入 PDF”路径。

### Phase 3：长录制与恢复 — 与 Phase 2 并行执行

任务：

- [x] `RecordingSink`、有界写入队列、背压、进度统计、flush/finalize/abort 协议。
- [ ] 将已完成的主线程 OPFS Sink 迁入 Worker，并实现 Tauri File Sink；Memory Sink 仅测试或短录。
- [x] session journal、`.part`、启动恢复中心、空间预估、低磁盘保护；异常分片明确不承诺可播放。
- [ ] 页面关闭、轨道 ended、写入失败、休眠/唤醒、摄像头/麦克风拔出时的 segment 策略。
- [ ] 记录掉帧、最长写队列、实际码率、磁盘吞吐、音画时钟和错误原因。
  - 已记录峰值/上限写队列、会话时长、平均写入速率、实际码率和错误；掉帧、磁盘瞬时吞吐与音画时钟仍待长录矩阵。

验收：720p30 连续 30 分钟与 2 小时；主进程内存达到稳态而非随录像线性增长；强制终止后能恢复到最近完整 segment；磁盘不足不会生成“看似成功”的损坏文件。

回滚：流式 Sink 不可用时只允许明确标注的“短录模式”，并显示时长/内存风险，不静默回到无限内存聚合。

### Phase 4：MP4 兼容生产链

任务：

- [ ] 以 capability probe 检查 VideoEncoder/AudioEncoder、H.264/AAC 配置和硬件路径。
- [ ] Tauri/Rust 会话将 MediaRecorder 输入同步保存并送入 FFmpeg fragmented MP4；停止后 remux 为 faststart。
- [ ] 固定 LGPL-only FFmpeg build、配置、哈希、NOTICE 与 SBOM；不直接分发当前开发机的 GPL/libx264 构建。
- [ ] MediaBunny streaming target/分片 MP4 仅作为独立试验；MediaRecorder + 桌面会话继续作为默认。
- [ ] 统一输出 manifest、扩展名、MIME、codec、时长和可恢复状态。
- [ ] 必要时提供“转换为兼容 MP4”的显式桌面操作；FFmpeg 只能由固定的 Rust command 以参数数组启动，绝不向前端开放通用 shell。

验收：Windows Media Player、VLC、剪映/Adobe Premiere 或 DaVinci Resolve 中至少三类消费者通过；`ffprobe` 检查轨道、时长、分辨率和 codec；音画偏移目标小于 150ms。

回滚：实时 finalizer 失败时保留已经落盘的 source 和 journal，录制 UI 显示可恢复状态；可继续保存 source 或安全停止，但不在录制中途悄悄变更最终格式并假报成功。

### Phase 5：Tauri 2 Windows 桌面化

前置门禁：安装 Rust stable、MSVC C++ Build Tools、Windows SDK 与 WebView2；构建机固定版本并记录 SBOM。

任务：

- [ ] 初始化 Tauri 2 壳和 Web/Tauri 双实现 HostBridge。
- [ ] 使用 dialog + scoped fs 打开/另存项目，原生流式写录像。
- [ ] 独立 always-on-top 提词器窗口；只交换最小状态，不得到项目文件权限。
- [ ] PowerPoint/LibreOffice 转换 command 使用固定参数、超时、取消、临时目录和输出校验。
- [ ] 隔离 HTML WebView：独立 capability、网络拦截、导航白名单、无 host object。
- [ ] CSP、权限清单、Windows installer、卸载和便携测试。

验收：`tauri build` 可重复；capability 审计无通配 shell/fs；导入恶意 HTML 不能读项目或调用 command；安装、升级、卸载不破坏用户项目；无网络时完整核心流程可用。

回滚：Web MVP 保持可运行；桌面能力通过 feature flag 启用；转换器和隔离 WebView 失败不影响白板/PDF录制。

### Phase 6：面向普通用户的完整体验

任务：

- [ ] 项目首页：新建、最近项目、复制、重命名、归档、恢复。
- [ ] 首次启动向导：权限解释、设备试听/预览、10 秒试录、保存位置。
- [ ] 录前检查：内容、选区、比例、空间、格式、麦克风电平、摄像头状态。
- [ ] 录中：清晰状态、暂停/继续、静音、摄像头开关、剩余空间、错误恢复。
- [ ] 录后：本地回看、打开文件夹、重命名、兼容转换、保留/删除失败片段。
- [ ] 键盘快捷键、焦点管理、可访问名称、颜色对比、200% DPI 与触控笔体验。
- [ ] 支持包：脱敏诊断、版本、能力、编码 profile、设备标签摘要；默认不含文件路径、脚本内容或媒体。

验收：新用户无需终端即可在 5 分钟内完成试录；关闭摄像头后系统指示灯熄灭；提词器位置跨会话恢复；所有破坏性操作可撤销或二次确认。

### Phase 7：发布与“可交给其他人”门禁

任务：

- [ ] 代码签名证书、签名安装器、病毒误报检查。
- [ ] 默认在线安装器使用 Evergreen WebView2；独立离线安装器明确体积差异。
- [ ] 隐私说明、第三方许可、MPL-2.0 合规、版本说明和支持渠道。
- [ ] 干净 Windows 10/11 虚拟机与至少两台真实设备安装测试。
- [ ] 发布候选版冻结、回滚包、崩溃恢复演练和数据迁移演练。

正式版门禁：所有 P0/P1 缺陷关闭；无数据丢失/权限越界/无法停止录制/生成不可播放文件的问题；长录和安装矩阵有可复核证据。

### Phase 8：首发后增强，不阻塞 v1

- 可编辑 camera-events sidecar、简单剪切与重新运镜。
- 字幕、章节、静音段提示和模板市场。
- PPT 动画/演示者模式捕获、协作式 HTML 动画协议。
- macOS 适配、云同步、协作与分享。

## 7. 格式能力矩阵

| 格式 | 首发方式 | 脚本/网络 | 动画 | 版式目标 | 失败兜底 |
|---|---|---:|---:|---|---|
| Excalidraw | 原生组件 | 无 | 白板交互 | 原生 | 导出/恢复画布 |
| PNG/JPEG/WebP | Image Adapter | 无 | 无 | 像素一致 | 报错不改项目 |
| PDF | PDF.js 本地 Worker | 无 | 无 | 页面一致 | 报错不改项目 |
| Markdown | 受控内部渲染 | 禁止远程 | 内置轻动画可后续 | 主题一致 | 纯文本模式 |
| Safe HTML | 白名单解析 + 内部渲染 | 禁止 | 首发无 | 支持子集 | 显示不支持项 |
| 任意本地 HTML | 隔离 WebView2 | 默认阻断 | 仅低动态快照 | 尽力而为 | 导出 PDF/图片 |
| PPT/PPTX | PowerPoint/LibreOffice 转 PDF | 宏不执行 | 首发无 | 静态高保真 | 手动导出 PDF |

## 8. 测试与发布证据

每个发布候选版本必须保存：

- 构建版本、Git revision、Node/Rust/WebView2/Windows 版本。
- `typecheck`、production build 和全部 smoke 报告。
- 720p/1080p、多比例、白板/PDF/图片/Markdown/HTML 的录制样例。
- `ffprobe` JSON、内存曲线、掉帧率、磁盘写入峰值、音画偏移。
- 30 分钟和 2 小时结果；强杀恢复、低磁盘、休眠唤醒结果。
- DPI 100/125/150/200%、窗口缩放、摄像头/麦克风许可拒绝与热拔插结果。
- 安装、覆盖升级、卸载、旧项目迁移、离线启动结果。
- capability、CSP、外部请求和恶意 HTML fixture 审计。

不得用“构建通过”替代真机验收，也不得用一个浏览器能播放替代跨软件兼容验收。

## 9. 风险登记与控制

| 风险 | 严重性 | 控制 |
|---|---:|---|
| 长录占满内存 | 阻断 | Sink 流式写盘、有界队列、2 小时门禁 |
| MP4 能力因 WebView2 版本不同 | 高 | 录前 capability probe、profile 冻结、MediaRecorder 回退 |
| HTML 执行恶意代码/读文件 | 阻断 | 安全子集或独立无权限 WebView、网络与导航拦截 |
| PPT 转换器不存在/版式差异 | 高 | PowerPoint 优先、LibreOffice 可选、手动 PDF 永久兜底 |
| 录制中睡眠/设备拔出 | 高 | segment、journal、track ended、恢复中心 |
| Tauri 权限配置过宽 | 阻断 | capability 白名单、fs scope、命令参数校验、安全审计 |
| 安装器未签名导致拦截 | 高 | 签名证书为正式发布门禁 |
| 项目 schema 升级丢数据 | 阻断 | 只增迁移、fixture、原子保存、未知版本只读 |
| 为追求功能继续膨胀单文件 App | 中 | Kernel/Adapter/Media/Desktop 边界与阶段性拆分 |

## 10. 当前立即执行顺序

1. 为 Markdown/安全 HTML 补内容呈现设置与项目目录相对资源入口；保持恶意 fixture 和零外联门禁。
2. 把 OPFS 写入移入 Worker，补 track ended/休眠/写失败分段策略和长录指标，再执行 30 分钟/2 小时门禁。
3. 安装并固定 Rust、MSVC、Windows SDK 等原生构建依赖，进入 Tauri 壳、原生文件流和隔离 WebView。
4. 在桌面 HostBridge 上接 PowerPoint/LibreOffice 转 PDF；没有转换器时始终保留手动 PDF 兜底。
5. 达成长录门禁后再评估 MediaBunny/FFmpeg 兼容 MP4 路径。
6. 最后完成项目首页、普通用户体验、签名安装器和完整发布矩阵。

## 11. 关键官方依据

- [PowerPoint `Presentation.ExportAsFixedFormat`](https://learn.microsoft.com/en-us/office/vba/api/powerpoint.presentation.exportasfixedformat)
- [Tauri Windows Installer 与 WebView2 安装模式](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri permissions](https://v2.tauri.app/security/permissions/)、[capabilities](https://v2.tauri.app/security/capabilities/)、[CSP](https://v2.tauri.app/security/csp/)
- [Tauri file system plugin 与 scope](https://v2.tauri.app/plugin/file-system/)
- [Microsoft WebView2 security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security)
- [WebView2 local content](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content) 与 [`CapturePreviewAsync`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.capturepreviewasync)
- [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [MDN MediaRecorder `dataavailable`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event)
- [MDN Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [MediaBunny writing media files](https://mediabunny.dev/guide/writing-media-files) 与 [media sources](https://mediabunny.dev/guide/media-sources)
- [MediaStream Recording 规范](https://www.w3.org/TR/mediastream-recording/)
- [FFmpeg MP4 fragmentation](https://ffmpeg.org/ffmpeg-formats.html) 与 [FFmpeg legal/licensing](https://ffmpeg.org/legal.html)
