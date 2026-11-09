# cctether

**开工前先读 `docs/SPEC.md` 和 `docs/HANDOFF.md`。**
- SPEC 是需求原文加方案，是唯一的施工图。
- HANDOFF 是交接，写着现在做到哪、下一步做什么。
- 主人自己的环境和部署细节在 `CLAUDE.local.md`。这个文件不进仓库，会自动加载。

这里只写概况和规矩。和 SPEC 不一致时以 SPEC 为准，并把这里改对。

## 项目概况

- cctether = 浏览器插件 + 跑在 Claude Code 那台机器上的常驻服务（MCP）。
  - 插件主动连到服务。服务把读页面、截图、点击、输入、看控制台和网络请求这些能力，交给 Claude Code 用。
  - 全程走用户自己的连接，不经过 Anthropic 的中转服务器。
- 起因：官方 Claude in Chrome 插件要经过 Anthropic 中转。主人的 Mac 有时连不上 Claude，这条链就断了。
- 要开源（MIT），给有同样需求的人用。所以不能写死主人的环境，界面和 README 都要中英双语。
- **当前：第二阶段全部做完，已公开发布（npm、GitHub、Chrome 应用商店），版本 0.3.2（SPEC §13 v0.10）。新对话从 `docs/HANDOFF.md` 第零节开始。**

## 仓库结构

```
extension/          浏览器插件：MV3，零依赖，不打包，用户能直接「加载已解压的扩展程序」
  background/       service worker：main.js → app.js（总调度）、connection.js + crypto.js（连接和加密）、
                    tabs.js（标签组范围）、debugger.js（调试器）、page-scripts.js、tools/（20 个工具）、badge.js（图标）
  popup/ options/   弹窗、设置页；文字全在 shared/strings.js（中英）
  shared/           contract.js（后台和界面之间的约定）、pairing.js（连接码）、i18n、ui.css
  icons/            图标；源文件和生成脚本是 scripts/icons.mjs
server/             npm 包 cctether：bin/cctether.js 命令行；src/ 里 gateway（插件入口）、control（控制入口）、
                    mcp、shim（cctether mcp）、daemon、protocol、config、tools（工具定义，唯一来源）、
                    setup（安装向导）、check（自检）、system（探测 npm/systemd/claude）、text（setup 和 check 的中英文案）
test/e2e/           端到端测试：无界面 Chrome for Testing + 插件 + 服务；lib/ 是自写的 CDP 客户端和 Chrome 启动器
docs/               SPEC（施工图）、HANDOFF（交接）、install-mac.zh-CN.md（Mac 安装步骤）、
                    connect.md / connect.zh-CN.md（各种连法）、PROTOCOL.md（协议说明，英文）
deploy/             通用部署示例（Caddy、systemd），不放主人的真实配置
scripts/            icons.mjs（生成图标）、screenshots.mjs（界面批量截图，输出到 screenshots/，不进仓库）、
                    pack-extension.mjs（打插件 zip 到 dist/，可复现；--flat 打商店用的）、store-images.mjs（商店宣传图）
store/              Chrome 应用商店要填的内容（listing.md 中英）和宣传图（images/）
.github/workflows/  ci.yml（每次 push 跑测试和打包）、release.yml（推 v* 标签建 Release 草稿）
README.md / README.zh-CN.md / SECURITY.md / PRIVACY.md   给用户看的说明（README 中英文，其余英文）
```

## 命令

- 服务端单元测试：`cd server && npm test`（约 15 秒）
- 端到端测试：`node --test test/e2e/*.test.mjs`（约 40 秒，用 `~/.cache/ms-playwright` 里的 Chrome for Testing，或设 `CHROME_PATH`）
  - 有界面跑（多测 1 项弹框）：先 `Xvfb :97 -screen 0 1280x900x24 -nolisten tcp &`，再 `CCTETHER_HEADED=1 DISPLAY=:97 node --test test/e2e/tools.test.mjs`
- 界面截图：`node scripts/screenshots.mjs [过滤词]`（全量约 2.5 分钟），看 `screenshots/sheet-*.png`
- 重新生成图标：`node scripts/icons.mjs`
- 打插件 zip：`node scripts/pack-extension.mjs`（`--check` 只核对两边版本号一致）
- 本机试 setup：一定要带临时配置目录和别的端口，并加 `--no-service`，不然会碰到主人在用的服务：
  `CCTETHER_HOME=/tmp/xxx node server/bin/cctether.js setup --yes --mode ssh --port <空闲端口> --no-service --no-mcp`
  试完停掉：`CCTETHER_HOME=/tmp/xxx node server/bin/cctether.js stop`
- 本机试命令行：`node server/bin/cctether.js help`；临时配置目录用 `CCTETHER_HOME=/tmp/xxx`

## 规矩

- **第零标准是好看**（见全局 CLAUDE.md）。
  - 插件的弹窗和设置页，中文/英文 × 浅色/深色四种组合都要截图自己看。
  - 未配对、连接中、已连接、已暂停、出错这几种状态也都要看。
  - 挑完毛病、改到满意，再给主人看。
- **语言**：
  - 给主人看的文档用简体中文大白话，包括本文件和 docs/ 下的 SPEC、HANDOFF。
  - 代码、注释、提交信息、日志用英文，因为是开源项目。
  - 界面文字一律走语言包，代码里不写死。
  - README 以英文为主，另附 README.zh-CN.md。
- **仓库里不放主人的私人信息**：服务器 IP、域名、主机名、个人路径、密钥，一律写进 `CLAUDE.local.md`。仓库已经公开，push 上去别人马上能看到，git 历史里也不能有这些。每次提交前看一眼 diff。
- **连接码和密钥不进对话**：要配对时，让主人自己在终端里跑命令、复制结果。Claude 不把它们打印出来，也不贴进对话。
- **安全是这个项目的命根子**（SPEC §6）。
  - 改认证、连接、权限、标签页范围相关的代码，必须配测试。
  - 拿不准就停下来问。
- **改需求、架构、协议或阶段范围**：先改 docs/SPEC.md，在 §13 记一笔，再改代码。
- **版本号**：`server/package.json` 和 `extension/manifest.json` 永远一致（SPEC §8.3）。改了哪一边，两边一起加。发新版本的步骤在 HANDOFF 第零节。
- **依赖越少越好**。
  - 插件零依赖、不打包，用户能直接审读源码。
  - 服务端只用必要的包，并锁精确版本。
  - 新增依赖先在 SPEC 里写明理由。
- **git**：
  - 提交后直接 push 到 guchaorui/cctether（2026-11-08 起公开）。
  - 改回私有、删仓库、改已经 push 的历史、发布新版本（npm、Release、商店），都要先问主人。
  - **推 `v*` 标签就等于发布到 npm**，没有第二道确认（SPEC §8.3），推之前一定先问主人。
- **派 subagent** 按全局 CLAUDE.md：写关键逻辑和做审查用 Opus，文档和清单明确的小改用 Sonnet，机械杂活用 Haiku。
- **主人的 Mac 不一定连得上 claude.ai**。要主人定的事都写在对话里，Artifact 链接只能当补充。
- **每个阶段收尾**：测试全过 → 审查 → 修 → 提交并 push → 更新 HANDOFF → 停下来等主人试用确认。
