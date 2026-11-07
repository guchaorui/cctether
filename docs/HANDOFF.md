# 交接

> 2026-11-08 更新。新对话读 `CLAUDE.md`、`CLAUDE.local.md`、`docs/SPEC.md` 和本文第零节，就能接上。

## 零、现在到哪了（先看这里）

- **第二阶段（SPEC §10.2，给别人用）做完了，版本 0.2.0，等主人看过再往下走。** 主人 2026-11-08 说「开工，可以开始第二阶段了」。
- 第一阶段主人 2026-11-08 已试用确认。那次试用提的问题（断网检测、设置页图标对齐）都改好了。
- 主人的 Mac 上的插件还是 **0.1.1**（2026-11-08 用 `cctether check` 看到的），所以 0.1.2 的图标对齐主人还没看到。0.2.0 包含它，照 `docs/install-mac.zh-CN.md` 第七节更新插件就能看到。
- 服务器上的 cctether 服务已经升级到 0.2.0（见下面「部署」）。插件 0.1.1 和服务端 0.2.0 的协议一样，能正常连。
- **新窗口接手时**：先问主人看过没有、有没有要改的；再按下面「主人要定的事」逐条问。没得到主人点头，不发 npm、不建 Release、不公开仓库。

### 第二阶段做了什么

- **`cctether setup`**（SPEC §8.1）：一问一答装好服务端。装 cctether 本身（用 npx 跑时）、生成密钥、问连法（同机 / SSH 隧道 / 公网 HTTPS）、装 systemd 后台服务、注册到 Claude Code、自检、打出连接码。能重复跑，不会换密钥，不会悄悄覆盖手写的服务文件或别的 Claude Code 注册。中文系统显示中文。
- **`cctether check`**（SPEC §8.2）：在服务器上像插件一样去连连接码里的地址，看能不能到达这台机器上的 cctether。只验证服务端的证明就挂断，不会顶掉正在连着的浏览器，也不算认证失败。2026-11-08 对主人的真实部署跑过：本机地址、公网地址都通，Mac 没有被断开。
- **插件**：设置页和弹窗里「第 1 步」的命令改成 `npx cctether@latest setup`，下面加一句「已经装好了？运行 `cctether pair`」。中英 × 浅深 × 各种状态都截图看过。
- **打包和发布**（SPEC §8.3）：
  - 服务端和插件统一成同一个版本号（0.2.0）。
  - `scripts/pack-extension.mjs` 打插件 zip：零依赖，同一份源码每次打出来字节都一样。
  - GitHub Actions：`ci.yml` 每次 push 跑单元测试（Node 22、24）、端到端测试（下载 Chrome for Testing）、打包；`release.yml` 在推 `v*` 标签时建一个 **Release 草稿**，附插件 zip、npm 包和校验和。Actions 都锁到具体提交。
  - npm 包准备好了（说明、许可证、关键词都齐了），`"private": true` 还留着防止误发。
- **文档**：README 中英文、`docs/connect.md` 中英文（同机、SSH 隧道、Caddy、Cloudflare 隧道、nginx、WSL）、`SECURITY.md`（威胁模型、怎么报告漏洞）、`docs/PROTOCOL.md`（协议说明）。README 和连法文档是 Sonnet subagent 照代码写的，Claude 逐条核对过界面文字和命令。
- **测试**：服务端 73 个（新增 21 个 setup/check/接手的）、端到端 46 个（1 个只能在有界面的 Chrome 里跑），全过。
- **顺手修的**：服务端单元测试每跑一次会漏一个常驻服务进程在后台（清理顺序不对）。已修，并清掉了开发机上积攒的 10 个。
- **审查**：派 Opus subagent 审查了第二阶段的全部改动，结果见下面「审查」一条。

### 审查

Opus subagent 审查了第二阶段的全部改动（读代码，并在隔离环境里实测，包括用真的 npx 跑打好的包）。发现 2 个高危、5 个中危、若干低危，**全部修了**，每一条都补了测试。细节记在 SPEC §13 v0.6。最要紧的两条：

- **npx 把自己的临时副本当成「已装好」**：Claude Code 和后台服务会指向 npm 的临时缓存，缓存一清就坏。改成只看 npm 的全局目录。
- **npm 名字可能被抢注**：插件和文档里写着 `npx cctether@latest setup`，可 npm 上 `cctether` 还没人占。要是仓库先公开，别人可以抢先发一个同名的包，照着说明做的人就会跑别人的代码。所以定了顺序：**先发 npm 占住名字，再公开仓库、发 Release**（SPEC §8.3）。

其他修掉的：非终端时会打出连接码（现在只在终端里显示）；交给 systemd 时和 Claude Code 拉起的服务打架（现在 systemd 起的服务会接手）；`--no-install` 不生效；`--yes` 会悄悄替换别的 Claude Code 注册；失败了还说「好了」；问答里 Ctrl-C 失灵；输入一直不对时会无限地问（测试里撞到过）；等等。

审查确认没问题的：密钥和连接码不会出现在进程参数、服务文件、Claude Code 配置、日志里；所有外部命令都不经过 shell；`check` 确实不会顶掉浏览器、不算认证失败；GitHub Actions 没有注入风险、权限最小、锁到了具体提交；插件 zip 符合格式、可复现；SECURITY.md 和协议说明和代码一致（两处小出入已改）。

### 部署

