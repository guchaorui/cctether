# 交接

> 2026-11-27 更新。新窗口读 `CLAUDE.md`、`CLAUDE.local.md`（这两个会自动加载）、`docs/SPEC.md` 和本文第零、一节，就能接上。

## 零、现在到哪了（先看这里）

> **2026-11-27 晚到 11-28：在干净的机器上从头装了一遍（第二节第 1 条），修了测出来的问题，发了 0.8.1 和 0.8.2。** 新窗口从这一段开始：
> - **怎么测的**（全文在 SPEC §11 第 18 条）：主人开了一台谷歌云服务器（Ubuntu 24.04.5 精简镜像，IP 在 `CLAUDE.local.md`），Claude 照 README 当新用户：nvm 装 Node 26（长期支持版），`npx cctether@latest setup` 选 SSH 隧道，后台服务、linger、重启机器、Claude Code（官方一行命令装，没登录）注册都走了一遍；浏览器是开发机上的测试 Chrome（带工作区的插件），经 SSH 隧道配对；扮演 Claude Code 起 `cctether mcp` 调工具。另开了一个用户 `bob` 试 Ubuntu 自带的 Node 18 和 NodeSource 装到系统的 Node 22。
> - **0.8.1 修的**：① **`upload_file` 在 setup 装的 systemd 服务里一律被拒**：沙盒带来一个只映射本用户的用户命名空间，root 的目录在服务眼里属主是 65534。改成属主看不出来的目录只在本用户真实主目录的上级放行，检查完经 `/proc/self/fd` 从核对过的目录打开文件（SPEC §5.2「后台服务的沙盒里」）。② 照 setup 的提示 `npm config set prefix ~/.local` 以后，`~/.local` 不存在又被判成没权限。③ 先问「要不要装」，答了才说装不了。④ 换端口重启时提示写错。README 和「Node 太旧」的提示加了下载链接。
> - **0.8.2**：0.8.1 发布后在主人真 Mac 上试上传仍被拒，原因是主人的 `~/.config` 同组可写（771；Debian/Ubuntu 的 umask 002 常见结果）。试了两种放宽，GPT 都否了（SPEC §5.2「同组可写的文件夹」），规则不变，只让报错说清楚是往上第几层、提示 `chmod go-w`。主人的服务器上用 `chmod g-w ~/.config` 解决。另外修了一条以前就不稳的端到端测试。
> - **测出来、没改的**（第二节第 1 条）：nvm 装的 Node 靠 `#!/usr/bin/env node` 找 node；`check` 看不出上传能不能用；同组可写的文件夹要用户自己改（可以让 setup 主动发现并问）。另外 Node 26 在精简版 Ubuntu 上缺 `libatomic1`（Node 的事）；linger 要用户自己 `sudo`（setup 给了命令）。
> - **临时服务器**：测完要提醒主人删掉（忘了删每月一百多元）。
> - **GPT 把关**：0.8.1 方案挑过刺，复审 2 条、核验两轮（又提 3 条、1 条），都处理了；0.8.2 的两种放宽各审了一轮，都撤掉。细节在 SPEC §13 v0.23、v0.24。

