# 交接

> 2026-11-26 更新。新窗口读 `CLAUDE.md`、`CLAUDE.local.md`（这两个会自动加载）、`docs/SPEC.md` 和本文第零、一节，就能接上。

## 零、现在到哪了（先看这里）

**两个阶段都做完了，项目已经公开发布，主人自己每天在用。** 主人 2026-11-09 说先做到这里。2026-11-17 加了 `resize_viewport`、`set_color_scheme`（0.4.0），已发布，商店版 11-18 过审。

**2026-11-25：按另一个 Claude 的使用反馈做了 0.5.0。2026-11-26 主人同意后已发布**（npm、GitHub Release、主人的服务器）；商店的新包等主人上传、过审。 另一个项目的 Claude 在谷歌云控制台里用了八九十次 cctether，按能省多少排了六条反馈，主人转过来说「你看看能怎么优化吧」。做了的（规则在 SPEC §5.2「按另一个 Claude 的使用反馈改的六处」，GPT 意见在 §13 v0.15）：
- 按文字找元素、点击（`find`/`click`/`hover`/`scroll` 加 `text`），只对唯一一个完全相同的动手，否则列出候选。
- `select_option` 能用在声明了 combobox/listbox 的自定义下拉框上：只认它用 `aria-controls`/`aria-owns` 指明的列表，不猜。
- 截图有编号，`click`/`hover`/`scroll` 带 `screenshot` 就能直接用图上的坐标；截图后页面滚动、跳转、视口变了会拒绝。截图尺寸同时管 Claude 的两个上限（原来 16:9 的大视口坐标会差 7%）。
- `wait_for` 说明「一开始就有」、最长 10 分钟；`navigate` 能接着等某个条件；`evaluate` 会等返回的 Promise。
- `read_page` 清单去掉重复（藏起来的单选框用 label 代表），对话框、主要内容排前面，导航放最后。
- `screenshot` 给元素加 `full_page` 能把一个滚动区域整个截下来（边滚边截再拼）。
- 新服务端配旧插件时，参数报错会说明是插件太旧。

做完以后测试全过。GPT 复审提了 7 条，都改了，又核验了四轮才没有必须改的（细节在 SPEC §13 v0.15）。复审还顺带堵上了一个所有工具都有的时间差：标签页在「确认在组里」和「挂上调试器」之间被拖出组，原来会被操作一小会儿。**2026-11-26 商店 0.5.0 过审**，商店里的包和发布的逐个文件核对过。随后在主人的真 Mac 上用公开演示网站（MUI、Angular Material）试了新功能：截图编号点击、按文字点击、元素清单分组、整页截图的提示都正常；试出三处要改（自定义下拉框要等弹出动画放完再点、选完要等菜单关上；Angular 下拉框「显示的文字」算进了选项；截滚动区域时外面浮着的 cookie 提示框被截进每一段），**改成了 0.5.1**（SPEC §13 v0.16），测试全过，GPT 复审的 4 条都改了、核验过。**0.5.1 2026-11-26 已发布**（npm、GitHub Release、主人的服务器），商店包等主人上传、过审。

已知还没解决的问题：有界面模式下有一条旧测试偶尔失败，原因还没查清（见「坑」→「测试」）。

| 在哪 | 版本 | 说明 |
|---|---|---|
| 仓库 `main` | 0.5.1 | 已公开（`guchaorui/cctether`），GitHub 上的测试全过 |
| npm（`cctether`） | 0.5.1 | 2026-11-09 起由 GitHub Actions 可信发布，带来源证明。0.5.1 的包和 Release 里的逐字节一致 |
| GitHub Release | v0.5.1 | 附插件 zip、npm 包和校验和；两个插件 zip 和本地打的一致 |
| Chrome 应用商店 | 0.5.0 | 2026-11-26 过审，和 v0.5.0 逐文件核对过（只有 manifest 按预期不同，多了 `_metadata/`）。**0.5.1 等主人上传 `cctether-extension-0.5.1-store.zip`、提交审核**（步骤在 `store/README.zh-CN.md` 末尾）。 |商店里的包和 `v0.4.0` 标签逐个文件核对过，只有 manifest 按预期不同（核对办法见「坑」→「发布」）。0.3.3 的插件代码没变，所以当时没提交。[商店页面](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib)，插件 ID `mbkadoolgknacadjkfjjajldmllbkdib` |
| 主人的服务器 | 0.5.1 | 2026-11-26 从 npm 装的，`cctether check` 全过（细节在 `CLAUDE.local.md`） |
| 主人的 Mac | 商店版 0.5.0 | Chrome 158，2026-11-26 自动更新，连接正常 |
| 官网主页 | 已有卡片 | site-ops 做的。要改卡片交给 site-ops |

