---
divergence-section: Трек 5 — эксплуатация
settings-section: 1.3 — STACK-UPDATES stack registry (SUA, parts A and B)
---

## changelog-en

### Stack component CVE advisory integration via OSV.dev (1.7-STACK-UPDATES-B)

- Stack registry release verification now queries known vulnerabilities from OSV.dev API (`/v1/querybatch`) for tracked components.
- Components with matching advisories report advisory markers (`vulnerabilities` list with CVE id, primary id, and normalized severity) alongside release divergence.
- When the advisory source is unreachable or times out, release checking degrades gracefully without failing.
- Advisory endpoint base URL is configurable via `MYRMIDON_STACK_OSV_API_BASE`.

## changelog-ru

### Сверка компонентов стека с базой уязвимостей OSV.dev (1.7-STACK-UPDATES-B)

- Проверка релизов компонентов стека в реестре stack-registry теперь запрашивает известные уязвимости через пакетный API OSV.dev (`/v1/querybatch`).
- Компоненты с найденными уязвимостями помечаются в реестре (`vulnerabilities`: id, cveId, severity, summary) вместе со статусом расхождения релизов.
- При недоступности или таймауте источника advisories проверка релизов мягко деградирует без сбоя сверки.
- Базовый URL API уязвимостей настраивается через переменную окружения `MYRMIDON_STACK_OSV_API_BASE`.

## divergence

| 1.7-STACK-UPDATES-B | Интеграция CVE-источников при сверке компонентов стека: пакетный опрос OSV.dev (`/v1/querybatch`), обогащение записи компонента списком `vulnerabilities` (CVE/GHSA/OSV id, нормализованная severity, summary), мягкая деградация при ошибках внешнего API | Наш код: `server/src/myrmidon/stack-registry/{advisory.ts,check.ts,domain.ts,settings.ts}`, тесты `stack-check.myrmidon.test.ts` | Задача OPE-12065 (1.7 STACK-UPDATES-B): сверка компонентов стека с базой CVE для своевременного обнаружения уязвимостей | `server/src/myrmidon/stack-registry/stack-check.myrmidon.test.ts` | Никогда, собственная функциональность реестра стека Myrmidon | (этот PR) |

## settings-en-append

| `MYRMIDON_STACK_OSV_API_BASE` | 1.7-STACK-UPDATES-B | `https://api.osv.dev` | Base URL for OSV.dev advisory API batch queries | Unset to use default `https://api.osv.dev` |

## settings-ru-append

| `MYRMIDON_STACK_OSV_API_BASE` | 1.7-STACK-UPDATES-B | `https://api.osv.dev` | Базовый URL API OSV.dev для пакетных запросов известных уязвимостей компонентов | Сбросить переменную для возврата к `https://api.osv.dev` |