> **2026-11-27：「上传文件」做完了，0.8.0 已发布**（npm、GitHub Release、主人的服务器；主人说「开工」，并说 0.7.0 的商店包先不传，全部做完一起传）。 新窗口从这一段开始：
> - **主人要做的**：① ~~上传商店的新包~~（主人 2026-11-27 已上传 `dist/cctether-extension-0.8.0-store.zip`，**当天过审**，主人 Mac 上已是 0.8.0）一次带上 0.6.x 的 iframe、0.7.0 的拖拽和这次的上传文件，0.7.0 的不用传了。商店介绍的功能列表多了「拖拽」和「上传文件」，调试器权限的理由也多了半句（`store/listing*.md` 已改），上传时顺手把介绍文字也更新。② 商店版过审以后，在真 Mac 上试一次上传文件（顺便看插件的内存，见下面），再请 Oracle 那个项目的 Claude 用一次（iframe、`file`、拖拽、上传文件）。
> - **下一步（主人 2026-11-27 定）：在干净的机器上从头装一遍**（第二节第 1 条）。商店 0.8.0 主人已经上传，过审以后主人开一台谷歌云服务器，开新窗口把外部 IP 给 Claude。配置已和主人说好：e2-small（2 核 2 GB）、Ubuntu 24.04 LTS、10–20 GB 标准盘、asia-southeast1、只开 SSH、什么都不预装；创建时加了 coding 的公钥（`~/.ssh/id_ed25519.pub`，用户名 `guchaorui`）。IP 记进 `CLAUDE.local.md`，不进仓库。测完提醒主人删掉服务器（忘了删一个月约一百元）。
>   - 怎么测：照 README 当新用户走。① 装 Node 22，`npx cctether@latest setup` 选 SSH 连法；② 看 systemd 用户服务和 linger 装好没有，重启机器确认自己起来；③ `cctether check`；④ 装 Claude Code，看 setup 能不能注册 MCP（不登录主人的账号）；⑤ 浏览器用 coding 上的测试 Chrome（`test/e2e/lib/chrome.js` 的 `launchChrome` 带工作区插件），经 SSH 隧道连到新机器的服务，配对后经 `cctether mcp` 调几个工具，包括 `upload_file`。不动主人 Mac 上的插件。结果和发现的问题报给主人，记进本文和 SPEC。
> - **0.8.0（`upload_file`）**：把运行 Claude Code 那台电脑上的文件交给网页的上传框，或者拖进放置区。规则在 SPEC §5.2「上传文件 `upload_file`」（含「施工时定下的细节」），经过在 §13 v0.22。要点：
>   - 文件只能来自 cctether 的上传文件夹（`~/.config/cctether/uploads/`，服务自己建，权限 700）。Claude 先把文件复制进去，再传文件名。不收路径、链接、硬链接；上面任何一级文件夹别人能改的话就不干。一次最多 10 个、合计 20 MiB。
>   - `tab` 和 `origin`（哪个网站）都必填，交付前那一刻再核对：还在标签组里、没暂停、没跳转、没弹框、还是那个网站、还是那个元素。中途出事就说「什么都没给」；说不准的时候说「可能已经给了，先看页面」。
>   - 协议多了一样：服务发给插件的大消息也能分段（只给上传文件用），插件在连接时声明自己会拼。旧插件配新服务：上传会说「请更新插件」，别的工具照常。
>   - 慢网也试了：20 MiB 经过限速 1 MiB/s 的转发，31 秒传完，连接没断。插件后台的内存峰值约 85 MiB（JS 堆 56 MiB 加 ArrayBuffer 28 MiB，测试 Chrome 里量的）。主人真 Mac 上的峰值和真实慢网还没测，要等商店过审。
>   - 真实组件试了 react-dropzone：给它的上传框设文件能用；往它的放置区「拖」进去不行（它要的东西合成的拖放给不出），所以工具会提示改用放置区里的上传框（SPEC §11 第 17 条）。
>   - 顺手补了 0.7.0 漏掉的：弹窗「最近操作」里的「拖拽」原来显示英文工具名 `drag`，现在中英文都有名字了，还加了测试防止再漏。
> - **GPT 把关**：方案在上次（v0.21）已经挑过刺。做完后复审提了 6 条，都改了，又核验了五轮才没有必须改的（细节在 SPEC §13 v0.22）。改出来的主要是：排队超时的调用不会被晚发（这条本来会造成重复点击）、用户按 Esc 能取消上传、慢网时分段改小到 16 KB、网页拿到文件后能写进去的东西（弹框文字、跳转后的地址、标题）不再带回给 Claude 和活动记录。开工时 GPT 的每周额度只剩 3%，复审完刚好重置（现在 1%，12/4 重置）。
> - **0.6.2、0.7.0（已发布）**：开着的会话在服务升级后拿到新工具（§13 v0.19）；新工具 `drag`（§13 v0.20）。

**2026-11-26：0.6.0 做完并已发布，随后补发 0.6.1**（npm、GitHub Release、主人的服务器；商店的新包等主人上传，直接传 0.6.1 的）。起因是又一个项目的 Claude 在 Oracle 云控制台里用 cctether，主人转来反馈：控制台把整个表单放在同源 iframe 里，`read_page` 只读回页眉页脚，按文字找「创建」说没有；400 多行的脚本每次都要整段贴。做的过程中它又补了两条：往 iframe 里的输入框打字报「不是文本框」（同一个原因）；14 KB 的脚本又整段贴了两遍。规则全在 SPEC §5.2「同源 iframe，和 `evaluate` 读脚本文件」，经过在 §13 v0.17。
- **同源 iframe 和页面本身一样能用**：读页面、按选择器和文字找、点击、输入、选下拉框、滚动、等待、截图都进得去；别的网站的、加了 sandbox 的写出它声明的地址（去掉参数）。跨页面不明确（好几个 iframe 都匹配、文字在不止一个页面里完全相同）就列出候选，不替 Claude 选。
- **`evaluate` 的 `file`**：只读 cctether 自己的脚本目录（`~/.config/cctether/scripts/`，权限 700，不能是链接），由服务读出来当 `expression` 发出去，旧插件也能用。主人服务器上已经在真链路上试过（读到了 example.com 的标题，`../config.json` 被拦下）。
- **顺手修的**：发给插件的消息太大时，原来会把加密计数弄乱、连接断掉（以前就有的问题）；在 iframe 里把元素滚进来时，外层页面会被带着挪几个像素；截图坐标原来查不出页面里的 div 滚动过。
- **GPT 把关**：方案挑了两轮刺，做完复审一轮（4 条要紧的、3 条次要的，都改了），核验两轮（第一轮又指出 4 处，都改了；0.6.0 发布后第二轮确认都修好了，又指出两处小的，改成 0.6.1，见 SPEC §13 v0.18，这两处没再送核验）。没采纳的和理由在 SPEC §13 v0.17。
- **还不支持**：把 iframe 里滚动的内容一次截全（提示 Claude 边滚边截）；在旋转、缩放过的 iframe 里按位置点击。

**顺带记一个这次自己用 cctether 时的不顺手**（全局 CLAUDE.md 要求汇报）：服务端升级以后，已经开着的 Claude Code 会话手里还是旧的工具清单，用不了新参数，只好自己写脚本走 `cctether mcp`（这次验证 `file` 又是这样）。2026-11-27 的 0.6.2 解决了（见上）。

**两个阶段都做完了，项目已经公开发布，主人自己每天在用。** 主人 2026-11-09 说先做到这里。2026-11-17 加了 `resize_viewport`、`set_color_scheme`（0.4.0），已发布，商店版 11-18 过审。

