# 把浏览器连到服务

[English](connect.md) | 简体中文

插件会主动连到跑 Claude Code 那台电脑上的 cctether 服务。这一页讲每一种连法，按你的情况挑一种。`npx cctether@latest setup` 会问你选哪一种，并给出对应的地址。

| 序号 | 情况 | `setup` 里选 |
|---|---|---|
| 1 | [同一台电脑](#1-同一台电脑) | 1 |
| 2 | [SSH 隧道](#2-ssh-隧道) | 2 |
| 3 | [HTTPS，自己的域名加 Caddy](#3-https自己的域名加-caddy) | 3 |
| 4 | [Cloudflare 隧道](#4-cloudflare-隧道) | 3 |
| 5 | [其他反向代理（nginx）](#5-其他反向代理nginx) | 3 |
| 6 | [WSL](#6-wsl) | 1 |

几件各种连法都适用的事：

- 服务监听 `127.0.0.1:27182`，只认路径 `/cctether`，其他路径一律 404。
- 插件连别的电脑时只用 `wss://`。明文的 `ws://` 只接受本机：`127.0.0.1`、`localhost` 或 `[::1]`。
- 不管走哪条路，握手之后每条消息都用共享的密钥加密。
- 装插件、粘贴连接码的步骤见 [README](../README.zh-CN.md#安装插件)。
- 最后运行一次 `cctether check`，见[检查连接](#检查连接)。

## 1. 同一台电脑

**适合：**Chrome 和 Claude Code 在同一台电脑上。

**步骤**

1. 运行 `npx cctether@latest setup`。
2. 选 **1**（Chrome 就在这台电脑上）。插件会连到 `ws://127.0.0.1:27182/cctether`。
3. 安装向导会问要不要装后台服务。这种连法用不着：Claude Code 用到 cctether 时会自己启动服务，插件一直在重试，过一会儿就自己连上了。
4. 装插件，粘贴连接码。

**注意**

- 服务是 Claude Code 开会话时顺带启动的。开 Claude Code 之前服务没在运行，插件会显示「连不上服务器」。这是正常的，开了 Claude Code 以后，插件过一会儿就会自己连上。
- macOS 上的用法一样，但没测过。macOS 上不装后台服务，Claude Code 用到时才会启动服务。
- 27182 端口被占用的话，换一个：`npx cctether@latest setup --port 27300`。

## 2. SSH 隧道

**适合：**Claude Code 在一台你用 SSH 登录的远程服务器上，又不想弄域名。

**步骤**

1. 在服务器上运行 `npx cctether@latest setup`，选 **2**（从 Chrome 那台电脑经 SSH 隧道连过来）。
2. 后台服务建议选「装」。不装的话，只有 Claude Code 在用 cctether 的时候服务才在运行，其余时间浏览器连不上。
3. 在 Chrome 所在的电脑上转发端口。二选一。在 `~/.ssh/config` 里，这台服务器那一段下面加一行：

   ```
   Host myserver
       HostName server.example.com
       LocalForward 27182 127.0.0.1:27182
   ```

   或者这样连：

   ```
   ssh -L 27182:127.0.0.1:27182 myserver
   ```

4. 装插件，粘贴连接码。

**注意**

- 只有这条 SSH 连接开着的时候，浏览器才连得上 cctether。把终端关了，插件就会显示「连不上服务器」，直到你重新连上。
- 连接码里的地址是 `ws://127.0.0.1:27182/cctether`。这是本机地址，所以允许用 `ws://`。你的电脑到服务器这一段由 SSH 隧道加密，cctether 自己还会给每条消息再加一层密。
- 连接码里带着端口，所以 `LocalForward` 里本机这一侧的端口要和它一致。最省事的办法是两边用同一个端口（默认 27182）。如果浏览器那台电脑上 27182 被占了，就在运行 setup 时用 `--port` 在服务器上换一个端口，让连接码跟着变。

## 3. HTTPS，自己的域名加 Caddy

**适合：**Claude Code 在服务器上，你有一个域名。浏览器直接经公网连过来，不用 SSH，任何电脑都能用。

**步骤**

1. 给一个名字（比如 `browser.example.com`）加 DNS 记录：A 记录（服务器有 IPv6 的话再加 AAAA 记录），指向服务器的公网地址。
2. 在服务器上放行 **80** 和 **443** 端口（防火墙，还有云服务商的安全组）。Caddy 要用 80 和 443 来拿证书。
3. 装 Caddy 2.6 或更新的版本。这个服务是面向公网的，所以最好用发行版 backports 里或者 [Caddy 官方软件源](https://caddyserver.com/docs/install)里的新版本，别用旧的发行版自带包。
4. 把下面这段写进 `/etc/caddy/Caddyfile`（也在 `deploy/Caddyfile.example` 里），名字换成你自己的：

   ```
   browser.example.com {
   	@tether path /cctether
   	handle @tether {
   		reverse_proxy 127.0.0.1:27182
   	}
   	handle {
   		respond 404
   	}
   	header -Server
   }
   ```

   只有 `/cctether` 会被转发，其他路径都回 404。
5. 重新加载 Caddy：`sudo systemctl reload caddy`。它会自己拿 Let's Encrypt 证书并自动续期。
6. 在服务器上运行 `npx cctether@latest setup`，选 **3**，输入 `wss://browser.example.com/cctether`。后台服务选「装」。
7. 运行 `cctether check`，应该会说这个地址能连到这台电脑上的 cctether。
8. 装插件，粘贴连接码。

**注意**

- 如果域名的 DNS 在 Cloudflare，配 Caddy 时要把记录设成**仅 DNS**（灰色云朵）。橙色云朵意味着流量先经过 Cloudflare。想这样用的话，请看 [Cloudflare 隧道](#4-cloudflare-隧道)。
- 地址里写了别的路径的话，代理要把它改写成 `/cctether`。安装向导会提醒你。
- 浏览器那台电脑上开着代理软件的话，给这个域名加一条直连规则。

## 4. Cloudflare 隧道

**适合：**你用 Cloudflare，又不想在服务器上开任何端口。

**步骤**

1. 照 Cloudflare 的说明，用 `cloudflared` 建一条隧道，并给 `browser.example.com` 加上指向它的 DNS 路由。
2. 在隧道的配置文件（`config.yml`）里给 cctether 加一条入口规则。最后一条必须是兜底规则：

   ```yaml
   ingress:
     - hostname: browser.example.com
       path: ^/cctether$
       service: http://127.0.0.1:27182
     - service: http_status:404
   ```

   隧道默认就支持 WebSocket。
3. 重启 `cloudflared`。
4. 在服务器上运行 `npx cctether@latest setup`，选 **3**，输入 `wss://browser.example.com/cctether`。后台服务选「装」。
5. 运行 `cctether check`，然后装插件，粘贴连接码。

**注意**

- Cloudflare 会在它那一头解开 HTTPS，所以原则上它能看到流量。但这对 cctether 没影响：每条消息都用共享的密钥做了端到端加密。Cloudflare 或者别的能解开 HTTPS 的代理，既看不到指令内容，也塞不进自己的指令。
- 服务看到的 Cloudflare 连接都来自 `127.0.0.1`。因为对外地址是别的主机上的 `wss://`，cctether 会信任本机代理给的 `X-Forwarded-For` 来做限流。见[其他反向代理](#5-其他反向代理nginx)。

## 5. 其他反向代理（nginx）

**适合：**你已经在用 nginx、Traefik、HAProxy 之类的反向代理。

代理要做到：

- 把路径 `/cctether` 转给 `http://127.0.0.1:27182`。服务只认这一个路径。
- 允许 WebSocket 升级。
- 用有效的证书提供 HTTPS，因为插件要的是 `wss://`。

nginx 的例子（放在你的 `server { listen 443 ssl; ... }` 里面）：

```nginx
location = /cctether {
    proxy_pass http://127.0.0.1:27182;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 120s;
}

location / {
    return 404;
}
```

然后运行 `npx cctether@latest setup`，选 **3**，输入 `wss://你的域名/cctether`，再运行 `cctether check`。

**关于 `X-Forwarded-For`**

服务会按来源地址给登录失败限流（1 分钟内失败 5 次，就被拒 5 分钟）。经过代理时，所有连接看起来都来自 `127.0.0.1`，所以服务要从代理设置的 `X-Forwarded-For` 里取最后一个地址当真实来源。但只有「信任本机反向代理」（`trustProxy`）打开时才这么做，因为本机上的任何程序都能伪造这个头。默认的规则是：保存的地址是别的主机上的 `wss://` 地址时打开，否则关闭。想强制指定，在 `config.json`（在 `~/.config/cctether`，或者 `$CCTETHER_HOME` 里）写 `"trustProxy": true` 或 `false`，然后重启服务。

## 6. WSL

**适合：**Chrome 在 Windows 上，Claude Code 在 WSL 2 里。

**状态：**还没测过，应该能用。欢迎反馈：[提 issue](https://github.com/guchaorui/cctether/issues)。

**步骤**

1. 在 WSL 里（要有 Node.js 22 或更新的版本）运行 `npx cctether@latest setup`，选 **1**。cctether 不能直接在 Windows 上运行，一律在 WSL 里运行。
2. 在 Windows 的 Chrome 里装插件，粘贴连接码。Chrome 会连到 `ws://127.0.0.1:27182/cctether`，经 WSL 的 localhost 转发到达 WSL。这个转发默认是开着的。
3. 连不上的话，试试镜像网络模式。在 Windows 上的 `%UserProfile%\.wslconfig` 里加：

   ```
   [wsl2]
   networkingMode=mirrored
   ```

   然后运行 `wsl --shutdown`，再重新打开 WSL。

**注意**

- 如果你的 WSL 开了 systemd（`/etc/wsl.conf` 的 `[boot]` 下写了 `systemd=true`），安装向导可以装后台服务。没开的话，服务在 Claude Code 用到 cctether 时启动，WSL 关机时停止。
- 只有 WSL 在运行的时候，插件才连得上。

## 检查连接

在服务运行的那台电脑上运行：

```
cctether check
```

它像插件一样去连连接码里的地址：先看服务有没有在运行，再看这个地址能不能连到这台电脑上的 cctether。它不会顶掉已经连着的浏览器，也不算一次登录失败。

失败的话，它会说明原因：

| 提示 | 意思 |
|---|---|
| 找不到这个地址 | DNS 的问题。域名没有记录，或者还没生效。 |
| 没有程序在接受连接 | 那个地址和端口上没有程序在听。如果是 `127.0.0.1`，说明服务没在运行，运行 `cctether daemon` 看看原因。 |
| 没有回应 | 可能是防火墙挡了端口，或者地址指到了别的电脑。 |
| HTTPS 证书无效 | 浏览器也会拒绝。检查证书和域名。 |
| 网站服务器回的是「HTTP 404」之类 | 代理有回应，但没有把 `/cctether` 转给 `127.0.0.1:27182`，或者没允许 WebSocket。 |
| HTTP 502 | 代理没问题，但连不到 `127.0.0.1:27182` 上的 cctether。服务在运行吗？端口对吗？ |
| 连到了一个 cctether，但不是这台电脑上的 | 那个的密钥不一样，域名指向了别处。 |
| 有程序回应了，但不是 cctether | 地址错了，或者那个路径上是别的程序。 |
| 服务拒绝了插件 ID | 这个 ID 不在 `config.json` 的 `extensionIds` 里。 |
| 失败次数太多 | 等 5 分钟再试。 |
| 那边的 cctether 比这里的旧或新 | 更新旧的那一边（见 README 的「更新」）。 |

这个检查是从服务器自己去连的。少数云服务器连不上自己的公网地址，那种情况下检查会失败，插件却能正常连上。如果检查失败但弹窗显示「已连接」，就没问题。

反向代理还没配好时就运行 `cctether setup`，检查失败是正常的。配好代理以后，再运行一次 `cctether check`。
