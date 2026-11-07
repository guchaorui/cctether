# cctether

> **Work in progress — not ready for use yet.**

cctether lets Claude Code (or any MCP client) read and drive your browser over your own connection — no third-party relay in between.

A Chrome extension connects out to a small server running next to Claude Code, and that server exposes browser tools over MCP: read pages, take screenshots, click and type, inspect console and network activity.

Built for setups where the official browser integration can't reach you, such as Claude Code on a remote server or in WSL, API-key or cloud-provider (Bedrock, Google Cloud, Foundry) authentication, or a network that can't reach the official relay.

## License

[MIT](LICENSE)
