## changelog-en

### Support api_version field in stack http-version probe (OPE-12568)

- Extended stack registry `http-version` probe to support JSON responses containing either `version` or `api_version` field, allowing live version collection for Hindsight FastAPI endpoints.

## changelog-ru

### Поддержка поля api_version в http-зонде версий стека (OPE-12568)

- В http-зонде версий реестра стека добавлена поддержка JSON-ответов с полем `api_version` наряду с `version`, что обеспечивает определение версии работающего сервиса Hindsight.
