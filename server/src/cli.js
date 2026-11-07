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
  init [--port N] [--url URL]   Create the key and settings (done automatically on first use)
  pair [--url URL]              Show the connection code to paste into the browser extension
  status [--json]               Is the service running? Is a browser connected?
  rotate                        Make a new key; the old connection code stops working at once
  daemon                        Run the service in the foreground (systemd uses this)
  stop                          Stop the running service
  mcp                           MCP server on stdin/stdout (Claude Code runs this)
  version                       Print the version

Options:
  --url URL   The address the extension should connect to, e.g. wss://browser.example.com/cctether
              (saved for next time). Without it: ws://127.0.0.1:<port>/cctether, which works when
              the browser is on this computer or reaches it through an SSH tunnel.
  --port N    Port of the local service (default 27182)

Settings live in ${'$'}CCTETHER_HOME, else ${'$'}XDG_CONFIG_HOME/cctether, else ~/.config/cctether.
`;

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '-h' || a === '--help') opts[a.replace(/^-+/, '')] = true;
    else if (a === '--url' || a === '--port') {
      if (i + 1 >= argv.length) throw new ConfigError(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--url=') || a.startsWith('--port=')) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v;
    } else if (a.startsWith('-')) throw new ConfigError(`Unknown option ${a}`);
    else rest.push(a);
  }
  if (opts.port !== undefined) {
    const p = Number(opts.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ConfigError('--port must be a number from 1 to 65535');
    opts.port = p;
  }
  if (opts.url !== undefined && !isValidServerUrl(opts.url)) {
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

      case 'daemon': {
        const log = createLogger();
        const { runDaemon } = await import('./daemon.js');
        const r = await runDaemon({ dir, version: VERSION, log, port: opts.port });
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
