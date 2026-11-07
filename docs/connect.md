# Connecting the browser to the server

English | [简体中文](connect.zh-CN.md)

The extension connects out to the cctether service on the computer that runs Claude Code. This page explains each way to make that connection. Pick the one that matches your setup. `npx cctether@latest setup` asks which one you want and prints the right address.

| # | Setup | `setup` choice |
|---|---|---|
| 1 | [Same computer](#1-same-computer) | 1 |
| 2 | [SSH tunnel](#2-ssh-tunnel) | 2 |
| 3 | [HTTPS with your own domain and Caddy](#3-https-with-your-own-domain-and-caddy) | 3 |
| 4 | [Cloudflare Tunnel](#4-cloudflare-tunnel) | 3 |
| 5 | [Other reverse proxies (nginx)](#5-other-reverse-proxies-nginx) | 3 |
| 6 | [WSL](#6-wsl) | 1 |

Some facts that apply everywhere:

- The service listens on `127.0.0.1:27182`, and only answers at the path `/cctether`. Every other path gets 404.
- The extension connects to another computer only over `wss://`. Plain `ws://` is only accepted for this computer: `127.0.0.1`, `localhost` or `[::1]`.
- Whatever the route, every message is encrypted with the shared key once the handshake is done.
- Install the extension and paste the connection code as described in the [README](../README.md#install-the-extension).
- Run `cctether check` at the end. See [Checking the connection](#checking-the-connection).

## 1. Same computer

**When to use it:** Chrome and Claude Code run on the same computer.

**Steps**

1. Run `npx cctether@latest setup`.
2. Choose **1** ("Chrome runs on this computer"). The extension will connect to `ws://127.0.0.1:27182/cctether`.
3. Setup asks whether to install a background service. You don't need one: Claude Code starts the service by itself when a session starts. The extension keeps retrying, so it connects a moment later.
4. Install the extension and paste the connection code.

**Caveats**

- Claude Code starts the service when a session starts. Before that, nothing is running and the extension shows "Can't reach the server". That is normal: it connects by itself shortly after you start Claude Code.
- macOS works the same way but has not been tested. No background service is installed on macOS; the service starts when Claude Code needs it.
- If port 27182 is taken, pass another one: `npx cctether@latest setup --port 27300`.

## 2. SSH tunnel

**When to use it:** Claude Code runs on a remote server that you reach over SSH, and you don't want to set up a domain.

**Steps**

1. On the server, run `npx cctether@latest setup` and choose **2** ("Through an SSH tunnel").
2. Say yes to the background service. It is recommended here. Without it, the service only runs while a Claude Code session is using it, and the browser can't connect the rest of the time.
3. On the computer where Chrome runs, forward the port. Either add this line under the server's entry in `~/.ssh/config`:

   ```
   Host myserver
       HostName server.example.com
       LocalForward 27182 127.0.0.1:27182
   ```

   or connect with:

   ```
   ssh -L 27182:127.0.0.1:27182 myserver
   ```

4. Install the extension and paste the connection code.

**Caveats**

- The browser only reaches cctether while that SSH connection is open. If you close the terminal, the extension shows "Can't reach the server" until you connect again.
- The connection code points at `ws://127.0.0.1:27182/cctether`. That is allowed because it is a local address. The tunnel provides the encryption between your computer and the server, and cctether encrypts every message on top.
- The connection code contains the port, so the local port in `LocalForward` has to match it. The simplest way is to use the same port on both sides (27182 by default). If 27182 is busy on the browser computer, pick another port on the server with `--port` at setup time, so that the code matches.

## 3. HTTPS with your own domain and Caddy

**When to use it:** Claude Code runs on a server, and you have a domain. The browser connects straight over the internet. No SSH needed, and it works from any computer.

**Steps**

1. Make a DNS record for a name such as `browser.example.com`: an A record (and an AAAA record if the server has IPv6) pointing to the server's public address.
2. Open ports **80** and **443** on the server (firewall, and your cloud provider's security group). Caddy uses 80 and 443 to get its certificate.
3. Install Caddy 2.6 or newer. This faces the internet, so prefer a current version from your distribution's backports or from [Caddy's own package repository](https://caddyserver.com/docs/install) over an old distro package.
4. Put this in `/etc/caddy/Caddyfile` (it is also in `deploy/Caddyfile.example`), with your own name:

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

   Only `/cctether` is forwarded. Everything else gets 404.
5. Reload Caddy: `sudo systemctl reload caddy`. It gets a Let's Encrypt certificate by itself and renews it.
6. On the server, run `npx cctether@latest setup`, choose **3**, and enter `wss://browser.example.com/cctether`. Say yes to the background service.
7. Run `cctether check`. It should say that the address reaches this computer's cctether.
8. Install the extension and paste the connection code.

**Caveats**

- If your DNS is on Cloudflare, set the record to **DNS only** (grey cloud) when you use Caddy. With the orange cloud, Cloudflare sits in front instead. To use that on purpose, see [Cloudflare Tunnel](#4-cloudflare-tunnel).
- If you put a different path in the address, your proxy has to rewrite it to `/cctether`. Setup warns you about this.
- If a proxy app runs on the browser computer, add a direct rule for the domain.

## 4. Cloudflare Tunnel

**When to use it:** you use Cloudflare and don't want to open any ports on the server.

**Steps**

1. Create a tunnel with `cloudflared` and a DNS route for `browser.example.com`, following Cloudflare's instructions.
2. In the tunnel's configuration (`config.yml`), add an ingress rule for cctether. The last rule must be the catch-all:

   ```yaml
   ingress:
     - hostname: browser.example.com
       path: ^/cctether$
       service: http://127.0.0.1:27182
     - service: http_status:404
   ```

   WebSockets work through tunnels by default.
3. Restart `cloudflared`.
4. On the server, run `npx cctether@latest setup`, choose **3**, and enter `wss://browser.example.com/cctether`. Say yes to the background service.
5. Run `cctether check`, then install the extension and paste the connection code.

**Caveats**

- Cloudflare ends the HTTPS connection on its side, so in principle it can see the traffic. That doesn't matter for cctether: every message is encrypted end to end with the shared key. Cloudflare, or any other proxy that can read HTTPS, can neither read the commands nor inject its own.
- The service sees Cloudflare's connections coming from `127.0.0.1`. Because the address starts with `wss://` on another host, cctether trusts the `X-Forwarded-For` header from the local proxy for rate limiting. See [Other reverse proxies](#5-other-reverse-proxies-nginx).

## 5. Other reverse proxies (nginx)

**When to use it:** you already run nginx, Traefik, HAProxy or similar.

What the proxy has to do:

- Forward the path `/cctether` to `http://127.0.0.1:27182`. The service only answers at that exact path.
- Allow the WebSocket upgrade.
- Terminate HTTPS with a valid certificate, since the extension needs `wss://`.

An nginx example (inside your `server { listen 443 ssl; ... }` block):

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

Then run `npx cctether@latest setup`, choose **3**, and enter `wss://your-domain/cctether`. Run `cctether check`.

**About `X-Forwarded-For`**

The service limits failed login attempts per source address (5 failures in a minute means 5 minutes locked out). Behind a proxy, every connection comes from `127.0.0.1`, so the service has to read the real address from the last `X-Forwarded-For` value that the proxy sets. It only does that when "trustProxy" is on, because any program on the same computer could fake the header. By default it is on when the saved address is a `wss://` address on another host, and off otherwise. To force it, set `"trustProxy": true` or `false` in `config.json` (in `~/.config/cctether`, or `$CCTETHER_HOME`), then restart the service.

## 6. WSL

**When to use it:** Chrome runs on Windows, and Claude Code runs inside WSL 2.

**Status:** not tested yet. It should work. Feedback is welcome: [open an issue](https://github.com/guchaorui/cctether/issues).

**Steps**

1. Inside WSL (needs Node.js 22 or newer), run `npx cctether@latest setup` and choose **1**. cctether doesn't run on Windows itself; always run it inside WSL.
2. Install the extension in Windows Chrome and paste the connection code. Chrome connects to `ws://127.0.0.1:27182/cctether`. That reaches WSL through WSL's localhost forwarding, which is on by default.
3. If it doesn't connect, try mirrored networking mode. In `%UserProfile%\.wslconfig` on Windows add:

   ```
   [wsl2]
   networkingMode=mirrored
   ```

   Then run `wsl --shutdown` and open WSL again.

**Caveats**

- If systemd is enabled in your WSL (`systemd=true` under `[boot]` in `/etc/wsl.conf`), setup can install the background service. Otherwise the service starts when Claude Code uses cctether, and stops when WSL shuts down.
- The extension can only connect while WSL is running.

## Checking the connection

Run this on the computer where the service runs:

```
cctether check
```

It connects to the address in your connection code the way the extension does. It checks that the service is running, then that the address reaches this computer's cctether. It never replaces a browser that is connected, and it doesn't count as a failed login.

If it fails, the message says why:

| Message | What it means |
|---|---|
| Can't find the address | DNS problem. The domain has no record, or it hasn't spread yet. |
| Nothing is accepting connections | Nothing listens at that host and port. For `127.0.0.1`, the service isn't running. Try `cctether daemon` to see why. |
| No answer | A firewall may block the port, or the address points to the wrong computer. |
| The HTTPS certificate isn't valid | Browsers will refuse it too. Check the certificate and the domain name. |
| The web server answered "HTTP 404" or other | The proxy answered but doesn't forward `/cctether` to `127.0.0.1:27182`, or doesn't allow WebSockets. |
| HTTP 502 | The proxy is fine, but can't reach cctether on `127.0.0.1:27182`. Is the service running, and is the port right? |
| It reaches a cctether, but not this one | That one has a different key. The domain points somewhere else. |
| Something answered, but it isn't cctether | Wrong address, or another program is on that path. |
| The service refused the extension ID | The ID isn't in `extensionIds` in `config.json`. |
| Too many failed attempts | Wait 5 minutes and try again. |
| The cctether there is older / newer | Update the older side (see the README's "Updating"). |

The check runs from the server itself. A few cloud servers can't reach their own public address, so the check can fail there even though the extension connects fine. If the check fails but the popup says "Connected", all is well.

When you run `cctether setup` before your reverse proxy is ready, a failed check is expected. Finish the proxy, then run `cctether check` again.
