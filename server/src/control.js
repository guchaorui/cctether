// The control entrance (D9): a Unix socket in the config directory (mode 700), so only this user
// can reach it. Each connection starts with one preamble line:
//   {"cctether":1,"mode":"mcp"}                 then MCP JSON-RPC lines both ways
//   {"cctether":1,"mode":"admin","cmd":"..."}   one JSON reply line, then close

import { createServer, createConnection } from 'node:net';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';

const PREAMBLE_MAX = 4096;
const PREAMBLE_TIMEOUT_MS = 5000;

export class AlreadyRunningError extends Error {}

/** Try to connect; resolves the socket or null. */
export function connectSocket(path, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = createConnection(path);
    const t = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', () => { clearTimeout(t); resolve(null); });
  });
}

/** Send an admin command. Resolves the reply object, or null if the daemon isn't reachable. */
export async function adminRequest(path, req, timeoutMs = 3000) {
  const s = await connectSocket(path, timeoutMs);
  if (!s) return null;
  return new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(t);
        s.end();
        try { resolve(JSON.parse(buf.slice(0, i))); } catch { resolve(null); }
      }
    });
    s.on('error', () => { clearTimeout(t); resolve(null); });
    s.on('close', () => { clearTimeout(t); resolve(null); });
    s.write(JSON.stringify({ cctether: 1, mode: 'admin', ...req }) + '\n');
  });
}

/**
 * @param {object} o
 * @param {string} o.socketPath
 * @param {(socket: import('node:net').Socket, rest: string) => void} o.onMcp
 * @param {(req: object) => Promise<object>} o.onAdmin
 */
export async function startControl({ socketPath, onMcp, onAdmin, log = () => {} }) {
  if (existsSync(socketPath)) {
    const s = await connectSocket(socketPath, 1000);
    if (s) {
      s.destroy();
      throw new AlreadyRunningError('Another cctether service is already running.');
    }
    unlinkSync(socketPath); // stale socket from a crashed run
  }

  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => socket.destroy(), PREAMBLE_TIMEOUT_MS);
    const onData = (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) {
        if (buf.length > PREAMBLE_MAX) socket.destroy();
        return;
      }
      clearTimeout(timer);
      socket.off('data', onData);
      let pre;
      try { pre = JSON.parse(buf.slice(0, i)); } catch { pre = null; }
      const rest = buf.slice(i + 1);
      if (pre?.cctether !== 1) return socket.destroy();
      if (pre.mode === 'mcp') return onMcp(socket, rest);
      if (pre.mode === 'admin') {
        Promise.resolve(onAdmin(pre))
          .catch((e) => ({ ok: false, error: e.message }))
          .then((reply) => socket.end(JSON.stringify(reply) + '\n'));
        return;
      }
      socket.destroy();
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EINVAL' || e.code === 'ENAMETOOLONG') {
        reject(new Error(`Can't create the control socket ${socketPath}: the path is too long. Set CCTETHER_HOME to a shorter folder, e.g. ~/.cctether.`));
      } else reject(e);
    });
    server.listen(socketPath, () => { server.removeAllListeners('error'); resolve(); });
  });
  chmodSync(socketPath, 0o600);
  log(`control socket ready`);

  return {
    close: () => new Promise((r) => {
      server.close(() => r());
      for (const s of sockets) s.destroy();
      try { unlinkSync(socketPath); } catch {}
    }),
  };
}