**2026-11-25：按另一个 Claude 的使用反馈做了 0.5.0。2026-11-26 主人同意后已发布**（npm、GitHub Release、主人的服务器）；商店的新包等主人上传、过审。 另一个项目的 Claude 在谷歌云控制台里用了八九十次 cctether，按能省多少排了六条反馈，主人转过来说「你看看能怎么优化吧」。做了的（规则在 SPEC §5.2「按另一个 Claude 的使用反馈改的六处」，GPT 意见在 §13 v0.15）：
- 按文字找元素、点击（`find`/`click`/`hover`/`scroll` 加 `text`），只对唯一一个完全相同的动手，否则列出候选。
- `select_option` 能用在声明了 combobox/listbox 的自定义下拉框上：只认它用 `aria-controls`/`aria-owns` 指明的列表，不猜。
- 截图有编号，`click`/`hover`/`scroll` 带 `screenshot` 就能直接用图上的坐标；截图后页面滚动、跳转、视口变了会拒绝。截图尺寸同时管 Claude 的两个上限（原来 16:9 的大视口坐标会差 7%）。
- `wait_for` 说明「一开始就有」、最长 10 分钟；`navigate` 能接着等某个条件；`evaluate` 会等返回的 Promise。
- `read_page` 清单去掉重复（藏起来的单选框用 label 代表），对话框、主要内容排前面，导航放最后。
- `screenshot` 给元素加 `full_page` 能把一个滚动区域整个截下来（边滚边截再拼）。
- 新服务端配旧插件时，参数报错会说明是插件太旧。

做完以后测试全过。GPT 复审提了 7 条，都改了，又核验了四轮才没有必须改的（细节在 SPEC §13 v0.15）。复审还顺带堵上了一个所有工具都有的时间差：标签页在「确认在组里」和「挂上调试器」之间被拖出组，原来会被操作一小会儿。**2026-11-26 商店 0.5.0 过审**，商店里的包和发布的逐个文件核对过。随后在主人的真 Mac 上用公开演示网站（MUI、Angular Material）试了新功能：截图编号点击、按文字点击、元素清单分组、整页截图的提示都正常；试出三处要改（自定义下拉框要等弹出动画放完再点、选完要等菜单关上；Angular 下拉框「显示的文字」算进了选项；截滚动区域时外面浮着的 cookie 提示框被截进每一段），**改成了 0.5.1**（SPEC §13 v0.16），测试全过，GPT 复审的 4 条都改了、核验过。**0.5.1 2026-11-26 已发布**（npm、GitHub Release、主人的服务器），商店版当天过审，主人的 Mac 已自动更新，三处修正在真 Mac 上复测过，都好了（SPEC §11 第 13 条）。除此之外没有做到一半的事。

已知还没解决的问题：有界面模式下有一条旧测试偶尔失败，原因还没查清（见「坑」→「测试」）。

| 在哪 | 版本 | 说明 |
|---|---|---|
| 仓库 `main` | 0.8.2 | 已公开（`guchaorui/cctether`），GitHub 上的测试全过 |
| npm（`cctether`） | 0.8.2 | 2026-11-09 起由 GitHub Actions 可信发布，带来源证明。0.8.1、0.8.2 的包都和 Release 里的逐字节一致 |
| GitHub Release | v0.8.2 | 附插件 zip、npm 包和校验和；两个插件 zip 和本地打的一致 |
| Chrome 应用商店 | 0.8.0 | 2026-11-27 过审（主人告知），主人 Mac 已自动更新到 0.8.0。0.8.1、0.8.2 只改服务端，不用传新包。[商店页面](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib)，插件 ID `mbkadoolgknacadjkfjjajldmllbkdib` |
| 主人的服务器 | 0.8.2 | 2026-11-28 从 npm 装的，`cctether check` 全过。`~/.config` 原来是 771（同组可写），上传被拒，改成了 751（`chmod g-w`，要改回就 `chmod g+w ~/.config`）。之后在主人真 Mac 上经公网地址传了一个小文件，网页收到的内容一字不差 |
| 主人的 Mac | 商店版 0.8.0 | Chrome 158，连接正常（升级服务时断开十几秒后都自己连回来了） |
| 官网主页 | 已有卡片 | site-ops 做的。要改卡片交给 site-ops |

