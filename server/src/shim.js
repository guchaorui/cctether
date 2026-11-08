// `cctether mcp`: what MCP clients run. Connects stdin/stdout to the resident service's control
// socket, starting the service if it isn't running (D11). If the service restarts, the shim
// reconnects; calls that were in flight get an error instead of hanging.

import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, statSync, renameSync, chmodSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { paths } from './config.js';
import { connectSocket } from './control.js';
import { createMcpSession, lineSplitter } from './mcp.js';

const PREAMBLE = JSON.stringify({ cctether: 1, mode: 'mcp' }) + '\n';
const LOG_MAX = 1024 * 1024;

export function spawnDaemon(P, cliPath, env = process.env, extraArgs = []) {
  mkdirSync(P.dir, { recursive: true, mode: 0o700 });
  try {
    if (statSync(P.log).size > LOG_MAX) renameSync(P.log, P.log + '.1');
  } catch {}
  const fd = openSync(P.log, 'a', 0o600);
  try { chmodSync(P.log, 0o600); } catch {}
  const child = spawn(process.execPath, [cliPath, 'daemon', ...extraArgs], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env,
  });
  child.unref();
  closeSync(fd);
  return child.pid;
}

/** Connect to the service, starting it if needed. Resolves a socket or null. */
export async function connectOrStart(P, cliPath, { waitMs = 6000 } = {}) {
  let s = await connectSocket(P.socket, 1000);
  if (s) return s;
  spawnDaemon(P, cliPath);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(100);
    s = await connectSocket(P.socket, 1000);
    if (s) return s;
  }
  return null;
}

export async function runShim({ dir, version, cliPath, stdin = process.stdin, stdout = process.stdout }) {
  const P = paths(dir);
  const writeOut = (line) => stdout.write(line + '\n');

  let sock = await connectOrStart(P, cliPath);
  if (!sock) {
    // Fallback: answer MCP ourselves so the client gets a useful message instead of a dead server.
    const session = createMcpSession({
      write: writeOut,
      browser: null,
      version,
      unavailable: `The cctether service could not be started. Ask the user to run \`cctether daemon\` in a terminal on this computer to see the error (log: ${P.log}).`,
    });
    stdin.setEncoding('utf8');
    stdin.on('data', lineSplitter((l) => session.handleLine(l)));
    stdin.on('end', () => process.exit(0));
    return;
  }

  const pending = new Map(); // JSON id → method
  let queue = [];
  let connected = false;
  let closing = false;

  const attach = (s) => {
    sock = s;
    connected = true;
    s.setEncoding('utf8');
    s.write(PREAMBLE);
    for (const l of queue) s.write(l + '\n');
    queue = [];
    s.on('data', lineSplitter((line) => {
      try {
        const m = JSON.parse(line);
        if (m && 'id' in m && !('method' in m)) pending.delete(JSON.stringify(m.id));
      } catch {}
      writeOut(line);
    }));
    s.on('error', () => {});
    s.on('close', () => onSocketClosed());
  };

  async function onSocketClosed() {
    connected = false;
    if (closing) return;
    for (const [idJson, method] of pending) {
      const id = JSON.parse(idJson);
      const text = 'The cctether service restarted while this call was running. Try again.';
      writeOut(JSON.stringify(method === 'tools/call'
        ? { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }
        : { jsonrpc: '2.0', id, error: { code: -32603, message: text } }));
    }
    pending.clear();
    for (let attempt = 0; !closing; attempt++) {
      const s = await connectOrStart(P, cliPath);
      if (s) return attach(s);
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
    }
  }

  attach(sock);
  stdin.setEncoding('utf8');
  stdin.on('data', lineSplitter((line) => {
    if (!line.trim()) return;
    try {
      const m = JSON.parse(line);
      if (m && typeof m.method === 'string' && 'id' in m && m.id !== null) pending.set(JSON.stringify(m.id), m.method);
    } catch {}
    if (connected) sock.write(line + '\n');
    else queue.push(line);
  }));
  stdin.on('end', () => {
    closing = true;
    sock?.end();
    setTimeout(() => process.exit(0), 200).unref();
  });
}
