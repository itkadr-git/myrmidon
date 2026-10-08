---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## divergence
| HERMES-SKILLS-A | Адаптер `hermes_gateway` доставляет навыки компании в прогон шлюза через тело запроса: перед `POST /v1/runs` сверка `reconcileGatewayPaperclipSkills` канонизирует `paperclipRuntimeSkills` карточки (тот же контракт, что читает `src/server/skills.ts`), читает SKILL.md каждого нужного навыка из его источника, собирает поле `paperclip_skills` (`{path, name, content}`) и отказывает старт прогона с «Cannot start without the required Paperclip-managed skills», пока хоть один нужный навык не подтверждён. Маршрут доставки закреплён в шапке модуля: у API шлюза нет эндпоинта записи навыков профиля (профильный маршрут невозможен), поэтому взято поле тела прогона. Приёмная половина факт-чека — в патче образа 12: шлюз материализует записи в `skills/paperclip-managed/` профиля прогона внутри `_profile_scope` до старта модели, перечитывает корень навыков и роняет прогон при пропаже записи | `packages/adapters/hermes/src/gateway/server/execute.ts` (вызов сверки и поле `paperclip_skills` в теле прогона, метка `myrmidon(1.6.6-HERMES-SKILLS-A)`); + наши `packages/adapters/hermes/src/gateway/server/myrmidon-skills-reconcile.ts`, `docker/bot-runtime/patches/12-run-scoped-paperclip-skills.patch` (плюс `tools/run_skills.py` в образе), запись в `scripts/myrmidon/hermes-upstream/deltas.json` | Gateway-агенты молча работали без навыков компании: у адаптера нет доступа к ФС шлюза, а в API шлюза нет эндпоинта записи навыков профиля. Пункт 1.6.6 HERMES-SKILLS ч.A | `packages/adapters/hermes/src/gateway/server/myrmidon-skills-reconcile.myrmidon.test.ts`; сторожи образа `scripts/myrmidon/bot-runtime/dockerfile.test.mjs` и `scripts/myrmidon/hermes-upstream/hermes-upstream-check.test.mjs` (патч 12 в таблице README и в реестре дельт) | Никогда, наше поведение, пока у API шлюза нет записи навыков профиля. При переносе сохранять куски с меткой `myrmidon(1.6.6-HERMES-SKILLS-A)` и `myrmidon(G1)` в патче; снимать, если апстрим hermes примет поле прогона для навыков или эндпоинт записи навыков профиля (см. условие снятия дельты 12 в `deltas.json`) | (этот PR) |

## changelog-en

- hermes_gateway adapter now reconciles Paperclip-managed skills before POST
  /v1/runs: the run carries its desired skills in the paperclip_skills body
  field, the gateway materializes them into the agent profile's
  skills/paperclip-managed segment before the model starts, and the run fails
  with "Cannot start without the required Paperclip-managed skills" unless
  every desired entry is verified on the gateway side. Previously gateway
  agents silently ran without any company skills.

## changelog-ru

- Адаптер hermes_gateway теперь сверяет управляемые навыки Paperclip до POST
  /v1/runs: ран несёт нужные навыки в поле paperclip_skills, шлюз материализует
  их в сегмент skills/paperclip-managed профиля агента до старта модели, и ран
  падает с «Cannot start without the required Paperclip-managed skills», если
  хотя бы один нужный навык не подтверждён чтением на стороне шлюза. Раньше
  gateway-агенты молча работали без навыков компании.
