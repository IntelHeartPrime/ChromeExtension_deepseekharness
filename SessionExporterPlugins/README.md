# Session Exporter 一键直达

点击金色的文档导出图标，切回已有的 Session Exporter 页面；尚未打开时，直接打开 `http://127.0.0.1:8765/`。无需弹出菜单。

## 安装

1. 在 Chrome 打开 `chrome://extensions`，启用右上角的 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择本目录 `SessionExporterPlugins`（包含 `manifest.json`）。
3. 在工具栏的扩展程序菜单中，固定 **Session Exporter 一键直达**。

## 行为

- 手动打开或点击插件打开的 Session Exporter 页面，都会自动归入黄色 **Session Exporter** 分组，横向和垂直标签栏均可显示。
- 按地址来源精确识别 `http://127.0.0.1:8765`，包括其子路径。DeepSeek Harness 的 `3080` 端口和其他本机服务不会被归入此分组。
- 点击图标时优先切回当前窗口最近访问的 Session Exporter 标签；当前窗口没有时，切换到其他普通窗口的已有标签。已有分组会自动展开，避免重复打开。
- 标签导航离开该服务时，会自动移出插件管理的分组；移动标签、重启 Chrome 后也会重新同步标记。
- 固定的标签保持固定，可通过图标切回；无痕窗口不参与自动分组。
- 使用前请启动本机 Session Exporter 服务。插件仅负责跳转和标签管理，不会启动服务。

## 图标与开发

图标使用金色渐变背景、深色文档和右上方导出箭头，与 DSH 的图标独立。Chrome 原生分组颜色使用最接近金色的 `yellow`。扩展包含 16、32、48、128 像素 PNG 及可编辑 SVG 源文件。

在 macOS 上修改 SVG 后，可在本目录运行：

```sh
swift -module-cache-path /tmp/session-exporter-swift-cache scripts/generate-icons.swift
```

运行行为测试（Node.js，无需安装依赖）：

```sh
node --test tests/background.test.cjs
```

扩展仅请求 `tabGroups`、`storage` 和本机 `127.0.0.1` 的访问权限。Chrome 的主机权限匹配不支持按端口缩小范围，因此在代码中按 `8765` 端口精确筛选。会话存储只记录插件分组与标签 ID。