- **测试**：服务端 138 个（0.8.1 的在 `uploads.test.js` 末尾：沙盒里属主看不出来的几种情况，其中一个在开发机上用 `unshare --user --map-current-user` 真建命名空间，Ubuntu 24.04 这类不许建的地方会跳过；`setup.test.js` 末尾：npm 全局目录还没建出来、不能写时不提问；0.6.2 的在 `server/test/shim.test.js`：假的常驻服务 + 子进程跑的 `cctether mcp`；0.8.0 的上传目录在 `uploads.test.js`，分段协议在 `fragments.test.js`：带背压的限速转发、按规矩乱发的假服务）；端到端 89 个（88 个通过，1 个要有界面的 Chrome，GitHub 上会跳过）。上传文件的两个测试在 `tools.test.mjs` 末尾，测试页 `fixtures/pages/upload.html`、`upload-one.html`，经真服务的一个在 `fullstack.test.mjs`；拖拽的在它们前面，测试页 `fixtures/pages/drag.html`；iframe 的再前面，测试页 `fixtures/pages/frames.html`、`frame-inner.html`（别的网站用 localhost 对 127.0.0.1 来模拟）。
- **两个新工具在主人的真 Mac 上试过的（2026-11-18，Chrome 157，Retina 屏，系统是浅色）**：调到 390 宽、只改高度、调到比窗口还高（1280×2000）；截图是 1 图片像素 = 1 CSS 像素，按截图坐标点击点得中；强制深色、再恢复跟随系统；跳到别的页面后两个模拟都还在；恢复后回到真实大小（1710×806）；标签页在前台和在后台都试了；在一个真实网站上（nodejs.org）也试了。模拟自动结束后的提醒两种情况都试了：5 分钟没操作后，下一次截图的说明末尾带了一句提醒，再下一次就不带了；Mac 断线几分钟再连上后，按旧坐标点击被拒绝了一次，之后正常。两种情况下页面都回到了真实大小和浅色。
- **主人在真 Mac 上确认过的**：合盖再打开，连接很快恢复；常用快捷键都对（清单在 SPEC §13 v0.10）；商店版能连上服务端，整条链走通。
- **外部反馈**：GitHub 上目前 0 个 star，没有 issue。还没有别人用过的反馈。

**主人已经定了的，不用再问：**

- 发布前不加「在 GitHub 上点批准」（SPEC §8.3），推版本标签就等于发布。
- **做完了可以直接发布**（主人 2026-11-26：「以后做完了可以直接发」）：测试全过、GPT 复审过、提交 push、GitHub 上的测试过，就照第三节发布并升级主人的服务器，发完汇报。商店的新包仍让主人上传。
- 商店只在插件代码改了才提交新版本，商店版可以落后于 npm。
- npm 的发布权限（包的 Settings → Publishing access）：主人 2026-11-09 打开设置页，选的是第一项「要求两步验证，不接受绕过两步验证的令牌」。可信发布不受影响。Claude 看不到这个设置，只看过主人的截图。

**还等主人定的：**

- **上传商店的包**：传 `dist/cctether-extension-0.8.0-store.zip`（照 `store/README.zh-CN.md` 末尾），顺手把商店介绍更新成 `store/listing*.md` 里的（功能列表多了拖拽和上传文件）。iframe、拖拽、上传文件都在插件里，过审以后才到主人的 Mac 上。
- **请 Oracle 那个项目的 Claude 再用一次**（商店版更新以后）：看 iframe、`file`、拖拽、上传文件在真的控制台里好不好用。它的会话要是开在 0.6.2 之前，要重开一次 Claude Code。

- **请谷歌云那个项目的 Claude 再用一次**（不急，主人方便时）：看那六条反馈在真的控制台里是不是解决了。有新反馈就照这次的流程改。
- 中英文介绍（不急，主人不提就别催）：Claude 写过草稿给主人，发不发、发到哪由主人定。Claude 不代发。

## 一、新窗口怎么接手

1. 问主人这次想做什么。主人只说「继续优化」的话，把第二节的清单用大白话讲给主人，让主人选。清单里的事主人都还没同意做。
2. 动手前先确认现状没变：`git status`、`npm view cctether version`、`cctether check`。
3. 主人在用的服务就在这台开发机上。改代码不影响它，但试 setup 和起服务时要小心（见「坑」）。
4. 改完照 `CLAUDE.md` 的规矩走：改需求、架构或协议先改 SPEC；界面要截图看；安全相关要配测试；提交后 push；发布前问主人。

## 二、接下来可以优化的（候选清单，按 Claude 的建议排序）

**先把「别人能不能装上」验证了。** 项目是给别人用的，这一段却测得最少：

1. ~~在一台干净的机器上从头装一遍~~：2026-11-27 做完（Ubuntu 24.04，SPEC §11 第 18 条），测出来的问题在 0.8.1 修了。剩下没改的两条：
   - **用 nvm 装 Node 的人**：注册给 Claude Code 的命令是 `…/bin/cctether mcp`，靠第一行 `#!/usr/bin/env node` 找 node。从交互终端起的 Claude Code 没问题；在没加载 nvm 的环境里（`ssh 服务器 'claude -p …'`、定时任务、项目里 `.nvmrc` 切到旧 Node）会起不来或用错 Node。可以考虑：`node` 和 `cctether` 在同一个 bin 目录时，注册成 `<那个目录>/node <cctether> mcp`（Homebrew 的也是稳定的链接路径）。要注意已经注册过的用户重跑 setup 会被问要不要替换。
   - **`cctether check` 看不出上传能不能用**：这次的问题只在服务进程（沙盒里）出现，`check` 在沙盒外跑。可以让服务在 `status` 里报告「上传目录能不能用、为什么」，`check` 显示出来。
   - **上传目录往上有同组可写的文件夹**（Debian/Ubuntu 上早就有的 `~/.config` 常是这样，主人的也是）：0.8.2 只让报错说清楚是第几层、提示 `chmod go-w`。可以让安装向导和 `check` 主动发现，问用户要不要改（要改的是用户自己的文件夹，`--yes` 时不改只提示）。规则本身不要放宽：两种放宽 GPT 都否了，理由在 SPEC §5.2「同组可写的文件夹」。
   - Mac、WSL 当服务端仍没测（下面第 2、3 条）。HTTPS 连法在干净机器上没测（要域名和开 80/443）。
