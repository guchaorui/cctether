# 交接

> 2026-11-09 更新。新对话读 `CLAUDE.md`、`CLAUDE.local.md`、`docs/SPEC.md` 和本文第零节，就能接上。

## 零、现在到哪了（先看这里）

- **第二阶段全部做完，已经公开发布。** 主人 2026-11-08 同意的四件事都做完了：
  - npm：`cctether` 0.3.1（主人的 npm 账号，开了两步验证）。
  - GitHub：仓库已公开，打开了私下报告漏洞；Release 到 v0.3.1。
  - Chrome 应用商店：**已上架**，https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib（插件 ID `mbkadoolgknacadjkfjjajldmllbkdib`，2026-11-08 提交，约一天过审）。
    - 2026-11-09 下载商店里的包和 v0.3.1 逐文件核对过：55 个文件里 54 个一字不差；manifest 只差 `key`（我们打包时去掉的）和 `update_url`（商店加的）；另外多了商店的签名文件 `_metadata/`。权限没变。
  - 主人的服务器跑 0.3.1（从 npm 装）。
- **主人 2026-11-09 确认：Mac 合盖再打开没问题，连接恢复得很快。**
- **还等主人的**（都不急，主人不提就别催）：
  1. 把 Mac 上自己加载的 0.3.0 换成商店版（`docs/install-mac.zh-CN.md` 第七节）。这也是商店版第一次真正连服务端：经公网地址实测过服务端接受这个 ID，但整条链还没走过。换完可以用 `list_extensions` 确认：id 是商店版的、不再标 unpacked。
  2. Mac 上的快捷键（⌘A/⌘C/⌘V）还没验证。主人说一声 Claude 就能测。没有擅自测，因为会出现调试提示条，⌘C 还会覆盖一次主人的剪贴板。
  3. 可选：把 cctether 加到主页（交给 site-ops）、写一段介绍发到社区。主人还没回话。
- **main 比 npm 新一点，不影响用户，等下次发版带上**：setup 结尾的链接直达商店（现在 0.3.1 里的链接到 README，也能到商店）；npm 页面的说明提到商店。版本号没加。
- **新窗口接手时**：问主人这次想做什么。

### 以后发新版本的步骤

1. `server/package.json`、`server/package-lock.json`、`extension/manifest.json` 的版本号一起加；测试全过；提交、push，等 CI 过。
2. 发 npm：`cd server && script -qfc "npm publish --access public" <日志文件>`，放后台跑（要有终端，npm 才会打出确认网址并等待）。把日志里的 `https://www.npmjs.com/auth/cli/...` 给主人，在浏览器里确认。确认后约半分钟 npm 上才有新版本。
3. 推 `v<版本号>` 标签，GitHub Actions 建 Release 草稿。核对：`SHA256SUMS` 和本地 `node scripts/pack-extension.mjs`、`--flat` 打出来的一样，npm 包的 sha1 和 `npm view cctether@<版本号> dist.shasum` 一样。写说明，发布：`gh release edit v<版本号> --notes-file ... --draft=false --latest`。
4. 插件代码改了的话：让主人照 `store/README.zh-CN.md` 末尾上传新的 `-store.zip`、提交审核。只改了服务端就不用。
5. 升级主人的服务器（`CLAUDE.local.md`），跑 `cctether check`。

### 2026-11-08 第二轮：主人的问题、建议和实际使用的反馈

- **占用**（主人问会不会挤占上下文）：20 个工具的说明约 4000 token（20 万上下文的 2%）；新版 Claude Code 工具多时按需加载，没用到时只占工具名约 150 token 加一小段说明。服务约 75 MB 内存，每个 Claude Code 窗口多一个约 55 MB 的转接进程。写进了 README「占用大吗？」。
- **主人建议的「让 Claude 帮别人装」**：`docs/setup-with-claude.md`（中文版 `.zh-CN.md`），README 快速开始里有链接。setup 新增一问「以后要不要 Claude 自己就用 cctether」，要的话在 `~/.claude/CLAUDE.md` 末尾加一段带标记的说明（SPEC §8.1 第 5 步）。主人同意后，2026-11-08 已加到主人自己的 `~/.claude/CLAUDE.md`（备份 `~/.claude/CLAUDE.md.bak-before-cctether`）。
- **另一个 Claude 实际用下来提的三处**，都修了并补了端到端测试（SPEC §5.2）：缩小了的截图说明前后矛盾，导致按图上坐标点错；选择器取到藏起来的副本；`evaluate` 中途页面跳转时报 Chrome 的原始错误。
- **GitHub Actions 第一次跑**：端到端测试和打包在 GitHub 上都过了；服务端测试暴露出「靠 `INVOCATION_ID` 认 systemd」的问题，改成服务单元明确写 `daemon --takeover`。
- **发布前的审查**（Opus subagent）：没有严重和高危；4 个中危、若干低危都修了，补了测试，细节在 SPEC §13 v0.7。其中一条改了行为：`cctether pair` 在 Claude Code 运行的命令里不再显示连接码（包括主人在 Claude Code 里用 `!` 运行），要在自己的终端里运行。
- **Chrome 应用商店材料**：`store/listing.md`、`store/listing.zh-CN.md`（逐项要填的内容，Sonnet subagent 写、Claude 核对过）、`store/images/`（`scripts/store-images.mjs` 用真实界面拼的宣传图，中英各一套，Claude 逐张看过）、`PRIVACY.md`。审核可能会问 `debugger` 权限和 `evaluate` 算不算「远程代码」，`store/listing*.md` 末尾写了怎么答。

