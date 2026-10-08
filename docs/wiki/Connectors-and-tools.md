# Connectors and tools

> Русская версия: [Connectors-and-tools.ru](Connectors-and-tools.ru)

Agents work through tools. Myrmidon keeps the dangerous or heavy machinery
outside the bot container — as services and gateways the board controls —
and hands each bot exactly the tools it is entitled to.

## The browser bridge

The browser bridge lets a company bot act in a browser on a client PC: open
pages, read, click, fill, download, screenshot, and — under an operator-set
policy — take part in a signing step a person completes on that PC. The
client PC has no open port: the browser extension dials **out** to the
board's connector gateway. The connector panel (Company settings →
Connectors) is the operator's control surface: pairing and revoking devices,
the domain allowlist, the signing policy and the journal.

The Browsers settings section lets the owner watch and drive the live
browsers bots sign in through: open a screen session, keep it alive, close
it, clear a site's data.

## MCP connectors

The board can connect a standards-compliant external MCP server — any HTTP
MCP endpoint the company operates or trusts — and hand its tools to selected
agents, without changing fork code. On the board's own MCP server every tool
is published under a `myrmidon*` name; the old `paperclip*` names keep
working as deprecated aliases for one release so installed systems do not
break.

## Cloud storage and Microsoft 365

The cloud connector makes cloud storage a first-class board module: the
owner connects one cloud account per provider from the panel, and folder
access is handed out to agents from the same place. The OAuth token lives in
the instance secret store as a company secret — bots never see it.

The cloud-files service gives container bots OneDrive and a shared mailbox
of one service Microsoft account, behind the board's tool gateway.

## Media, office and OCR

The bot image carries no ffmpeg, LibreOffice, poppler or Tesseract. Those
live in separate services, and the bot gets a single MCP address. The OCR
path turns a PDF a bot received — a mail attachment, a download through the
browser bridge, a workspace document — into text the bot can work with, plus
a structural excerpt for tender documentation.

## GitHub

Development agents push code through the run-scoped GitHub broker: the board
hands a run its credentials for exactly that run. A company can authorize
GitHub once for the whole server with its own GitHub App instead of
per-person OAuth identities.

## In detail

- [Browser bridge: gateway and pairing](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/browser-bridge-gateway.md)
- [Browser bridge extension](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/bridge-extension.md)
- [Connector panel](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/connector-panel.md)
- [Browsers: live screen console](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/browsers.md)
- [External MCP connectors](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/external-mcp-connectors.md)
- [Board MCP tool names](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/mcp-tool-names.md)
- [Cloud storage connector](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/cloud-connector.md)
- [Microsoft 365 files and mail for container bots](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/cloud-files-connector.md)
- [Shared media and office tools](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/media-tools.md)
- [OCR path: PDF to text](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/ocr.md)
- [Shared GitHub identity](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/github-shared-identity.md)
