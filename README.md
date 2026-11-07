# cctether

English | [简体中文](README.zh-CN.md)

cctether lets Claude Code (or any MCP client) read and drive your own Chrome browser. A Chrome extension connects out to a small server that runs on the computer where Claude Code runs. The server gives Claude browser tools over MCP: read pages, take screenshots, click, type, and look at the console and network requests. Everything goes over your own connection. There is no Anthropic or third-party relay in between.

## Why it exists

The official "Claude in Chrome" integration goes through Anthropic's relay (`bridge.claudeusercontent.com`). That doesn't work if you:

- log in to Claude Code with an API key or `claude setup-token`;
- use Claude through Amazon Bedrock, Google Cloud or Microsoft Foundry;
- run Claude Code in WSL;
- are on a network that can't reach the relay;
- run Claude Code on a remote server while the browser is on your own computer.

cctether works in all of these, because the browser connects to a service that you run yourself.

## How it works

```
 Browser                       Computer that runs Claude Code
+--------------------+        +--------------------------+        +-------------+
| cctether extension | -----> | cctether service         | <----> | Claude Code |
+--------------------+  wss   +--------------------------+  MCP   +-------------+
                  (or ws to 127.0.0.1)
```

- The extension connects out to the service, so the browser computer needs no open port.
- The extension only connects to another computer over `wss://` (HTTPS, through a reverse proxy or a tunnel service). Plain `ws://` is only allowed to this same computer (`127.0.0.1`), which also covers an SSH tunnel.
- After a handshake that proves both sides hold the same key, every message is encrypted.

## Quick start

You need Node.js 22 or newer on the computer that runs Claude Code.

