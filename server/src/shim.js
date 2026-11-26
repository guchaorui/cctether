// `cctether mcp`: what MCP clients run. Connects stdin/stdout to the resident service's control
// socket, starting the service if it isn't running (D11). If the service restarts, the shim
// reconnects; calls that were in flight get an error instead of hanging. After a reconnect it
// checks the new service's tool list and tells the client if it changed (listwatch.js).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, mkdirSync, statSync, renameSync, chmodSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { paths } from './config.js';
import { connectSocket } from './control.js';
import { createMcpSession, lineSplitter } from './mcp.js';
import { createListWatch, completeList, NOTE_GRACE_MS } from './listwatch.js';

const PREAMBLE = JSON.stringify({ cctether: 1, mode: 'mcp' }) + '\n';
const LOG_MAX = 1024 * 1024;
const CHECK_TIMEOUT_MS = 5000;
const LIST_CHANGED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });

/** A JSON-RPC request id as MCP has them: a string or a number. */
const isId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

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

export async function runShim({ dir, version, cliPath, stdin = process.stdin, stdout = process.stdout, noteGraceMs = NOTE_GRACE_MS }) {
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

  const pending = new Map(); // JSON id → { method, at, cursor }
  let queue = [];
  let connected = false;
  let closing = false;
  let attached = 0;
  const watch = createListWatch({ notify: () => writeOut(LIST_CHANGED), graceMs: noteGraceMs });
  const ownIds = new Set(); // ids of requests this shim sent itself: their replies stay here
  let check = null; // this shim's own tools/list after a reconnect: { id, timer }

  // A line from the service, before it goes to the client. Returns what to pass on, or null.
  function fromService(line) {
    let m;
    try { m = JSON.parse(line); } catch { return line; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || !('id' in m) || 'method' in m) return line;
    if (!isId(m.id)) return line;
    if (typeof m.id === 'string' && ownIds.delete(m.id)) {
      if (check?.id === m.id) {
        clearTimeout(check.timer);
        check = null;
        const tools = completeList(m);
        if (tools) watch.serviceList(tools);
      }
      return null;
    }
    const key = JSON.stringify(m.id);
    const req = pending.get(key);
    pending.delete(key);
    return req && !req.cancelled && watch.reply(req, m) ? JSON.stringify(m) : line;
  }

  const attach = (s) => {
    sock = s;
    connected = true;
    s.setEncoding('utf8');
    s.write(PREAMBLE);
    if (attached++ > 0) {
      // A reconnect: the service may be a new version with other tools (SPEC §4.5).
      watch.reconnected();
      if (watch.ready) {
        const id = `cctether-shim-${randomUUID()}`;
        ownIds.add(id);
        check = { id, timer: setTimeout(() => { if (check?.id === id) check = null; }, CHECK_TIMEOUT_MS) };
        check.timer.unref();
        s.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n');
      }
    }
    for (const l of queue) s.write(l + '\n');
    queue = [];
    s.on('data', lineSplitter((line) => {
      const out = fromService(line);
      if (out !== null) writeOut(out);
    }));
    s.on('error', () => {});
    s.on('close', () => onSocketClosed());
  };

  async function onSocketClosed() {
    connected = false;
    ownIds.clear();
    if (check) { clearTimeout(check.timer); check = null; }
    if (closing) return;
    for (const [idJson, { method }] of pending) {
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
    let msgs = [];
    try {
      const m = JSON.parse(line);
      msgs = Array.isArray(m) ? m : [m];
    } catch {}
    const at = Date.now();
    for (const m of msgs) {
      if (!m || typeof m !== 'object' || typeof m.method !== 'string') continue;
      const params = m.params && typeof m.params === 'object' ? m.params : {};
      if (isId(m.id)) {
        pending.set(JSON.stringify(m.id), { method: m.method, at, cursor: params.cursor != null });
      } else if (m.method === 'notifications/cancelled' && isId(params.requestId)) {
        // Its reply, if one still comes, is passed on as it is but counts for nothing here.
        const req = pending.get(JSON.stringify(params.requestId));
        if (req) req.cancelled = true;
      }
    }
    if (connected) sock.write(line + '\n');
    else queue.push(line);
    for (const m of msgs) watch.fromClient(m);
  }));
  stdin.on('end', () => {
    closing = true;
    sock?.end();
    setTimeout(() => process.exit(0), 200).unref();
  });
}
