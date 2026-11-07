# cctether wire protocol (version 1)

This is the protocol between the cctether browser extension and the cctether service. It is written so the code can be audited against it, and so a compatible client or server could be written from it. The reference implementations are `server/src/protocol.js` + `server/src/gateway.js` (service) and `extension/background/crypto.js` + `extension/background/connection.js` (extension). `server/test/interop.test.js` checks that the two agree byte for byte.

## Overview

```
extension                                   service (127.0.0.1:27182, path /cctether)
    │ ── WebSocket upgrade, Origin: chrome-extension://<id> ──▶ │  path and Origin checked
    │ ── hello      { proto, cn }                  (text) ────▶ │
    │ ◀── challenge { proto, sn, sp }              (text) ───── │  sp proves the service has K
    │ ── auth       { cp }                         (text) ────▶ │  cp proves the extension has K
    │ ◀═══════════ AES-256-GCM frames, both directions (binary) ═══════════▶ │
```

- The extension always opens the connection; the browser's computer never listens on a port.
- Both sides share one secret: a random 256-bit key **K**, carried by the connection code. K never crosses the network.
- The service proves itself first. The extension acts on nothing until that proof checks out.
- After the handshake every message is encrypted and authenticated, so an attacker who can read or modify the TLS stream (for example a proxy with its own root certificate) can neither read nor inject messages.

## Transport

