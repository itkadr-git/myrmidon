## changelog-en

### Bot replies are no longer cut at 2000 characters (TG-REPLY-FULL)

- The Hermes adapters (local and gateway) used to copy only the first 2,000
  characters of the answer into the run summary, which the chat bridge delivers to
  the owner when the run has no separate final message. Long answers therefore
  arrived in Telegram cut off. The summary now carries the whole answer; the
  existing Telegram publication path then splits anything above the 4,096 limit into
  ordered messages at paragraph, line, then word boundaries (and sends long
  structured Markdown as one attached document). Nothing is silently dropped.

## changelog-ru

### Ответы бота больше не обрезаются на 2000 символов (TG-REPLY-FULL)

- Адаптеры Hermes (local и gateway) раньше копировали в сводку прогона только
  первые 2 000 символов ответа, и chat bridge доставлял владельцу именно её,
  если у прогона не было отдельного финального сообщения. Длинные ответы поэтому
  приходили в Telegram обрезанными. Теперь сводка несёт весь ответ целиком;
  существующий путь публикации в Telegram затем разбивает всё, что длиннее
  4 096 символов, на упорядоченные сообщения по границам абзацев, строк, затем
  слов (а длинный структурированный Markdown отправляет одним вложенным
  документом). Ничего не теряется молча.
