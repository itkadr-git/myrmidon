# Пилот MinerU для CORPUS-2.0

> English version: [mineru-corpus-pilot.md](mineru-corpus-pilot.md)

В этом руководстве зафиксирован кандидат парсера MinerU, использованный в
пилоте CORPUS-2.0. Адаптер находится во внешнем репозитории
`BastionPrime/ops-tools`, а не в дереве продукта Myrmidon.

## Объём

PR #10 (`ope-5003-pilot-harness`, коммит `26346616`) добавляет и подключает
кандидат MinerU для прогона по 30 файлам:

- `parsers/mineru.py` — адаптер MinerU;
- `parsers/register_ope6520.py` и `parsers/run_ope6520.py` — регистрация и
  точка входа;
- `docker/Dockerfile.mineru` и `docker/constraints-mineru.txt` — образ среды и
  зафиксированные ограничения;
- `parsers/export_csv.py` и `parsers/tables_check.py` — выгрузка результатов и
  проверка таблиц;
- `results/mineru.csv` и `results/tables_check.mineru.tsv` — доказательства
  пилота;
- `README-part3.md` — инструкция оператора.

Кандидат развёрнут на `myr-dev-build` в
`/srv/pilot-corpus-2.0/`. Корневой раздел хоста дополнительно настроен
командой `tune2fs -m 1`, что освободило 4,2 ГБ.

## Доказательства критерия

В `results/mineru.csv` есть все 30 из 30 файлов. Прогон также измеряет CER на
10 сканах и валидирует таблицы по выводу проверки MinerU.

Проверки запускаются на стенде из `/srv/pilot-corpus-2.0/`:

```sh
.venv/bin/python3 -m pytest tests/test_cer.py -q
/home/build/venv-harness/bin/ruff check \
  parsers/mineru.py parsers/register_ope6520.py parsers/run_ope6520.py \
  parsers/tables_check.py parsers/export_csv.py
```

Зафиксированный результат: 11 тестов CER пройдены, Ruff завершился без
замечаний. Состояние стенда и PR — источники истины; при проверке нового
развёртывания проверки нужно выполнить повторно, а не считать эту страницу
живым статусом.

## Связанная работа

Кандидат закрывает часть MinerU в OPE-6520 / OPE-8313. Статус ревью и слияния
относится к PR #10 в `BastionPrime/ops-tools`; эта документация только
фиксирует расположение и способ проверки переданных доказательств.
