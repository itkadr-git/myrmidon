# Server console

> Russian version: [server-console.ru.md](server-console.ru.md)

Server console is a section on the company settings page (route
`company/settings`, the "Server console" section below the team settings) that
opens a terminal of a fleet server right in the owner's browser — for the
moments when something on a fleet server needs hands: checking a service,
reading a log, fixing a stalled process.

The terminal itself is Apache Guacamole; the board does not run or install the
Guacamole client — operations deploys it and gives the board its address. The
board keeps the node registry, issues one-time sign-in tokens for Guacamole,
writes the journal and keeps every secret on the server: nothing long-lived
reaches the browser, and a node password never leaves the signed token.

## Who can do what

Only the owner of the company — a board user with an active owner role in the
company, an instance admin, or the local implicit actor — reads the registry,
registers nodes, opens consoles and closes sessions. Members and agent API keys
get 403 on every call of the section.

## The node registry

The registry holds one row per fleet server. Every row has:

- **Name key** (slug) — a short lowercase identifier, unique inside the
  company (`node-a` style: `^[a-z0-9][a-z0-9-]{0,62}$`);
- **Display name** — the label the list and the console show;
- **Host** and **Port** — where the node lives; leave the port empty to use
  the protocol default (22 for ssh, 5900 for vnc);
- **Protocol** — `ssh` for a shell, `vnc` for a graphical console;
- **Node user** — the account the console signs in as; leave empty for the
  default `fleet-console`;
- **Password secret key** — the name of a company secret (Access hub →
  Secrets) that holds the node password. Leave empty when the node signs in
  by key. The registry stores only the secret's name; the password value is
  read by the server at token issuance and never appears in a response, a log
  or the browser.

Register a node with the "Register a node" form at the bottom of the section.
Re-registering with a name key that already exists replaces that row's fields
— the same form is how a node's address, protocol or secret reference is
edited. A registry row can be disabled (`enabled` off): a disabled node stays
in the list and its Console button is inactive. The registry lives in the
database (the `myrmidon_fleet_servers` table, added by an additive migration)
and is per company: each company sees only its own nodes.

The registry and the journal work with no console address configured at all;
only opening a console needs the operations setup below.

## Opening a console

Press **Console** on a node's row. The board:

1. Checks you are the company owner and the node is enabled;
2. Builds a one-time sign-in document for Guacamole, signs and encrypts it
   with the shared key, and writes the issuance to the journal;
3. Shows the Guacamole terminal for that node in a frame inside the section
   (plus an **Open in a new tab** link to the same address).

The token is short-lived: it is valid for 5 minutes from issuance, and the
panel shows the countdown ("Token expires in … s"). Open the terminal right
away — Guacamole does not accept the token after it expires, and an expired
token means pressing Console again for a fresh one. The browser receives only
the encrypted blob; the node password travels inside it as ciphertext.

Opening a console on another node while one is open closes the previous
session first (its journal entry gets the duration), then issues the new
token.

Press **Close session** when done — the journal entry gets the session
duration.

## The journal

Every console use is recorded in the board's activity log (the company
activity screen):

- `myrmidon.console.token_issued` — who opened a console, when, on which
  node, over which protocol, and when the token expires;
- `myrmidon.console.session_closed` — the close, with the session duration.

No token, shared key or node password ever appears in the journal — only the
session identifier and the facts above.

## What operations must provide

Two things outside the board make Console work:

- `MYRMIDON_FLEET_CONSOLE_URL` — the base address of the Guacamole client the
  board signs tokens for (e.g. `https://guac.example.com`, no trailing `/`),
  set in the board's environment. Unset or empty — pressing Console answers
  `503 console_not_configured`; the registry and the journal keep working.
  Read at server startup, so changing it needs a restart.
- A company secret named `guacamole-json-secret-key` — the shared key between
  the board and the Guacamole client (the same value as the client's
  `json-secret-key`). The value must be 32 hexadecimal characters (128 bits).
  A missing secret answers `503 console_secret_missing`; a value in another
  format answers `503 console_secret_invalid` — the board refuses rather than
  issuing a token Guacamole would reject. The value is read by the server
  only, and never appears in a response or a log.

A node row that names a password secret missing from the secret store answers
`503 console_node_secret_missing`; a disabled node answers
`409 console_server_disabled`; an unknown node answers
`404 console_server_not_found`.

## API surface

Base path `/api/myrmidon/fleet`; all four routes require a company owner
(403 otherwise, 403 for agent keys):

```text
GET  /api/myrmidon/fleet/servers?companyId=          — the node registry
PUT  /api/myrmidon/fleet/servers                     — register or replace a node row
POST /api/myrmidon/fleet/console-token               — issue the 5-minute Guacamole token
POST /api/myrmidon/fleet/console-sessions/close      — close a session (writes the duration)
```

## Settings

The one environment variable is documented in
[../SETTINGS.md](../SETTINGS.md), section "SC1 — server console
(SERVER-CONSOLE, 1.4)": `MYRMIDON_FLEET_CONSOLE_URL`. The shared key and node
passwords are company secrets, not environment variables.

## Known limitations of this part

- A console session has no idle timeout on the board's side: press **Close
  session** when done — without it the journal keeps only the issuance entry
  and no duration. The token itself still expires in 5 minutes.
- Session recording (Guacamole's `recording-path`) is not set up by this
  part: the board journal is the record of who used a console.
- Creating the `fleet-console` account on the nodes themselves and placing
  their passwords into the secret store are operations tasks, not done by the
  board.
