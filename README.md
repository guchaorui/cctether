# cctether

English | [简体中文](README.zh-CN.md)

[Chrome Web Store](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib) · [npm](https://www.npmjs.com/package/cctether) · [Releases](https://github.com/guchaorui/cctether/releases)

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

You need Node.js 22 or newer on the computer that runs Claude Code ([download](https://nodejs.org/en/download)). The `nodejs` package that comes with some Linux distributions is older (Ubuntu 24.04 has 18), and setup stops with a message if Node is too old.

1. On that computer, open a terminal and run:

   ```
   npx cctether@latest setup
   ```

   It asks a few questions and then:

   - installs cctether for your user (`npm install -g cctether`);
   - makes a key;
   - asks how your browser will reach this computer (see [Ways to connect](#ways-to-connect));
   - optionally installs a background service (systemd user service on Linux);
   - adds cctether to Claude Code (`claude mcp add -s user ...`), and if you like, tells Claude to use it by itself for every browser task;
   - checks that the address works;
   - prints a connection code that starts with `cctether1:`.

2. [Install the extension from the Chrome Web Store](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib). [More on this below](#install-the-extension).
3. Open the extension's settings and paste the connection code.
4. Restart Claude Code if it was open, and ask it to use the browser.

Treat the connection code like a password. It contains the key.

Rather have Claude do it? Paste the prompt from [docs/setup-with-claude.md](docs/setup-with-claude.md) into Claude Code. Claude runs setup, and you only paste the connection code into the extension yourself.

## Install the extension

1. Open **[cctether on the Chrome Web Store](https://chromewebstore.google.com/detail/cctether/mbkadoolgknacadjkfjjajldmllbkdib)** and click **Add to Chrome**. Chrome lists what the extension may do, including a strong-sounding warning that comes with its debugger permission: see [Permissions](#permissions). After you confirm, the extension's settings page opens by itself. Leave it open.
2. Click the puzzle-piece icon in Chrome's toolbar, then the pin next to cctether, so the button stays visible. A plain grey icon means you haven't paired yet.
3. On the settings page, paste the connection code from `cctether setup` (or from `cctether pair`) into the box under "Pair with your server" and click **Pair**.
4. The page shows "Connected" and the toolbar icon turns teal. Done.

The store version updates itself.

Notes:

- Edge and other Chromium browsers probably work, but they aren't tested. Firefox and Safari are not supported.
- If a proxy app (Clash and similar) runs on the browser computer, add a direct rule for your server's domain. Otherwise a proxy problem also cuts cctether.

### Or load it yourself

If you can't use the store, or want to run exactly the files from a release:

1. Download `cctether-extension-<version>.zip` from the [GitHub Releases page](https://github.com/guchaorui/cctether/releases) (not the one ending in `-store`).
2. Unzip it. You get a folder called `cctether-extension`.
3. Put that folder somewhere permanent, such as your Documents folder. Chrome reads the extension from there every time it starts, so don't delete or move it.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode** (top right).
6. Click **Load unpacked** and pick the `cctether-extension` folder. A cctether card appears, and the extension's settings page opens.
7. Pin the button and pair, as in steps 2 to 4 above.

Keep only one of the two installed. They don't share their pairing, and two copies in one browser compete for the same connection (one of them shows "Another browser took over"). To switch, remove the old one on `chrome://extensions`, install the new one, and pair again: `cctether pair` shows the same code.

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
- If you answered yes to "use cctether by itself" in setup, Claude reaches for cctether whenever a task needs a browser. Otherwise, ask it to ("use the browser to check…"). The setting is a short marked note in `~/.claude/CLAUDE.md`; delete it to undo.

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
| `cctether check` | Tests that the extension's address reaches this computer's service, and that `upload_file` can use its folder. |
| `cctether status [--json]` | Is the service running? Is a browser connected? |
| `cctether rotate` | Makes a new key. The old connection code stops working at once. |
| `cctether daemon [--takeover]` | Runs the service in the foreground. The systemd service runs it with `--takeover`, so it replaces a copy that Claude Code started. |
| `cctether stop` | Stops the running service. |
| `cctether mcp` | MCP server on stdin/stdout. Claude Code runs this. |
| `cctether version` | Prints the version. |

Options: `--url URL` is the address the extension should connect to (saved for next time), `--port N` is the local port (default 27182). For scripts, `setup` also takes `--yes`, `--mode local|ssh|https`, `--no-install`, `--no-service`, `--no-mcp`, `--claude-md` / `--no-claude-md` and `--lang en|zh`.

Settings live in `$CCTETHER_HOME`, else `$XDG_CONFIG_HOME/cctether`, else `~/.config/cctether`.

## Tools

Claude gets these 25 tools:

| Tool | What it does |
|---|---|
| `list_tabs` | Lists the tabs in the cctether group (and which are muted or playing sound), plus browser info. |
| `open_tab` | Opens a new tab in the group and makes it the current tab, muted if Claude asks. |
| `close_tab` | Closes a tab in the group. |
| `mute_tab` | Mutes a tab in the group, so a page that plays sound doesn't disturb you (Chrome's own tab mute). |
| `navigate` | Loads a URL, or goes back, forward or reloads. Waits for the page to load, and optionally for some text or element to appear. |
| `read_page` | Reads the page, including same-origin iframes: visible text, a numbered list of interactive elements, or the HTML of a selector. Long output is split. |
| `find` | Finds elements by CSS selector and/or visible text, also inside same-origin iframes. |
| `screenshot` | Screenshots the visible area, the full page, one element, or all the content of an element that scrolls. Each screenshot has a number, so points on it can be clicked directly. |
| `resize_viewport` | Resizes a tab's viewport (for example to a phone width) without resizing the browser window. |
| `set_color_scheme` | Makes a tab see a dark or light color scheme (to check dark mode) without changing the browser's own setting. |
| `click` | Clicks an element (by number, selector or visible text) or a point with real mouse events. |
| `type` | Types text into an element or the focused element. |
| `press_key` | Presses a key or combination, such as `Enter` or `Control+A` (`Meta+A` when the browser is on a Mac). |
| `scroll` | Scrolls the page, or scrolls an element into view. |
| `hover` | Moves the mouse over an element or a point. |
| `drag` | Drags with the mouse from an element or point to another: sortable lists, sliders, splitters, HTML drag and drop. |
| `select_option` | Chooses options in a `<select>`, or in a custom dropdown that declares itself (`role=combobox` / `listbox`). |
| `wait_for` | Waits until text or an element appears (or disappears), for up to 10 minutes. |
| `evaluate` | Runs JavaScript in the page and returns the result as JSON (a returned Promise is awaited). A long script can be saved once in cctether's scripts directory and then run by its file name. |
| `upload_file` | Gives files to a file input on the page, or drops them on a drop zone. The files come from cctether's uploads folder on the computer that runs Claude Code (`~/.config/cctether/uploads`): Claude copies a file there first. Up to 20 MiB at a time. |
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

When you install it, Chrome warns that the extension can "Read and change all your data on all websites" and "Access the page debugger backend". Chrome shows this for any extension with the `debugger` permission, because that permission really is that powerful. The limit is in cctether's own code: every tool that works on a page first checks that the tab is in the cctether tab group ([extension/background/tabs.js](extension/background/tabs.js)). The code isn't minified, so you can read it. The extension asks for no separate website (host) permissions and has no content scripts: the code that reads pages ships inside the extension and only runs when a tool is called.

## Security and privacy

- Both sides prove they hold the same 256-bit key (a challenge-response handshake). The extension accepts no commands until the server has proved it has the key.
- After the handshake, every message is encrypted with AES-256-GCM. A proxy that can read HTTPS traffic still can't read or inject commands.
- To another computer, the extension only connects over `wss://`. Plain `ws://` is only allowed to this computer.
- Claude can only use tabs in the cctether tab group. You can pause at any time.
- `upload_file` reads files only from cctether's own uploads folder, not from anywhere else on the computer, and gives them only to the site Claude names for that tab.
- The service accepts only this extension, rate-limits failed attempts, and serves only the path `/cctether`.
- No analytics, no telemetry. Nothing is sent anywhere except to your own service.
- The connection code is a secret. If it leaks, run `cctether rotate` on the server, then pair again.

Web pages can contain hidden instructions meant for an AI (prompt injection), and Claude acts in your logged-in browser. Keep sensitive tabs (banking, email, admin panels) out of the cctether group, and look at what Claude is doing in the popup.

More: [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Updating

**The extension from the Chrome Web Store updates itself.** New versions reach the store after its review, so it can be a little behind the service. That's fine: if the two can't work together, the popup says which side to update.

**The service** you update yourself, on the Claude Code computer:

1. `npm install -g cctether@latest`
2. Restart it. With the background service: `systemctl --user restart cctether`. Without it: `cctether stop`. It starts again by itself when Claude Code needs it.

Claude Code sessions that are already open don't need a restart: cctether tells them which tools are new or changed (from 0.6.2 on; a session started with an older cctether needs a restart to see new tools).

**If you loaded the extension yourself:** download the new zip, replace the contents of your `cctether-extension` folder with the new files, then click the reload button on the cctether card at `chrome://extensions`.

Your pairing is kept either way.

## Troubleshooting

- On the Claude Code computer, run `cctether check`. It connects to the address in your connection code the way the extension does, and says in plain words what's wrong. Run `cctether status` to see whether the service runs and a browser is connected.
- "Can't reach the server": the service isn't running, or the network blocks it. Check `cctether status`. A proxy app on the browser computer may need a direct rule for your domain.
- "This server couldn't prove it's yours", or "The server no longer accepts this browser": the key changed (for example after `cctether rotate`). Run `cctether pair` and pair again with the new code.
- "Another browser took over": the service works with one browser at a time. Click **Reconnect here** to switch back.
- "Please update the extension" or "Please update cctether on your server": see [Updating](#updating).
- More about each connection setup: [docs/connect.md](docs/connect.md).

## Does it cost much?

- **Claude's context:** the 25 tool descriptions take about 6,100 tokens, under 3% of a 200k context. Recent Claude Code versions load MCP tools on demand when there are many of them, so until Claude actually uses the browser, only the tool names (about 150 tokens) and a short note (about 120 tokens) sit in the context.
- **Memory on the Claude Code computer:** the service uses about 75 MB, and each open Claude Code window adds a small relay process of about 55 MB.
- **The browser:** the extension does nothing while Claude isn't using it, apart from a tiny heartbeat every 10 seconds.

## Known limitations

- Iframes from other sites, and sandboxed ones, can't be read or searched; their console messages and network requests aren't available either. Same-origin iframes work like the page itself, except that capturing all of what scrolls inside one in a single screenshot isn't supported yet, and iframes rotated, scaled or zoomed with CSS can be read but not clicked by position.
- CSS selectors don't reach into shadow DOM. The interactive list from `read_page` and finding by text do see inside.
- `reload_extension` applies code changes, but not `manifest.json` changes. For those, click reload on `chrome://extensions` yourself.
- Very long full-page screenshots are scaled down (to stay under the image size limit), so they come out narrow.
- `resize_viewport` gives a narrow desktop viewport, not a phone emulation: the user agent, touch and pixel ratio stay as they are, so it checks the layout at that width, not everything a real phone does.
- `set_color_scheme` changes what the page is told about the system's color scheme; it does not operate a site's own theme switch or change a theme the site has saved.
- `upload_file` sets the files of a file input with script events, as a page's own code could; it can't answer the browser's "choose a file" window. Most pages and upload widgets take files this way. A page that insists on a real person's choice won't, and some drop zones (react-dropzone, for example) ignore a drop that didn't come from a real drag: setting the files on their file input works instead. Files go only from the uploads folder; inputs in other sites' iframes and choosing folders aren't supported.
- `mute_tab` uses Chrome's own tab mute, and once an extension has muted or unmuted a tab, Chrome stops applying that site's sound setting to it until the tab is closed. So a tab cctether muted stays muted if you drag it out of the group (cctether doesn't touch tabs outside the group), and "Unmute site" in the tab's menu doesn't bring the sound back: put the tab back into the group and ask Claude to unmute it, or close it and open the page again.
- One browser per service at a time.
- The service doesn't run on Windows directly. Use WSL.

### Not tested yet

- macOS as the computer that runs Claude Code.
- WSL (Chrome on Windows, Claude Code in WSL).

Both should work, but nobody has tried them yet. Feedback is welcome: [open an issue](https://github.com/guchaorui/cctether/issues).

## Uninstall

1. `claude mcp remove -s user cctether`, and if setup added it, the cctether note in `~/.claude/CLAUDE.md`
2. If you installed the background service: `systemctl --user disable --now cctether`, then delete `~/.config/systemd/user/cctether.service`.
3. `npm uninstall -g cctether`
4. Delete the config folder: `~/.config/cctether` (or `$CCTETHER_HOME` if you set it). It also holds the scripts and uploads folders.
5. In Chrome, remove the extension on `chrome://extensions`. If you loaded it yourself, also delete the `cctether-extension` folder.

## Development

```
extension/   the browser extension (MV3, no dependencies, no build step)
server/      the npm package "cctether": CLI, service, MCP
test/e2e/    end-to-end tests: headless Chrome for Testing + extension + service
docs/        design (SPEC), connection guides
deploy/      example Caddyfile and systemd unit
scripts/     icons, screenshots, extension packaging, store images
store/       Chrome Web Store listing text and images
```

- Server unit tests: `cd server && npm test`
- End-to-end tests: `node --test test/e2e/*.test.mjs` (needs Chrome for Testing, or set `CHROME_PATH`)
- Build the extension zip: `node scripts/pack-extension.mjs` (reproducible: the same source gives the same zip, so you can check a release yourself)

## License

[MIT](LICENSE)
