// Command line: cctether <command> [options]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDir, paths, loadConfig, saveConfig, initConfig, newKey, serverUrl, localUrl, isValidServerUrl, trustProxy, ConfigError } from './config.js';
import { encodePairingCode, keyFingerprint } from './pairing.js';
import { adminRequest } from './control.js';
import { createLogger } from './log.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const CLI_PATH = fileURLToPath(new URL('../bin/cctether.js', import.meta.url));

const HELP = `cctether ${VERSION} — let Claude Code use your browser over your own connection.

Usage: cctether <command> [options]

Commands:
  setup                         Set everything up, step by step (start here)
  init [--port N] [--url URL]   Create the key and settings (done automatically on first use)
  pair [--url URL]              Show the connection code to paste into the browser extension
  check                         Test that the extension's address reaches this service
  status [--json]               Is the service running? Is a browser connected?
  rotate                        Make a new key; the old connection code stops working at once
  daemon [--takeover]           Run the service in the foreground. With --takeover (the systemd service
                                uses it), replace a copy that Claude Code started instead of exiting
  stop                          Stop the running service
  mcp                           MCP server on stdin/stdout (Claude Code runs this)
  version                       Print the version

Options:
  --url URL   The address the extension should connect to, e.g. wss://browser.example.com/cctether
              (saved for next time). Without it: ws://127.0.0.1:<port>/cctether, which works when
              the browser is on this computer or reaches it through an SSH tunnel.
  --port N    Port of the local service (default 27182)

Setup options (to run it from a script, give --yes and how the browser connects):
  --yes, -y                     Don't ask; take the defaults
  --mode local|ssh|https        Browser on this computer / through an SSH tunnel / over HTTPS
  --no-install --no-service --no-mcp   Skip installing, the background service, or adding to Claude Code
  --claude-md, --no-claude-md   Do / don't tell Claude (in ~/.claude/CLAUDE.md) to use cctether by itself
                                for every browser task (asked when run in a terminal)
  --lang en|zh                  Language of setup and check (default: from LANG)

Settings live in ${'$'}CCTETHER_HOME, else ${'$'}XDG_CONFIG_HOME/cctether, else ~/.config/cctether.
`;

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '-h' || a === '--help' || a === '--takeover') opts[a.replace(/^-+/, '')] = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--no-install' || a === '--no-service' || a === '--no-mcp') opts[a.slice(5)] = false;
    else if (a === '--claude-md' || a === '--no-claude-md') opts.claudeMd = a === '--claude-md';
    else if (a === '--url' || a === '--port' || a === '--mode' || a === '--lang') {
      if (i + 1 >= argv.length) throw new ConfigError(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (/^--(url|port|mode|lang)=/.test(a)) {
      const i2 = a.indexOf('=');
      opts[a.slice(2, i2)] = a.slice(i2 + 1);
    } else if (a.startsWith('-')) throw new ConfigError(`Unknown option ${a}`);
    else rest.push(a);
  }
  if (opts.port !== undefined) {
    const p = Number(opts.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ConfigError('--port must be a number from 1 to 65535');
    opts.port = p;
  }
  if (opts.mode !== undefined && !['local', 'ssh', 'https'].includes(opts.mode)) {
    throw new ConfigError('--mode must be local, ssh or https');
  }
  if (opts.lang !== undefined && !['en', 'zh'].includes(opts.lang)) throw new ConfigError('--lang must be en or zh');
  // setup also accepts a bare domain for --url and fixes it up itself
  if (opts.url !== undefined && !isValidServerUrl(opts.url) && !(rest[0] === 'setup' && opts.mode !== 'local')) {
    throw new ConfigError('--url must start with wss:// (or ws:// for 127.0.0.1 / localhost), with no query string, e.g. wss://browser.example.com/cctether');
  }
  return { opts, rest };
}

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s = '') => process.stderr.write(s + '\n');

async function notifyDaemon(P) {
  const r = await adminRequest(P.socket, { cmd: 'reload' });
  return r?.ok ? r : null;
}