### 第二阶段做了什么

- **`cctether setup`**（SPEC §8.1）：一问一答装好服务端。装 cctether 本身（用 npx 跑时）、生成密钥、问连法（同机 / SSH 隧道 / 公网 HTTPS）、装 systemd 后台服务、注册到 Claude Code、自检、打出连接码。能重复跑，不会换密钥，不会悄悄覆盖手写的服务文件或别的 Claude Code 注册。中文系统显示中文。
- **`cctether check`**（SPEC §8.2）：在服务器上像插件一样去连连接码里的地址，看能不能到达这台机器上的 cctether。只验证服务端的证明就挂断，不会顶掉正在连着的浏览器，也不算认证失败。2026-11-08 对主人的真实部署跑过：本机地址、公网地址都通，Mac 没有被断开。
- **插件**：设置页和弹窗里「第 1 步」的命令改成 `npx cctether@latest setup`，下面加一句「已经装好了？运行 `cctether pair`」。中英 × 浅深 × 各种状态都截图看过。
- **打包和发布**（SPEC §8.3）：
  - 服务端和插件统一成同一个版本号（0.2.0）。
  - `scripts/pack-extension.mjs` 打插件 zip：零依赖，同一份源码每次打出来字节都一样。
  - GitHub Actions：`ci.yml` 每次 push 跑单元测试（Node 22、24）、端到端测试（下载 Chrome for Testing）、打包；`release.yml` 在推 `v*` 标签时建一个 **Release 草稿**，附插件 zip、npm 包和校验和。Actions 都锁到具体提交。
  - npm 包的说明、许可证、关键词都齐了（2026-11-08 已发布，去掉了 `"private": true`）。
- **文档**：README 中英文、`docs/connect.md` 中英文（同机、SSH 隧道、Caddy、Cloudflare 隧道、nginx、WSL）、`SECURITY.md`（威胁模型、怎么报告漏洞）、`docs/PROTOCOL.md`（协议说明）。README 和连法文档是 Sonnet subagent 照代码写的，Claude 逐条核对过界面文字和命令。
- **测试**：服务端 76 个、端到端 48 个（1 个只能在有界面的 Chrome 里跑），全过（2026-11-08 第二轮之后的数）。
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

## 开发机上测不了、还没专门确认过的

- 真实断网时，扩展后台收不收得到 offline/online 事件（收不到也没关系，每秒会读一次联网状态）。
- Mac 上的快捷键（Meta+A/C/V 等）有没有按对。
- 界面在 Mac 上的样子：开发机没有苹方字体，截图里中文标题是常规粗细。
- systemd 那几步只用假的 systemctl 测过（真的会碰到主人在用的服务）；生成的服务文件用 `systemd-analyze --user verify` 验过。
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
- 改了插件：版本号两边一起加（SPEC §8.3），主人能在设置页底部看到版本。商店版要上传、过审才到用户手里。想让主人马上试，就让主人临时自己加载（要先移除商店版，两个版本不能同时装着，配对也要重来）。
- 扩展后台里 Chrome 的断网模拟只改 navigator.onLine，不发 offline 事件。测断网要靠读联网状态，不能只听事件。
- 端到端测试里别把插件版本写死，从 manifest 读（tools.test.mjs 里的 VERSION_RE）。
- **在开发机上试 setup 要特别小心**：主人在用的服务就在这台机器上（端口 27182、`~/.config/cctether`、systemd 服务 `cctether`）。一定要设临时的 `CCTETHER_HOME`、换端口、加 `--no-service`；碰 `claude mcp` 时设临时的 `CLAUDE_CONFIG_DIR`。setup 起的服务记得 `cctether stop`。
- 自己起的常驻服务要传对环境变量：`spawnDaemon` 不传 env 时用的是当前进程的环境，测试里会指到主人的真实配置（这次撞到过一次，因为主人的服务已经在跑，新起的那个自己退出了，没造成影响）。
- 在开发机上跑测试时，Claude 的命令里有 `CLAUDECODE=1`，`cctether pair` 会拒绝显示连接码。测试里调用命令行的地方要把这个变量去掉（`termEnv()`）。
- GitHub Actions 的机器上所有程序都带着 `INVOCATION_ID`：别拿环境变量判断「是不是 systemd 起的」。
- Chrome 不让任何插件操作应用商店页面，cctether 打开它会直接报 restricted。要看商店页面：`curl` 取（页面是服务端渲染的），或者让主人截图。
- 想知道用户安装时 Chrome 会提示什么：在测试 Chrome 的插件后台调 `chrome.management.getPermissionWarningsByManifest(manifest 字符串)`，`--lang=zh-CN` 能看中文。
- 想核对商店里的包：`curl -L "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=156.0.0.0&acceptformat=crx3&x=id%3Dmbkadoolgknacadjkfjjajldmllbkdib%26uc"` 下载 CRX，跳过文件头（4 字节 `Cr24` + 4 字节版本 + 4 字节头长度 + 头）后面就是 zip。
- 设置页里带 `backticks` 的说明文字不要用 `.note` 样式：它是 flex 布局，文字和代码块会被排成几列。用 `.step-hint` 那种普通段落。