- WebSocket (RFC 6455). The service listens on `127.0.0.1` only (default port 27182) and accepts upgrades only on the path `/cctether`; any other path, and any plain HTTP request, gets `404`. Reaching it from another computer is left to an SSH tunnel or a reverse proxy that terminates TLS.
- The extension only connects to `wss://` addresses, or to `ws://` on `127.0.0.1`, `localhost` or `[::1]`.
- No WebSocket extensions (no per-message deflate).
- Maximum frame payload: 1 MiB in both directions. Larger messages from the extension are split (see [Fragments](#fragments)).

### Origin check

The upgrade request must carry `Origin: chrome-extension://<id>` where `<id>` is in the service's allow list (`extensionIds` in `config.json`; by default the ID fixed by the `key` in `extension/manifest.json`). This keeps web pages, which can also open WebSockets to `127.0.0.1`, out. It doesn't stop non-browser programs, which can send any Origin; the key is the real barrier.

A rejected Origin still gets the WebSocket upgrade, followed by `{"t":"error","code":"origin_rejected"}` and close code 4403, because a browser can't read the HTTP status of a failed WebSocket and the extension wants to tell the user what's wrong.

## Encoding

- Handshake messages are JSON objects in WebSocket **text** frames, at most 2048 bytes each.
- Binary values are base64url without padding (RFC 4648 §5). The service rejects non-canonical encodings and wrong lengths.
- `|` below means byte concatenation. Labels are ASCII.

## Handshake

The service must see a valid `auth` within 5 seconds of the upgrade, otherwise it closes with 4408. The extension gives up after 10 seconds.

### 1. `hello` (extension → service)

```json
{ "t": "hello", "proto": 1, "cn": "<32 random bytes>" }
```

If `proto` isn't 1, the service replies `{"t":"error","code":"update_server","proto":1}` when the extension's number is higher, otherwise `{"t":"error","code":"update_extension","proto":1}`, and closes with 4426.

### 2. `challenge` (service → extension)

```json
{ "t": "challenge", "proto": 1, "sn": "<32 random bytes>", "sp": "<32 bytes>" }
```

```
sp = HMAC-SHA256(K, "cctether/1 server" | cn | sn)
```

The extension checks `sp` (constant-time). If it doesn't match, the extension closes the connection and tells the user the server's identity is wrong. It does not send its own proof, so a fake server learns nothing it could replay.

### 3. `auth` (extension → service)

```json
{ "t": "auth", "cp": "<32 bytes>" }
```

```
cp = HMAC-SHA256(K, "cctether/1 client" | cn | sn)
```

The service checks `cp` in constant time. If it is wrong: `{"t":"error","code":"auth_rejected"}`, close 4401.

The two proofs use different labels and both cover both nonces, so a proof can't be replayed in another session or reflected to the other side.

### 4. Session keys

Both sides derive two AES-256 keys with HKDF-SHA256 (RFC 5869):

```
salt = cn | sn
k_c2s = HKDF(IKM = K, salt, info = "cctether/1 c2s", length = 32)   extension → service
k_s2c = HKDF(IKM = K, salt, info = "cctether/1 s2c", length = 32)   service → extension
```

Fresh nonces on both sides mean fresh keys for every connection.

## Encrypted messages

After `auth` every frame in both directions is **binary**:

```
frame = AES-256-GCM(key, iv, plaintext) | tag (16 bytes)
iv    = 0x00000000 | counter (64-bit unsigned, big-endian)
```

- Each direction has its own key and its own counter, starting at 0 and increasing by 1 per frame. A lost, replayed, reordered or altered frame fails to decrypt, and the receiver closes the connection (the service with 4400). There is no associated data.
- The plaintext is a UTF-8 JSON object with a string field `t`. Receivers ignore types they don't know, so newer versions can add optional messages.
- A text frame after the handshake is a protocol error.

### Messages

| `t` | Direction | Fields | Meaning |
|---|---|---|---|
| `welcome` | service → extension | `server`: service version | First encrypted message. The extension treats the connection as up only after decrypting it. |
| `info` | extension → service | `extension`, `browser`, `platform` (strings) | Sent once after `welcome`; shown by `cctether status`. |
| `ping` | extension → service | | Every 10 s. |
| `pong` | service → extension | | Reply to `ping`. No `pong` within 10 s and the extension reconnects. The service closes a connection that has sent nothing for 60 s (4408). |
| `call` | service → extension | `id` (integer), `tool` (string), `args` (object) | Run a browser tool. Calls may overlap. |
| `result` | extension → service | `id`, `ok` (boolean), then `data` if ok, else `error`: `{ code, message }` | `data` is MCP tool content: `{ "content": [ { "type": "text", "text": … } \| { "type": "image", "data": <base64>, "mimeType": … } ] }`. |
| `frag` | extension → service | `s` (string), `end` (true on the last piece) | A piece of a larger message; see below. |
| `bye` | service → extension | `reason`: `replaced`, `key_changed` or `shutdown` | Sent just before the service closes the connection on purpose. |

The extension runs only tools on its fixed list, with arguments checked against each tool's schema. Code from `evaluate` runs only inside the web page, never in the extension.

### Fragments

A single message from the extension may be large (a full-page screenshot can be tens of megabytes), but a frame may not exceed 1 MiB. The service accepts up to 32 Mi characters of reassembled JSON text; the extension stays under that by replacing any result over 30 Mi characters with a `too_large` error. The extension splits the JSON text of a large message into slices of at most 120,000 characters and sends each as its own encrypted `{"t":"frag","s":"<slice>"}`; the last one has `"end": true`. The service joins the slices and parses the result as one message. Other messages can't be interleaved with a fragmented one. Messages from the service are limited to 1 MiB and are never fragmented.

## Errors before encryption

Sent as a text frame right before the service closes:

| `code` | Close code | Meaning |
|---|---|---|
| `origin_rejected` | 4403 | Origin is not an allowed extension. |
| `rate_limited` | 4401 | Too many failed handshakes from this address (see below). |
| `auth_rejected` | 4401 | Wrong `cp`: the extension doesn't have this service's key. |
| `update_extension` / `update_server` | 4426 | Protocol version mismatch; the field `proto` gives the service's version. |

## Close codes

| Code | Meaning |
|---|---|
| 4400 | Protocol error: malformed message, bad nonce, failed decryption, text frame after the handshake. |
| 4401 | Authentication failed, or rate limited. |
| 4403 | Origin rejected. |
| 4408 | Timeout: handshake too slow, or the connection was idle for 60 s. |
| 4409 | Replaced: another browser authenticated. The extension does not reconnect by itself, so two browsers don't keep knocking each other off. |
| 4410 | The key was changed (`cctether rotate`). |
| 4426 | Protocol version mismatch. |
| 4503 | The service is shutting down. |

## Limits and rate limiting

- At most 16 connections may be in the handshake at once; more get HTTP 503.
- Failed handshakes are counted per client address: 5 failures within a minute block that address for 5 minutes. What counts: a binary or oversized frame during the handshake, a message that isn't valid JSON, the wrong message type, a malformed nonce, a wrong `cp`, and not finishing within 5 seconds.
- What doesn't count: hanging up at any point before the timeout (a genuine extension hangs up when the server fails to prove itself, and `cctether check` hangs up on purpose after the challenge), a protocol version mismatch, a rejected Origin, and connections refused because the address is already blocked.
- The client address is the TCP peer. When `trustProxy` is on (by default when the public address is `wss://` on another host, meaning a local reverse proxy is in front), connections from `127.0.0.1` use the last entry of `X-Forwarded-For` instead.

## One browser at a time

The service keeps one authenticated browser. When another one completes the handshake, the old one receives `bye` with reason `replaced` and close code 4409.

## Connection codes

```
cctether1:<base64url(JSON)>      JSON = { "u": "<server address>", "k": "<base64url(K)>" }
```

Anyone with the code can act as either side, so it is a secret. `cctether rotate` makes a new K; the old code stops working immediately and a connected browser is dropped (4410).

The **key fingerprint** shown by `cctether status` and the extension's settings is the first 8 hex digits of SHA-256(K). It lets you check that both sides hold the same key without revealing it.

## `cctether check`

`check` runs the first two steps of the handshake against the address in the connection code: it sends `hello` with an allowed Origin, verifies `sp` with its own K, and hangs up without sending `auth`. A valid `sp` proves that the address leads to this service. Because no `auth` is sent, a connected browser stays connected and the attempt doesn't count as a failure.

## Versioning

`proto` changes only for incompatible changes. Optional message types and fields can be added without changing it, since receivers ignore what they don't know.
