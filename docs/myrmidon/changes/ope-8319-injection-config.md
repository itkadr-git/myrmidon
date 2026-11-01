---
divergence-section: 1.6.1 — GUARDRAILS-B: флаг prompt-injection на недоверенном входе (очередь пробуждений)
settings-section: 1.6.1 — GUARDRAILS (untrusted-input flagging layer)
---

## changelog-en

### GUARDRAILS injection configuration in Company Settings (OPE-8319)

- Company Settings → Guardrails now stores `guardrailModes.injectionConfig` (`enabled`, `scoreThreshold`) and shows the effective values and provenance. Runtime precedence is environment override > UI setting > default, including explicit environment `false`; legacy mode overrides are preserved. The score threshold is constrained to 0..1 (UI step 0.05); the default is 0.6.

## changelog-ru

### Настройки injection GUARDRAILS в параметрах компании (OPE-8319)

- Экран «Параметры компании → Guardrails» сохраняет `guardrailModes.injectionConfig` (`enabled`, `scoreThreshold`) и показывает эффективные значения и их источник. Приоритет runtime: переопределение окружением > настройка интерфейса > умолчание, включая явное `false` в окружении; прежние переопределения режимов сохраняются. Порог score ограничен диапазоном 0..1 (шаг интерфейса 0,05); умолчание — 0,6.

## divergence

| 1.6.6-GRD-INJECTION-CONFIG | `guardrailModes.injectionConfig` is operator-editable in Company Settings → Guardrails; effective enabled/threshold and provenance are returned by the Guardrails API. Environment overrides (including explicit false) take precedence over UI settings, then defaults; existing mode overrides remain intact. | `packages/shared/src/myrmidon-guardrail-modes.ts`; `server/src/myrmidon/guardrails/{modes,routes}.ts`; `server/src/modules/wake-queue/{index.ts,application/queued-comment-use-cases.ts}`; `ui/src/components/myrmidon/guardrails/*`; `ui/src/i18n/myrmidon-locales/{en,ru}.json` | The legacy detector was environment-only and had no settings UI/API roundtrip. | Shared resolver tests; Guardrails route/UI tests; wake-queue guardrail integration tests | Never, this is Myrmidon behavior. Remove only when upstream provides the same settings, precedence, and provenance contract. | #2223 |

## settings-en-replace

| `MYRMIDON_GUARDRAILS_INJECTION_SCORE` | GUARDRAILS-B | `0.6` | Score threshold at which the heuristic scan sets `flagged: true`. `0` flags everything, `1` flags nothing | Unset, empty, non-numeric or outside 0..1 — the UI setting; the legacy environment value takes precedence when set |

## settings-ru-replace

| `MYRMIDON_GUARDRAILS_INJECTION_SCORE` | GUARDRAILS-B | `0.6` | Порог балла, при котором скан ставит `flagged: true`. `0` — флагается всё, `1` — ничего | Не задана, пуста, не число или вне 0..1 — настройка интерфейса; заданное значение окружения имеет приоритет |
