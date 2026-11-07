# 交接

> 2026-11-07 更新。新对话读 `CLAUDE.md`、`CLAUDE.local.md`、`docs/SPEC.md` 和本文第零节，就能接上。

## 零、现在到哪了（先看这里）

- **第一阶段做完了，已部署在主人的服务器上，正在等主人在 Mac 上试用确认。** 主人确认之前不开始第二阶段。
- 做完的（SPEC §10.1 第 1–9 步）：
  - §11 的实验全部做完，结论写回了 SPEC。
  - 服务端：插件入口（Origin 检查、双向认证、每条消息加密、限流、只接一个浏览器）、控制入口（Unix socket）、自己写的 MCP、`cctether mcp` 薄壳，以及 init / pair / status / rotate / daemon / stop 命令。
  - 插件：连接层、20 个工具（全走 chrome.debugger）、cctether 标签组范围、弹窗和设置页（中英 × 浅深色）、工具栏状态图标。
  - 测试：服务端 48 个、端到端 45 个（1 个只能在有界面的 Chrome 里跑），全过。命令见 CLAUDE.md。
  - 安全审查（SPEC §6.3）：没有严重或高危问题；唯一的低危发现已修，攻击测试留作回归测试。
  - 部署：Caddy + systemd 用户服务 + 用户作用域 MCP，细节在 `CLAUDE.local.md`。2026-11-07 用真 Chrome 经公网地址实测通过。
  - 给主人的 Mac 安装步骤：`docs/install-mac.zh-CN.md`。
- **主人要做的**（已经在对话里一步一步写给主人了）：在 Mac 的 Chrome 里装插件，在服务器上跑 `cctether pair`，把连接码贴到插件设置页，开着代理的话给域名加直连规则，然后试用。

## 主人试用时要特别留意、开发机上测不了的

- Mac 合盖再打开、切换网络以后，多久能自己连回（SPEC §11 第 1 条）。设计上：每 30 秒检查一次，断了按 1、2、4…最多 30 秒退避重连，网络恢复时立刻重试。
- Mac 上的快捷键（Meta+A/C/V 等）有没有按对。
- 界面在 Mac 上的样子（开发机没有苹方字体，截图里中文标题是常规粗细）和真实工具栏里的图标。

## 接下来（主人确认第一阶段以后）

1. 按主人试用的反馈修。
2. 第二阶段（SPEC §10.2）：`npx cctether setup`、各种连法的文档、README 中英文、SECURITY.md、协议说明、GitHub Actions 打包插件、准备发 npm。
3. 发 npm、上 Chrome 应用商店、公开仓库，都要主人点头（SPEC §10.3）。

## 攒着问主人的

- 第二阶段什么时候开始（等试用确认后再问）。

## 已知的限制（第一阶段先这样，文档里要写）

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
- systemd 用户服务的 PATH 里没有 `~/.local/bin`，服务单元里要写 node 的完整路径。
- 改了服务端代码，要重新打包安装再重启服务，主人在用的才会变（见 `CLAUDE.local.md`）。
