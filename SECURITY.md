# Security

cctether gives a program on one computer (Claude Code, through the cctether service) control over tabs in your real browser, where you are signed in to your accounts. That is a lot of power, so security is the core of the design. This page says what cctether defends against, what it doesn't, and how to report a problem.

## Reporting a vulnerability

Please report security problems privately, through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for them.

Include what you found, how to reproduce it, and which versions you tried (`cctether version`, and the extension version at the bottom of its settings page). cctether is a small project maintained in spare time; reports are answered as soon as possible, and fixes for real vulnerabilities go out before anything else.

Only the latest release gets security fixes.

## What cctether protects against

**Someone on the internet finding your service.** If you expose the service (for example through a reverse proxy), anyone can try to connect. Without the 256-bit key from your connection code they can't complete the handshake, and nothing they send is acted on. Failed handshakes are rate-limited per address (5 per minute, then a 5-minute block), handshakes must finish within 5 seconds, at most 16 can be pending, and frames are capped at 1 MiB.

**Someone between the browser and the service.** This includes a proxy that decrypts HTTPS with its own root certificate, or a service like Cloudflare that terminates TLS for you. Both sides prove they hold the key with a challenge–response bound to fresh random values from each side, and the service proves itself first: the extension acts on nothing until it does. After that, every message is encrypted and authenticated with AES-256-GCM using per-connection keys, with a counter that catches lost, replayed or reordered messages. An attacker in the middle can't read the traffic, can't inject commands, and can't replay an old session. The extension refuses unencrypted `ws://` addresses on other computers. See [docs/PROTOCOL.md](docs/PROTOCOL.md).

**Other users on the computer running the service.** The service's network entrance listens on `127.0.0.1` only and needs the key like any other client. The control entrance that MCP clients use is a Unix socket, readable only by you, in a configuration folder only you can open (mode 700). The key lives in `config.json` with mode 600. The two entrances are separate, so exposing the browser entrance by mistake never exposes control.

**Web pages.** A page in your browser can try to open a WebSocket to `127.0.0.1`. The service only accepts connections whose `Origin` is the cctether extension, and a page can't read the extension's key. The code cctether runs inside pages to read them and find elements runs in a separate, isolated environment that the page's own scripts can't reach.

**Your other tabs.** Claude can only use tabs in the browser's **cctether** tab group. Membership is checked on every call. Tabs Claude opens join the group; you decide which of your own tabs to add, and you can drag any tab out at any time.

**A leaked connection code.** `cctether rotate` makes a new key; the old code stops working at once and the connected browser is dropped. Pair again with the new code.

You stay in control: the toolbar icon shows the connection state, the popup lists recent actions, **Pause** stops every tool immediately, and Chrome shows its "started debugging this browser" bar whenever cctether is attached to a tab (clicking **Cancel** on it pauses cctether).

## What it doesn't protect against

- **Prompt injection.** A web page can contain text written to manipulate an AI. Cryptography can't help with that: Claude acts with your sign-ins in the tabs you share. cctether limits the reach (only the tab group), tells Claude that page content is untrusted and to ask you before actions with real-world effects, and lets you watch and pause. Keep tabs with sensitive accounts (banking, email, admin consoles) out of the group unless you are watching.
- **Anyone who can run programs as you on the service's computer.** They can read the key and use the control socket. That's the same trust you already give Claude Code there.
- **Anyone who controls your browser or computer**, including other extensions with the `debugger` permission.
- **The tools doing what they are designed to do.** Inside a shared tab, cctether can read everything on the page, run JavaScript in it (`evaluate`), see its network requests and their bodies, click and type. Only share tabs you are comfortable handing over.
- **Denial of service.** Someone who can reach your service can't take it over, but can keep it busy, for example by occupying the handshake slots. If you expose it to the internet, a reverse proxy with its own limits helps.

## Hardening in the code

- The extension has no dependencies and isn't bundled or minified, so you can read exactly what runs. It asks for no separate website (host) permissions and has no content scripts; it works through Chrome's debugger API. That permission is powerful, and Chrome's install dialog says so ("Read and change all your data on all websites"). Keeping to the tab group is enforced by the extension's own code, which checks it on every call ([extension/background/tabs.js](extension/background/tabs.js)).
- The extension runs only tools from its fixed list, checks every argument, and never runs code it receives inside the extension itself: `evaluate` code goes to the web page.
- The service has one dependency, [`ws`](https://github.com/websockets/ws), pinned to an exact version. Its MCP layer is written by hand instead of pulling in an SDK.
- Keys, proofs and connection codes are never written to logs, error messages or `cctether status`.
- The extension zip is reproducible: `node scripts/pack-extension.mjs` on the same commit produces the same bytes, so you can compare it with a release. The Chrome Web Store version is the `-store` zip of the same release (`--flat`), which has no `key` in its manifest; the store adds its update address and signature. The GitHub Actions used to build releases are pinned to exact commits.
- Since 0.3.3 the npm package is published by those GitHub Actions through npm trusted publishing: no long-lived token exists, and each version carries a provenance statement naming the commit and the run that built it. `npm audit signatures` verifies it.

## Reviews

Before the first deployment the code was reviewed for security, and the attacks above were tried for real: wrong keys, replayed handshakes, forged `Origin`, a web page connecting to the local port, reaching tabs outside the group, oversized messages and slow handshakes. No critical or high-severity problems were found. One low-severity issue was fixed: the rate limiter trusted `X-Forwarded-For` from any local program, which could be used to dodge it or to get someone else's address blocked; now that header is only used when `trustProxy` is on. The attack tests live on as regression tests in `server/test/security.test.js` and `test/e2e/security.test.mjs`.
