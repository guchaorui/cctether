// The resident service: extension entrance + control entrance (SPEC §4.1).

import { loadConfig, initConfig, paths, trustProxy, WS_PATH } from './config.js';
import { keyFingerprint } from './pairing.js';
import { Gateway } from './gateway.js';
import { startControl, adminRequest, AlreadyRunningError } from './control.js';
import { createMcpSession, lineSplitter } from './mcp.js';
import { setTimeout as sleep } from 'node:timers/promises';

export async function runDaemon({ dir, version, log, port: portOverride, exitOnSignal = true }) {
  const P = paths(dir);
  let { cfg, created } = initConfig(dir);
  if (created) log(`created ${P.config} with a new key`);
  const port = portOverride ?? cfg.port;

  const gateway = new Gateway({ key: cfg.key, extensionIds: cfg.extensionIds, path: WS_PATH, version, log, trustProxy: trustProxy(cfg) });
  let boundPort;
  try {
    boundPort = await gateway.listen(port);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    // Either another cctether service holds the port (fine) or some other program does.
    for (let i = 0; i < 20; i++) {
      const st = await adminRequest(P.socket, { cmd: 'status' }, 1000);
      if (st?.ok) {
        log(`already running (pid ${st.pid})`);
        return { alreadyRunning: true };
      }
      await sleep(100);
    }
    throw new Error(`Port ${port} on 127.0.0.1 is used by another program. Set a different "port" in ${P.config}, then run \`cctether pair\` again and paste the new code into the extension.`);
  }

  const startedAt = Date.now();
  let sessions = 0;
  let control;
  try {
    control = await startControl({
      socketPath: P.socket,
      log,
      onMcp(socket, rest) {
        sessions++;
        const write = (line) => { if (!socket.destroyed) socket.write(line + '\n'); };
        const session = createMcpSession({ write, browser: gateway, version, log });
        const feed = lineSplitter((line) => {
          session.handleLine(line).catch((e) => log(`mcp error: ${e.message}`));
        }, { onOverflow: () => socket.destroy() });
        socket.on('data', feed);
        socket.on('close', () => { sessions--; });
        if (rest) feed(rest);
      },
      async onAdmin(req) {
        switch (req.cmd) {
          case 'status':
            return {
              ok: true, pid: process.pid, version, port: boundPort, path: WS_PATH,
              publicUrl: cfg.publicUrl, trustProxy: gateway.trustProxy, fingerprint: keyFingerprint(cfg.key), startedAt,
              browser: gateway.status(), mcpSessions: sessions,
            };
          case 'reload':
            return reload();
          case 'stop':
            setImmediate(() => shutdown('stop command'));
            return { ok: true };
          default:
            return { ok: false, error: 'unknown command' };
        }
      },
    });
  } catch (e) {
    await gateway.close();
    if (e instanceof AlreadyRunningError) {
      log(e.message);
      return { alreadyRunning: true };
    }
    throw e;
  }

  function reload() {
    const next = loadConfig(dir);
    if (!next) return { ok: false, error: 'config.json is missing' };
    const keyChanged = Buffer.compare(next.key, cfg.key) !== 0;
    gateway.setExtensionIds(next.extensionIds);
    gateway.trustProxy = trustProxy(next);
    gateway.setKey(next.key);
    const portChanged = next.port !== cfg.port;
    cfg = next;
    log(`config reloaded${keyChanged ? ' (new key)' : ''}${portChanged ? ' (port change needs a restart)' : ''}`);
    return { ok: true, keyChanged, portChanged };
  }

  let stopping = false;
  async function shutdown(why) {
    if (stopping) return;
    stopping = true;
    log(`stopping (${why})`);
    await control.close();
    await gateway.close();
    if (exitOnSignal) process.exit(0);
  }

  if (exitOnSignal) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => { try { reload(); } catch (e) { log(`reload failed: ${e.message}`); } });
  }

  log(`cctether ${version} listening on 127.0.0.1:${boundPort}${WS_PATH} (key ${keyFingerprint(cfg.key)})`);
  return { port: boundPort, gateway, shutdown };
}
