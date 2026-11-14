---
settings-section: Track 5 — operations
---

## changelog-en

### RELEASE-STAGE: signed release-verification verdict binds the GitHub release publish to the verified candidate SHA (OPE-13017)

- The `POST /issues/:id/release-verify` route now signs its verdict with HMAC-SHA256 over the canonical `verdict|deployedVersion|checkedAt|issueId` string, keyed by `MYRMIDON_RELEASE_VERIFICATION_KEY` (legacy alias `PAPERCLIP_RELEASE_VERIFICATION_KEY`), and returns the `deployedVersion` as the build commit SHA.
- `scripts/myrmidon/release/publish-github-release.sh` enforces the verification gate on the production publish path: without a confirmed verdict for the exact tag SHA (or with a signature that does not verify) the publish refuses — fail closed. An explicit `MYRMIDON_RELEASE_SKIP_VERIFICATION=1` rehearsal escape only dry-runs the pipeline and never creates or edits a GitHub Release.
- New CLI `scripts/myrmidon/release/fetch-release-verdict.mjs` fetches the signed verdict from the board into a file for the publish workflow; `.github/workflows/myrmidon-release.yml` runs it before the publish step and passes the verdict file to the publisher.

## changelog-ru

### RELEASE-STAGE: подписанный вердикт проверки версии привязывает публикацию GitHub release к проверенному SHA кандидата (OPE-13017)

- Роут `POST /issues/:id/release-verify` теперь подписывает вердикт HMAC-SHA256 по канонической строке `verdict|deployedVersion|checkedAt|issueId` на ключе `MYRMIDON_RELEASE_VERIFICATION_KEY` (устаревший псевдоним `PAPERCLIP_RELEASE_VERIFICATION_KEY`) и возвращает `deployedVersion` как SHA коммита сборки.
- `scripts/myrmidon/release/publish-github-release.sh` делает проверку обязательной на боевом пути публикации: без подтверждённого вердикта для точного SHA тега (или с неподтвердившейся подписью) публикация отказывает — fail closed. Явный rehearsal-обход `MYRMIDON_RELEASE_SKIP_VERIFICATION=1` только прогоняет пайплайн как dry run и не создаёт и не редактирует GitHub Release.
- Новый CLI `scripts/myrmidon/release/fetch-release-verdict.mjs` забирает подписанный вердикт с доски в файл для публикационного workflow; `.github/workflows/myrmidon-release.yml` запускает его перед шагом публикации и передаёт файл вердикта публикатору.

## settings-en

| `MYRMIDON_RELEASE_VERIFICATION_KEY` | OPE-13017 | unset | Shared HMAC secret binding the release-verify verdict to the publish gate: the board signs `verdict|deployedVersion|checkedAt|issueId` with it, and `publish-github-release.sh` refuses to publish when the signature does not verify. The value must match the GitHub Actions secret of the same name on the publish workflow. Unset — the route responds without a signature and the publish gate fails closed. | Unset — signing is off and the publish gate refuses (fail closed). There is no safe "disable": both sides must carry the same secret for a verified release. Legacy alias: `PAPERCLIP_RELEASE_VERIFICATION_KEY`. |

## settings-ru

| `MYRMIDON_RELEASE_VERIFICATION_KEY` | OPE-13017 | не задана | Общий HMAC-секрет, связывающий вердикт проверки версии с гейтом публикации: доска подписывает им строку `verdict|deployedVersion|checkedAt|issueId`, а `publish-github-release.sh` отказывает в публикации, если подпись не подтверждается. Значение должно совпадать с GitHub Actions-секретом с тем же именем на публикационном workflow. Не задана — роут отвечает без подписи и гейт публикации отказывает (fail closed). | Не задана — подпись выключена и гейт публикации отказывает (fail closed). Безопасного «выключения» нет: обе стороны должны нести один секрет для проверенного релиза. Устаревший псевдоним: `PAPERCLIP_RELEASE_VERIFICATION_KEY`. |
