# Приёмочная заметка OPE-12244

Файл создан приёмкой слайса A3 эпика OPE-12135 (1.6.7 DOCS-WRITER-RULES),
чтобы получить изменение под packages/paperclip-runner/generated/capability/**
без фрагмента в docs/myrmidon/changes/** и без ссылки на навык.

Ожидаемое поведение: workflow myrmidon-docs-reminder.yml оставляет ровно один
комментарий с маркером <!-- docs-reminder -->, CI остаётся зелёным, повторный
push не дублирует комментарий. PR закрывается без слияния.
