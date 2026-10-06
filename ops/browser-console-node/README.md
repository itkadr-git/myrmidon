# myrmidon(BROWSER-CONSOLE): the screen node (part B)

Runs on the exec host next to the live browser (Chromium + Xvfb :99 + CDP) and
implements the HTTP contract of
`server/src/myrmidon/browser-console/screen-console-client.ts`:

| endpoint | behaviour |
|---|---|
| `POST /browsers/<id>/open` | starts x11vnc on the display as a transient unit `browser-screen-x11vnc@<id>` (systemd-run --collect), answers `{"wsUrl": "vnc://<host>:<port>", "screenSessionId": "<uuid>"}` |
| `POST /sessions/<id>/done` | stops the unit (idempotent: an unknown id is still 200) |
| `POST /sessions/<id>/heartbeat?activity=0\|1` | keep-alive; no heartbeat for 120 s and the watchdog releases the unit itself |
| `POST /browsers/<id>/pause` | `systemctl stop mcp-reaper-proxy.service` — kills the bot write path 8932→18932→CDP |
| `POST /browsers/<id>/resume` | `systemctl start mcp-reaper-proxy.service` |
| `POST /browsers/<id>/clear-site-data?domain=` | CDP on 127.0.0.1: `Network.clearBrowserCookies` + `Storage.clearDataForOrigin` (https and http origins) |
| `GET /health` | liveness only (`{"ok": true, "sessions": N}`), no auth, no internals |

## Why stdlib python

The node must not drag a new dependency with an unclear licence onto the
stand: the HTTP API is `http.server`, systemctl is a subprocess, and the CDP
websocket is a hand-written RFC6455 text-frame client (masked client frames,
ping→pong, close handling) against the browser-level endpoint advertised by
`/json/version`. The board reaches the node with a Bearer token over plain
HTTP inside the management network only.

The screen picture does NOT pass through the node: per the 1.4 screen-solution
decision (step0-solution-choice) guacd on the console VM connects VNC to
x11vnc here, and the panel authorizes itself with a short-lived signed
Guacamole auth-JSON (`server/src/myrmidon/browser-console/console-token.ts`).
That is why `-localhost` is deliberately absent from the x11vnc command —
guacd lives on another host — and why `-nopw` is safe: the port opens only
while a session unit exists, reach is bounded by the network policy between
this host and guacd, and every connect needs a valid signed token the board
issues per owner (5-minute expiry, decoded by the shared
`guacamole-json-secret-key`). `wsUrl` in the open() response is informational
(`vnc://host:port`); the UI never dials it.

## Deploy (adm-dev-release, after the PR merges)

1. Release the env file once: copy `systemd/browser-console-node.env.example`
   to `/etc/myrmidon/browser-console-node.env` on the exec host, set
   `BROWSER_CONSOLE_NODE_TOKEN` to a fresh `openssl rand -hex 32` value (never
   in the repo or the ticket), the bind/port to the operational address,
   `BROWSER_CONSOLE_VNC_URL` to the address guacd reaches this host by — the
   same host the board puts into `MYRMIDON_BROWSER_VNC_TARGET` — and chmod
   root:root 0600.
2. Board side: `MYRMIDON_BROWSER_CONSOLE_HOST` = `http://<this node>`,
   `MYRMIDON_BROWSER_CONSOLE_TOKEN` = the same generated value,
   `MYRMIDON_BROWSER_VNC_TARGET` = `host[:port]`, `MYRMIDON_FLEET_CONSOLE_URL`
   = the shared guacamole-client URL, `MYRMIDON_BROWSER_CONSOLE_MCP_URLS` =
   JSON map of the reaper-proxy MCP URL to the fleet browser id.
3. `sudo ops/browser-console-node/deploy/install.sh` — syntax-checks the node,
   backs up any previous unit/code to `/var/backups/myrmidon/browser-console-node/<ts>/`,
   installs `browser-console-node.service`, `daemon-reload`, enable.
4. `systemctl start browser-console-node.service`, then smoke: open a screen
   session from Settings → Browsers, check `systemctl is-active
   browser-screen-x11vnc@<browser>` on this host, pause/resume toggles
   `mcp-reaper-proxy.service`, and after 2 minutes of silence from the board
   the unit is gone on its own.
5. Rollback: `sudo deploy/rollback.sh` restores the newest backup (or removes
   the install) and stops any `browser-screen-x11vnc@*` unit still running.

A leftover manual `x11vnc-temp.service` (failed) on the stand is NOT managed
by this node; the operator may delete it.

## Tests

`python3 -m unittest discover -s tests` — stdlib only, no installs. Covers
each contract method against mocked systemd/CDP, the browser-id and domain
guards, the 120 s heartbeat insurance and the RFC6455 masking.
