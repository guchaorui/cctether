// Keeps an MCP client's view of the tool list in step with the service across restarts
// (SPEC §4.5 "服务换了以后"). `cctether mcp` feeds it the messages it passes on; it says when to
// send notifications/tools/list_changed and adds a note to a tool result when the client's copy
// of some tools is probably out of date (Claude Code keeps the old schema of tools it has used).

import { createHash } from 'node:crypto';

export const NOTE_GRACE_MS = 2000;
const NOTE_MAX = 4000;
const ARG_MAX = 600;
const NAMES_MAX = 1500;

/** JSON with object keys sorted (array order kept), so equal lists compare equal. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const fingerprint = (tools) => createHash('sha256').update(canonical(tools)).digest('hex');

/** The tools of a successful, single-page tools/list result; else null. */
export function completeList(msg) {
  const r = msg?.result;
  if (!r || typeof r !== 'object' || !Array.isArray(r.tools) || r.nextCursor != null) return null;
  if (!r.tools.every((t) => t && typeof t === 'object' && typeof t.name === 'string')) return null;
  return r.tools;
}

/**
 * @param {object} o
 * @param {() => void} o.notify   sends notifications/tools/list_changed to the client
 * @param {number} [o.graceMs]    how long after a change a call must come to get the note
 * @param {() => number} [o.now]
 */
export function createListWatch({ notify, graceMs = NOTE_GRACE_MS, now = Date.now }) {
  let initOk = false;    // the client's initialize got a successful reply
  let ready = false;     // ... and the client sent notifications/initialized
  let clientFp = null;   // fingerprint of the last complete list passed to the client
  // The version of each tool the model is taken to have: the first one passed to the client
  // (Claude Code keeps the schema of a tool it has used), or the one in the last note.
  let view = null;       // Map name → { canon, tool }
  let served = null;     // the current service's list: { fp, tools }
  let confirmed = false; // `served` was seen on the current connection
  let since = null;      // { at, fp }: when the model's view started to differ from list fp

  function update() {
    const differs = view && served && !(view.size === served.tools.length && served.tools.every((t) => view.get(t.name)?.canon === canonical(t)));
    if (!differs) since = null;
    else if (since?.fp !== served.fp) since = { at: now(), fp: served.fp }; // the same list again keeps its time
  }

  function delivered(tools) {
    const fp = fingerprint(tools);
    clientFp = fp;
    served = { fp, tools };
    confirmed = true;
    view ??= new Map();
    for (const t of tools) if (!view.has(t.name)) view.set(t.name, { canon: canonical(t), tool: t });
    update();
  }

  return {
    get ready() { return ready; },

    /** A message from the client (after it is passed on). */
    fromClient(msg) {
      if (msg?.method === 'notifications/initialized' && initOk) ready = true;
    },

    /** A new connection to the service: nothing about it is known until its list is seen. */
    reconnected() { confirmed = false; },

    /** The service's tool list, fetched by `cctether mcp` itself after a reconnect. */
    serviceList(tools) {
      const fp = fingerprint(tools);
      served = { fp, tools };
      confirmed = true;
      update();
      if (ready && clientFp !== fp) notify(); // also when the client has no list yet
    },

    /**
     * The service's reply to a client request, before it is passed on (not for cancelled ones).
     * May change `msg`; returns true if it did.
     * @param {{ method: string, at: number, cursor: boolean }} req
     */
    reply(req, msg) {
      if (req.method === 'initialize') {
        const r = msg.result;
        if (!r || typeof r !== 'object') return false;
        r.capabilities = { ...r.capabilities, tools: { ...r.capabilities?.tools, listChanged: true } };
        initOk = true;
        return true;
      }
      if (req.method === 'tools/list') {
        const tools = !req.cursor && completeList(msg);
        if (tools) delivered(tools);
        return false;
      }
      if (req.method === 'tools/call') {
        if (!confirmed || since == null || req.at < since.at + graceMs || !Array.isArray(msg.result?.content)) return false;
        msg.result.content.push({ type: 'text', text: describeChange([...view.values()].map((v) => v.tool), served.tools) });
        view = new Map(served.tools.map((t) => [t.name, { canon: canonical(t), tool: t }]));
        since = null;
        return true;
      }
      return false;
    },
  };
}

/**
 * What changed from `before` (the model's copy) to `after`, for the model. Arguments changed alike
 * in several tools share a line. Every name is always given; definitions while there is room.
 */