- **测试**：服务端 80 个；端到端 80 个（79 个通过，1 个要有界面的 Chrome，GitHub 上会跳过）。有界面模式下新测试也都过（那两条老的偶尔失败照旧，见「坑」）。
- **两个新工具在主人的真 Mac 上试过的（2026-11-18，Chrome 157，Retina 屏，系统是浅色）**：调到 390 宽、只改高度、调到比窗口还高（1280×2000）；截图是 1 图片像素 = 1 CSS 像素，按截图坐标点击点得中；强制深色、再恢复跟随系统；跳到别的页面后两个模拟都还在；恢复后回到真实大小（1710×806）；标签页在前台和在后台都试了；在一个真实网站上（nodejs.org）也试了。模拟自动结束后的提醒两种情况都试了：5 分钟没操作后，下一次截图的说明末尾带了一句提醒，再下一次就不带了；Mac 断线几分钟再连上后，按旧坐标点击被拒绝了一次，之后正常。两种情况下页面都回到了真实大小和浅色。
- **主人在真 Mac 上确认过的**：合盖再打开，连接很快恢复；常用快捷键都对（清单在 SPEC §13 v0.10）；商店版能连上服务端，整条链走通。
- **外部反馈**：GitHub 上目前 0 个 star，没有 issue。还没有别人用过的反馈。

**主人已经定了的，不用再问：**

- 发布前不加「在 GitHub 上点批准」（SPEC §8.3），推版本标签就等于发布。
- **做完了可以直接发布**（主人 2026-11-26：「以后做完了可以直接发」）：测试全过、GPT 复审过、提交 push、GitHub 上的测试过，就照第三节发布并升级主人的服务器，发完汇报。商店的新包仍让主人上传。
- 商店只在插件代码改了才提交新版本，商店版可以落后于 npm。
- npm 的发布权限（包的 Settings → Publishing access）：主人 2026-11-09 打开设置页，选的是第一项「要求两步验证，不接受绕过两步验证的令牌」。可信发布不受影响。Claude 看不到这个设置，只看过主人的截图。

**还等主人定的：**

- **商店 0.5.1**：主人上传、提交审核。过审以后：核对商店里的包；在主人的 Mac 上把 MUI、Angular Material 的下拉框从关着的状态再选一次（0.5.0 在这里会拒绝或点不上），截一次 Angular 文档站的导航（cookie 提示框不该再出现在每一段里）；有条件的话请谷歌云那个项目的 Claude 再用一次，看六条反馈是不是解决了。
- 中英文介绍（不急，主人不提就别催）：Claude 写过草稿给主人，发不发、发到哪由主人定。Claude 不代发。

## 一、新窗口怎么接手

1. 问主人这次想做什么。主人只说「继续优化」的话，把第二节的清单用大白话讲给主人，让主人选。清单里的事主人都还没同意做。
2. 动手前先确认现状没变：`git status`、`npm view cctether version`、`cctether check`。
3. 主人在用的服务就在这台开发机上。改代码不影响它，但试 setup 和起服务时要小心（见「坑」）。
4. 改完照 `CLAUDE.md` 的规矩走：改需求、架构或协议先改 SPEC；界面要截图看；安全相关要配测试；提交后 push；发布前问主人。

## 二、接下来可以优化的（候选清单，按 Claude 的建议排序）

**先把「别人能不能装上」验证了。** 项目是给别人用的，这一段却测得最少：

1. **在一台干净的机器上从头装一遍。** `cctether setup` 里 systemd 那几步只用假的 `systemctl` 测过，因为真的会碰到主人在用的服务。开一台临时机器跑 `npx cctether@latest setup`，一路走到连上浏览器。要花一点云服务器的钱，先问主人。
2. **Mac 当服务端。** 代码里没有 Mac 的后台服务（launchd），setup 在 Mac 上不会装开机自启，靠 Claude Code 启动时把服务拉起来。文档写的是「没测过，欢迎反馈」。Claude 碰不到 Mac，要主人配合，或者等用户反馈。
3. **WSL 当服务端。** 同样没测过，开发机上测不了。

**再补工具的缺口。** 现在有 22 个工具，这几件事 Claude 做不了：

