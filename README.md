<div align="center">

# OpenContext Desktop

**把 [OpenContext](https://github.com/melandlabs/opencontext) 运行时装进桌面应用：装好就能用，写一句、搜一句，全部留在自己电脑上。**

[简体中文](#功能) · [English](#english)

</div>

---

## 功能

- **零门槛上手**：首次启动只有一个「一键安装并开始使用」按钮，检查详情和安装日志默认折叠；装完直接进入首页，只有「记一条 / 搜一下 / 最近记住的」三块，端口、PID、后端这些都收在「技术详情」和「高级功能」里。
- **搜索开箱可用**：默认使用内置关键词搜索（离线、零配置，中文按二元切分打分），不需要先配嵌入模型；在设置里改成「智能搜索」后会优先走语义检索，失败时自动退回关键词搜索。
- **首次启动环境检测**：检查系统与架构、数据目录可写性、Node.js（≥ 18）、npm、npm 源可达性、运行时是否已安装、端口占用，逐项给出 通过 / 警告 / 失败。
- **自动安装**：缺 Node.js 就从 nodejs.org 下载对应平台的 LTS 运行时（校验 SHA256）解压到应用数据目录；随后用它把 `@melandlabs/opencontext` + `@melandlabs/ai-rag` 安装到数据目录，再真正启动一次服务做健康检查。整个过程不动系统环境。
- **下次直接启动**：安装状态写入 `config.json`，之后每次打开应用直接拉起本地 HTTP 服务（默认 `127.0.0.1:7421`，端口被占用自动顺延），窗口进入内嵌控制台。
- **高级功能仍在**：折叠区里保留服务状态与进程信息、原始接口调试（`POST /v1/raw-messages`、`POST /v1/search`、按 `messageId` 查询）、实时日志，以及可内嵌本地服务地址或任意自建前端地址的「内嵌页面」。
- **版本更新**：基于 `electron-updater` + GitHub Releases，支持自动检查、后台下载、一键「重启并安装」。
- **数据落在本地**：SQLite 数据库、日志、运行时包全部位于系统的应用数据目录，卸载即清理。

## 下载

前往 [Releases](https://github.com/gatesenman/opencontext-desktop/releases) 下载：

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | `OpenContext Desktop-<version>-win-x64.exe`（NSIS 安装器） |
| Linux x64 | `OpenContext Desktop-<version>-linux-x86_64.AppImage` / `.deb` |
| macOS | `OpenContext Desktop-<version>-mac-<arch>.dmg` |

首次启动点「一键安装并开始使用」即可，全程无需手动装 Node.js。

## 目录布局（运行时产生）

| 路径 | 内容 |
| --- | --- |
| `<userData>/config.json` | 安装状态与设置 |
| `<userData>/node-runtime/` | 自动下载的 Node.js（系统已有可用 Node 时不会下载） |
| `<userData>/server/` | `@melandlabs/opencontext` 及其依赖 |
| `<userData>/data/memory.db` | SQLite 记忆库（`MEMORY_STORE_DB_PATH`） |
| `<userData>/logs/` | 桌面端与服务进程日志 |

`<userData>` 在 Windows 为 `%APPDATA%\opencontext-desktop`，macOS 为 `~/Library/Application Support/opencontext-desktop`，Linux 为 `~/.config/opencontext-desktop`。

## 设置项

| 设置 | 说明 |
| --- | --- |
| 你的名字（userId） | 记忆归属，默认 `me` |
| 搜索方式 | 关键词搜索（默认，离线）/ 智能搜索（首次下载约 90MB 本地模型）/ 云端模型 |
| 监听地址 / 端口 | 传给 `opencontext http --host/--port`；端口被占用时自动顺延 |
| 嵌入模型来源 | `none` / `local`（首次检索会下载约 90MB 模型） / `openrouter` |
| 记忆 / 洞察 / 知识库后端 | `sqlite-vec`、`chroma`、`none` |
| npm 源、Node.js 下载源 | 国内网络可换成镜像源 |
| 运行时版本标签 | `latest` 或指定版本，用于重新安装运行时 |
| 内嵌页面地址 | 留空则内嵌本地服务地址 |

## 从源码运行

```bash
git clone https://github.com/gatesenman/opencontext-desktop.git
cd opencontext-desktop
npm install
npm start           # 开发模式运行（开发模式不检查更新）
npm run dist:linux  # 或 dist:win / dist:mac 本地打包
```

## 发布新版本

1. 修改 `package.json` 的 `version`。
2. 打标签推送：`git tag v1.0.1 && git push origin v1.0.1`。
3. `.github/workflows/release.yml` 会在三端构建并发布到 GitHub Releases，已安装的客户端随后即可检测到更新。

---

## English

A desktop shell around the [OpenContext](https://github.com/melandlabs/opencontext) agentic context runtime.

- **First run** detects the environment (OS/arch, writable data dir, Node.js ≥ 18, npm, registry reachability, runtime packages, free port), then installs everything automatically: a checksum-verified Node.js LTS runtime when the host has none, followed by `@melandlabs/opencontext` and `@melandlabs/ai-rag` into the app data directory, finishing with a real `GET /health` boot check. Nothing is installed system-wide.
- **Every later launch** boots the local HTTP daemon and opens a beginner-friendly home view (write a note / search / recent notes) with plain-language status; the developer surface — service status, raw API console, embedded page, live logs — lives behind the collapsed "advanced" section.
- **Search works out of the box** through a built-in offline keyword index (CJK bigram scoring) so no embedding model has to be configured; switching to the local embedding model upgrades searches to semantic, with automatic fallback to keywords.
- **Updates** ship through GitHub Releases via `electron-updater` (auto check, background download, restart-and-install).

Licensed under Apache-2.0, same as the upstream project.
