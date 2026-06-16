# Chrome Recorder Plus

**Google Chrome 录制器（Recorder）的增强升级版。** 在官方 Recorder 基础上，增加了坐标采集、OCR 提示、导航追踪等大量实用功能，生成的 JSON 可直接用于自动化执行工具（如 `universal_runner`）。

## ✨ 主要特性

| 特性 | 说明 |
|------|------|
| 🎯 **坐标直接采集** | `mousedown` 时同步采集 `clientX/Y`、`pageX/Y`，无需后置合并 |
| 🧠 **OCR 提示字段** | 自动从 `text/` 选择器中提取文本，生成 `ocr_hint` |
| 🧭 **导航自动追踪** | 自动捕获 `click` 后的页面跳转，追加到 `assertedEvents` |
| 📐 **视口自动记录** | 开始录制时自动记录 `setViewport` 步骤 |
| 🔍 **多维度选择器** | 同时生成 ARIA、CSS、XPath、Pierce、text 5 种选择器 |
| 📊 **实时预览面板** | 弹出面板实时显示录制事件数和步骤预览 |
| 📤 **一键导出 JSON** | 导出格式与 Puppeteer/Playwright 录制器兼容 |

## 🛠️ 安装方法

1. 打开 Chrome，进入 `chrome://extensions`
2. 开启 **"开发者模式"**（右上角）
3. 点击 **"加载已解压的扩展程序"**
4. 选择 `recorderplus` 文件夹
5. 点击扩展栏图标即可使用

## 📂 文件结构

```
recorderplus/
├── manifest.json        # 扩展配置
├── background.js        # Service Worker：状态管理、事件录制、JSON 组装
├── content_script.js    # 注入脚本：事件捕获、选择器生成、坐标采集
├── panel.html           # 弹出面板 UI
└── panel.js             # 面板交互逻辑
```

## 📖 使用方法

1. 点击扩展图标打开录制面板
2. 点击 **「开始录制」**，在目标网页上进行操作
3. 操作完成后点击 **「停止」**
4. 点击 **「导出 JSON」** 保存录制结果
5. 将导出的 JSON 用于自动化执行工具

---

*Made with ❤️ by daoyaun*
