## changelog-en

### SKILLS-UI part A: skills from agentskills.io sites, verified by digest (SKILLS-UI-A)

- New server route `POST /api/companies/:companyId/skills/discover` with body
  `{ source }`: give it a bare vendor site (for example `https://kie.ai`) and it
  reads the published discovery index
  (`/.well-known/agent-skills/index.json`, HTTPS only, 15 s timeout, 2 MB cap)
  and answers `{ skills: [{ name, description, digest, url }] }` with absolute
  archive URLs. A site that does not publish the index, an unreachable host, or
  a malformed index each produce a clear 422 with a stable code. The route runs
  the same skill-import policy gate and activity log as the existing import.
- `POST /api/companies/:companyId/skills/import` now accepts
  `{ source, skillName }` for those sites. The server downloads the selected
  tar.gz (20 MB cap), verifies its SHA-256 against the digest the index
  advertises (a mismatch rejects the import with 422 and writes nothing), then
  unpacks it with a hardened reader that refuses absolute paths, `..` traversal,
  symlink and hardlink entries, and oversized expansion. The SKILL.md and the
  skill's files are stored under the company managed-skills root as a new
  `well_known` source; skills.sh-style sources keep their old behavior.
- Re-import is update: the same digest changes nothing, a new digest stores the
  new files and records a new skill version labeled with the short hash.
- Each imported external skill now carries `requiredEnv` in its metadata, and
  `GET /api/companies/:companyId/skills/:id` returns it as `requiredEnv:
  string[]`: environment names read from the SKILL.md text by pattern
  (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, explicit `os.environ` /
  `process.env` / `$VAR` references). It is advisory metadata for the
  key-provisioning UI (part B), never a credential.

## changelog-ru

### SKILLS-UI часть A: навыки с сайтов agentskills.io с проверкой по дайджесту (SKILLS-UI-A)

- Новый серверный маршрут `POST /api/companies/:companyId/skills/discover` с
  телом `{ source }`: передайте адрес сайта вендора (например `https://kie.ai`) —
  сервер читает опубликованный индекс обнаружения
  (`/.well-known/agent-skills/index.json`, только HTTPS, таймаут 15 с, предел
  2 МБ) и отвечает `{ skills: [{ name, description, digest, url }] }` с
  абсолютными ссылками на архивы. Сайт без индекса, недоступный хост или битый
  формат дают понятную ошибку 422 со стабильным кодом. Маршрут проверяет права
  по политике навыков и пишет activity-log, как существующий импорт.
- `POST /api/companies/:companyId/skills/import` теперь принимает
  `{ source, skillName }` для таких сайтов. Сервер качает выбранный tar.gz
  (предел 20 МБ), сверяет SHA-256 с дайджестом из индекса (несовпадение — 422,
  ничего не записывается), затем распаковывает защищённым читателем: абсолютные
  пути, `..`, симлинки и хардлинки, чрезмерное разрастание — отказ. SKILL.md и
  файлы навыка сохраняются под управляемым каталогом навыков компании как
  новый источник `well_known`; прежние источники работают как раньше.
- Повторный импорт — это обновление: тот же дайджест ничего не меняет, новый
  дайджест сохраняет новые файлы и создаёт новую версию навыка с коротким хешем
  в названии.
- Каждый импортированный внешний навык теперь хранит `requiredEnv` в метаданных,
  а `GET /api/companies/:companyId/skills/:id` отдаёт его как `requiredEnv:
  string[]`: имена переменных окружения, извлечённые из текста SKILL.md по
  шаблонам (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, явные ссылки
  `os.environ` / `process.env` / `$VAR`). Это справочные данные для интерфейса
  ключей (часть B), а не секреты.

## divergence-new

### 1.6.6 — SKILLS-UI A: обнаружение agentskills.io и импорт архивов по дайджесту (сервер)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-SKILLS-UI-A | agentskills.io discovery and digest-verified import for Company Skills: маршрут `POST /skills/discover`, импорт `{ source, skillName }` с проверкой sha256 и защищённой распаковкой tar.gz, поле `requiredEnv` в метаданных и в ответе детали навыка. | Вендор: `server/src/services/company-skills.ts` (well-known layer), `server/src/routes/company-skills.ts` (`skills/discover`, `skillName`), `packages/shared` (union `well_known`, `CompanySkillDiscoverResult`, `requiredEnv` на детали). | Источники навыков раньше: GitHub/skills.sh/URL/локальный путь; целостность архивов не проверялась; требуемые переменные окружения нигде не отдавались. | `server/src/__tests__/company-skills-well-known.test.ts` (обнаружение по моковому индексу, отказ некорректного источника и битого индекса, импорт с верным дайджестом и requiredEnv, mismatch → 422, traversal/absolute/symlink → 422, повторный импорт: тот же дайджест — тишина, новый — новая версия) | Снять: удалить well-known слой из сервиса и маршрута, значения union и поле `requiredEnv` — поведение прежних источников не затронуто | (этот PR) |