export function describeChange(before, after) {
  const old = new Map(before.map((t) => [t.name, t]));
  const cur = new Map(after.map((t) => [t.name, t]));
  const added = after.filter((t) => !old.has(t.name)).map((t) => t.name);
  const removed = before.filter((t) => !cur.has(t.name)).map((t) => t.name);
  const groups = { new: new Map(), changed: new Map(), gone: new Map() }; // key → { arg, def, flag, tools }
  const add = (kind, arg, def, flag, tool) => {
    const key = `${arg}\0${flag}\0${def === undefined ? '' : canonical(def)}`;
    const g = groups[kind].get(key) ?? { arg, def, flag, tools: [] };
    g.tools.push(tool);
    groups[kind].set(key, g);
  };
  const other = [];
  for (const t of after) {
    const o = old.get(t.name);
    if (!o || canonical(o) === canonical(t)) continue;
    const op = props(o);
    const np = props(t);
    const oreq = required(o);
    const nreq = required(t);
    for (const k of Object.keys(np)) {
      if (!(k in op)) add('new', k, np[k], nreq.has(k) ? 'required' : '', t.name);
      else if (canonical(op[k]) !== canonical(np[k]) || oreq.has(k) !== nreq.has(k)) {
        add('changed', k, np[k], oreq.has(k) === nreq.has(k) ? '' : nreq.has(k) ? 'now required' : 'now optional', t.name);
      }
    }
    for (const k of Object.keys(op)) if (!(k in np)) add('gone', k, undefined, '', t.name);
    const { inputSchema: os, ...orest } = o;
    const { inputSchema: ns, ...nrest } = t;
    const strip = (x) => { const { properties, required: _, ...rest } = x && typeof x === 'object' ? x : {}; return rest; };
    if (canonical(orest) !== canonical(nrest) || canonical(strip(os)) !== canonical(strip(ns))) other.push(t.name);
  }

  const restart = 'ask the user to restart Claude Code or their MCP client';
  const items = []; // [text, definition or null]
  if (added.length) items.push([`- New tools: ${names(added)}. This session may not have them yet: to use them, ${restart}.`, null]);
  const section = (kind, title) => {
    if (!groups[kind].size) return;
    items.push([title, null]);
    for (const { arg, def, flag, tools } of groups[kind].values()) {
      items.push([`  - ${arg} (${tools.join(', ')})${flag ? `, ${flag}` : ''}`, def === undefined ? null : clip(JSON.stringify(def), ARG_MAX)]);
    }
  };
  section('new', '- New arguments (you can pass them even if your copy of the tool\'s schema doesn\'t list them):');
  section('changed', '- Changed arguments, as they are now:');
  section('gone', '- Arguments no longer accepted:');
  if (other.length) items.push([`- Descriptions or other details changed: ${names(other)}. To see the new ones, ${restart}.`, null]);
  if (removed.length) items.push([`- Removed tools: ${names(removed)}.`, null]);
  const head = 'Note from cctether: the cctether service restarted with a different tool list, so this session\'s copy of some cctether tools may be out of date.';
  // Names first (if even they are too many, the last arguments are counted instead of named);
  // then definitions, in order, while the note stays under NOTE_MAX.
  let len = head.length + items.reduce((n, [t]) => n + t.length + 1, 0);
  let omitted = 0;
  for (let i = items.length - 1; i >= 0 && len > NOTE_MAX * 2; i--) {
    if (!items[i][0].startsWith('  - ')) continue;
    len -= items[i][0].length + 1;
    items.splice(i, 1);
    omitted++;
  }
  if (omitted) items.push([`- (${omitted} more changed arguments not listed. To see them all, ${restart}.)`, null]);
  const lines = items.map(([t, def]) => {
    if (def == null || len + def.length + 2 > NOTE_MAX) return t;
    len += def.length + 2;
    return `${t}: ${def}`;
  });
  return [head, ...lines].join('\n');
}

/** Tool names, up to about NAMES_MAX characters, then how many more. */
function names(list) {
  let out = '';
  let i = 0;
  for (; i < list.length; i++) {
    const next = out ? `${out}, ${list[i]}` : list[i];
    if (next.length > NAMES_MAX && i > 0) break;
    out = next;
  }
  return i < list.length ? `${out} and ${list.length - i} more` : out;
}

function props(tool) {
  const p = tool?.inputSchema?.properties;
  return p && typeof p === 'object' ? p : {};
}

function required(tool) {
  const r = tool?.inputSchema?.required;
  return new Set(Array.isArray(r) ? r.filter((x) => typeof x === 'string') : []);
}

function clip(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