- 2026-11-08 把服务器上主人在用的服务升级到 0.2.0（`npm pack` → `npm install -g` → `systemctl --user restart cctether`）。升级后 `cctether check`：本机地址、公网地址都通，Mac 上的 Chrome 3 秒内自己连回来了。
- 升级时正好撞上审查说的那种情况：旧服务一停，开着的 Claude Code 会话立刻拉起了一个临时的服务；新的 systemd 服务按新逻辑接手了它（日志里有「taking over」）。旧代码在这里会一直重启到 systemd 放弃。
- 回退用的 0.1.0 包在 `/tmp/cctether-0.1.0.tgz`（`/tmp` 重启会清掉；要用时也可以从 git 历史重新打）。
- 现在主人可以在服务器上直接跑 `cctether check` 自检。

## 主人要定的事（SPEC §10.3）

1. **要不要发 npm。** 发了别人才能用 `npx cctether@latest setup`。要用主人的 npm 账号：主人在服务器上运行 `! npm login` 登录，Claude 去掉 `"private": true`、跑一遍测试再发。发完要真跑一遍 `npx cctether@latest setup`（在隔离环境里）。
2. **要不要建第一个 Release。** 推 `v0.2.0` 标签就会自动建一个草稿（仓库现在是私有的，草稿只有主人看得到）。看过再点发布。
3. **要不要上 Chrome 应用商店。** 要以主人的名义注册开发者账号（一次性 5 美元），还要过审核。商店版的插件 ID 会不一样，到时候要加进服务端的白名单。不上也行：README 写的是从 Releases 下载、手动加载。
4. **要不要公开仓库。** 公开前 Claude 再查一遍 git 历史（2026-11-08 查过：没有 IP、域名、个人路径、密钥；提交者都是 noreply 邮箱）。公开后要在仓库设置里打开「Private vulnerability reporting」，SECURITY.md 里写的报告漏洞的入口才能用。

**顺序必须是：先发 npm（占住名字）→ 公开仓库 → 打开漏洞报告 → 推 v0.2.0 标签发 Release。** 理由见上面「审查」第二条。在发 npm 之前，0.2.0 的插件 zip 也不要发给别人。README 里的命令和下载链接要等这几步做完才对别人有效。

## 开发机上测不了、还没专门确认过的

- Mac 合盖再打开以后多久能自己连回（SPEC §11 第 1 条）。
- 真实断网时，扩展后台收不收得到 offline/online 事件（收不到也没关系，每秒会读一次联网状态）。
- Mac 上的快捷键（Meta+A/C/V 等）有没有按对。
- 界面在 Mac 上的样子：开发机没有苹方字体，截图里中文标题是常规粗细。
- `npx cctether@latest setup` 从 npm 装的那一步：包还没发，只用假的 npm 和本地打的包测过。发 npm 以后要真跑一遍。
- systemd 那几步只用假的 systemctl 测过（真的会碰到主人在用的服务）；生成的服务文件用 `systemd-analyze --user verify` 验过。
- GitHub Actions 的 Release 流程：要推标签才会跑，还没跑过。CI 流程 push 以后会跑，结果见下面。
- macOS 和 WSL 当服务端：文档里写了「没测过，欢迎反馈」。

## 已知的限制（文档里已经写了）

- 跨域 iframe 里的元素、控制台和网络请求拿不到。
- CSS 选择器进不了 shadow DOM（`read_page` 的可交互元素清单能看到里面的）。
- `reload_extension` 只能让代码改动生效，manifest 改了要用户手动在 chrome://extensions 点重载（SPEC §11 第 2 条）。
- 截整页时，很长的页面会被缩得很窄（为了不超过图片尺寸上限）。

## 坑

- `node --test` 要写成通配（`test/*.test.js`），只给目录在 Node 24 上会报错。
- `xvfb-run` 在开发机上用不了（没有 xauth），要有界面的 Chrome 就直接起 `Xvfb :97`。
- 让开发版插件自己 `chrome.runtime.reload()`，在测试环境里会把插件弄成停用，不可靠（SPEC §11 第 2 条）。
- 后台标签页页面变化后截图会卡住，靠临时开 screencast 解决（SPEC §11 第 3 条）。
- 测试里插件刚装好会自动打开设置页，有时会占掉初始的空白标签页。测试要用的页面一律自己 `Target.createTarget` 新开。
- 配置目录路径太长时 Unix socket 建不起来，会改用 `$XDG_RUNTIME_DIR`（SPEC §4.5）。临时测试目录尽量用短路径。
- systemd 用户服务的 PATH 里没有 `~/.local/bin`，服务单元里要写 node 的完整路径（setup 生成的就是完整路径）。
- 改了服务端代码，要重新打包安装再重启服务，主人在用的才会变（见 `CLAUDE.local.md`）。
- 改了插件，要让主人在 Mac 上重新下载、替换文件夹、点重新加载；版本号两边一起加一（SPEC §8.3），主人能在设置页底部看到版本。
- 扩展后台里 Chrome 的断网模拟只改 navigator.onLine，不发 offline 事件。测断网要靠读联网状态，不能只听事件。
- 端到端测试里别把插件版本写死，从 manifest 读（tools.test.mjs 里的 VERSION_RE）。
- **在开发机上试 setup 要特别小心**：主人在用的服务就在这台机器上（端口 27182、`~/.config/cctether`、systemd 服务 `cctether`）。一定要设临时的 `CCTETHER_HOME`、换端口、加 `--no-service`；碰 `claude mcp` 时设临时的 `CLAUDE_CONFIG_DIR`。setup 起的服务记得 `cctether stop`。
- 自己起的常驻服务要传对环境变量：`spawnDaemon` 不传 env 时用的是当前进程的环境，测试里会指到主人的真实配置（这次撞到过一次，因为主人的服务已经在跑，新起的那个自己退出了，没造成影响）。
- 设置页里带 `backticks` 的说明文字不要用 `.note` 样式：它是 flex 布局，文字和代码块会被排成几列。用 `.step-hint` 那种普通段落。