1. On that computer, open a terminal and run:

   ```
   npx cctether@latest setup
   ```

   It asks a few questions and then:

   - installs cctether for your user (`npm install -g cctether`);
   - makes a key;
   - asks how your browser will reach this computer (see [Ways to connect](#ways-to-connect));
   - optionally installs a background service (systemd user service on Linux);
   - adds cctether to Claude Code (`claude mcp add -s user ...`);
   - checks that the address works;
   - prints a connection code that starts with `cctether1:`.

2. [Install the extension](#install-the-extension) in Chrome.
3. Open the extension's settings and paste the connection code.
4. Restart Claude Code if it was open, and ask it to use the browser.

Treat the connection code like a password. It contains the key.

## Install the extension

cctether is not on the Chrome Web Store yet, so you load it by hand. It takes a minute.

1. Download `cctether-extension-<version>.zip` from the [GitHub Releases page](https://github.com/guchaorui/cctether/releases).
2. Unzip it. You get a folder called `cctether-extension`.
3. Put that folder somewhere permanent, such as your Documents folder. Chrome reads the extension from there every time it starts, so don't delete or move it.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode** (top right).
6. Click **Load unpacked** and pick the `cctether-extension` folder. A cctether card appears, and the extension's settings page opens. Leave it open.
7. Click the puzzle-piece icon in Chrome's toolbar, then the pin next to cctether, so the button stays visible. A plain grey icon means you haven't paired yet.
8. On the settings page, paste the connection code from `cctether setup` (or from `cctether pair`) into the box under "Pair with your server" and click **Pair**.
9. The page shows "Connected" and the toolbar icon turns teal. Done.

Notes:

- Edge and other Chromium browsers probably work, but they aren't tested. Firefox and Safari are not supported.
- If a proxy app (Clash and similar) runs on the browser computer, add a direct rule for your server's domain. Otherwise a proxy problem also cuts cctether.

## Ways to connect

| Setup | Address the extension uses | `setup` choice |
|---|---|---|
| Chrome and Claude Code on the same computer | `ws://127.0.0.1:27182/cctether` | 1 |
| Claude Code on a server, through an SSH tunnel | `ws://127.0.0.1:27182/cctether` (the tunnel carries it) | 2 |
| Claude Code on a server, over HTTPS with your own domain (Caddy, Cloudflare Tunnel, nginx, ...) | `wss://browser.example.com/cctether` | 3 |
| Chrome on Windows, Claude Code in WSL | `ws://127.0.0.1:27182/cctether` | 1 |

Step-by-step instructions for each are in [docs/connect.md](docs/connect.md).

## Daily use

- Claude can only use tabs in the **cctether** tab group. Tabs that Claude opens join the group by themselves.
- To let Claude see a page you already have open, click the cctether button in the toolbar and click **Share**. Or drag the tab into the cctether group.
- To take a tab back, click **Stop sharing**, or drag it out of the group.
- While Claude works on a page, Chrome shows a bar: "“cctether” started debugging this browser". That is normal. Chrome requires it and it can't be hidden. If you click **Cancel** on that bar, cctether pauses.
- You can **Pause** at any time from the toolbar button. While paused, Claude can't touch any page. Click **Resume** to continue.
- The popup lists recent activity: what Claude clicked, typed, read or captured.

### The toolbar icon

| Icon | Meaning | What to do |
|---|---|---|
| Teal | Connected | Nothing |
| Grey with a blue dot | Connecting | Wait a few seconds |
| Grey with a red dot | Can't connect | Click the icon to see why. It keeps retrying by itself. Usual causes: the server isn't running, or a network or proxy problem |
| Grey with an orange dot | Another browser took over | The service works with one browser at a time. Click **Reconnect here** to use this one |
| Pause symbol | Paused | Click the icon, then **Resume** |
| Plain grey | Not paired yet | Paste a connection code in Settings |

## Commands

Run `cctether help` for the full text.

| Command | What it does |
|---|---|
| `cctether setup` | Sets everything up, step by step. Start here. Safe to run again. |
| `cctether init [--port N] [--url URL]` | Creates the key and settings. Done automatically on first use. |
| `cctether pair [--url URL]` | Shows the connection code to paste into the extension. |
| `cctether check` | Tests that the extension's address reaches this computer's service. |
| `cctether status [--json]` | Is the service running? Is a browser connected? |
| `cctether rotate` | Makes a new key. The old connection code stops working at once. |
| `cctether daemon` | Runs the service in the foreground (the systemd service uses this). |
| `cctether stop` | Stops the running service. |
| `cctether mcp` | MCP server on stdin/stdout. Claude Code runs this. |
| `cctether version` | Prints the version. |

Options: `--url URL` is the address the extension should connect to (saved for next time), `--port N` is the local port (default 27182). For scripts, `setup` also takes `--yes`, `--mode local|ssh|https`, `--no-install`, `--no-service`, `--no-mcp` and `--lang en|zh`.

Settings live in `$CCTETHER_HOME`, else `$XDG_CONFIG_HOME/cctether`, else `~/.config/cctether`.

## Tools

Claude gets these 20 tools:

| Tool | What it does |
|---|---|
| `list_tabs` | Lists the tabs in the cctether group, plus browser info. |
| `open_tab` | Opens a new tab in the group and makes it the current tab. |
| `close_tab` | Closes a tab in the group. |
| `navigate` | Loads a URL, or goes back, forward or reloads. Waits for the page to load. |
| `read_page` | Reads the page: visible text, a numbered list of interactive elements, or the HTML of a selector. Long output is split. |
| `find` | Finds elements by CSS selector. |
| `screenshot` | Screenshots the visible area, the full page, or one element. |
| `click` | Clicks an element or a point with real mouse events. |
| `type` | Types text into an element or the focused element. |
| `press_key` | Presses a key or combination, such as `Enter` or `Control+A`. |
| `scroll` | Scrolls the page, or scrolls an element into view. |
| `hover` | Moves the mouse over an element or a point. |
| `select_option` | Chooses options in a `<select>`. |
| `wait_for` | Waits until text or an element appears (or disappears). |
| `evaluate` | Runs JavaScript in the page and returns the result as JSON. |
| `console_messages` | Reads console messages and uncaught errors. |
| `network_requests` | Lists network requests, or shows headers and body of one. |
| `handle_dialog` | Accepts or dismisses an alert, confirm or prompt. |
| `list_extensions` | Lists installed browser extensions. |
| `reload_extension` | Reloads an extension (useful when developing one). |

## Permissions

The extension asks for these Chrome permissions, and nothing else:

| Permission | Why |
|---|---|
| `debugger` | All page work: real mouse and keyboard input, screenshots, console, network, JavaScript dialogs, running scripts in the page. This is also why Chrome shows its debugging bar. |
| `tabs` | Read tab titles and addresses; open and close tabs. |
| `tabGroups` | Create the cctether tab group and tell which tabs are in it. |
| `storage` | Keep the connection code, your settings and the recent-activity list. |
| `alarms` | Check the connection on a timer and reconnect by itself. |
| `management` | List and reload extensions (`list_extensions`, `reload_extension`). |

It does not ask for website access ("Read and change your data on all websites"). Page work goes through the debugger, and the code that reads pages ships inside the extension.

## Security and privacy

- Both sides prove they hold the same 256-bit key (a challenge-response handshake). The extension accepts no commands until the server has proved it has the key.
- After the handshake, every message is encrypted with AES-256-GCM. A proxy that can read HTTPS traffic still can't read or inject commands.
- To another computer, the extension only connects over `wss://`. Plain `ws://` is only allowed to this computer.
- Claude can only use tabs in the cctether tab group. You can pause at any time.
- The service accepts only this extension, rate-limits failed attempts, and serves only the path `/cctether`.
- No analytics, no telemetry. Nothing is sent anywhere except to your own service.
- The connection code is a secret. If it leaks, run `cctether rotate` on the server, then pair again.

Web pages can contain hidden instructions meant for an AI (prompt injection), and Claude acts in your logged-in browser. Keep sensitive tabs (banking, email, admin panels) out of the cctether group, and look at what Claude is doing in the popup.

More: [SECURITY.md](SECURITY.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Updating

The service and the extension use the same version number. Update both.

1. On the Claude Code computer: `npm install -g cctether@latest`.
2. Restart the service. With the background service: `systemctl --user restart cctether`. Without it: `cctether stop`. It starts again by itself when Claude Code needs it.
3. Extension: download the new zip, replace the contents of your `cctether-extension` folder with the new files, then click the reload button on the cctether card at `chrome://extensions`.

Your pairing is kept. If the two versions can't talk to each other, the popup tells you which side to update.

## Troubleshooting

- On the Claude Code computer, run `cctether check`. It connects to the address in your connection code the way the extension does, and says in plain words what's wrong. Run `cctether status` to see whether the service runs and a browser is connected.
- "Can't reach the server": the service isn't running, or the network blocks it. Check `cctether status`. A proxy app on the browser computer may need a direct rule for your domain.
- "This server couldn't prove it's yours", or "The server no longer accepts this browser": the key changed (for example after `cctether rotate`). Run `cctether pair` and pair again with the new code.
- "Another browser took over": the service works with one browser at a time. Click **Reconnect here** to switch back.
- "Please update the extension" or "Please update cctether on your server": see [Updating](#updating).
- More about each connection setup: [docs/connect.md](docs/connect.md).

## Known limitations

- Elements, console messages and network requests inside cross-origin iframes aren't available.
- CSS selectors don't reach into shadow DOM. The interactive list from `read_page` does see inside.
- `reload_extension` applies code changes, but not `manifest.json` changes. For those, click reload on `chrome://extensions` yourself.
- Very long full-page screenshots are scaled down (to stay under the image size limit), so they come out narrow.
- One browser per service at a time.
- The service doesn't run on Windows directly. Use WSL.

### Not tested yet

- macOS as the computer that runs Claude Code.
- WSL (Chrome on Windows, Claude Code in WSL).

Both should work, but nobody has tried them yet. Feedback is welcome: [open an issue](https://github.com/guchaorui/cctether/issues).

## Uninstall

1. `claude mcp remove -s user cctether`
2. If you installed the background service: `systemctl --user disable --now cctether`, then delete `~/.config/systemd/user/cctether.service`.
3. `npm uninstall -g cctether`
4. Delete the config folder: `~/.config/cctether` (or `$CCTETHER_HOME` if you set it).
5. In Chrome, remove the extension on `chrome://extensions`, and delete the `cctether-extension` folder.

## Development

```
extension/   the browser extension (MV3, no dependencies, no build step)
server/      the npm package "cctether": CLI, service, MCP
test/e2e/    end-to-end tests: headless Chrome for Testing + extension + service
docs/        design (SPEC), connection guides
deploy/      example Caddyfile and systemd unit
scripts/     icons, screenshots, extension packaging
```

- Server unit tests: `cd server && npm test`
- End-to-end tests: `node --test test/e2e/*.test.mjs` (needs Chrome for Testing, or set `CHROME_PATH`)
- Build the extension zip: `node scripts/pack-extension.mjs` (reproducible: the same source gives the same zip, so you can check a release yourself)

## License

[MIT](LICENSE)
