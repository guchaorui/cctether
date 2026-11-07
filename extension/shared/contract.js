// Shared contract between the service worker (background/) and the UI pages (popup/, options/).
//
// The service worker owns all state and writes it to chrome.storage. UI pages only render what is
// in storage (and re-render on chrome.storage.onChanged) and send commands with
// chrome.runtime.sendMessage({ type, ...params }).

/** Storage keys. */
export const KEYS = {
  /** chrome.storage.local — Pairing | absent. Never shown in full in the UI (it contains the key). */
  pairing: 'pairing',
  /** chrome.storage.local — Settings. */
  settings: 'settings',
  /** chrome.storage.session — Status. */
  status: 'status',
  /** chrome.storage.session — ActivityEntry[] (newest first, at most ACTIVITY_MAX). */
  activity: 'activity',
};

export const ACTIVITY_MAX = 50;

/** Name of the tab group whose tabs Claude may use. */
export const GROUP_TITLE = 'cctether';

/**
 * @typedef {object} Pairing
 * @property {string} url          WebSocket URL of the server, e.g. "wss://browser.example.com/cctether"
 * @property {string} key          base64url, 32 bytes. Secret.
 * @property {string} fingerprint  8 hex chars, safe to display (identifies the key, can't be used to connect)
 * @property {number} pairedAt     ms epoch
 */

/**
 * @typedef {object} Settings
 * @property {'auto'|'zh'|'en'} lang   UI language. 'auto' follows the browser.
 * @property {boolean} paused          When true every tool call is refused with "paused".
 * @property {'user'|'debugger_canceled'|null} pausedReason
 *           'debugger_canceled' = the user clicked "Cancel" on Chrome's "started debugging this browser" bar.
 */
export const DEFAULT_SETTINGS = { lang: 'auto', paused: false, pausedReason: null };
// Writers: settings.lang is a pure UI preference and is written by the settings page directly
// (read-merge-write of the whole Settings object). Everything else in Settings is written by the
// service worker. Both sides must merge with the stored object, never overwrite it with defaults.

/**
 * @typedef {'unpaired'|'connecting'|'connected'|'disconnected'|'replaced'} ConnState
 *   unpaired      no pairing saved
 *   connecting    a connection attempt (incl. handshake) is in progress
 *   connected     handshake done, tools available
 *   disconnected  not connected; `error` says why, `retryAt` says when the next attempt happens
 *   replaced      another browser connected to the same server; no automatic retry (user can press reconnect)
 */

/**
 * @typedef {'unreachable'|'timeout'|'server_auth_failed'|'auth_rejected'|'origin_rejected'|
 *           'rate_limited'|'update_extension'|'update_server'|'insecure_url'|'protocol_error'|'closed'} ErrorCode
 *   unreachable        could not open the WebSocket (server down, wrong address, network/proxy problem)
 *   timeout            connected but the handshake or heartbeat timed out
 *   server_auth_failed the server could NOT prove it knows the key: wrong connection code or an impostor server
 *   auth_rejected      the server rejected our proof: the key was changed on the server (`cctether rotate`) — pair again
 *   origin_rejected    the server does not accept this extension's ID
 *   rate_limited       too many failed attempts from this IP; wait a few minutes
 *   update_extension   the server speaks a newer protocol; update the extension
 *   update_server      the server speaks an older protocol; update the server (npm package)
 *   insecure_url       saved URL is ws:// to a non-local host (should not happen: rejected at pairing time)
 *   protocol_error     malformed message / decryption failure; connection dropped for safety
 *   closed             the connection was closed by the server or the network after it was established
 */

/**
 * @typedef {object} Status
 * @property {ConnState} conn
 * @property {string|null} server        display form of the server address, e.g. "browser.example.com" or "127.0.0.1:27182"
 * @property {number|null} since         ms epoch when `conn` last changed
 * @property {{ code: ErrorCode, detail?: string }|null} error
 * @property {number|null} retryAt       ms epoch of the next reconnect attempt (conn === 'disconnected')
 * @property {string|null} serverVersion
 * @property {number} sharedTabs         tabs currently in the cctether group(s)
 * @property {number} attachedTabs       tabs the debugger is attached to (Chrome shows its warning bar while > 0)
 */
export const DEFAULT_STATUS = {
  conn: 'unpaired', server: null, since: null, error: null, retryAt: null,
  serverVersion: null, sharedTabs: 0, attachedTabs: 0,
};

/**
 * @typedef {object} ActivityEntry
 * @property {number} t        ms epoch
 * @property {string} tool     tool name, e.g. "click"
 * @property {{ id: number, title: string, host: string }|null} tab
 * @property {boolean} ok
 * @property {string} [error]  error code when !ok
 */

/**
 * Messages the UI sends to the service worker (chrome.runtime.sendMessage). Every reply is
 * { ok: true, ...data } or { ok: false, error: <code>, detail?: string }.
 *
 *   { type: 'pair', code }            → { ok, fingerprint, server } | { ok:false, error: 'invalid_code'|'insecure_url' }
 *   { type: 'unpair' }                → { ok }
 *   { type: 'setPaused', paused }     → { ok }
 *   { type: 'reconnect' }             → { ok }   (also used after 'replaced')
 *   { type: 'shareTab', tabId }       → { ok } | { ok:false, error: 'restricted_url'|'no_tab' }
 *   { type: 'unshareTab', tabId }     → { ok }
 *   { type: 'tabInfo', tabId }        → { ok, shared: boolean, restricted: boolean }
 */
export const MSG = {
  pair: 'pair',
  unpair: 'unpair',
  setPaused: 'setPaused',
  reconnect: 'reconnect',
  shareTab: 'shareTab',
  unshareTab: 'unshareTab',
  tabInfo: 'tabInfo',
};

export const REPO_URL = 'https://github.com/guchaorui/cctether';
