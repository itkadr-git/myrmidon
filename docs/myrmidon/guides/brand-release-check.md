# Brand release check (read-only, before the tag)

> DEBRAND 1.6.6 (OPE-8127). Краткая русская версия — в конце файла.

This is the manual, read-only pass over UI copy, bot/log texts and API
answers that the file-based guards cannot see. Run it before cutting a
release tag. It changes nothing: look, do not click through destructive
flows, do not edit runtime or configuration.

## 1. Repository gate (CI)

```bash
node scripts/myrmidon/docs-branding-guard.mjs        # docs/ — must be clean
node scripts/myrmidon/brand-release-audit.mjs        # root + docs/ — report mode
node scripts/myrmidon/brand-release-audit.mjs --gate # same, fails on findings
node --test scripts/myrmidon/brand-release-audit.test.mjs
```

Report mode prints the exact count and paths of non-allowlisted old-brand
mentions. A non-zero total is honest output: it means a parallel DEBRAND part
has not landed yet — record the number in the release report instead of
trimming the allowlist.

## 2. UI copy (read-only browser pass)

Open the board UI (regular and production account-menu variants) and check
that every human-visible string says Myrmidon:

- browser tab title and page titles (incl. breadcrumbs);
- the About screen: product name and the one attribution line
  "Based on Paperclip (MIT)" — this line MUST stay;
- sidebar version label and its aria-label;
- empty states, onboarding copy, error toasts, the new-issue dialog.

Search is allowed and encouraged: DevTools → Elements → search `Paperclip`
(case-sensitive). Allowed hits: the About attribution line, package names,
HTTP header names in network docs. Anything else in visible copy is a defect.

## 3. Bot and log texts (read-only)

- Watch an agent heartbeat run's live status in the owner DM: the product
  prefix must be Myrmidon. The old body "Paperclip needs a disposition
  before this issue can continue." is recognized as a legacy alias (kept one
  release, removed no earlier than 1.8) — receiving it from an OLD instance
  is expected; a NEW build sending it is a defect.
- `GET /api/…` JSON answers: error `message` and `details` fields, issue
  summaries, agent intros — no old brand in human-readable fields. Machine
  identifiers (`X-Paperclip-Run-Id` header, `PAPERCLIP_*` env names,
  `@paperclipai/*` package refs in payloads) are compatibility names and stay.
- Server logs of a running instance: grep the tail for `Paperclip` — hits in
  legacy-alias matchers are fine; hits in newly emitted lines are defects.

## 4. What is never a defect

- `LICENSE`, `NOTICE`, third-party notices (`ui/public/fonts/NOTICE.md`,
  `packages/adapters/hermes/LICENSE`): legal attribution, kept forever.
- The attribution line "Based on Paperclip (MIT)".
- Machine identifiers until their owning epic renames the code:
  `@paperclipai/*`, `PAPERCLIP_*`, `X-Paperclip-*`, `paperclipai` CLI,
  `skills/paperclip/`, the `paperclip` skill and API names, container/image/
  database example names in deploy docs, wire-protocol fields.
- External vendor services (Paperclip Cloud/Labs/EE/Enterprise/Runner).
- Historical records (CHANGELOG, tracks, old DIVERGENCE rows) — the state
  that was correct at the time.

## 5. Recording the result

In the release report state: gate output (count + paths), which control
points were checked by hand, and any residual finding with its path/category
and the epic that owns it. A red whole-repo audit before the parallel parts
land is an expected, reportable state — not a release blocker for this gate.

---

## Кратко (RU)

Read-only проверка перед тегом: (1) оба сторожа зелёные или их вывод записан
в отчёт с числом и путями; (2) в UI везде Myrmidon, кроме строки атрибуции
«Based on Paperclip (MIT)»; (3) живые статусы прогонов, ответы API и новые
строки логов — без старого бренда (старое тело recovery-уведомления —
легаси-алиас, его приём от старых инстансов нормален); (4) юридическая
атрибуция и машинные идентификаторы — не дефект; (5) результат — в отчёт
релиза с количеством/путями остатков и владельцем каждого.
