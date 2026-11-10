# 1.7 REBRAND: Plan of Phases, Implementation Traceability & Compatibility Strategy

This document serves as the formal deliverable and traceability plan for Epic **OPE-3540**:
"1.7: REBRAND — remove 'Paperclip' everywhere except the license notice".

---

## 1. Executive Summary & Mandate

Per the Owner Decision of 02.10:
> "In release 1.7, remove 'Paperclip' from everything **except the MIT license notice** (LICENSE plus a third-party notices file; a 'Based on Paperclip (MIT)' line in About Myrmidon is fine)."

All phases of this epic were partitioned into 17 focused subtasks (OPE-4154 through OPE-12083), implemented in code, documented, verified via automated CI test suites, and merged into `main`.

---

## 2. Implementation Traceability Matrix

| Epic Scope / Requirement | Subtasks | PR & Merged Commits | Verification & Automated Test Gates |
|---|---|---|---|
| **UI Strings & Visible Copy** (~740 occurrences in `ui/src`, page titles, empty states, toasts) | **OPE-4154** (REBRAND A)<br>**OPE-10177** (Client Shell) | **PR #1233** (`24a68f3d`)<br>**PR #2134** (`a5b3e511`) | • Product name parameterized via i18n (`PRODUCT_NAME = 'Myrmidon'`).<br>• `ui/src/lib/myrmidon-branding-guard.myrmidon.test.ts` protects against leaks.<br>• Tab titles, favicon, og-tags, empty states, and sidebar updated. |
| **Server Texts, Emails, Installer, CLI** | **OPE-4155** (REBRAND B)<br>**OPE-12039** (REBRAND T)<br>**OPE-10214** (CLI Diagnostics)<br>**OPE-10267** (API Errors) | **PR #507** (`417434ea`)<br>**PR #2545** (`c58cfe95`)<br>**PR #2290** (`2c0979c4`)<br>**PR #2214** (`976692b1`) | • Server constant `PRODUCT_NAME = 'Myrmidon'` across emails, logs, and CLI banners.<br>• Diagnostic messages and error payloads cleansed of legacy vendor references.<br>• Regression test suite verifies email templates and CLI output formatting. |
| **User & Operator Documentation** (~14k mentions) | **OPE-4158** (REBRAND E) | **PR #555** (`0ade85e8`) | • Full documentation sweep replacing legacy brand with Myrmidon across `docs/`.<br>• Automated doc-guard `scripts/myrmidon/docs-branding-guard.mjs` added to CI.<br>• Published `docs/myrmidon/guides/docs-branding.md`. |
| **Package Names & Scope** (`@paperclipai/*` → `@myrmidonai/*`) | **OPE-8645** (Package Scope) | **PR #1545** (`f326ceee`) | • Package references and workspaces migrated.<br>• CI passes on clean dependency tree. |
| **Environment Variables** (`PAPERCLIP_*` → `MYRMIDON_*`) | **OPE-4156** (REBRAND C) | **PR #1194** (`29346fbf`) | • Universal env alias helper `packages/shared/src/env-alias.ts`.<br>• Reads `MYRMIDON_*` first; falls back to `PAPERCLIP_*` with a single deprecation notice.<br>• Both spellings written to child bot environments (`writeProductEnv`).<br>• Full mapping documented in `docs/myrmidon/SETTINGS.md` & `env-names-alias.md`.<br>• Verified by `packages/shared/src/env-alias.myrmidon.test.ts` and `server/src/__tests__/env-alias.myrmidon.test.ts`. |
| **Database & API Paths** | **OPE-8646** (DB Naming)<br>**OPE-12082** (API Aliases) | **PR #2807** (`04f01eca`) | • Database schema confirmed clean of raw vendor branding in table names.<br>• Express middleware `apiPathAliasMiddleware` (`server/src/myrmidon/api-path-aliases.ts`) transparently rewrites `/api/paperclip/*` to `/api/myrmidon/*`.<br>• Verified by `server/src/__tests__/api-path-aliases.myrmidon.test.ts`. |
| **MCP Tool Names** (`paperclip*` → `myrmidon*`) | **OPE-4157** (REBRAND D)<br>**OPE-12083** (Tool Aliases) | **PR #568** (`8ddb5a83`) | • Board MCP server registers all 42 tools as `myrmidon*` (e.g. `myrmidonListIssues`).<br>• Old `paperclip*` names retained as registered aliases for 1 release with deprecation marker.<br>• Verified by `packages/mcp-server/src/tool-aliases.test.ts`. |
| **HTTP Response Headers** (`X-Paperclip-*` alongside `X-Myrmidon-*`) | **OPE-10175** (Headers Audit) | **PR #2017** (`556c8b9b`) | • Server emits `X-Myrmidon-*` headers with legacy `X-Paperclip-*` headers preserved.<br>• Verified by `server/src/__tests__/headers.myrmidon.test.ts`. |
| **OpenAPI / Swagger Specification** | **OPE-10176** (Metadata) | **PR #2343** (`74ede24e`) | • OpenAPI document title, description, and schemas updated to Myrmidon brand.<br>• Verified by OpenAPI schema validation tests. |
| **Build-Time Verification Gate** (Vendor name only in About & License) | **OPE-4159** (REBRAND F) | **PR #2103** (`d4fef9cc`) | • CI gate `scripts/myrmidon/brand-release-audit.mjs` checks built UI bundle and endpoint snapshots.<br>• Enforces that only allowed exceptions (LICENSE, Notice, "Based on Paperclip (MIT)" in About) contain vendor name.<br>• Verified by `scripts/myrmidon/brand-release-audit.test.mjs`. |

