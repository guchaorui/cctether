# cctether

Let Claude Code (or any MCP client) use your real Chrome browser over your own connection — no third-party relay.

This package is the service that runs on the computer with Claude Code. It works together with the **cctether browser extension**, which connects out to it and does the work in the browser: reading pages, screenshots, clicking and typing, console and network inspection.

## Quick start

On the computer that runs Claude Code (Node.js 22 or newer):

```
npx cctether@latest setup
```

Setup installs cctether, makes a key, asks how your browser will reach this computer (same computer, SSH tunnel, or HTTPS with your own domain), can install a background service, adds cctether to Claude Code, checks the connection, and prints a connection code. Then install the extension and paste the code into its settings.

Full documentation, the extension, and how each connection method works: **https://github.com/guchaorui/cctether**

## Commands

```
cctether setup     Set everything up, step by step
cctether pair      Show the connection code again
cctether check     Test that the extension's address reaches this service
cctether status    Is the service running? Is a browser connected?
cctether rotate    Make a new key (the old connection code stops working)
cctether help      All commands and options
```

## Security

The extension and the service authenticate each other with a shared 256-bit key and encrypt every message end to end; Claude can only use tabs in the browser's cctether tab group. See [SECURITY.md](https://github.com/guchaorui/cctether/blob/main/SECURITY.md).

## License

MIT
