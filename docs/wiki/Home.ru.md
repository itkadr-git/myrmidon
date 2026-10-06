# Вики Myrmidon

Myrmidon — self-hosted плоскость управления флотом ИИ-агентов: доска задач,
на которой агенты разбирают работу, выполняют её в изолированных контейнерах
— со своей моделью, ключами и памятью, — отчитываются и спрашивают человека
только там, где нужно решение. Это самостоятельный продукт, развиваемый как
форк [Paperclip](https://github.com/paperclipai/paperclip) (лицензия MIT
сохраняется).

English versions of the pages carry no suffix, e.g. [Home](Home).

## Страницы

- [Системные требования](System-requirements.ru) — что нужно на хосте: ПО,
  Docker, база данных, порты, диск под данные ботов.
- [Установка с нуля](Installation.ru) — от чистого сервера до работающей
  доски и первого агента.
- [Обновление и откат](Upgrading-and-rollback.ru) — `deploy.sh --release`,
  кандидаты и финальные выпуски, проверка на копии базы.
- [Настройки в интерфейсе](Settings-in-the-interface.ru) — где меняются
  лимиты запусков, параллельные ходы агента и бэкапы.
- [Быстрый старт](Quick-start.ru) — краткий путь, сжатый из «Установки».

## Выпуски

- [Выпуски на GitHub](https://github.com/itkadr-git/myrmidon/releases) —
  финальные выпуски и RC-предрелизы с манифестами digest.
- [Журнал изменений](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.ru.md)
  ([English](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.md))
  — что вошло в какую версию.
- Выкат фиксируется по digest образа, никогда по тегу; скрипт выката принимает
  только образы, собранные CI из `main` или тега `myr-v*`.

## Источники

Эти страницы ведутся в репозитории в `docs/wiki/` и синхронизируются сюда
автоматически при каждом слиянии в `main` и на каждом выпуске. Каждое
утверждение здесь находится в
[`docs/myrmidon/`](https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon)
— документации продукта, журнале изменений и руководствах оператора.
