from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "见舟画布录制-用户使用手册.pdf"
ASSETS = ROOT / "docs" / "assets" / "user-manual"
OUT.parent.mkdir(parents=True, exist_ok=True)

W, H = A4
BG = HexColor("#F6F2E9")
PAPER = HexColor("#FFFDF8")
TEAL = HexColor("#086C67")
TEAL_DARK = HexColor("#184A47")
TEAL_LIGHT = HexColor("#DCEDEA")
GOLD = HexColor("#C59B3B")
GOLD_LIGHT = HexColor("#F2E8CC")
INK = HexColor("#26312F")
MUTED = HexColor("#697572")
RED = HexColor("#B24A42")
LINE = HexColor("#D9D4C8")

pdfmetrics.registerFont(TTFont("CN", r"C:\Windows\Fonts\msyh.ttc"))
pdfmetrics.registerFont(TTFont("CN-Bold", r"C:\Windows\Fonts\msyhbd.ttc"))


def text_width(text, size, font="CN"):
    return pdfmetrics.stringWidth(text, font, size)


def wrap(text, width, size, font="CN"):
    lines, current = [], ""
    for char in text:
        if char == "\n":
            lines.append(current)
            current = ""
            continue
        trial = current + char
        if current and text_width(trial, size, font) > width:
            lines.append(current)
            current = char
        else:
            current = trial
    if current or not lines:
        lines.append(current)
    return lines


def paragraph(c, text, x, y, width, size=10.2, leading=16, color=INK, font="CN", max_lines=None):
    lines = wrap(text, width, size, font)
    if max_lines:
        lines = lines[:max_lines]
    c.setFont(font, size)
    c.setFillColor(color)
    for line in lines:
        c.drawString(x, y, line)
        y -= leading
    return y