2. **Mac 当服务端。** 代码里没有 Mac 的后台服务（launchd），setup 在 Mac 上不会装开机自启，靠 Claude Code 启动时把服务拉起来。文档写的是「没测过，欢迎反馈」。Claude 碰不到 Mac，要主人配合，或者等用户反馈。
3. **WSL 当服务端。** 同样没测过，开发机上测不了。

**再补工具的缺口。** 现在有 23 个工具，这几件事 Claude 做不了：

4. ~~上传文件~~：2026-11-27 做完，0.8.0。
5. ~~拖拽~~：2026-11-27 做完，0.7.0。
6. **每个 Claude 窗口各用一个标签组。** 现在所有窗口共用一个「cctether」组，同时开几个窗口时看得到彼此的标签页，可能互相干扰。这会改标签页范围，属于安全相关，必须配测试。
7. **长页面分段截图。** 现在截整页时，很长的页面会被缩得很窄。
8. **真正的手机模拟。** 要有触摸、UA、手机的视口规则；现在的 `resize_viewport` 只是「窄的桌面视口」。别的媒体模拟（减少动画、打印样式）也还没做。

**iframe 里滚动的内容一次截全**（0.6.0 没做，SPEC §5.2「还不支持」）：GPT 认为要每一步核对 iframe 的位置和滚动、加锁、要求整个区域都在屏幕里。

**拖拽的后续**（0.7.0 没做，SPEC §5.2「拖拽 `drag`」）：拖到视口外时自动滚动；对话框关掉以后自动松开鼠标；从页面拖进 iframe（跨文档）没专门测过；拖的过程中 iframe 换了页面不会让它停下。

**上传文件的后续**（0.8.0 没做，SPEC §5.2「上传文件 `upload_file`」）：拦截「选择文件」窗口（点按钮才临时造输入框的网页用得上；GPT 认为要把时间窗口压到几秒、只认能证明的输入框，见 SPEC）；让 react-dropzone 这类放置区也认合成的拖放（要在页面里动 `getAsFileSystemHandle`，没做）；上传时别的调用要等文件发完（慢网时会等很久，超时的不会再被发出去）；线路慢到约 1.6 KB/s 以下时上传可能被当成断线；别的工具还是不响应取消（Esc），只有上传响应。

**这次反馈里没做、或者做了一半的：**

- **测试 Chrome 里后台标签页点击慢**（每个鼠标事件约 0.3 秒）。2026-11-26 在主人的真 Chrome 上量过：后台标签页点一次 0.1–0.2 秒，所以只影响端到端测试的时长，不影响使用。
- **用户按 Esc 取消时，插件不知道。** 服务端收到 MCP 的取消通知不转给插件，10 分钟的 `wait_for` 会一直等到超时（只读页面，没有副作用）。要改协议。
- **长的滚动区域截全以后字很小**，和整页截图一样（下面第 7 条）。
- **截图上叠编号**（反馈里提的另一种做法）：没做，编号在 `read_page`/`find` 里已经有了。

**小事，顺手就能做：**

9. **打开 Dependabot 安全提醒。** 仓库现在是关着的。依赖只有 `ws` 一个，开了也不吵。这是改仓库设置，先问主人。
10. **操作时页面上的提示。** SPEC §6.2 写的「可选，做得好看就做」，还没做。Chrome 的调试提示条已经能说明情况，所以不急。

**以后再说：** 下载文件、录 GIF、书签和历史、多个浏览器同时连、Firefox 和 Safari（SPEC §12）。没人要之前不做。

## 三、发新版本的步骤

1. `server/package.json`、`server/package-lock.json`、`extension/manifest.json` 的版本号一起加；测试全过；提交、push。
2. 确认这件事已经做完（测试全过、GPT 复审过、GitHub 上的测试过）。主人 2026-11-26 起授权做完就直接发，不用再问。推标签：`git tag -a v<版本号> -m "cctether <版本号>" && git push origin v<版本号>`。这一推就会发布：GitHub Actions 跑全部测试，通过后用可信发布发到 npm（不用登录，也不用点确认），再建 Release 草稿。
3. 核对：`SHA256SUMS` 和本地 `node scripts/pack-extension.mjs`、`--flat` 打出来的一样，npm 包的 sha1 和 `npm view cctether@<版本号> dist.shasum` 一样。写说明，发布：`gh release edit v<版本号> --notes-file ... --draft=false --latest`。
4. 插件代码改了的话：让主人照 `store/README.zh-CN.md` 末尾上传新的 `-store.zip`、提交审核。只改了服务端就不用，商店版可以落后。
5. 升级主人的服务器（`npm install -g cctether@latest && systemctl --user restart cctether`），跑 `cctether check`。要回退：把 `latest` 换成旧版本号，再重启。

可信发布出问题时的备用办法：让主人 `! npm login`，然后 `cd server && script -qfc "npm publish --access public" <日志文件>` 放后台跑（要有终端，npm 才会打出确认网址并等待），把网址给主人确认。再重跑那次 Release 运行，已经发过的版本会自动跳过 npm 这一步。

## 四、东西都在哪

