# Remote sites presentation fixture

`ui/src/components/myrmidon/RemoteSitesPanel.tsx` exports `RemoteSitesPanel` and the `RemoteSiteRow` / `RemoteBotRow` view-model types for T8 integration. The component is presentation-only: pass normalized rows, loading/error state, an injectable clock and health TTL; provide `allowedActions` plus `onAction` when actions are authorized. It does not make requests or invoke real operations itself. Actions are disabled unless explicitly allowed and a callback exists, and are also disabled for stale health, expired certificates, unreachable or disabled sites.

Each site row contains `name`, one of the six `status` values, ISO `lastSeenAt` (or null), `{ used, total }` capacity, `botCount`, `driftCount`, ISO `clientCertNotAfter` (or null), and `bots`. Each bot contains `agent`, `imageDigest`, `state`, `drift`, and `apiBaseUrl`. The component visibly marks its presentation as fixture preview; local fixture values are not production data. Loading, error and empty states are handled without an API dependency. Details expand using a native button with `aria-expanded`, and the layout uses wrapping/min-width constraints for narrow viewports.

Focused presentation tests: `ui/src/components/myrmidon/RemoteSitesPanel.myrmidon.test.tsx`.