def page_base(c, page_no, kicker, title):
    c.setFillColor(BG)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(TEAL_DARK)
    c.rect(0, H - 42, W, 42, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("CN", 8.5)
    c.drawString(34, H - 27, "见舟画布录制 · 快速使用手册")
    c.drawRightString(W - 34, H - 27, f"{page_no:02d}")
    c.setFillColor(GOLD)
    c.setFont("CN-Bold", 9)
    c.drawString(38, H - 75, kicker)
    c.setFillColor(INK)
    c.setFont("CN-Bold", 24)
    c.drawString(38, H - 108, title)
    c.setStrokeColor(GOLD)
    c.setLineWidth(2)
    c.line(38, H - 122, 112, H - 122)


def footer(c, note="本地运行 · 无需登录 · 无需 API Key"):
    c.setStrokeColor(LINE)
    c.setLineWidth(0.6)
    c.line(38, 34, W - 38, 34)
    c.setFillColor(MUTED)
    c.setFont("CN", 7.6)
    c.drawString(38, 20, note)


def pill(c, text, x, y, fill=TEAL_LIGHT, color=TEAL_DARK, width=None):
    width = width or text_width(text, 8.6, "CN-Bold") + 22
    c.setFillColor(fill)
    c.roundRect(x, y, width, 24, 12, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont("CN-Bold", 8.6)
    c.drawCentredString(x + width / 2, y + 7.5, text)
    return width


def card(c, x, y, w, h, title, body, number=None, accent=TEAL):
    c.setFillColor(PAPER)
    c.setStrokeColor(LINE)
    c.roundRect(x, y, w, h, 10, fill=1, stroke=1)
    tx = x + 15
    if number is not None:
        c.setFillColor(GOLD)
        c.circle(x + 20, y + h - 22, 10, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont("CN-Bold", 8)
        c.drawCentredString(x + 20, y + h - 25, str(number))
        tx = x + 38
    c.setFillColor(accent)
    c.setFont("CN-Bold", 11)
    c.drawString(tx, y + h - 27, title)
    paragraph(c, body, x + 15, y + h - 48, w - 30, 8.5, 13, MUTED, max_lines=5)


def screenshot(c, name, x, y, w, h, callouts=()):
    path = ASSETS / name
    c.setFillColor(PAPER)
    c.setStrokeColor(LINE)
    c.roundRect(x - 4, y - 4, w + 8, h + 8, 11, fill=1, stroke=1)
    image = ImageReader(str(path))
    iw, ih = image.getSize()
    scale = min(w / iw, h / ih)
    dw, dh = iw * scale, ih * scale
    dx, dy = x + (w - dw) / 2, y + (h - dh) / 2
    c.drawImage(image, dx, dy, dw, dh, preserveAspectRatio=True, mask="auto")
    for n, px, py in callouts:
        cx, cy = dx + dw * px, dy + dh * py
        c.setFillColor(GOLD)
        c.circle(cx, cy, 10, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont("CN-Bold", 8)
        c.drawCentredString(cx, cy - 3, str(n))


def bullets(c, items, x, y, width, size=9.4, leading=15, gap=7, color=INK):
    for item in items:
        c.setFillColor(GOLD)
        c.circle(x + 4, y + 3, 3.2, fill=1, stroke=0)
        y = paragraph(c, item, x + 15, y, width - 15, size, leading, color)
        y -= gap
    return y


c = canvas.Canvas(str(OUT), pagesize=A4, pageCompression=1)
c.setTitle("见舟画布录制 · 用户使用手册")
c.setAuthor("见舟AI")
c.setSubject("本地白板、文档、提词与自动运镜录制工具使用说明")

# 1 Cover
c.setFillColor(TEAL_DARK)
c.rect(0, 0, W, H, fill=1, stroke=0)
c.setFillColor(GOLD)
c.circle(W - 80, H - 85, 145, fill=1, stroke=0)
c.setFillColor(TEAL)
c.circle(W - 30, H - 150, 150, fill=1, stroke=0)
c.setFillColor(white)
c.setFont("CN-Bold", 33)
c.drawString(46, H - 215, "见舟画布录制")
c.setFont("CN-Bold", 22)
c.drawString(46, H - 252, "用户使用手册")
c.setFillColor(GOLD_LIGHT)
c.setFont("CN", 12)
c.drawString(48, H - 286, "白板 · 文档 · 提词 · 摄像头 · 自动运镜 · 本地录制")
pill(c, "5 分钟上手", 48, H - 340, GOLD_LIGHT, TEAL_DARK, 96)
pill(c, "无需 API", 154, H - 340, TEAL_LIGHT, TEAL_DARK, 82)
pill(c, "无需登录", 246, H - 340, TEAL_LIGHT, TEAL_DARK, 82)
pill(c, "本地运行", 338, H - 340, TEAL_LIGHT, TEAL_DARK, 82)
c.setFillColor(HexColor("#234F4C"))
c.roundRect(46, 132, W - 92, 210, 18, fill=1, stroke=0)
c.setFillColor(white)
c.setFont("CN-Bold", 15)
c.drawString(66, 306, "第一次录制，只做这 5 件事")
steps = ["选画幅与保存位置", "测试麦克风/摄像头", "放好提词器", "试录 10～20 秒", "回看后正式录制"]
for idx, step in enumerate(steps, 1):
    y = 270 - (idx - 1) * 31
    c.setFillColor(GOLD)
    c.circle(75, y + 3, 9, fill=1, stroke=0)
    c.setFillColor(TEAL_DARK)
    c.setFont("CN-Bold", 8)
    c.drawCentredString(75, y, str(idx))
    c.setFillColor(white)
    c.setFont("CN", 10.5)
    c.drawString(94, y - 1, step)
c.setFillColor(GOLD_LIGHT)
c.setFont("CN", 8.5)
c.drawString(48, 60, "适用版本 0.1.0-beta.3 · Windows 10/11 x64 · macOS 12+")
c.showPage()

# 2 quick start
page_base(c, 2, "QUICK START", "5 分钟完成第一次录制")
quick = [
    ("打开设置", "选 16:9 / 9:16 等画幅，确认虚线选区。"),
    ("选择保存位置", "指定文件夹最清楚；重启后需要重新选择。"),
    ("测试设备", "麦克风看到电平；摄像头拖到发布安全区。"),
    ("放好提词器", "靠近镜头，调速度、字号和透明度。"),
    ("开始试录", "录 10～20 秒，画一笔并观察输出预览。"),
    ("结束并回看", "等待封装完成；MP4 优先，必要时回退 WebM。"),
]
for i, (t, b) in enumerate(quick):
    col, row = i % 2, i // 2
    card(c, 38 + col * 260, 550 - row * 135, 242, 110, t, b, i + 1)
c.setFillColor(GOLD_LIGHT)
c.roundRect(38, 123, W - 76, 76, 10, fill=1, stroke=0)
c.setFillColor(TEAL_DARK)
c.setFont("CN-Bold", 11)
c.drawString(54, 174, "最重要的判断标准")
paragraph(c, "不要只看白板中央：自动运镜、摄像头位置、背景风格和最终裁切，应以右侧“输出预览 / 大图预览”为准。", 54, 151, W - 108, 9.5, 15, TEAL_DARK)
footer(c)
c.showPage()

# 3 install
page_base(c, 3, "INSTALL", "安装与首次打开")
card(c, 38, 470, 250, 225, "Windows 10/11", "1. 运行 beta.3 Windows x64 安装器。\n2. SmartScreen 可能提示未知发布者。\n3. 只从原始渠道获取并核对 SHA-256。\n4. 缺少 WebView2 时会下载微软运行环境。", 1)
card(c, 307, 470, 250, 225, "macOS 12+", "1. 打开 DMG，拖入“应用程序”。\n2. 被拦截时到“隐私与安全性”选择仍要打开。\n3. 首次设备弹窗选择允许。\n4. 修改权限后 Command + Q 完全退出再开。", 2)
c.setFillColor(HexColor("#FBE7E3"))
c.roundRect(38, 285, W - 76, 135, 12, fill=1, stroke=0)
c.setFillColor(RED)
c.setFont("CN-Bold", 12)
c.drawString(55, 390, "当前仍是小范围 beta 包")
paragraph(c, "Windows 尚未使用 Authenticode 商业签名；macOS 为 ad-hoc 签名、未进行 Apple 公证。SHA-256 可以校验文件是否一致，但不能替代发布者签名。面向普通用户大规模公开分发前，必须完成正式代码签名与公证。", 55, 365, W - 110, 9.5, 15, RED)
pill(c, "不需要账号", 54, 220, TEAL_LIGHT, TEAL_DARK, 105)
pill(c, "不需要 API Key", 170, 220, TEAL_LIGHT, TEAL_DARK, 125)
pill(c, "内容保存在本机", 306, 220, TEAL_LIGHT, TEAL_DARK, 135)
footer(c, "安装提示来自操作系统安全机制，不等于软件联网或索取账号")
c.showPage()

# 4 overview
page_base(c, 4, "WORKSPACE", "界面总览：哪些会进入成片？")
screenshot(c, "01-overview.png", 38, 355, 519, 325, [(1, .49, .05), (2, .90, .05), (3, .02, .50), (4, .89, .82)])
for i, (t, b) in enumerate([
    ("顶部工具", "白板绘图；导入文档后切换讲解工具。"),
    ("录制控制", "设置、提词器、开始/暂停/结束。"),
    ("讲解内容", "导入与翻页，可随时隐藏。"),
    ("输出预览", "最终裁切、运镜、摄像头和背景以此为准。"),
]):
    card(c, 38 + (i % 2) * 260, 235 - (i // 2) * 92, 242, 76, t, b, i + 1)
footer(c, "控制面板、提词器、侧栏、状态标签和虚线选区不会进入视频")
c.showPage()

# 5 settings
page_base(c, 5, "RECORDING", "画幅、选区、风格与画质")
screenshot(c, "02-recording-settings.png", 38, 385, 519, 295, [(1, .88, .23), (2, .88, .48), (3, .88, .63), (4, .88, .85)])
items = [
    "画幅：16:9、4:3、3:4、9:16、1:1 或自定义。",
    "选区：打开虚线框，编辑并预留字幕、头像和平台按钮边距。",
    "风格：只改变最终输出背景，不破坏原文档。",
    "画质：720p 更稳；1080p 更清晰但负载明显增加。",
]
bullets(c, items, 44, 337, W - 88, 9.5, 15, 9)
c.setFillColor(GOLD_LIGHT)
c.roundRect(38, 112, W - 76, 62, 10, fill=1, stroke=0)
paragraph(c, "短视频常用 9:16；横版课程常用 16:9。选好画幅后再移动摄像头，避免发布时被平台 UI 遮挡。", 54, 150, W - 108, 9.2, 15, TEAL_DARK)
footer(c)
c.showPage()

# 6 devices
page_base(c, 6, "CAMERA & AUDIO", "摄像头和麦克风")
card(c, 38, 455, 250, 235, "麦克风", "1. 打开“录制麦克风”。\n2. 不确定时选“系统默认”。\n3. 点击“测试麦克风 6 秒”。\n4. 有电平变化再录制。\n5. 无声音先查系统权限与设备占用。", 1)
card(c, 307, 455, 250, 235, "摄像头", "1. 打开画中画并选择设备。\n2. 设置形状、大小与镜像。\n3. 直接拖动监看画面到安全位置。\n4. 开录后位置自动锁定。\n5. 结束/离开窗口后默认关闭设备。", 2)
c.setFillColor(TEAL_LIGHT)
c.roundRect(38, 245, W - 76, 155, 12, fill=1, stroke=0)
c.setFillColor(TEAL_DARK)
c.setFont("CN-Bold", 12)
c.drawString(54, 370, "macOS 权限排查")
bullets(c, ["系统设置 → 隐私与安全性 → 摄像头 / 麦克风。", "开启 Jianzhou Canvas Recorder Beta。", "Command + Q 完全退出，再重新打开。", "关闭 FaceTime、Zoom、会议网页、OBS 等占用软件。"], 52, 342, W - 104, 9.2, 14, 5, TEAL_DARK)
c.setFillColor(GOLD_LIGHT)
c.roundRect(38, 135, W - 76, 70, 10, fill=1, stroke=0)
paragraph(c, "摄像头可自由拖动，但请在开始录制前定好位置。建议离四边保留 6%～10% 安全距离。", 54, 176, W - 108, 9.5, 15, TEAL_DARK)
footer(c)
c.showPage()

# 7 teleprompter
page_base(c, 7, "TELEPROMPTER", "提词器：靠近镜头，不进成片")
screenshot(c, "03-teleprompter.png", 38, 365, 519, 315, [(1, .14, .12), (2, .13, .17), (3, .24, .17), (4, .06, .31)])
tips = [
    ("自由移动", "拖动标题栏到镜头附近，减少眼神偏移。"),
    ("速度与字号", "慢速也会平滑滚动；先回到开头再播放。"),
    ("精简阅读", "切成可移动的双行透明字幕条。"),
    ("透明度", "窗口背景可到 0，文字也可独立调整。"),
]
for i, (t, b) in enumerate(tips):
    card(c, 38 + (i % 2) * 260, 240 - (i // 2) * 92, 242, 76, t, b, i + 1)
footer(c, "精简模式快捷键：Alt + 空格 播放 / 暂停")
c.showPage()

# 8 whiteboard autozoom
page_base(c, 8, "AUTO CAMERA", "白板、激光笔与自动运镜")
flow = [
    ("选择工具", "白板用自由书写；文档用激光笔、画笔或荧光笔。"),
    ("连续划线", "按住鼠标/笔完成动作，轨迹会进入实时合成。"),
    ("镜头跟随", "开启“划线时自动放大”，输出平滑聚焦动作区域。"),
    ("回到全景", "松开后镜头自然恢复；强度过猛时改为标准/轻柔。"),
]
for i, (t, b) in enumerate(flow):
    card(c, 60, 620 - i * 125, W - 120, 95, t, b, i + 1)
    if i < 3:
        c.setStrokeColor(GOLD)
        c.setLineWidth(2)
        c.line(W / 2, 610 - i * 125, W / 2, 592 - i * 125)
c.setFillColor(GOLD_LIGHT)
c.roundRect(38, 115, W - 76, 68, 10, fill=1, stroke=0)
paragraph(c, "判断运镜是否生效，请观察输出预览，而不是只看原白板。激光笔适合临时指示；画笔/荧光笔适合保留批注。", 54, 157, W - 108, 9.4, 15, TEAL_DARK)
footer(c)
c.showPage()

# 9 content
page_base(c, 9, "CONTENT", "导入讲解内容")
screenshot(c, "04-content-import.png", 38, 420, 519, 260, [(1, .07, .21), (2, .07, .27), (3, .07, .50)])
formats = [
    ("PDF", "视觉最稳定；80 MB / 200 页以内。"),
    ("图片", "PNG/JPEG/WebP/GIF/BMP/AVIF；24 MB、24MP。"),
    ("Markdown", "横竖版、连续文档/幻灯片、三种主题。"),
    ("静态 HTML", "保留离线 CSS/SVG；禁用脚本和外部资源。"),
    ("PPT/PPTX", "先用 PowerPoint/Keynote/WPS 导出 PDF。"),
]
for i, (t, b) in enumerate(formats):
    x = 38 + (i % 2) * 260
    y = 320 - (i // 2) * 82
    card(c, x, y, 242, 67, t, b, None)
footer(c, "左侧侧栏可隐藏；翻页、批注和讲解工具都可直接录制")
c.showPage()

# 10 pdf/html
page_base(c, 10, "PRESENTATION", "PDF 与静态 HTML 怎么用")
screenshot(c, "05-pdf-presentation.png", 38, 395, 519, 285, [(1, .08, .22), (2, .50, .03), (3, .93, .05)])
bullets(c, [
    "PDF：左侧选页；顶部激光笔用于临时指示，画笔/荧光笔保留批注。",
    "长 HTML：自动拆成多页；静态 CSS/SVG 会保留，JavaScript 与动态交互不会运行。",
    "HTML 黑屏/缺样式：通常依赖在线字体、远程图片、脚本或框架运行时。请改为完全离线静态 HTML，或导出 PDF。",
    "页面被遮挡：隐藏左侧内容栏；顶部讲解工具选择后可收起/完整显示。",
], 44, 350, W - 88, 9.4, 15, 9)
footer(c)
c.showPage()

# 11 save
page_base(c, 11, "SAVE & REVIEW", "录制、保存、回看")
steps = [
    ("选择位置", "推荐指定文件夹；重启后需重新选择授权。"),
    ("开始录制", "倒计时结束后讲解；可暂停/继续。"),
    ("结束封装", "点击结束后等待保存完成，不要立刻强退。"),
    ("回看文件", "优先 MP4；不支持时自动回退 WebM。"),
    ("处理恢复副本", "文件夹写入成功后自动清理临时副本；中断分片可手动导出或删除。"),
]
for i, (t, b) in enumerate(steps):
    card(c, 50, 625 - i * 105, W - 100, 78, t, b, i + 1)
c.setFillColor(TEAL_LIGHT)
c.roundRect(38, 105, W - 76, 74, 10, fill=1, stroke=0)
paragraph(c, "WebM 播放优先尝试 VLC；剪辑兼容性以 MP4 最佳。找不到文件时，先检查当次指定文件夹，再检查系统下载目录。", 54, 149, W - 108, 9.4, 15, TEAL_DARK)
footer(c)
c.showPage()

# 12 privacy
page_base(c, 12, "PRIVACY", "你的内容和 API 会不会泄露？")
privacy = [
    ("无账号 / 无 API", "不需要手机号、邮箱、登录、API Key 或云服务配置。"),
    ("无自动上传", "没有遥测、广告或录制上传接口；运行时只处理本机内容。"),
    ("权限按需", "摄像头和麦克风只在主动开启或测试时访问。"),
    ("诊断已脱敏", "移除文件/文件夹、本机路径、会话标识、设备指纹、链接、邮箱与凭据样式。"),
    ("可随时清除", "设置页提供“清除本机诊断记录”。"),
    ("分享前复核", "不要分享开发目录、原始测试材料、恢复分片或带课程隐私的截图。"),
]
for i, (t, b) in enumerate(privacy):
    col, row = i % 2, i // 2
    card(c, 38 + col * 260, 555 - row * 135, 242, 110, t, b, i + 1)
c.setFillColor(GOLD_LIGHT)
c.roundRect(38, 110, W - 76, 72, 10, fill=1, stroke=0)
paragraph(c, "导出诊断虽然已自动脱敏，发送给他人前仍建议自己打开快速检查。发布包隐私门禁会阻止原始测试 JSON、截图和本机绝对路径进入分享目录。", 54, 153, W - 108, 9.2, 15, TEAL_DARK)
footer(c)
c.showPage()

# 13 troubleshooting
page_base(c, 13, "TROUBLESHOOTING", "常见问题快速处理")
qa = [
    ("摄像头 / 麦克风打不开", "查系统权限 → 关闭会议/录屏软件 → 系统默认设备 → 完全退出重开。"),
    ("闪黑、卡住或崩溃", "先无麦克风/摄像头录 10 秒；改 720p；逐项开启设备。"),
    ("提词器太快或不动", "回到开头，调低速度；文本需长于窗口；Alt+空格暂停/播放。"),
    ("自动运镜没反应", "确认开关开启，连续划线，并观察输出预览。"),
    ("HTML 黑屏或只有字", "移除动态脚本/远程资源，改离线静态 HTML，或导出 PDF。"),
    ("WebM 不好编辑", "VLC 播放；用剪映/FFmpeg 转 H.264 MP4。"),
]
for i, (t, b) in enumerate(qa):
    col, row = i % 2, i // 2
    card(c, 38 + col * 260, 555 - row * 137, 242, 112, t, b, None, GOLD if i >= 4 else TEAL)
c.setFillColor(HexColor("#FBE7E3"))
c.roundRect(38, 102, W - 76, 74, 10, fill=1, stroke=0)
paragraph(c, "仍然无法解决时：导出“脱敏诊断日志”，记录操作系统、应用版本、复现步骤和问题截图。发送前先自行打开日志检查。", 54, 146, W - 108, 9.4, 15, RED)
footer(c)
c.showPage()

# 14 checklist
page_base(c, 14, "CHECKLIST", "分享前最后检查")
checks = [
    "画幅与平台一致：横版 16:9，竖版 9:16。",
    "虚线录制区域没有裁掉标题、页码或人物。",
    "麦克风测试有电平；摄像头位于发布安全区。",
    "提词器靠近镜头，速度、字号和透明度舒适。",
    "激光笔/画笔能在输出预览中出现，自动运镜自然。",
    "保存目录已选，并完成 10～20 秒试录回看。",
    "分享包同时包含使用手册、隐私说明和 SHA-256。",
    "beta 仅小范围可控分发；公开发布前完成商业签名与 Apple 公证。",
]
y = 660
for i, item in enumerate(checks, 1):
    c.setFillColor(PAPER)
    c.setStrokeColor(LINE)
    c.roundRect(48, y - 31, W - 96, 48, 8, fill=1, stroke=1)
    c.setStrokeColor(TEAL)
    c.setLineWidth(1.4)
    c.rect(65, y - 14, 14, 14, fill=0, stroke=1)
    paragraph(c, item, 92, y - 9, W - 160, 9.4, 14, INK)
    y -= 62
c.setFillColor(TEAL_DARK)
c.roundRect(48, 93, W - 96, 66, 12, fill=1, stroke=0)
c.setFillColor(white)
c.setFont("CN-Bold", 12)
c.drawCentredString(W / 2, 129, "先试录，再正式录；先回看，再分享")
c.setFont("CN", 8.5)
c.drawCentredString(W / 2, 108, "本地、轻量、清楚，才是这款工具最舒服的使用方式")
footer(c, "版本 0.1.0-beta.3")
c.showPage()

c.save()
print(OUT)