export async function main(argv) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    err(`cctether needs Node.js 22 or newer (this is ${process.version}).`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(e.message);
    return 2;
  }
  const { opts, rest } = parsed;
  const cmd = rest[0] ?? (opts.h || opts.help ? 'help' : undefined);
  if (opts.takeover && cmd !== 'daemon') {
    err('--takeover only goes with `cctether daemon`.');
    return 2;
  }
  // Claude Code sets CLAUDECODE=1 for the commands it runs (also for `! command` lines): anything
  // printed there ends up in the conversation, so the connection code must not be printed.
  const insideClaude = !!process.env.CLAUDECODE;
  const dir = configDir();
  const P = paths(dir);

  try {
    switch (cmd) {
      case 'init': {
        const { cfg, created } = initConfig(dir, { port: opts.port, publicUrl: opts.url });
        if (!created) {
          let changed = false;
          if (opts.port !== undefined && opts.port !== cfg.port) { cfg.port = opts.port; changed = true; }
          if (opts.url !== undefined && opts.url !== cfg.publicUrl) { cfg.publicUrl = opts.url; changed = true; }
          if (changed) {
            saveConfig(dir, cfg);
            out(`Updated ${P.config}.`);
            if (await notifyDaemon(P)) out('The running service picked up the change (a new port needs a restart).');
          } else out(`Already set up: ${P.config}`);
        } else out(`Created ${P.config} (key fingerprint ${keyFingerprint(cfg.key)}).`);
        out('Next: run `cctether pair` and paste the code into the browser extension.');
        return 0;
      }

      case 'pair': {
        if (insideClaude) {
          err('The connection code contains the secret key, so cctether doesn’t print it inside Claude Code:');
          err('it would end up in the conversation. Run `cctether pair` in a terminal of your own instead.');
          return 2;
        }
        let { cfg } = initConfig(dir, { port: opts.port, publicUrl: opts.url });
        if (opts.url !== undefined && opts.url !== cfg.publicUrl) {
          cfg.publicUrl = opts.url;
          saveConfig(dir, cfg);
          await notifyDaemon(P);
        }
        const url = serverUrl(cfg);
        err('Connection code — keep it secret: anyone who has it can control this browser connection.');
        err('');
        out(encodePairingCode(url, cfg.key));
        err('');
        err('Paste it into the cctether extension: click its toolbar icon → Settings → Connection code.');
        err(`The extension will connect to ${url}`);
        err(`Key fingerprint (shown in the extension after pairing): ${keyFingerprint(cfg.key)}`);
        if (!cfg.publicUrl) {
          err('');
          err('This address works when Chrome runs on this computer, or reaches it through an SSH tunnel');
          err(`(ssh -L ${cfg.port}:127.0.0.1:${cfg.port} ...). For an HTTPS address: cctether pair --url wss://your.domain/cctether`);
        }
        err('If the code leaks: run `cctether rotate`, then pair again.');
        return 0;
      }

      case 'status': {
        const cfg = loadConfig(dir);
        const st = await adminRequest(P.socket, { cmd: 'status' });
        if (opts.json) {
          out(JSON.stringify({ configured: !!cfg, running: !!st?.ok, ...(st?.ok ? st : {}) }, null, 2));
          return st?.ok ? 0 : 3;
        }
        if (!cfg) {
          out('Not set up yet. Run `cctether pair`.');
          return 3;
        }
        out(`Settings:     ${P.config}`);
        out(`Address:      ${serverUrl(cfg)}${cfg.publicUrl ? ` (local ${localUrl(cfg)})` : ''}`);
        out(`Key:          fingerprint ${keyFingerprint(cfg.key)}`);
        out(`Proxy:        ${trustProxy(cfg) ? 'behind a local reverse proxy (client addresses from X-Forwarded-For)' : 'none (client addresses from the connection)'}`);
        if (!st?.ok) {
          out('Service:      not running (it starts automatically when Claude Code uses cctether)');
          return 3;
        }
        out(`Service:      running, pid ${st.pid}, version ${st.version}, since ${new Date(st.startedAt).toLocaleString()}`);
        if (st.browser.connected) {
          const i = st.browser.info ?? {};
          out(`Browser:      connected since ${new Date(st.browser.since).toLocaleString()} from ${st.browser.ip}`);
          if (i.browser || i.extension) out(`              ${i.browser ?? 'unknown browser'}, extension ${i.extension ?? '?'}`);
        } else out('Browser:      not connected');
        out(`MCP clients:  ${st.mcpSessions}`);
        return 0;
      }

      case 'rotate': {
        const existing = loadConfig(dir);
        const { cfg } = existing ? { cfg: existing } : initConfig(dir);
        cfg.key = newKey();
        saveConfig(dir, cfg);
        const r = await notifyDaemon(P);
        out(`New key made (fingerprint ${keyFingerprint(cfg.key)}). The old connection code no longer works${r ? '; the browser was disconnected' : ''}.`);
        out('Run `cctether pair` and paste the new code into the extension.');
        return 0;
      }

      case 'setup': {
        const { runSetup } = await import('./setup.js');
        const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
        const { createInterface } = await import('node:readline/promises');
        // One readline per question: while it's open the terminal is in raw mode, and Ctrl-C
        // wouldn't reach a long `npm install` or systemctl run in between.
        const ask = async (prompt) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.on('SIGINT', () => { out(''); process.exit(130); });
          try {
            return await rl.question(prompt);
          } finally {
            rl.close();
          }
        };
        return runSetup({
          dir, version: VERSION, cliPath: CLI_PATH, opts, write: out, ask, interactive,
          // The code is a secret: only show it on a terminal, not in logs or another program's output.
          showCode: !!process.stdout.isTTY && !insideClaude,
          color: interactive && !process.env.NO_COLOR,
        });
      }

      case 'check': {
        const { runCheck } = await import('./setup.js');
        return runCheck({ dir, version: VERSION, write: out, lang: opts.lang, color: !!process.stdout.isTTY && !process.env.NO_COLOR });
      }

      case 'daemon': {
        const log = createLogger();
        const { runDaemon } = await import('./daemon.js');
        // --takeover: only the systemd service passes it (see renderUnit). Not an environment check:
        // INVOCATION_ID, for one, is inherited by everything a systemd service starts.
        const r = await runDaemon({ dir, version: VERSION, log, port: opts.port, takeOver: !!opts.takeover });
        if (r.alreadyRunning) return 0;
        return new Promise(() => {}); // runs until a signal
      }

      case 'stop': {
        const r = await adminRequest(P.socket, { cmd: 'stop' });
        out(r?.ok ? 'Stopped.' : 'Not running.');
        return 0;
      }

      case 'mcp': {
        const { runShim } = await import('./shim.js');
        await runShim({ dir, version: VERSION, cliPath: CLI_PATH });
        return new Promise(() => {}); // runs until stdin closes
      }

      case 'version':
      case '--version':
        out(VERSION);
        return 0;

      case 'help':
      case undefined:
        out(HELP);
        return cmd ? 0 : 2;

      default:
        err(`Unknown command: ${cmd}\n`);
        err(HELP);
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      err(e.message);
      return 2;
    }
    throw e;
  }
}
