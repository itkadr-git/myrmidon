---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## divergence
| HERMES-SKILLS-A | Адаптер `hermes_gateway` доставляет навыки компании в прогон шлюза через тело запроса: перед `POST /v1/runs` сверка `reconcileGatewayPaperclipSkills` канонизирует `paperclipRuntimeSkills` карточки (тот же контракт, что читает `src/server/skills.ts`), читает SKILL.md каждого нужного навыка из его источника, собирает поле `paperclip_skills` (`{path, name, content}`) и отказывает старт прогона с «Cannot start without the required Paperclip-managed skills», пока хоть один нужный навык не подтверждён. Маршрут доставки закреплён в шапке модуля: у API шлюза нет эндпоинта записи навыков профиля (профильный маршрут невозможен), поэтому взято поле тела прогона. Приёмная половина факт-чека — в патче образа 12: шлюз материализует записи в `skills/paperclip-managed/` профиля прогона внутри `_profile_scope` до старта модели, перечитывает корень навыков и роняет прогон при пропаже записи | `packages/adapters/hermes/src/gateway/server/execute.ts` (вызов сверки и поле `paperclip_skills` в теле прогона, метка `myrmidon(1.6.6-HERMES-SKILLS-A)`); + наши `packages/adapters/hermes/src/gateway/server/myrmidon-skills-reconcile.ts`, `docker/bot-runtime/patches/12-run-scoped-paperclip-skills.patch` (плюс `tools/run_skills.py` в образе), запись в `scripts/myrmidon/hermes-upstream/deltas.json` | Gateway-агенты молча работали без навыков компании: у адаптера нет доступа к ФС шлюза, а в API шлюза нет эндпоинта записи навыков профиля. Пункт 1.6.6 HERMES-SKILLS ч.A | `packages/adapters/hermes/src/gateway/server/myrmidon-skills-reconcile.myrmidon.test.ts`; сторожи образа `scripts/myrmidon/bot-runtime/dockerfile.test.mjs` и `scripts/myrmidon/hermes-upstream/hermes-upstream-check.test.mjs` (патч 12 в таблице README и в реестре дельт) | Никогда, наше поведение, пока у API шлюза нет записи навыков профиля. При переносе сохранять куски с меткой `myrmidon(1.6.6-HERMES-SKILLS-A)` и `myrmidon(G1)` в патче; снимать, если апстрим hermes примет поле прогона для навыков или эндпоинт записи навыков профиля (см. условие снятия дельты 12 в `deltas.json`) | (этот PR) |

## changelog-en

- hermes_gateway runs now resume across a board restart: the pre-reaper
  reattach sweep uses the gateway run ID saved on the heartbeat run, so an
  in-flight run can finish and its result remains visible instead of being
  lost or started again. A gateway HTTP 429 means "busy", not failure:
  `transient_upstream` keeps the run idle for retry, honoring `Retry-After`
  for up to 8 attempts with a one-hour ceiling. Cancelling the board run sends
  `POST /v1/runs/{id}/stop` to stop its gateway run. To verify, restart the
  board while a gateway run is active; confirm it completes and its result is
  visible in the board.

- hermes_gateway adapter now reconciles Paperclip-managed skills before POST
  /v1/runs: the run carries its desired skills in the paperclip_skills body
  field, the gateway materializes them into the agent profile's
  skills/paperclip-managed segment before the model starts, and the run fails
  with "Cannot start without the required Paperclip-managed skills" unless
  every desired entry is verified on the gateway side. Previously gateway
  agents silently ran without any company skills.

## changelog-ru

- Прогоны hermes_gateway теперь продолжаются после перезапуска доски:
  выполняемый до reaper sweep использует сохранённый в heartbeat run ID
  шлюзового прогона, поэтому активный прогон может завершиться, а его
  результат останется виден вместо потери или повторного запуска. HTTP 429
  от шлюза означает «занят», а не ошибку: `transient_upstream` оставляет
  прогон в ожидании повтора, учитывая `Retry-After`; допускается до 8 попыток
  с пределом в один час. При отмене прогона на доске отправляется
  `POST /v1/runs/{id}/stop`, чтобы остановить прогон шлюза. Проверка:
  перезапустить доску во время активного gateway-прогона и убедиться, что
  он завершился, а его результат виден на доске.

- Адаптер hermes_gateway теперь сверяет управляемые навыки Paperclip до POST
  /v1/runs: ран несёт нужные навыки в поле paperclip_skills, шлюз материализует
  их в сегмент skills/paperclip-managed профиля агента до старта модели, и ран
  падает с «Cannot start without the required Paperclip-managed skills», если
  хотя бы один нужный навык не подтверждён чтением на стороне шлюза. Раньше
  gateway-агенты молча работали без навыков компании.
