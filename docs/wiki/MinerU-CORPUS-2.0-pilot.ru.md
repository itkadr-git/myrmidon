# Пилот MinerU CORPUS-2.0

> English version: [MinerU-CORPUS-2.0-pilot](MinerU-CORPUS-2.0-pilot)

Кандидат MinerU описан в руководстве оператора
[Пилот MinerU для CORPUS-2.0](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/mineru-corpus-pilot.ru.md).
Это изменение во внешнем репозитории `BastionPrime/ops-tools`, а не компонент
продукта Myrmidon.

PR #10 (`ope-5003-pilot-harness`, коммит `26346616`) добавляет адаптер,
регистрацию и точку входа, ограничения среды Docker, выгрузку CSV, проверку
таблиц и файлы доказательств для прогона CORPUS-2.0 по 30 файлам. Кандидат
развёрнут в `/srv/pilot-corpus-2.0/` на `myr-dev-build`.

Доказательства покрывают 30 из 30 файлов, CER на 10 сканах и проверку таблиц.
Для повторения зафиксированных проверок используйте команды из связанного
руководства. Зафиксированный результат — 11 пройденных тестов CER и чистый
прогон Ruff.