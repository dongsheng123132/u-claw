# 第三方资源说明

本项目自有源码采用 MIT 许可证，见 LICENSE。第三方 Agent、工具和组件独立保留上游许可证；本发行版不包含本地模型或推理引擎。

| 资源 | 本轮版本与来源 | 许可证 |
| --- | --- | --- |
| PicoClaw core + launcher | [固定 v0.3.1 源码，发行补丁 u-pico.1](https://github.com/sipeed/picoclaw/releases/tag/v0.3.1) | MIT，全文见 licenses/PicoClaw-MIT.txt |
| WinDirStat 可选便携工具 | [官方 2.9.0 便携包](https://github.com/windirstat/windirstat/releases/tag/release/v2.9.0) | GPL-2.0；工具目录保留 LICENSE.md，工具包附对应源码 |
| PeaZip 可选便携工具 | [官方 11.3.0 WIN64 Portable](https://github.com/peazip/PeaZip/releases/tag/11.3.0) | LGPL-3.0；依赖另按 res/share/copying/third-parties 保留各自声明，工具包附 PeaZip 主项目源码 |
| Notepad++ | [官方 8.9.8.1 x64 Portable](https://github.com/notepad-plus-plus/notepad-plus-plus/releases/tag/v8.9.8.1) | GPL-3.0，保留官方 license.txt，附对应主项目源码 |
| SumatraPDF | [官方 3.6.1 Portable](https://www.sumatrapdfreader.org/download-free-pdf-viewer) | GPL-3.0 及组件声明，保留 COPYING / COPYING.BSD / AUTHORS，附对应项目源码 |
| Explorer++ | [官方 1.4.0 x64](https://github.com/derceg/explorerplusplus/releases/tag/version-1.4.0) | GPL-3.0，保留 License.txt，附对应项目源码 |
| Everything | [官方 1.4.1.1032 x64 ZIP](https://www.voidtools.com/downloads/) | MIT 风格许可及 PCRE 声明，完整保留官网 License.txt |

PicoClaw 按固定 v0.3.1 源码构建，发行补丁禁用自更新入口，修正 Windows launcher 对已附着 Gateway 的进程存活判断，并在重启前发现已有核心，避免快速操作时重复启动。源代码压缩包与最终三平台 core/launcher 哈希记录在 `catalog/picoclaw.json`，补丁与构建方法为 `scripts/build-picoclaw-pinned.py`。

`package-portable.py` 包含六款常用便携工具，以及 `catalog/emergency-tools.json` 固定的 CrystalDiskInfo 9.9.3、PhotoRec/TestDisk 7.2。CrystalDiskInfo 保留 MIT 通知；PhotoRec/TestDisk 保留 GPL 与依赖声明。来源记录、对应源码和依赖材料来自已准备的资源包，分别置于 `app/tool-sources/`、`app/extras/sources/` 与 `app/extras/licenses/`；未修改第三方维护工具二进制。

随附 3DP Net 21.01 历史网卡资源的来源、限制、静态检查与许可证来源说明保存在 `drivers/windows-x64/3dp-net-21.01/`。它不等于全硬件驱动支持；无需或不适用时不运行。此发行版不含 Ventoy/WinPE/SystemRescue 启动层。

Go 包依赖中的 gorilla/websocket v1.5.3 与 yaml.v3 v3.0.1 随源码保留各自许可证。旧模型许可证文件仅为历史保留，不代表发行包包含这些模型。

`catalog/tool-library.json` 仅为选装目录；尚未适配或未获再分发许可的项目不打入 ZIP。特别是 [Microsoft Sysinternals](https://learn.microsoft.com/en-us/sysinternals/license-faq) 明确不提供第三方再分发许可，Autoruns、Process Explorer、Process Monitor、RAMMap、TCPView 只提供官方下载入口。

KeePass 等尚未适配的工具仍仅提供官方入口；是否内置以固定清单和真实校验结果为准。