| 想找 | 看哪 |
|---|---|
| 每个版本改了什么、为什么 | SPEC §13（第二阶段的两轮审查在 v0.6、v0.7） |
| 第一阶段的安全审查 | SPEC §6.3；攻击测试在 `server/test/security.test.js`、`test/e2e/security.test.mjs` |
| 占用多少内存和上下文 | README「占用大吗？」 |
| 让 Claude 帮别人装的提示词 | `docs/setup-with-claude.md`（中文版 `.zh-CN.md`） |
| 商店要填的内容、审核问到权限怎么答 | `store/listing*.md`；上传步骤 `store/README.zh-CN.md`；宣传图 `store/images/`（`scripts/store-images.mjs` 生成） |
| 主人的部署、账号、怎么升级 | `CLAUDE.local.md` |

## 开发机上测不了、还没专门确认过的

- 上传文件在主人真 Mac 上（商店过审以后）：插件后台的内存峰值（测试 Chrome 里 20 MiB 约 85 MiB）、真实的慢网和反向代理（开发机上用限速转发模拟过）、一个真实网站的上传（开发机上只试了测试页和 react-dropzone）。

- 拖拽在主人真 Mac 上的 Chrome 里（商店过审以后）：开发机上无界面、有界面的 Chrome for Testing 156 都测过。插件声明的最低版本 Chrome 120 上没试过「鼠标事件转成 HTML 拖放」。
- 0.6.2：2026-11-27 在一个真的 Claude Code 会话里确认了（会话开在 0.7.0 的服务上，服务升到 0.8.0 以后 `upload_file` 不用重开就出现了，调用也正常）。原来只在 `claude -p` 里试过（§11 第 15 条）。

- 真实断网时，扩展后台收不收得到 offline/online 事件（收不到也没关系，每秒会读一次联网状态）。
- 界面在 Mac 上的样子：开发机没有苹方字体，截图里中文标题是常规粗细。
- 0.5.x 的新功能没在真的谷歌云控制台上试过、0.6.0 的 iframe 没在真的 Oracle 控制台上试过（那是主人登录的账号，Claude 不自己去点）。0.6.x 的插件部分要等商店过审才到主人的 Mac 上，在那之前只在开发机的测试 Chrome 里测过。在主人的真 Mac 上用公开演示网站（MUI、Angular Material）试过的见 SPEC §11 第 13 条。
- 第二节第 2、3 条：Mac 和 WSL 当服务端。（干净的 Ubuntu 上真实的 systemd 流程 2026-11-27 测过了，见 SPEC §11 第 18 条。）
- `resize_viewport` 和 `set_color_scheme` 在主人的真 Mac 上还没试成的：
  - 主人的 Mac 是深色时强制浅色（试的时候系统是浅色）。自动测试里用 `--force-dark-mode` 测过。
  - 页面缩放不是 100% 时调宽度（自动测试里测过）。
  - 标签页在前台、宽度被调窄时，主人眼里页面是什么样子（Claude 只看得到截图）。

## 已知的限制（文档里已经写了）

- 别的网站的 iframe、加了 sandbox 的 iframe 里的元素、控制台和网络请求拿不到（会写出它声明的地址）。同源 iframe 一页最多跟 20 个、5 层；旋转、缩放过的 iframe 能读不能按位置点；iframe 里滚动的内容不能一次截全。
- `evaluate` 的 `file` 只读 cctether 的脚本目录；这个目录是链接、或者别人有权限时，`file` 不能用。
- CSS 选择器进不了 shadow DOM（`read_page` 的可交互元素清单能看到里面的）。
- `reload_extension` 只能让代码改动生效，manifest 改了要用户手动在 chrome://extensions 点重载（SPEC §11 第 2 条）。
- 截整页时，很长的页面会被缩得很窄（为了不超过图片尺寸上限）。
- `resize_viewport` 模拟的是窄的桌面视口，不是手机（UA、触摸、像素比不变）；标签页 5 分钟没操作或暂停后模拟自动结束，Claude 下次操作时会收到一次提醒。
- `set_color_scheme` 只对跟着系统深浅色走的网页有效；网页自己的主题开关和存下来的主题它不去动。和调宽度一样，5 分钟没操作或暂停后自动恢复，并提醒 Claude 一次。
- 自定义下拉框：没用 `aria-controls`/`aria-owns` 指明列表的、只渲染一部分选项的（虚拟列表，比如 Ant Design），`select_option` 不会替 Claude 选，只列出看得见的选项，让 Claude 自己点。菜单按钮（`aria-haspopup="menu"`）不算下拉框。
- `upload_file`：用脚本事件给上传框设文件，应付不了浏览器的「选择文件」窗口；非要真人选的网页不认；有些放置区（react-dropzone）不认合成的拖放，要改用它的上传框。文件只能来自上传文件夹，最多 10 个、合计 20 MiB；别的网站的 iframe 里的上传框、选文件夹都不支持。上传期间这条连接上别的调用要等文件发完才发。
- 截图编号只在调试器挂着时有效（5 分钟没操作或暂停后就没了）；拼出来的滚动区域截图不能拿坐标点。
- 把滚动区域截全时会真的滚动它，页面可能因此加载新内容；虚拟列表的内容可能不全。只拼竖向。

## 坑

**发布：**

