# OPE-7719: licensing implementation record

Status: implementation record for the 1.6.6 licensing umbrella. This document describes the code that is present in the Myrmidon core repository; issuer-plugin and deployment acceptance remain outside this repository.

## Built boundary

The board is a verifier and client-side licensing UI. It does not mint licenses and does not load a private signing key. The license envelope, verification order, trusted-key rotation, module/feature checks, expiry, and the MYRQ1 request format are implemented in `server/src/myrmidon/licensing/license.ts:1-229`. The verifier is fail-closed: malformed input, an untrusted signature, an unsupported revision, an installation mismatch, expiry, or a missing module/feature returns a specific negative reason.

The issuer is intentionally a closed deployment module. The core comment and implementation boundary are explicit at `server/src/myrmidon/licensing/license.ts:1-14`; the core trusts public issuer keys supplied by `trusted-keys.ts` and never contains the private key.

## Stable installation identity

There is one database-owned installation ID. Its source, persistence, fallback derivation, and compatibility format are documented and implemented in `server/src/myrmidon/licensing/install-id.ts:1-60`. The ID is `myr-` plus 20 hexadecimal characters, persisted in `myrmidon_install_identity`; the raw machine ID is not returned or logged. The licensing API and the module-visible `instance-id` file use the same provider (`server/src/myrmidon/licensing/routes.ts:1-12`, `server/src/myrmidon/licensing/install-id.ts:1-18`). This supersedes the obsolete 64-hex instance-id wording in plan rev.5.

## Client request and UI

The module-side-compatible request is `MYRQ1.<base64url(json)>`. Construction is in `server/src/myrmidon/licensing/license.ts:191-229`; compatibility tests are in `server/src/myrmidon/licensing/client-licensing.myrmidon.test.ts:89-120`. The server status route builds the request from the persisted installation ID (`server/src/myrmidon/licensing/routes.ts:100-122`). The instance-admin UI exposes the installation ID, one-click request copy, per-module status, and license installation in `ui/src/components/myrmidon/LicensingSettingsPanel.tsx:1-14`; authorization is enforced by the server route before status or installation operations (`server/src/myrmidon/licensing/routes.ts:1-12`).

The request is a transport convenience, not authentication. The owner must verify the customer-to-installation association before issuing a license. The blob contains no private key and is not signed.

## Gates and tamper handling

The core computes status for all known closed modules using the same signed license verifier (`server/src/myrmidon/licensing/client-license.ts:122-166`). It fails closed for missing, malformed, invalid-signature, expired, wrong-installation, ungranted-module, and ungranted-feature cases. The module-side-compatible behavior is covered by `server/src/myrmidon/licensing/client-licensing.myrmidon.test.ts` and `server/src/myrmidon/licensing/licensing.myrmidon.test.ts`.

The deny-list reader verifies the signed list against trusted issuer keys, validates the complete payload shape, rejects rollback, persists the highest accepted serial, and matches license ID, installation ID, or signer key ID (`server/src/myrmidon/licensing/denylist.ts:1-177`). A revoked valid license is reported as `reason: revoked` by `server/src/myrmidon/licensing/client-license.ts:134-151`. Tests cover signature rejection, rollback, persistence, and the status transition in `server/src/myrmidon/licensing/denylist.myrmidon.test.ts:1-151`.

Delivery is separate from verification: the periodic signed-list pull and atomic replacement are implemented on the OPE-9084 branch in `server/src/myrmidon/licensing/denylist-pull.ts`; the corresponding lifecycle and delivery tests are in `server/src/myrmidon/licensing/denylist.myrmidon.test.ts` on that branch. This umbrella must not claim production delivery until OPE-9084 is merged and its exact-head CI/RC acceptance is recorded.

## Acceptance matrix

| Criterion | Evidence | State |
|---|---|---|
| License is tied to one installation | `install-id.ts:1-60`; `license.ts:146-155`; client-license tests | Implemented in core; RC positive/negative e2e must be recorded by ADM |
| Unpaid modules/features do not start | `license.ts:156-181`; `client-license.ts:122-166` | Implemented and unit-tested |
| Tampering is detected/fails closed | `license.ts:110-181` and licensing tests | Implemented and tested |
| MYRQ1 can be copied once and accepted by issuer form | `license.ts:191-229`; client-licensing tests | Implemented in core; real blob-to-issuer-form e2e requires RC evidence |
| Revocation reaches an installed client | `denylist.ts:1-177`; `client-license.ts:134-151` | Verification implemented; delivery/RC acceptance depends on OPE-9084 |
| Lost updates prevent continued access | Private delivery/update policy | Not implemented in this repository; track OPE-9084/L4 acceptance |
| Alibaba-image and client-1 gates | `KNOWN_MODULES` currently covers google-ai, antigravity, chatgpt-pool, client-1; client-1 registration is mapped in `client-license.ts` and scope is covered by the client licensing test | Client-1 core gate implemented; Alibaba-image remains tracked by OPE-10277 |

## Threats and limits

A copied license is rejected on a different persisted installation and cannot grant an unlisted module or feature. Payload or signature changes fail verification. A customer with control of the runtime can still patch readable Python/JS or bypass a local check; this design is not protection against a determined reverse engineer. The practical controls are fail-closed gates, signed private delivery, update entitlement, monitoring, and contractual terms.

Offline revocation is not instantaneous: a client must receive a newer deny-list or license update. The issuer private key remains a deployment secret and must not be shipped to clients. Key rotation is supported by the trusted-key list and optional signer key ID; old key-less licenses remain compatible while their public key is trusted (`license.ts:78-108`).

## Remaining delivery evidence

Before closing OPE-7719, attach the exact-head CI/PR and RC evidence for OPE-9084, a redacted real MYRQ1 blob copied from the client screen and accepted by the issuer form, and the positive-on-A/`instance_mismatch`-on-B result. Do not include customer data, private keys, or raw credentials. The Alibaba-image and client-1 gate tasks must be completed separately before the umbrella criterion is fully satisfied.
