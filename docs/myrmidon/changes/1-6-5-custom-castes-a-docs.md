## changelog-en

### docs: custom castes (CUSTOM-CASTES A) — the company agent-role directory

- A new guide (EN+RU) describing the agent_castes directory: the fields of a caste, the twelve seeded built-ins, the REST contract under /api/myrmidon/companies/:id/castes including the DELETE reassignTo flow, and live reads with no restart.
- The stale 'until part A lands' wording in the CUSTOM-CASTES B section of SETTINGS.md/SETTINGS.ru.md is corrected (part A is in; the directory section itself comes from the 1-6-1-custom-castes-a fragment). The guides table points at the new guide, and the wiki settings page mentions the Agent castes screen.

## changelog-ru

### docs: custom castes (CUSTOM-CASTES A) — справочник каст компании

- Новый гайд (EN+RU) про справочник agent_castes: поля касты, двенадцать встроенных каст при первом чтении, REST-контракт /api/myrmidon/companies/:id/castes включая DELETE с reassignTo, живое чтение без перезапуска.
- Устаревшая фраза «пока часть A не слита» в секции CUSTOM-CASTES B файлов SETTINGS.md/SETTINGS.ru.md исправлена (часть A слита; секция самого справочника приходит из фрагмента 1-6-1-custom-castes-a). Таблица гайдов указывает на новый гайд, вики-страница настроек упоминает экран Agent castes.

## settings-en-append

<!-- section: 1.6.1 — CUSTOM-CASTES B: caste-directory consumers (role validator, swarm gate) -->
Update: part A has landed. The directory is the `agent_castes` table described in [guides/custom-castes.md](guides/custom-castes.md); the "until part A lands" wording above no longer applies, and a role with no directory entry behaves exactly as before the directory.

## settings-en-replace

<!-- section: 1.6.1 — CUSTOM-CASTES B: caste-directory consumers (role validator, swarm gate) -->
| — | 1.6.1-CUSTOM-CASTES-B | — | This part adds no tunables of its own; the directory rows (`swarmEligible`, `maxActiveTasks`) come from part A's store, the swarm globals stay under `MYRMIDON_SWARM_*` | A role with no directory entry is unaffected; nothing to disable |

## settings-ru-append

<!-- section: 1.6.1 — CUSTOM-CASTES B: потребители справочника каст (валидатор роли, гейт роя) -->
Обновление: часть A слита. Справочник — таблица `agent_castes`, см. [guides/custom-castes.ru.md](guides/custom-castes.ru.md); формулировка «пока часть A не слита» выше больше не действует, а роль без записи в справочнике ведёт себя ровно как до справочника.

## settings-ru-replace

<!-- section: 1.6.1 — CUSTOM-CASTES B: потребители справочника каст (валидатор роли, гейт роя) -->
| — | 1.6.1-CUSTOM-CASTES-B | — | Эта часть не добавляет своих регуляторов; строки справочника (`swarmEligible`, `maxActiveTasks`) приходят из хранилища части A, глобальные настройки роя остаются под `MYRMIDON_SWARM_*` | Роль без записи в справочнике не затронута; отключать нечего |