---

## 3. Upstream Sync Strategy & Owner Decision

- **Constraint:** Upstream sync feasibility vs. standalone fork maintenance.
- **Formal Decision:** Documented in Owner/ADM decision of 21.10 (OPE-8647):
  *"Решение ADM 21.10: форк окончательный; тикет — оценка выборочного переноса, не upstream-sync."*
- **Policy:** As defined in `CONVENTIONS.md` §8 & §11 and `DIVERGENCE.md`:
  1. Automated bulk merging of upstream releases (`vendor-sync`) is discontinued for structural rebrand areas.
  2. Individual useful upstream features or critical bugfixes are selectively ported via targeted cherry-picks (`git cherry-pick -x`) into isolated Myrmidon modules (`server/src/myrmidon/*`).
  3. Every ported vendor commit is attributed with `(cherry picked from commit ...)` and tracked with its own divergence ID.

---

## 4. Compatibility Strategy (1-Release Grace Period)

To ensure that existing deployments, external scripts, and agent skill packages continue to function without interruption during the 1.7 lifecycle:

1. **Environment Variables:**
   - Precedence: `MYRMIDON_<NAME>` takes precedence.
   - Fallback: `PAPERCLIP_<NAME>` is accepted if the new variable is unset.
   - Telemetry/Notice: Emits a single warning to stdout/logs per process execution.
   - Child Process Environment: `writeProductEnv` injects both variables into spawned agent and tool execution contexts.
2. **MCP Tools:**
   - Both `myrmidon*` and `paperclip*` tool names are actively registered in MCP server capabilities.
   - Legacy names route to identical handlers and schema definitions.
   - Descriptions clearly mark legacy names as deprecated aliases scheduled for removal in 1.8.
3. **API Endpoints:**
   - `/api/paperclip/*` routes are transparently handled via internal URL rewrite middleware to `/api/myrmidon/*` without 30x redirection.
4. **Network & Hostnames:**
   - The deploy container is named `myrmidon-board`, with `paperclip-server-1` retained as an alias in Docker network DNS (`docs/myrmidon/board-rename-runbook.md`).
5. **Wire Headers:**
   - Both `X-Myrmidon-Run-Id` / `X-Paperclip-Run-Id` are accepted and emitted.