- 推了标签以后，如果 npm 那一步失败：标签已经在 GitHub 上了，别删了重推（改已经 push 的东西要先问主人）。先看失败原因；不用改代码的，重跑那次运行就行；要改代码的，加一个小版本号重新走。npm 上的版本号用过就不能再用。
- `release.yml` 不能改名，发布这一步也不能挪到别的文件：npm 只认这个文件名。
- 发布完要等几十秒，`npm view` 才看得到新版本。
- 手动跑的 `npm publish`、`npm trust` 都要有终端才会打出确认网址，所以用 `script -qfc` 放后台跑。`npm trust list` 也要登录。开发机上的 npm 登录已退出，要用时让主人 `! npm login`。
- 商店报「无法访问隐私权政策链接」时，先用没登录的方式查（`curl`，或无痕窗口）。GitHub 故障时登录的人打得开、没登录的打不开（Google 的检查程序不登录），2026-11-09 就撞上过一次，恢复后重新提交就过了。查 `https://www.githubstatus.com/api/v2/incidents/unresolved.json`。
- 想核对商店里的包：`curl -L "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=156.0.0.0&acceptformat=crx3&x=id%3Dmbkadoolgknacadjkfjjajldmllbkdib%26uc"` 下载 CRX，跳过文件头（4 字节 `Cr24` + 4 字节版本 + 4 字节头长度 + 头）后面就是 zip。正常情况下只有 manifest 不同（没有 `key`，商店加了 `update_url`），另外多了商店的签名文件 `_metadata/`。

**在开发机上试东西：**

- **试 setup 要特别小心**：主人在用的服务就在这台机器上（端口 27182、`~/.config/cctether`、systemd 服务 `cctether`）。一定要设临时的 `CCTETHER_HOME`、换端口、加 `--no-service`；碰 `claude mcp` 时设临时的 `CLAUDE_CONFIG_DIR`。setup 起的服务记得 `cctether stop`。
- 自己起的常驻服务要传对环境变量：`spawnDaemon` 不传 env 时用的是当前进程的环境，测试里会指到主人的真实配置（撞到过一次，因为主人的服务已经在跑，新起的那个自己退出了，没造成影响）。
- 配置目录路径太长时 Unix socket 建不起来，会改用 `$XDG_RUNTIME_DIR`（SPEC §4.5）。临时测试目录尽量用短路径。
- systemd 用户服务的 PATH 里没有 `~/.local/bin`，服务单元里要写 node 的完整路径（setup 生成的就是完整路径）。
- 改了服务端代码，要打包安装再重启服务，主人在用的才会变（见 `CLAUDE.local.md`）。
- 别用 `pkill -f` / `pgrep -f` 配同一条命令里出现过的文字：会把跑这条命令的 shell 也杀掉，或者一直找到它自己（2026-11-26 用 `while pgrep -f …` 等 GPT 跑完，就因此一直等下去）。等 Codex 跑完，就用后台方式直接跑 `codex exec`，完成时会有通知。
- `xvfb-run` 在开发机上用不了（没有 xauth），要有界面的 Chrome 就直接起 `Xvfb :97`。
- 想在开发机上模拟 systemd 服务的沙盒：开发机没有用户级 D-Bus，`systemd-run --user` 用不了。用 `unshare --user --map-current-user <命令>`，得到的 uid_map 和 systemd 服务的一样（只映射自己，root 的目录显示成 65534）。Ubuntu 24.04（包括 GitHub 的机器）默认不许这样建，GitHub 的服务端测试那一步先用 sysctl 放开了。
- 想看服务进程到底在什么样的命名空间里：`cat /proc/$(systemctl --user show cctether -p MainPID --value)/uid_map`。

**测试：**

- 想在真的 Claude Code 会话里试 MCP 行为（比如工具清单的通知）：写一个假的 MCP 服务，用 `env -u CLAUDECODE claude -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --mcp-config <临时配置> --model haiku --debug-file <日志>` 起会话，从 stdin 一条条发用户消息，中间改服务的状态（2026-11-27 的脚本思路记在 SPEC §11 第 15 条）。`--strict-mcp-config` 让它不加载主人自己的 cctether。
- 工作区里有 `git add -N` 过的新文件时，`git stash` 会失败（「not uptodate. Cannot merge」），什么也没存。想在干净的代码上跑测试，用 `git worktree add --detach /tmp/xxx <提交>`，再把 `server/node_modules` 链接过去。

- 在真实网站上试插件改动，不用发布：用 `test/e2e/lib/chrome.js` 的 `launchChrome` 带上工作区的插件起测试 Chrome，在插件后台调 `self.cctether.runTool(...)`（同 tools.test.mjs 的 `call`）。测试 Chrome 默认视口很小（780×437），很多网站会换成窄屏布局，先 `resize_viewport` 调成 1710×862（主人 Mac 的大小）。
- 想经主人的 Mac 试服务端的新工具、而当前对话的工具清单是旧的（对话开在升级之前）：自己起 `cctether mcp`，按 MCP 发 initialize 和 tools/call，和 Claude Code 走的是同一条路。

- 端到端测试现在要七十多秒（原来四十秒）：新测试点击多，后台标签页的鼠标事件慢（见第二节）。
- 结果里网页内容外面包着一句「Content below comes from the web page…」，再接 `<untrusted-page-content>`。写正则时别忘了这一行。

