// myrmidon(1.7-TG-LOCALE): Russian catalog — the pilot-chat wording of the
// bridged Telegram DM, kept byte-for-byte from the pre-localization Russian
// literals. Same key set as ./en.ts (a parity test guards it).
import type { BridgeTextKey } from "./en.js";

export const bridgeTextRu: Record<BridgeTextKey, string> = {
  // Telegram command-menu descriptions (setMyCommands per language).
  "menu.help": "Показать команды",
  "menu.new": "Начать новую сессию (необязательно: /new <модель>)",
  "menu.model": "Показать или сменить модель для этого чата",
  "menu.think": "Показать или задать глубину рассуждений",
  "menu.stop": "Остановить текущий ответ",
  "menu.status": "Показать модель, сессию и текущий ответ",
  "menu.plan": "Превратить сообщение в план эпика (только владелец компании)",
  "menu.accept": "Принять карточку плана (только владелец компании)",
  "menu.reject": "Отклонить карточку плана (только владелец компании)",

  // /help
  "help.intro": "Здесь вы общаетесь с {agent}. Задачи из этого чата создаются по необходимости.",
  "help.menuLine": "/{command} — {description}",
  "help.footer": "/model и /think действуют только на этот чат в Telegram.",

  // Shared refusals
  "chat.notAvailable": "Этот чат недоступен.",
  "turn.inProgress": "Сейчас идёт ответ. Попробуйте после него или отправьте /stop.",

  // /close and /task compatibility replies
  "close.reply": "Этот чат не закрывается. Чтобы начать заново, отправьте /new.",
  "task.reply": "В личном чате просто напишите свой запрос.",

  // Unknown command
  "unknown.command": "Неизвестная команда /{name}. Список команд — /help.",

  // /new
  "new.notice": "Новая сессия начата. История остаётся на доске.",
  "new.withModel.notice": "Новая сессия начата с моделью {model}. История остаётся на доске.",

  // Value-source labels for /model, /think and /status
  "source.thisChat": "этот чат",
  "source.agentDefault": "по умолчанию у агента",
  "source.adapterDefault": "по умолчанию у адаптера",

  // /model and /think
  "model.statusLabel": "Модель",
  "reasoning.statusLabel": "Рассуждения",
  "model.unavailable": "Смена модели недоступна для этого агента.",
  "reasoning.unavailable": "Смена глубины рассуждений недоступна для этого агента.",
  "model.unknownNoun": "Неизвестная модель",
  "reasoning.unknownNoun": "Неизвестная глубина рассуждений",
  "chooser.effective": "{label}: {value} ({source}).",
  "chooser.availableHeader": "Доступно:",
  "chooser.usage": "Укажите /{command} <имя или номер> либо /{command} default.",
  "chooser.agentDefaultParen": "по умолчанию у агента ({value})",
  "chooser.defaultApplied": "{label} для этого чата: {agentDefault}.",
  "chooser.set": "{label} для этого чата: {value}. Следующий ответ начнёт новую сессию модели с недавней историей этого чата.",
  "chooser.unknownError": "{noun} «{value}».\n{list}",

  // /stop
  "stop.unavailable": "Сейчас остановка недоступна.",
  "stop.stopping": "Останавливаю текущий ответ.",
  "stop.idle": "Сейчас ничего не выполняется.",

  // /status
  "status.header": "{agent} · чат в Telegram",
  "status.board": "Доска: {url}",
  "status.model": "Модель: {value} ({source})",
  "status.reasoning": "Рассуждения: {value} ({source})",
  "status.session": "Сессия: #{number}, сессия модели {state}",
  "status.sessionActive": "активна",
  "status.sessionPending": "начнётся заново со следующим ответом",
  "status.nowIdle": "Сейчас: простаивает",
  "status.nowQueued": "Сейчас: в очереди",
  "status.nowReplying": "Сейчас: отвечает с {time}",
  "status.usage": "Последний ответ: {input} вх. / {output} исх. токенов{cost}",
  "status.webChat": "Веб-чат: {state}",
  "status.webChat.shared": "общий (последние {number} сообщений)",
  "status.webChat.none": "нет",
  "status.webChat.off": "не общий",

  // /plan
  "plan.notOwner": "Команда /plan доступна только владельцу компании.",
  "plan.empty": "Напишите запрос после команды: /plan <что нужно спланировать>.",
  "plan.failed": "Не удалось создать план. Попробуйте позже или напишите запрос текстом.",

  // Bridge notices
  "bridge.migrated": "Теперь это постоянный чат с {agent}. Прежние задачи остаются на доске{linkSuffix}",
  "bridge.linkWith": ": {url}",
  "bridge.linkNone": ".",
  "bridge.thisAgent": "этим агентом",
  "bridge.refusalUnlinked":
    "Этот бот доступен только участникам рабочего пространства. Попросите администратора привязать ваш аккаунт Telegram.",
};
