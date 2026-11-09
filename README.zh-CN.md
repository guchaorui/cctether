# cctether

[English](README.md) | 简体中文

[Chrome 应用商店](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib) · [npm](https://www.npmjs.com/package/cctether) · [Releases](https://github.com/guchaorui/cctether/releases)

cctether 让 Claude Code（或者任何 MCP 客户端）用上你自己的 Chrome 浏览器。它由两部分组成：一个 Chrome 插件，和一个跑在 Claude Code 所在电脑上的小服务。插件主动连到这个服务，服务再通过 MCP 把浏览器的本领交给 Claude：读页面、截图、点击、输入，还能看控制台和网络请求。全程走你自己的连接，中间没有 Anthropic 或任何第三方的中转服务器。

## 为什么做这个

官方的「Claude in Chrome」要经过 Anthropic 的中转服务器（`bridge.claudeusercontent.com`）。下面这些情况用不了：

- 用 API key 或 `claude setup-token` 登录 Claude Code；
- 通过 Amazon Bedrock、Google Cloud 或 Microsoft Foundry 使用 Claude；
- 在 WSL 里跑 Claude Code；
- 所在的网络连不上那个中转服务器；
- Claude Code 跑在远程服务器上，浏览器却在你自己的电脑上。

cctether 这些情况都能用，因为浏览器连的是你自己跑的服务。

## 工作原理

```
 浏览器                         跑 Claude Code 的电脑
+--------------------+        +--------------------------+        +-------------+
| cctether 插件      | -----> | cctether 服务            | <----> | Claude Code |
+--------------------+  wss   +--------------------------+  MCP   +-------------+
                  （连本机时用 ws://127.0.0.1）
```

- 是插件主动连出去，所以浏览器那台电脑不用开任何端口。
- 连别的电脑时，插件只用 `wss://`（HTTPS，经反向代理或隧道服务）。明文的 `ws://` 只允许连本机（`127.0.0.1`），SSH 隧道也算在内。
- 握手时双方要先证明自己有同一把密钥，之后每条消息都加密。

## 快速开始

跑 Claude Code 的那台电脑上要有 Node.js 22 或更新的版本。

1. 在那台电脑上打开终端，运行：

   ```
   npx cctether@latest setup
   ```

   它会问几个问题，然后：

   - 把 cctether 装到当前用户下（`npm install -g cctether`）；
   - 生成密钥；
   - 问你浏览器怎么连到这台电脑（见[几种连法](#几种连法)）；
   - 可选：装一个后台服务（Linux 上是 systemd 用户服务）；
   - 把 cctether 加到 Claude Code（`claude mcp add -s user ...`）；你愿意的话，还会让 Claude 以后遇到浏览器的事就自己用它；
   - 检查地址通不通；
   - 最后显示一个以 `cctether1:` 开头的连接码。

2. [从 Chrome 应用商店安装插件](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib)。[详细步骤见下面](#安装插件)。
3. 打开插件的设置页，粘贴连接码。
4. 如果 Claude Code 开着，重开一次，然后让它用浏览器。

连接码要当密码对待，里面有密钥。

想让 Claude 帮你装？把 [docs/setup-with-claude.zh-CN.md](docs/setup-with-claude.zh-CN.md) 里的提示词粘贴到 Claude Code 里就行。安装向导由 Claude 运行，你只需要自己把连接码粘贴到插件里。

## 安装插件

1. 打开 **[Chrome 应用商店里的 cctether](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib)**，点**添加至 Chrome**。Chrome 会列出这个插件能做什么，其中有一条听着很吓人的提示，是调试权限带来的，见[权限](#权限)。确认以后，插件的设置页会自动打开，先别关。
2. 点 Chrome 右上角的拼图图标，在 cctether 旁边点图钉，把按钮固定在工具栏上。纯灰色的图标说明还没配对。
3. 在设置页的「和服务器配对」里，把 `cctether setup`（或 `cctether pair`）显示的连接码整行粘贴进去，点**配对**。
4. 设置页顶部显示「已连接」，工具栏图标变成青绿色，就成功了。

商店版以后会自己更新。

说明：

- Edge 等 Chromium 内核的浏览器多半也能用，但没测过。不支持 Firefox 和 Safari。
- 如果浏览器那台电脑上开着 Clash 之类的代理软件，给你的服务器域名加一条「直连」规则。不然代理出问题时，cctether 也会跟着断。

### 也可以自己加载

用不了应用商店，或者想用某个发布版本里的文件时：

1. 到 [GitHub Releases 页面](https://github.com/guchaorui/cctether/releases)下载 `cctether-extension-<版本号>.zip`（不是结尾带 `-store` 的那个）。
2. 解压，得到一个叫 `cctether-extension` 的文件夹。
3. 把它放在一个固定的地方，比如「文稿」。Chrome 每次启动都要从这里读插件，**以后别删、别挪**。
4. 在 Chrome 地址栏输入 `chrome://extensions`，回车。
5. 打开右上角的**开发者模式**开关。
6. 点**加载已解压的扩展程序**，选 `cctether-extension` 文件夹。页面上会出现 cctether 的卡片，同时自动打开插件的设置页。
7. 照上面第 2 到第 4 步固定按钮、配对。

两种只留一种。它们不共用配对信息，同时装着还会抢同一条连接（其中一个会显示「另一个浏览器连上了」）。要换的话：先在 `chrome://extensions` 里移除旧的，装上新的，再配对一次（`cctether pair` 显示的还是同一个连接码）。

## 几种连法

| 情况 | 插件连的地址 | `setup` 里选 |
|---|---|---|
| Chrome 和 Claude Code 在同一台电脑 | `ws://127.0.0.1:27182/cctether` | 1 |
| Claude Code 在服务器上，走 SSH 隧道 | `ws://127.0.0.1:27182/cctether`（由隧道转过去） | 2 |
| Claude Code 在服务器上，走 HTTPS 和你自己的域名（Caddy、Cloudflare 隧道、nginx 等） | `wss://browser.example.com/cctether` | 3 |
| Chrome 在 Windows，Claude Code 在 WSL 里 | `ws://127.0.0.1:27182/cctether` | 1 |

每一种的详细步骤见 [docs/connect.zh-CN.md](docs/connect.zh-CN.md)。

## 平时怎么用

- Claude 只能用 **cctether** 标签组里的标签页。它自己新开的标签页会自动进组。
- 想让 Claude 看你已经打开的页面：点工具栏上的 cctether 按钮，再点**共享**；或者直接把标签页拖进 cctether 组。
- 想收回来：点**停止共享**，或者把标签页拖出组。
- Claude 操作页面时，Chrome 顶部会出现“cctether”已开始调试此浏览器的提示条。这是正常的，是 Chrome 的规定，去不掉。在提示条上点**取消**，cctether 会暂停。
- 随时可以点工具栏按钮里的**暂停**。暂停时 Claude 碰不了任何页面，点**继续**就恢复。
- 弹窗里能看到最近的操作记录：Claude 点了什么、输入了什么、读了什么、截了什么图。
- 如果安装时对「以后自己就用 cctether」选了「要」，任务需要浏览器时 Claude 会自己用 cctether；没选的话，跟它说一声就行（比如「用浏览器看看……」）。这个设置是 `~/.claude/CLAUDE.md` 里一小段带标记的说明，删掉就撤销了。

### 工具栏图标

| 图标 | 意思 | 怎么办 |
|---|---|---|
| 青绿色 | 已连接 | 不用管 |
| 灰色带蓝点 | 正在连接 | 等几秒 |
| 灰色带红点 | 连不上 | 点图标看原因。它会自己重试。常见的是服务器没开，或者网络、代理有问题 |
| 灰色带橙点 | 另一个浏览器连上了 | 服务同一时间只连一个浏览器。想用这个浏览器，点「在这里重新连接」 |
| 暂停符号 | 已暂停 | 点图标，再点「继续」 |
| 纯灰色 | 还没配对 | 在设置页粘贴连接码 |

## 命令

`cctether help` 能看到完整说明。

| 命令 | 作用 |
|---|---|
| `cctether setup` | 一步步装好一切，从这里开始。可以重复运行。 |
| `cctether init [--port N] [--url URL]` | 生成密钥和设置。第一次用到时会自动做。 |
| `cctether pair [--url URL]` | 显示要粘贴到插件里的连接码。 |
| `cctether check` | 测试插件用的地址能不能连到这台电脑上的服务。 |
| `cctether status [--json]` | 服务在运行吗？有浏览器连着吗？ |
| `cctether rotate` | 换一把新密钥，旧的连接码立刻失效。 |
| `cctether daemon [--takeover]` | 在前台运行服务。systemd 后台服务用的是 `--takeover`：Claude Code 已经拉起过一个的话，由它接手。 |
| `cctether stop` | 停掉正在运行的服务。 |
| `cctether mcp` | 在 stdin/stdout 上提供 MCP（Claude Code 会运行它）。 |
| `cctether version` | 显示版本号。 |

选项：`--url URL` 是插件要连的地址（会记住，下次不用再给），`--port N` 是本机服务的端口（默认 27182）。要在脚本里跑 `setup`，还有 `--yes`、`--mode local|ssh|https`、`--no-install`、`--no-service`、`--no-mcp`、`--claude-md` / `--no-claude-md` 和 `--lang en|zh`。

设置存放在 `$CCTETHER_HOME`；没设的话是 `$XDG_CONFIG_HOME/cctether`；再没有就是 `~/.config/cctether`。

## 工具

Claude 能用这 20 个工具：

| 工具 | 作用 |
|---|---|
| `list_tabs` | 列出 cctether 组里的标签页，附上浏览器信息。 |
| `open_tab` | 在组里新开一个标签页，并设为当前页。 |
| `close_tab` | 关掉组里的一个标签页。 |
| `navigate` | 打开网址，或者后退、前进、刷新，等页面加载完再返回。 |
| `read_page` | 读页面：可见文字、带编号的可交互元素清单，或某个选择器的 HTML。内容长时会分段。 |
| `find` | 用 CSS 选择器找元素。 |
| `screenshot` | 截可见区域、整页或某个元素。 |
| `click` | 点击某个元素或某个位置，用的是真实的鼠标事件。 |
| `type` | 在元素或当前焦点处输入文字。 |
| `press_key` | 按键或组合键，比如 `Enter`、`Control+A`。 |
| `scroll` | 滚动页面，或者滚到某个元素。 |
| `hover` | 鼠标悬停在元素或某个位置上。 |
| `select_option` | 在 `<select>` 下拉框里选值。 |
| `wait_for` | 等某段文字或某个元素出现（或消失）。 |
| `evaluate` | 在页面里执行 JavaScript，结果以 JSON 返回。 |
| `console_messages` | 读控制台消息和没被捕获的错误。 |
| `network_requests` | 列出网络请求，或查看某一条的请求头、响应头和响应体。 |
| `handle_dialog` | 接受或关闭 alert、confirm、prompt 弹框。 |
| `list_extensions` | 列出浏览器里装的插件。 |
| `reload_extension` | 重载某个插件（开发插件时有用）。 |

## 权限

插件只申请下面这些 Chrome 权限，没有别的：

| 权限 | 为什么需要 |
|---|---|
| `debugger` | 所有页面操作：真实的鼠标键盘输入、截图、控制台、网络、JS 弹框、在页面里执行脚本。Chrome 顶部的调试提示条也是因为它。 |
| `tabs` | 读标签页的标题和网址，开关标签页。 |
| `tabGroups` | 建 cctether 标签组，判断标签页在不在组里。 |
| `storage` | 存连接码、设置和最近的操作记录。 |
| `alarms` | 定时检查连接，断了自己连回去。 |
| `management` | 列出和重载插件（`list_extensions`、`reload_extension`）。 |

安装时 Chrome 会提示这个插件可以「读取和更改您在所有网站上的所有数据」「访问页面调试程序后端」。凡是带 `debugger` 权限的插件，Chrome 都会这样提示，因为这个权限确实很大。真正的限制在 cctether 自己的代码里：每个操作页面的工具，都会先检查这个标签页在不在 cctether 标签组里（[extension/background/tabs.js](extension/background/tabs.js)）。代码没有压缩，你可以自己看。插件没有另外申请网站权限，也不会往网页里放常驻的脚本：读页面用的代码是插件自带的，只在调用工具时才运行。

## 安全和隐私

- 双方先证明自己有同一把 256 位的密钥（挑战—应答式握手）。服务端没证明它有密钥之前，插件不执行任何指令。
- 握手之后，每条消息都用 AES-256-GCM 加密。就算有代理能解开 HTTPS，也看不到、塞不进指令。
- 连别的电脑时，插件只用 `wss://`。明文的 `ws://` 只允许连本机。
- Claude 只能用 cctether 标签组里的标签页。你可以随时暂停。
- 服务只接受这个插件，会对失败的尝试限流，并且只认路径 `/cctether`。
- 没有统计，没有遥测。除了你自己的服务，数据不会发往任何地方。
- 连接码是秘密。万一泄露，在服务器上运行 `cctether rotate`，再重新配对。

网页里可能藏着写给 AI 看的指令（提示词注入），而 Claude 是在你已经登录的浏览器里干活的。银行、邮箱、管理后台这类敏感页面不要放进 cctether 组，也留意弹窗里 Claude 在做什么。

更多内容：[SECURITY.md](SECURITY.md)、[PRIVACY.md](PRIVACY.md)（隐私政策，英文）和 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 更新

**从 Chrome 应用商店装的插件会自己更新。** 新版本要过了商店审核才会推送，所以它可能比服务稍微落后一点。这没关系：两边真的配合不了时，弹窗会告诉你该更新哪一边。

**服务**要你自己更新，在跑 Claude Code 的电脑上：

1. `npm install -g cctether@latest`
2. 重启服务。装了后台服务的：`systemctl --user restart cctether`。没装的：`cctether stop`，Claude Code 下次用到时它会自己再启动。

**自己加载的插件**：下载新的 zip，用新文件替换 `cctether-extension` 文件夹里的内容，然后在 `chrome://extensions` 里点 cctether 卡片上的重新加载按钮。

配对信息都会保留。

## 出问题时

- 在跑 Claude Code 的电脑上运行 `cctether check`。它像插件一样去连连接码里的地址，并用大白话告诉你哪里不对。`cctether status` 能看服务有没有在运行、有没有浏览器连着。
- 「连不上服务器」：服务没在运行，或者网络挡住了。先看 `cctether status`。浏览器那台电脑上的代理软件，可能要给你的域名加一条直连规则。
- 「服务器身份不对」或「服务器不再接受这个浏览器」：密钥换过了（比如运行过 `cctether rotate`）。运行 `cctether pair`，用新的连接码重新配对。
- 「另一个浏览器连上了」：服务同一时间只连一个浏览器。点「在这里重新连接」就切回来。
- 「请更新插件」或「请更新服务器上的 cctether」：见[更新](#更新)。
- 各种连法的更多细节：[docs/connect.zh-CN.md](docs/connect.zh-CN.md)。

## 占用大吗？

- **Claude 的上下文：** 20 个工具的说明一共约 4000 个 token，大约是 20 万上下文的 2%。新版 Claude Code 在 MCP 工具多的时候会按需加载：Claude 真正用到浏览器之前，上下文里只有工具名（约 150 个 token）和一小段说明（约 120 个 token）。
- **跑 Claude Code 那台电脑的内存：** 服务本身约 75 MB；每开一个 Claude Code 窗口，多一个约 55 MB 的转接小进程。
- **浏览器：** Claude 不用的时候插件什么也不做，只有每 10 秒一次很小的心跳。

## 已知的限制

- 跨域 iframe 里的元素、控制台消息和网络请求拿不到。
- CSS 选择器进不了 shadow DOM。`read_page` 的可交互元素清单能看到里面的。
- `reload_extension` 能让代码改动生效，但 `manifest.json` 的改动不行，那种要你自己在 `chrome://extensions` 点重新加载。
- 很长的整页截图会被缩小（为了不超过图片尺寸上限），所以会很窄。
- 一个服务同一时间只连一个浏览器。
- 服务端不能直接在 Windows 上运行，请用 WSL。

### 还没测过的

- 用 macOS 当跑 Claude Code 的电脑。
- WSL（Chrome 在 Windows，Claude Code 在 WSL 里）。

这两种应该能用，但还没有人试过。欢迎反馈：[提 issue](https://github.com/guchaorui/cctether/issues)。

## 卸载

1. `claude mcp remove -s user cctether`；如果安装时加过，再删掉 `~/.claude/CLAUDE.md` 里那段 cctether 说明
2. 如果装过后台服务：`systemctl --user disable --now cctether`，然后删掉 `~/.config/systemd/user/cctether.service`。
3. `npm uninstall -g cctether`
4. 删掉设置文件夹：`~/.config/cctether`（如果设过 `$CCTETHER_HOME`，就删那个）。
5. 在 Chrome 的 `chrome://extensions` 里移除插件。如果是自己加载的，再删掉 `cctether-extension` 文件夹。

## 开发

```
extension/   浏览器插件（MV3，零依赖，不用打包）
server/      npm 包 cctether：命令行、服务、MCP
test/e2e/    端到端测试：无界面 Chrome for Testing + 插件 + 服务
docs/        设计文档（SPEC）、连接指南
deploy/      Caddyfile 和 systemd 服务的示例
scripts/     图标、截图、插件打包、商店宣传图
store/       Chrome 应用商店的上架文字和图片
```

- 服务端单元测试：`cd server && npm test`
- 端到端测试：`node --test test/e2e/*.test.mjs`（需要 Chrome for Testing，或设置 `CHROME_PATH`）
- 打包插件 zip：`node scripts/pack-extension.mjs`（可复现：同样的源码打出一模一样的 zip，别人能自己核对发布的文件）

## 许可证

[MIT](LICENSE)
