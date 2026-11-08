# Let Claude set up cctether for you

English | [简体中文](setup-with-claude.zh-CN.md)

Instead of running `npx cctether@latest setup` yourself, you can ask Claude Code to do it. Open Claude Code on the computer where it runs (your own computer, or the server you use it on) and paste this:

```
Please set up cctether for me. It lets you use my own Chrome browser over my own connection: https://github.com/guchaorui/cctether

1. Read the README and docs/connect.md in that repository.
2. Ask me how my browser will reach this computer: Chrome on this same computer, through an SSH tunnel, or over HTTPS with my own domain. For HTTPS, ask for the address (like wss://browser.example.com/cctether), and help me set up the reverse proxy when we get there.
3. Ask me whether, from now on, you should use cctether by yourself whenever a task needs a browser.
4. Run setup without its questions, for example:
   npx cctether@latest setup --yes --mode https --url wss://browser.example.com/cctether --claude-md
   Use --mode local or --mode ssh instead when that's my answer, and leave out --claude-md if I said no to step 3. Show me what it printed and explain anything marked ✗ or !.
5. If it printed a command that needs sudo, give it to me to run myself.
6. Run `cctether check` and help me fix whatever it reports.
7. Then tell me what's left, step by step:
   - install the cctether extension in Chrome (README, section "Install the extension");
   - in a terminal of my own, not through you, run `cctether pair` and paste the code it prints into the extension's settings.
   Don't ask me to paste the connection code into this chat: it contains a secret key.
8. Remind me to restart Claude Code afterwards, so the cctether tools show up.

The connection code and the key must never appear in this conversation. So never run `cctether pair` or `cctether rotate` yourself, and never open, print or copy ~/.config/cctether/config.json (or the folder in $CCTETHER_HOME). To change the address, run setup again with a different --url.

```

## Good to know

- **The connection code stays out of the conversation.** Setup only prints the code in a real terminal, Claude's commands don't run in one, and `cctether pair` refuses to print the code in commands Claude Code runs. The prompt also tells Claude not to open the settings file that holds the key. Run `cctether pair` in a terminal of your own (not with `!` inside Claude Code) and paste the code straight into the extension.
- **"Use cctether by itself" (`--claude-md`)** adds a short, marked note to `~/.claude/CLAUDE.md`, the personal instructions Claude Code reads in every session. It tells Claude to reach for cctether whenever a task needs a browser. To undo it, delete the lines from `<!-- cctether:start` to `<!-- cctether:end -->`. Without the note, Claude still uses cctether when you ask it to.
- **Sessions that were already open** don't see new tools. Restart Claude Code after setup.
