# 交接

> 2026-11-09 更新。新窗口读 `CLAUDE.md`、`CLAUDE.local.md`（这两个会自动加载）、`docs/SPEC.md` 和本文第零、一节，就能接上。

## 零、现在到哪了（先看这里）

**两个阶段都做完了，项目已经公开发布，主人自己每天在用。** 主人 2026-11-09 说先做到这里。没有做到一半的事，也没有已知的 bug。

| 在哪 | 版本 | 说明 |
|---|---|---|
| 仓库 `main` | 0.3.3 | 已公开（`guchaorui/cctether`），GitHub 上的测试全过 |
| npm（`cctether`） | 0.3.3 | 2026-11-09 起由 GitHub Actions 可信发布，带来源证明 |
| GitHub Release | v0.3.3 | 附插件 zip、npm 包和校验和 |
| Chrome 应用商店 | 0.3.2 | 0.3.3 的插件代码没变，所以没提交。[商店页面](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib)，插件 ID `mbkadoolgknacadjkfjjajldmllbkdib` |
| 主人的服务器 | 0.3.3 | 从 npm 装的，`cctether check` 全过（细节在 `CLAUDE.local.md`） |
| 主人的 Mac | 商店版 0.3.2 | 连接正常，会自动更新 |
| 官网主页 | 已有卡片 | site-ops 做的。要改卡片交给 site-ops |

- **测试**：服务端 77 个；端到端 49 个（48 个通过，1 个要有界面的 Chrome，GitHub 上会跳过）。
- **主人在真 Mac 上确认过的**：合盖再打开，连接很快恢复；常用快捷键都对（清单在 SPEC §13 v0.10）；商店版能连上服务端，整条链走通。
- **外部反馈**：GitHub 上目前 0 个 star，没有 issue。还没有别人用过的反馈。

**主人已经定了的，不用再问：**

- 发布前不加「在 GitHub 上点批准」（SPEC §8.3）。所以推版本标签就等于发布，推之前 Claude 必须先问主人。
- 商店只在插件代码改了才提交新版本，商店版可以落后于 npm。
- npm 的发布权限（包的 Settings → Publishing access）：主人 2026-11-09 打开设置页，选的是第一项「要求两步验证，不接受绕过两步验证的令牌」。可信发布不受影响。Claude 看不到这个设置，只看过主人的截图。

**还等主人定的（都不急，主人不提就别催）：**

- 中英文介绍：Claude 写过草稿给主人，发不发、发到哪由主人定。Claude 不代发。

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

**再补工具的缺口。** 现在有 20 个工具，这几件事 Claude 做不了：

4. **上传文件。** 真实使用里最容易撞到。要先想清楚设计：文件在服务器上，浏览器在 Mac 上，内容要传过去，而现在一条消息上限是 1 MiB（要分片，要定总大小上限）；还要防止任意读服务器上的文件。动手前先写进 SPEC。
5. **拖拽。** 拖动排序、拖进上传框这类页面现在操作不了。比上传简单，用现有的鼠标事件就能做。
6. **每个 Claude 窗口各用一个标签组。** 现在所有窗口共用一个「cctether」组，同时开几个窗口时看得到彼此的标签页，可能互相干扰。这会改标签页范围，属于安全相关，必须配测试。
7. **长页面分段截图。** 现在截整页时，很长的页面会被缩得很窄。

**小事，顺手就能做：**

8. **打开 Dependabot 安全提醒。** 仓库现在是关着的。依赖只有 `ws` 一个，开了也不吵。这是改仓库设置，先问主人。
9. **操作时页面上的提示。** SPEC §6.2 写的「可选，做得好看就做」，还没做。Chrome 的调试提示条已经能说明情况，所以不急。

**以后再说：** 下载文件、录 GIF、书签和历史、多个浏览器同时连、Firefox 和 Safari（SPEC §12）。没人要之前不做。

## 三、发新版本的步骤

1. `server/package.json`、`server/package-lock.json`、`extension/manifest.json` 的版本号一起加；测试全过；提交、push。
2. **先问主人。** 同意后推标签：`git tag -a v<版本号> -m "cctether <版本号>" && git push origin v<版本号>`。这一推就会发布：GitHub Actions 跑全部测试，通过后用可信发布发到 npm（不用登录，也不用点确认），再建 Release 草稿。
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
- 第二节第 1、2、3 条：干净机器上真实的 systemd 流程（生成的服务文件用 `systemd-analyze --user verify` 验过）、Mac 和 WSL 当服务端。

## 已知的限制（文档里已经写了）

- 跨域 iframe 里的元素、控制台和网络请求拿不到。
- CSS 选择器进不了 shadow DOM（`read_page` 的可交互元素清单能看到里面的）。
- `reload_extension` 只能让代码改动生效，manifest 改了要用户手动在 chrome://extensions 点重载（SPEC §11 第 2 条）。
- 截整页时，很长的页面会被缩得很窄（为了不超过图片尺寸上限）。

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

- `node --test` 要写成通配（`test/*.test.js`），只给目录在 Node 24 上会报错。
- 让开发版插件自己 `chrome.runtime.reload()`，在测试环境里会把插件弄成停用，不可靠（SPEC §11 第 2 条）。
- 测试里插件刚装好会自动打开设置页，有时会占掉初始的空白标签页。测试要用的页面一律自己 `Target.createTarget` 新开。
- 端到端测试里别把插件版本写死，从 manifest 读（tools.test.mjs 里的 VERSION_RE）。
- Claude 的命令里有 `CLAUDECODE=1`，`cctether pair` 会拒绝显示连接码。测试里调用命令行的地方要把这个变量去掉（`termEnv()`）。
- GitHub Actions 的机器上所有程序都带着 `INVOCATION_ID`：别拿环境变量判断「是不是 systemd 起的」。
- 扩展后台里 Chrome 的断网模拟只改 navigator.onLine，不发 offline 事件。测断网要靠读联网状态，不能只听事件。
- 想知道用户安装时 Chrome 会提示什么：在测试 Chrome 的插件后台调 `chrome.management.getPermissionWarningsByManifest(manifest 字符串)`，`--lang=zh-CN` 能看中文。

**插件：**

- 后台标签页页面变化后截图会卡住，靠临时开 screencast 解决（SPEC §11 第 3 条）。
- 改了插件：版本号两边一起加（SPEC §8.3），主人能在设置页底部看到版本。商店版要上传、过审才到用户手里。想让主人马上试，就让主人临时自己加载（要先移除商店版，两个版本不能同时装着，配对也要重来）。
- Chrome 不让任何插件操作应用商店页面，cctether 打开它会直接报 restricted。要看商店页面：`curl` 取（页面是服务端渲染的），或者让主人截图。
- 在主人的 Chrome 里测粘贴要先防一手：粘贴会把主人剪贴板里原来的内容读出来（可能是密码）。先确认复制真的成功了，并在页面上挂 `paste` 监听，内容不是测试文字就拦下，只记长度。
- 设置页里带 `backticks` 的说明文字不要用 `.note` 样式：它是 flex 布局，文字和代码块会被排成几列。用 `.step-hint` 那种普通段落。