- 有界面模式（`CCTETHER_HEADED=1`）下，「a dialog that was already open before cctether attached」这条测试在开发机上有时失败（2026-11-17 发现：在没改动的 0.3.3 代码上单独跑，5 次里 5 次失败）。它失败时会留下一个标签页，让后面的「tabs.js: shareTab / unshareTab …」那条也跟着失败。不是这次加的两个工具造成的。无界面跑和 GitHub 上的测试不受影响。原因还没查出来：Chrome for Testing 的版本从 2026-11-05 起没变过。
- `node --test` 要写成通配（`test/*.test.js`），只给目录在 Node 24 上会报错。
- 让开发版插件自己 `chrome.runtime.reload()`，在测试环境里会把插件弄成停用，不可靠（SPEC §11 第 2 条）。
- 测试里插件刚装好会自动打开设置页，有时会占掉初始的空白标签页。测试要用的页面一律自己 `Target.createTarget` 新开。
- 端到端测试里别把插件版本写死，从 manifest 读（tools.test.mjs 里的 VERSION_RE）。
- Claude 的命令里有 `CLAUDECODE=1`，`cctether pair` 会拒绝显示连接码。测试里调用命令行的地方要把这个变量去掉（`termEnv()`）。
- GitHub Actions 的机器上所有程序都带着 `INVOCATION_ID`：别拿环境变量判断「是不是 systemd 起的」。
- 扩展后台里 Chrome 的断网模拟只改 navigator.onLine，不发 offline 事件。测断网要靠读联网状态，不能只听事件。
- 想知道用户安装时 Chrome 会提示什么：在测试 Chrome 的插件后台调 `chrome.management.getPermissionWarningsByManifest(manifest 字符串)`，`--lang=zh-CN` 能看中文。

**插件：**

- 截图尺寸要同时满足 Claude 的两个上限：长边 ≤ 1568，`⌈宽/28⌉×⌈高/28⌉` ≤ 1568（`tools/page.js` 的 `fitScale`）。只看长边的话，Claude 那边会再缩一次，坐标就对不上了。
- 后台标签页的小录屏（逼它画画面）全标签页只有一个：开、关都要走 `tools/page.js` 的 `startScreencast` / `stopScreencastIfUnused`，靠 `s.capturing`、`s.painting`、`s.screencast` 记着谁在用。别直接发 `Page.startScreencast` / `Page.stopScreencast`。
- 自定义下拉框的弹出动画要等放完再点（`ddSettling`），而且等的时候后台标签页要保持绘制，不然动画停在半路。
- 截图编号的计数从一个随机数开始：插件后台重启以后，旧编号不太可能正好撞上新截图。
- 元素编号（ref）在每个新页面里从 1 重新数。一个流程要跨好几次调用用同一个编号时（自定义下拉框、滚动区域截全），要带上页面库给的 `doc`（页面身份），`resolve()` 对不上就报 stale_ref。
- `Runtime.callFunctionOn` 的参数里，值为 null 的字段到页面里会变成「没有这个字段」。在页面里比较时把 null 和 undefined 当成一样（`?? null`）。
- 调试会话挂上以后要等 `ready` 才能用（`session()` 会等）：挂上后会再确认一次标签页还在组里。

- 后台标签页页面变化后截图会卡住，靠临时开 screencast 解决（SPEC §11 第 3 条）。
- 页面库（`page-scripts.js`）每次调用有一份缓存（`cache`：iframe 清单、每层 iframe 的位置），调用结束时清掉。调用中途滚动过（`scrollIntoViewCentered` 里），位置缓存要作废，不然点击位置会差几个像素（0.6.0 施工时撞上过）。
- 在 iframe 里 `scrollIntoView` 会把外层页面也带着滚，哪怕外层是 `overflow: hidden`。`scrollIntoViewCentered` 会把外层放回原位（元素照样看得清楚时）。别处要滚动 iframe 里的元素，也走这个函数。
- 截图坐标的核对（`shotCheck`）：宁可少拒也不要「永远拒」。会让重截图也过不去的情况（旋转缩放过的 iframe、超出跟踪范围的 iframe）直接报 bad_args 并说明，不报 stale_screenshot。
- 改了插件：版本号两边一起加（SPEC §8.3），主人能在设置页底部看到版本。商店版要上传、过审才到用户手里。想让主人马上试，就让主人临时自己加载（要先移除商店版，两个版本不能同时装着，配对也要重来）。
- Chrome 不让任何插件操作应用商店页面，cctether 打开它会直接报 restricted。要看商店页面：`curl` 取（页面是服务端渲染的），或者让主人截图。
- 在主人的 Chrome 里测粘贴要先防一手：粘贴会把主人剪贴板里原来的内容读出来（可能是密码）。先确认复制真的成功了，并在页面上挂 `paste` 监听，内容不是测试文字就拦下，只记长度。
- 设置页里带 `backticks` 的说明文字不要用 `.note` 样式：它是 flex 布局，文字和代码块会被排成几列。用 `.step-hint` 那种普通段落。
- 清掉视口模拟后，后台标签页可能有 0.1–1 秒还报着旧尺寸（SPEC §11 第 9 条）。测试里比较「真实大小」，要等调试器挂上、提示条稳定以后再量，并且用轮询等，不要读一次就比。
- 让标签页模拟深浅色的那条命令（`Emulation.setEmulatedMedia`）每次是整份替换，没带的项会被清掉。只从 `tools/page.js` 里那一个函数发；以后加别的媒体模拟（减少动画、打印）也必须从那里发（SPEC §5.2）。
