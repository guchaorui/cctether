# Chrome Web Store listing (English)

Paste these into the developer dashboard, field by field. The privacy tab answers are in English because the dashboard takes English.

## Store listing tab

### Item name
cctether

### Summary (max 132 characters)
Let Claude Code use your browser over your own connection, with no third-party relay.

### Description (plain text, paste as is)

cctether lets Claude Code (or another MCP client) read and operate tabs in your Chrome, through a connection you run yourself. Nothing goes through a relay or a cctether server. The extension connects only to the service you set up.

This extension needs a small service, which you run on the computer where Claude Code runs. The extension does nothing until it is paired with that service.

WHAT IT CAN DO
When your Claude Code asks, cctether can:
- list, open and close tabs, and navigate
- read a page as text, and find elements
- take screenshots
- click, type, press keys, scroll, hover and choose menu options
- show console messages and network requests
- run JavaScript in the page (the same as DevTools' console)
- list installed extensions and reload one (for extension developers)

HOW IT STAYS SAFE
- Only tabs in the "cctether" tab group can be used. You choose which tabs to share, and you can drag any tab out at any time.
- A pause button in the popup stops every action at once.
- Both sides prove they hold the same 256-bit key before anything happens. After that, every message is encrypted with AES-256-GCM, so a proxy in between can not read or change it.
- Connections to another computer must use wss://.
- No analytics, no telemetry, no ads.
- The code is open source (MIT), has no dependencies, is not minified, and has had a security review (see SECURITY.md).

HOW TO SET UP
1. On the computer that runs Claude Code, run: npx cctether@latest setup (needs Node.js 22 or newer).
2. Copy the connection code it prints.
3. Open cctether's settings page in Chrome and paste the code.
4. Open a page you want Claude to use and click Share in the cctether popup, or let Claude open its own tabs.

While cctether works on a tab, Chrome shows a bar saying "cctether started debugging this browser". Clicking Cancel on it pauses cctether.

PRIVACY
The developer receives no data. Page content, screenshots and other results go only to the service you pair with, encrypted. Locally the extension stores your connection code, your settings and a short list of recent actions. Privacy policy: https://github.com/guchaorui/cctether/blob/main/PRIVACY.md

Warning: web pages can contain hidden text meant to trick an AI. Keep tabs with sensitive accounts (banking, email, admin consoles) out of the group unless you are watching.

cctether is an independent project. It is not made by or affiliated with Anthropic.

Source code: https://github.com/guchaorui/cctether

### Category
Developer Tools

### Language
English (the default). A Simplified Chinese (zh_CN) listing is in store/listing.zh-CN.md.

### Homepage URL
https://github.com/guchaorui/cctether

### Support URL
https://github.com/guchaorui/cctether/issues

## Graphic assets

All files are in store/images/.

- Store icon 128x128: store-icon-128.png (96x96 artwork with a 16 px transparent margin, as the store's image guidelines ask)
- Screenshots (1280x800 or 640x400, up to 5): screenshot-1-en.png, screenshot-2-en.png, screenshot-3-en.png
- Small promo tile (440x280): promo-small-en.png
- Marquee promo tile (1400x560): marquee-en.png
- For the Chinese listing: screenshot-1-zh.png, screenshot-2-zh.png, screenshot-3-zh.png, promo-small-zh.png, marquee-zh.png

## Privacy practices tab

### Single purpose description
Let the user's own AI coding agent (Claude Code, or another MCP client) read and operate the browser tabs the user shares, through a server the user runs.

### Permission justifications

debugger:
All page work goes through Chrome's debugger API, only on tabs in the user's "cctether" tab group: real mouse and keyboard input, screenshots, console messages, network requests, JavaScript dialogs and reading the page. No other API can do this, because the extension has no host permissions and no content scripts. Chrome shows its "started debugging this browser" bar while it is attached.

tabs:
To read the title and address of tabs, to tell which tabs are in the cctether group and show the Share button for the current tab, and to open, close and navigate tabs when the user's agent asks. Tabs outside the group are not read or controlled by tools.

tabGroups:
To create the "cctether" tab group and to check, on every call, whether a tab is in it. Only tabs in this group can be used by the agent.

storage:
To keep the connection code (server address and key), the user's settings (language, paused or not), and the connection status and a short list of recent actions shown in the popup. Data stays on the user's computer.

alarms:
To check the connection on a timer and reconnect by itself, because a Manifest V3 service worker is stopped by Chrome when idle.

management:
Used only by two tools, list_extensions and reload_extension, which let the user's agent list installed extensions and reload one. This helps when the user is developing an extension. It is not used for anything else.

### Host permissions
None. The extension requests no host permissions and has no content scripts.

### Remote code
Question: "Are you using remote code?"

Suggested answer: Yes, with the explanation below. If the form offers only a yes/no choice, read the justification carefully and choose the option that matches: the extension package contains all of its own code and does not download or run code from a server; but the evaluate tool runs JavaScript supplied by the user's own agent inside a web page the user shared.

Justification (paste):
The extension package contains all of the extension's own code. It never downloads code and never runs code it receives over the network inside the extension (no eval, no new Function, no remotely hosted scripts). It runs only a fixed list of 20 tools and checks every argument. One tool, "evaluate", runs a JavaScript expression that the user's own AI coding agent sends through the user's own server. That code runs inside the web page the user has shared, through Chrome's debugger API (the same as typing in the DevTools console), not in the extension. It works only on tabs in the user's cctether tab group, only while connected to the user's paired server, and the user can pause it at any time. The developer hosts no code and operates no server.

### Data usage

Tick these categories (data the extension handles when the user's agent asks):
- Website content: page text, HTML, screenshots, console messages and network requests (including headers and bodies) of tabs the user shares.
- Web history: the URL and title of shared tabs, and the site names in the recent-actions list.
- User activity: clicks, typing and key presses the agent performs in shared tabs.
- Authentication information: the connection code and key are stored locally. Tick this one too if you want to be cautious: the key is a credential, and network headers or page content the agent reads may contain credentials. The data stays on the user's computer and goes only to the user's own server.

Do not tick: personally identifiable information, health, financial and payment information, personal communications, location. (The agent may see such content on a page the user shares, but the extension does not look for or collect it by category. See the owner notes about this choice.)

Certifications (tick all three, they are accurate for this extension):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL:
https://github.com/guchaorui/cctether/blob/main/PRIVACY.md

## Distribution tab

- Visibility: Public
- Regions: all regions
- Pricing: free

## Notes for the owner

1. Remote code. The "evaluate" tool is the item most likely to draw reviewer questions. The honest framing is in the justification above. If a reviewer asks, point at extension/background/ (no eval, no dynamic code in the extension itself) and say the JavaScript runs in the page via the debugger.
2. The debugger permission is a "powerful" permission and usually gets a closer look and a longer review. The single purpose description and the debugger justification should be read together. Expect questions about why content scripts are not used.
3. The store build gets a new extension ID, shown as soon as the draft item is created. Tell Claude the ID: it will be added to the service's built-in allow list and published in a new npm version before the item is submitted for review, so store users connect without editing config.json.
4. Upload `cctether-extension-<version>-store.zip` (built by `node scripts/pack-extension.mjs --flat`, and attached to each GitHub Release). It has the files at the top level and no "key" in manifest.json, as the store requires; the self-loaded zip keeps the key so its ID stays fixed.
5. The wording "for Claude Code" describes compatibility only. The listing says it is not affiliated with Anthropic. Do not use the Claude logo or colors in the images.
6. The description says "has had a security review". SECURITY.md describes one internal review, not an outside audit. Do not change this to say "audited".
7. The data usage choice is a judgment call. The extension handles whatever is on a shared page, so ticking more categories is the safer side with reviewers. A mismatch between the form and the actual behavior is a common reason for rejection.
8. The store requires the extension to work when installed alone. Without the service it shows a "Not set up yet" screen with setup steps. Say this in the reviewer notes (test instructions) if the dashboard has that field: the extension needs a user-run server, so reviewers can only see the setup screens unless they run `npx cctether@latest setup`.
9. Screenshots must not show real accounts, real server addresses or a real connection code.
