# 让 Claude 帮你装 cctether

[English](setup-with-claude.md) | 简体中文

不想自己运行 `npx cctether@latest setup` 的话，可以让 Claude Code 帮你装。在跑 Claude Code 的那台电脑上（你自己的电脑，或者你用 Claude Code 的服务器）打开 Claude Code，把下面这段粘贴进去：

```
请帮我装好 cctether。它能让你通过我自己的连接使用我的 Chrome 浏览器：https://github.com/guchaorui/cctether

1. 先读这个仓库里的 README.zh-CN.md 和 docs/connect.zh-CN.md。
2. 问我浏览器怎么连到这台电脑：Chrome 就在这台电脑上、经 SSH 隧道，还是用我自己的域名走 HTTPS。选 HTTPS 的话，问我地址（形如 wss://browser.example.com/cctether），到了那一步再帮我配反向代理。
3. 问我：以后任务需要用到浏览器时，要不要你自己就用 cctether。
4. 用不提问的方式运行安装向导，比如：
   npx cctether@latest setup --yes --mode https --url wss://browser.example.com/cctether --claude-md --lang zh
   按我的回答把 --mode 换成 local 或 ssh；第 3 步我说不要的话，去掉 --claude-md。把它的输出给我看，标了 ✗ 或 ! 的地方给我解释清楚。
5. 输出里如果有要 sudo 的命令，交给我自己运行。
6. 运行 `cctether check`，它报什么问题就帮我解决。
7. 然后一步一步告诉我还剩什么：
   - 在 Chrome 里装 cctether 插件：https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib ；
   - 在我自己开的终端里（不要通过你）运行 `cctether pair`，把它显示的连接码粘贴到插件的设置页。
   不要让我把连接码贴到这里：里面有密钥。
8. 最后提醒我重开 Claude Code，这样才能看到 cctether 的工具。

连接码和密钥绝不能出现在这个对话里。所以你自己不要运行 `cctether pair` 和 `cctether rotate`，也不要打开、显示或复制 ~/.config/cctether/config.json（设了 $CCTETHER_HOME 的话是那个文件夹里的）。要改地址，就带上新的 --url 再运行一次安装向导。

```

## 要知道的几件事

- **连接码不会进到对话里。** 安装向导只在真正的终端里显示连接码，Claude 运行的命令不在终端里；在 Claude Code 运行的命令里，`cctether pair` 也不会显示连接码。提示词里还交代了 Claude 不要打开存密钥的设置文件。请在你自己开的终端里运行 `cctether pair`（不要在 Claude Code 里用 `!` 运行），把连接码直接粘贴到插件里。
- **「以后自己就用 cctether」（`--claude-md`）** 会在 `~/.claude/CLAUDE.md` 里加一小段带标记的说明。这个文件是 Claude Code 每次开会话都会读的个人说明，这段话告诉 Claude：任务需要浏览器时就用 cctether。想撤销，删掉从 `<!-- cctether:start` 到 `<!-- cctether:end -->` 的几行就行。不加这段说明的话，你让 Claude 用 cctether 时它照样会用。
- **已经开着的会话**看不到新装的工具，装好以后重开一次 Claude Code。
