export const HTTP_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["proxy-authorization"]',
  "req.headers.cookie",
  // "set-cookie" is normally a response header; keep the request-side
  // path as defensive coverage in case a proxy forwards it inbound.
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Credential- and session-paired headers with no debugging value.
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  'req.headers["x-api-key"]',
  // Agent-key and tool-token headers the fleet clients send on every request.
  // A live-container overlay redacted them once, but the overlay never reached
  // the repository and the next image build dropped it, so raw agent API keys
  // reached the board HTTP log. Keep the paths in the source allowlist so every
  // build redacts them.
  'req.headers["x-paperclip-api-key"]',
  'req.headers["x-agent-key"]',
  'req.headers["x-paperclip-cloud-tenant-token"]',
  'req.headers["x-paperclip-signature"]',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-paperclip-tool-gateway-token"]',
  'req.headers["x-openclaw-token"]',
  'req.headers["x-openclaw-auth"]',
  // Telegram's optional webhook verification header is a reusable bearer
  // secret sent on every provider callback.
  'req.headers["x-telegram-bot-api-secret-token"]',
  // The structured failure logger adds a sanitized request-body copy under
  // `reqBody`. Keep the standard connector credential envelope covered again
  // at the final serialization boundary in case a future custom serializer
  // bypasses the recursive redactor.
  "reqBody.credentials",
  "errorContext.details.credentials",
] as const;
