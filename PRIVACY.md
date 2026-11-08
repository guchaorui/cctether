# cctether privacy policy

Last updated: 2026-11-08

This policy covers the cctether browser extension (Chrome Web Store and the version you load yourself) and the cctether service you run next to Claude Code.

## Who we are

cctether is an open-source project (MIT license), maintained by an individual. There is no company behind it and no cctether server. The source code is at https://github.com/guchaorui/cctether.

The short version: the developer receives no data from you. Everything the extension does goes to a service that you run yourself.

## What the extension accesses, and why

The extension lets your own AI coding agent (Claude Code, or another MCP client) read and operate browser tabs that you share with it. It does this only when your agent calls a tool, and only on tabs in the browser tab group named "cctether". Depending on the tool, it can access:

- the text, HTML and structure of the page in a shared tab
- screenshots of a shared tab
- the console messages and network requests of a shared tab, including request and response headers and bodies
- clicks, typing and key presses in a shared tab
- JavaScript that your agent asks to run in a shared tab
- the title and address of your tabs. These are not sent anywhere for tabs outside the group; the extension looks at them only to tell which tabs are in the group, and to show the Share button for the tab you are looking at.

Tabs outside the cctether tab group are not read or controlled.

Two tools are for people developing extensions: `list_extensions` and `reload_extension` use the `management` permission to list your installed extensions and reload one.

## Where the data goes

Results go only to the server address you entered when you paired the extension, which is the service you run on the computer where Claude Code runs. The extension connects to that address and nowhere else. When it connects, it also tells that service its own version, the browser's name and version, and the operating system, which `cctether status` shows.

- The connection is encrypted end to end with AES-256-GCM, using a 256-bit key from your connection code, after both sides prove they hold the key. A proxy or network provider in between cannot read or change it.
- Connections to another computer must use `wss://`. Plain `ws://` is allowed only to your own computer.
- We never receive this data. What your Claude Code does with it afterwards is covered by the terms and privacy policy of the AI service you use with it, not by this policy.

## What is stored on your computer

- In `chrome.storage.local`: the connection code (server address and key), the key's short fingerprint, and your settings (language, paused or not).
- In `chrome.storage.session` (held in memory, cleared when the browser closes): the connection status, which shared tab Claude is currently working in, and a short list of your recent actions (tool name, tab title and site, success or failure) that the popup shows.

Nothing is synced to your Google account. Removing the extension removes all of it.

## What we never do

- We do not sell or share user data.
- We do not collect analytics or telemetry, and the extension has no tracking code.
- We do not show ads.
- We do not use any third-party service.
- We do not use or transfer user data to determine creditworthiness or for lending.
- We do not use or transfer user data for anything unrelated to the extension's single purpose.

## Your control

- Pause: the popup's Pause button stops every tool at once. Clicking Cancel on Chrome's "started debugging this browser" bar also pauses cctether.
- Unshare: drag a tab out of the cctether tab group, or use the popup's Stop sharing button.
- Unpair: remove the connection in the extension's settings. The stored key is deleted.
- Rotate: run `cctether rotate` on the service computer to make a new key. The old code stops working at once.
- Uninstall: removing the extension deletes everything it stored.

## Children

cctether is a developer tool. It is not directed at children, and we do not knowingly collect information from anyone.

## Changes to this policy

Changes are made in this file in the repository, and the history at https://github.com/guchaorui/cctether/commits/main/PRIVACY.md shows every version. The date at the top changes with each update.

## Contact

- Questions and bugs: https://github.com/guchaorui/cctether/issues
- Security problems: report them privately through the repository's Security tab, as described in [SECURITY.md](SECURITY.md).