4. **上传文件。** 真实使用里最容易撞到。要先想清楚设计：文件在服务器上，浏览器在 Mac 上，内容要传过去，而现在一条消息上限是 1 MiB（要分片，要定总大小上限）；还要防止任意读服务器上的文件。动手前先写进 SPEC。
5. **拖拽。** 拖动排序、拖进上传框这类页面现在操作不了。比上传简单，用现有的鼠标事件就能做。
6. **每个 Claude 窗口各用一个标签组。** 现在所有窗口共用一个「cctether」组，同时开几个窗口时看得到彼此的标签页，可能互相干扰。这会改标签页范围，属于安全相关，必须配测试。
7. **长页面分段截图。** 现在截整页时，很长的页面会被缩得很窄。
8. **真正的手机模拟。** 要有触摸、UA、手机的视口规则；现在的 `resize_viewport` 只是「窄的桌面视口」。别的媒体模拟（减少动画、打印样式）也还没做。

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

- 真实断网时，扩展后台收不收得到 offline/online 事件（收不到也没关系，每秒会读一次联网状态）。
- 界面在 Mac 上的样子：开发机没有苹方字体，截图里中文标题是常规粗细。
- 0.5.x 的新功能没在真的谷歌云控制台上试过（那是主人登录的账号，Claude 不自己去点）。在主人的真 Mac 上用公开演示网站试过的见 SPEC §11 第 13 条。0.5.1 的下拉框修正只在开发机的测试 Chrome 里对真实网站（MUI、Angular Material）试过，主人的 Mac 要等 0.5.1 商店过审。
- 第二节第 1、2、3 条：干净机器上真实的 systemd 流程（生成的服务文件用 `systemd-analyze --user verify` 验过）、Mac 和 WSL 当服务端。
- `resize_viewport` 和 `set_color_scheme` 在主人的真 Mac 上还没试成的：
  - 主人的 Mac 是深色时强制浅色（试的时候系统是浅色）。自动测试里用 `--force-dark-mode` 测过。
  - 页面缩放不是 100% 时调宽度（自动测试里测过）。
  - 标签页在前台、宽度被调窄时，主人眼里页面是什么样子（Claude 只看得到截图）。

## 已知的限制（文档里已经写了）

- 跨域 iframe 里的元素、控制台和网络请求拿不到。
- CSS 选择器进不了 shadow DOM（`read_page` 的可交互元素清单能看到里面的）。
- `reload_extension` 只能让代码改动生效，manifest 改了要用户手动在 chrome://extensions 点重载（SPEC §11 第 2 条）。
- 截整页时，很长的页面会被缩得很窄（为了不超过图片尺寸上限）。
- `resize_viewport` 模拟的是窄的桌面视口，不是手机（UA、触摸、像素比不变）；标签页 5 分钟没操作或暂停后模拟自动结束，Claude 下次操作时会收到一次提醒。
- `set_color_scheme` 只对跟着系统深浅色走的网页有效；网页自己的主题开关和存下来的主题它不去动。和调宽度一样，5 分钟没操作或暂停后自动恢复，并提醒 Claude 一次。
- 自定义下拉框：没用 `aria-controls`/`aria-owns` 指明列表的、只渲染一部分选项的（虚拟列表，比如 Ant Design），`select_option` 不会替 Claude 选，只列出看得见的选项，让 Claude 自己点。菜单按钮（`aria-haspopup="menu"`）不算下拉框。
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
- 别用 `pkill -f` 配同一条命令里出现过的文字：会把跑这条命令的 shell 也杀掉。
- `xvfb-run` 在开发机上用不了（没有 xauth），要有界面的 Chrome 就直接起 `Xvfb :97`。

**测试：**

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
- 改了插件：版本号两边一起加（SPEC §8.3），主人能在设置页底部看到版本。商店版要上传、过审才到用户手里。想让主人马上试，就让主人临时自己加载（要先移除商店版，两个版本不能同时装着，配对也要重来）。
- Chrome 不让任何插件操作应用商店页面，cctether 打开它会直接报 restricted。要看商店页面：`curl` 取（页面是服务端渲染的），或者让主人截图。
- 在主人的 Chrome 里测粘贴要先防一手：粘贴会把主人剪贴板里原来的内容读出来（可能是密码）。先确认复制真的成功了，并在页面上挂 `paste` 监听，内容不是测试文字就拦下，只记长度。
- 设置页里带 `backticks` 的说明文字不要用 `.note` 样式：它是 flex 布局，文字和代码块会被排成几列。用 `.step-hint` 那种普通段落。
- 清掉视口模拟后，后台标签页可能有 0.1–1 秒还报着旧尺寸（SPEC §11 第 9 条）。测试里比较「真实大小」，要等调试器挂上、提示条稳定以后再量，并且用轮询等，不要读一次就比。
- 让标签页模拟深浅色的那条命令（`Emulation.setEmulatedMedia`）每次是整份替换，没带的项会被清掉。只从 `tools/page.js` 里那一个函数发；以后加别的媒体模拟（减少动画、打印）也必须从那里发（SPEC §5.2）。
