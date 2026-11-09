# GigaAM Speech Recognition plugin

The bundled plugin polls the configured GigaAM STT runtime's `/health` and `/metrics` endpoints when Paperclip requests worker health. It exposes readiness, model/VAD loaded flags, fallback mode, transcription totals, and p50 latency as health diagnostics. It never reads or returns transcripts or audio.

Configure an HTTPS base URL (or loopback HTTP for local development). If endpoint authentication is enabled, bind `authTokenRef` to a Paperclip secret reference; the secret value is resolved only for requests and is never included in diagnostics or logs. Responses are bounded and requests time out after five seconds.

The CI-built package exposes `/api/plugins/:pluginId/health` through Paperclip operator health diagnostics after installation and configuration. The manifest and worker are compiled into the installable package artifact, with entrypoints validated during packaging.
