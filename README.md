# 本机服务 Chrome 一键直达插件

两个独立的 Chrome Manifest V3 扩展，为本机服务提供工具栏一键跳转和标签分组标记。

| 插件目录 | 服务地址 | 标签分组 | 图标 |
| --- | --- | --- | --- |
| [DeepSeekHarnessPlugins](DeepSeekHarnessPlugins/) | `http://127.0.0.1:3080/` | 紫色 DSH | DSH 图标 |
| [SessionExporterPlugins](SessionExporterPlugins/) | `http://127.0.0.1:8765/` | 黄色 Session Exporter | 金色文档导出图标 |

点击对应图标时，优先切回当前窗口的已有标签，再查找其他普通窗口；没有打开时才新建标签。手动打开服务页面也会自动分组，两个服务按端口分别识别。

## 安装

1. 下载并解压本仓库，或使用 Git 克隆到本机。
2. 打开 `chrome://extensions`，开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择需要的插件子目录（包含 `manifest.json`），不要选择仓库根目录。
4. 如需两个插件，分别加载两个子目录，并在工具栏扩展程序菜单中固定它们。

使用前请启动对应本机服务。详细说明见各插件目录的 README。

原先位于仓库根目录的 DSH 扩展已移至 `DeepSeekHarnessPlugins/`。此前从根目录加载的用户，请在 Chrome 中重新加载该子目录。

## Session Exporter 图标

![Session Exporter 金色图标](SessionExporterPlugins/icons/session-exporter-128.png)

提供 16、32、48、128 像素 PNG、SVG 源文件，以及 macOS 图标生成脚本。

## 验证

无需安装依赖，使用 Node.js 运行：

```sh
node --test SessionExporterPlugins/tests/background.test.cjs
```
