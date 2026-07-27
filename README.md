# Excalidraw Recorder

一个完全本地的课程讲解录制工作台：可使用 Excalidraw 白板，也可导入图片、PDF、Markdown 和安全 HTML。激光笔与书写轨迹会进入成片并触发平滑自动运镜；提词器、设置面板、选区框和录制控件不会进入视频。

## 当前能力

- 使用官方 `@excalidraw/excalidraw@0.18.1`，字体和 PDF Worker 均为本地资源，不依赖 CDN。
- 支持 Excalidraw、PNG/JPEG/WebP/GIF/AVIF、PDF、Markdown 和安全 HTML。
- Markdown 支持文档/幻灯片分页、横竖版渲染、内置主题、标题、列表、引用、代码块和表格。
- 安全 HTML 只解析白名单静态内容，再由内部 Canvas 渲染；脚本、事件属性、表单、iframe、嵌入对象和远程资源均不会执行或加载。
- 图片、PDF、Markdown 和安全 HTML 共用翻页、逐页批注、激光笔、自动运镜与刷新恢复链路。
- PDF/图片的批注采用页面坐标，切换 `contain`/`cover`、窗口比例或 DPI 后不会因舞台留白发生偏移。
- 激光笔、自由书写、直线、箭头和图形绘制可触发自动放大；选择、抓手和普通平移不会误触发。
- 提词器可拖动、缩放、最小化、调节速度和透明度；状态存入课程项目，且始终位于视频合成树之外。
- 支持麦克风预检与 6 秒电平测试；支持低负载摄像头画中画、位置/大小/形状/镜像设置和设备释放策略。
- 支持 16:9、4:3、3:4、9:16、1:1、自定义比例、可编辑录制选区、720p/1080p 和五种输出背景。
- 双缓冲合成完成后才向编码器提交帧，避免早期黑白闪烁。
- 优先使用 H.264/AAC MP4；运行环境不支持时明确回退 VP8/Opus WebM。
- 录制默认通过有界队列流式写入 OPFS，不把所有分片持续堆入内存；浏览器不支持 OPFS 时才进入明确的短录制内存模式。
- 录制前检查空间并预留至少 10 分钟容量；“保存与恢复”可查看、导出或清理本地会话，也可申请持久化浏览器存储。
- 录制结束自动下载并打开本地回看。异常中断时可以导出已落盘原始分片，但当前不承诺不完整 MP4/WebM 容器可直接播放。
- 版本化 `CourseProject` 清单保存内容源、输出设置、提词器和录制记录；旧版数据自动迁移，未来未知 schema 只读打开，避免写坏数据。

## 本地运行

已安装 pnpm 时：

```powershell
pnpm install
pnpm dev
```

没有 pnpm 也可以直接使用 npm：

```powershell
npm install
npm run dev
```

注意：`npm dev` 不是有效命令，必须写成 `npm run dev`。打开终端给出的本地地址后，建议先完成一段 10 秒无麦克风试录，再逐项开启麦克风和摄像头。

## 验证

完整回归只需运行：

```powershell
npm run verify
```

它会依次执行类型检查、生产构建，并在动态本地端口运行白板、内容、Markdown、安全 HTML、录制存储和真实媒体 smoke；最终报告写入 `artifacts/verify-report.json`。

也可以分项执行：

```powershell
npm run typecheck
npm run build
npm run smoke
npm run smoke:content
npm run smoke:markdown
npm run smoke:html
npm run smoke:sink
npm run smoke:media
```

其中 `smoke:media` 使用浏览器虚拟摄像头/麦克风，录制真实 MP4/WebM 并通过 `ffprobe` 检查分辨率、时长、音视频轨和解码；`smoke:sink` 检查 OPFS 顺序写入、有界背压、异常 journal、原始分片导出、空间估算和安全清理。

检查当前电脑是否具备桌面版构建条件：

```powershell
npm run native:check
```

结果保存为 `artifacts/native-readiness.json`。当前开发机已具备 Node/pnpm、WebView2、FFmpeg/ffprobe，并已检测到 Microsoft PowerPoint；但尚缺 Rust/Cargo、MSVC C++ Build Tools、Windows SDK/SignTool，所以暂时不能诚实地产出 Tauri 安装包，也无法从 Web 页面直接调用 PowerPoint 自动转换。Web 版已提供“导出 PDF 后继续导入”的明确兜底；LibreOffice 只是未安装的可选备用引擎。

## 当前交付边界

目前是通过自动化验证的本地 Web 版本，还不是可安装桌面正式版。OPFS 长录制落盘和恢复中心已经建立，但 30 分钟/2 小时真机长录、休眠唤醒、设备热插拔、可播放分段恢复、兼容 MP4 最终封装、Tauri 安装/签名与干净 Windows 机器验收仍是正式发布门槛。

后续唯一权威路线图见 [PRODUCT_EXECUTION_ROADMAP.md](./PRODUCT_EXECUTION_ROADMAP.md)。早期故障复盘见 [STABILITY_REPORT.md](./STABILITY_REPORT.md)；[DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) 仅作为历史 MVP 方案保留。
