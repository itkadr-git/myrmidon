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

  // /accept and /reject (1.6.3-CTO-CHAT-B)
  "accept.noId": "Укажите ID карточки: /accept <id> — ID карточки с планом из ответа бота.",
  "accept.notPlanOrProcessed": "Эта карточка не является предложением задач или уже обработана.",
  "accept.ok": "✅ План принят.\n\nЭпик: {epicLink}\nСоздано задач: {count}",
  "accept.error": "Не удалось принять карточку: {message}",
  "accept.notOwner": "Команда /accept доступна только владельцу компании.",
  "reject.notOwner": "Команда /reject доступна только владельцу компании.",
  "reject.noId": "Укажите ID карточки: /reject <id> — ID карточки с планом из ответа бота.",
  "reject.alreadyProcessed": "Эта карточка уже обработана.",
  "reject.notPlan": "Эта карточка не является предложением задач; /reject применим только к планам.",
  "reject.ok": "❌ План отклонён. Задачи не созданы.",
  "reject.error": "Не удалось отклонить карточку: {message}",
  // myrmidon(X9c): /agents, /to, /who — addressing the company's agents.
  "menu.agents": "Показать агентов компании и их алиасы",
  "menu.to": "Выбрать адресата по умолчанию (/to <алиас>; без аргумента — сброс)",
  "menu.who": "Показать текущего адресата",

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
  // myrmidon(1.6.5-TG-LOCALE-C): недоступную смену объясняем до конца — названы
  // адаптер и причина, сказано, где значение меняется (карточка агента на доске)
  // и когда вступит в силу.
  "model.unavailable":
    "Смена модели недоступна для адаптера {adapterType}: {reason}. Модель меняется на доске — в разделе моделей карточки агента; применится со следующего ответа.",
  "reasoning.unavailable":
    "Смена глубины рассуждений недоступна для адаптера {adapterType}: {reason}. Глубина рассуждений меняется на доске — в разделе моделей карточки агента; применится со следующего ответа.",
  "model.unknownNoun": "Неизвестная модель",
  "reasoning.unknownNoun": "Неизвестная глубина рассуждений",
  "chooser.effective": "{label}: {value} ({source}).",
  "chooser.availableHeader": "Доступно:",
  "chooser.usage": "Ответьте на это сообщение номером или именем либо укажите /{command} <имя или номер> или /{command} default.",
  "chooser.agentDefaultParen": "по умолчанию у агента ({value})",
  "chooser.defaultApplied": "{label} для этого чата: {agentDefault}.",
  "chooser.set": "{label} для этого чата: {value}. Следующий ответ начнёт новую сессию модели с недавней историей этого чата.",
  "chooser.unknownError": "{noun} «{value}».\n{list}",
  // myrmidon(F06-A): см. en.ts — список моделей агента, применение профиля и
  // причина недоступности команды.
  "chooser.catalogWhole":
    "Показан весь каталог шлюза — собственный список моделей агента прочитать не удалось.",
  "chooser.effortNotAllowed": "Глубина рассуждений «{value}» не поддерживается моделью {model}; допустимо: {list}.",
  "chooser.applyNextTurn":
    "Профиль агента применён без перезапуска: изменение вступит в силу со следующего ответа.",
  "chooser.applyFailed":
    "Изменение записано для этого чата, но применить профиль агента не удалось: {reason}",
  "chooser.applyNotApplied":
    "Агент пока работает на прежнем профиле ({reason}); изменение вступит в силу при следующем применении профиля.",
  "chooser.applyRolledBack": "Прежнее значение возвращено.",
  "chooser.reason.unsupportedAdapter": "этот адаптер не поддерживает смену из чата",
  "chooser.reason.noCandidates": "не удалось прочитать варианты для этого чата",
  "chooser.button.default": "↩ По умолчанию у агента",
  "chooser.moreHidden": "Кнопки есть у первых {count} моделей; остальные выбирайте номером или именем из списка.",
  // myrmidon(F06-D): почему собственный список агента не использован.
  "chooser.keyFailure": "Причина: {reason}.",
  "chooser.keyFailure.noGatewayUrl": "в доске не настроен адрес шлюза LLM",
  "chooser.keyFailure.noKey": "у агента нет привязанного ключа шлюза",
  "chooser.keyFailure.secretError": "ключ шлюза не удалось прочитать из хранилища секретов",
  "chooser.keyFailure.gatewayError": "шлюз не вернул список моделей для ключа этого агента",
  "chooser.keyFailure.emptyList": "ключ этого агента не разрешает ни одной модели",

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

  // myrmidon(X9c): /agents, /to and /who — which agent of the company this
  // chat addresses. Agent names and aliases are data, not prose.
  // myrmidon(1.6.5 OPE-6318 part A) adds the group titles of /agents, the
  // live-status words and the grouped line template.
  "agents.header": "Агенты компании:",
  "agents.noAliases": "—",
  "agents.currentSuffix": "текущий адресат",
  "agents.none": "В этой компании нет агентов, доступных для адресации.",
  "agents.hint": "Выбрать адресата по умолчанию: /to <алиас>. /to без аргумента сбрасывает выбор.",
  // Названия групп для карточек без своего `telegramGroup`: группа берётся из
  // префикса имени (см. ../grouping.ts).
  "agents.group.infra": "Инфраструктура / Myrmidon",
  "agents.group.bbq": "bbq",
  "agents.group.work": "work",
  "agents.group.other": "Прочие",
  // «{group}» — уже готовое название группы: из каталога или из карточки.
  "agents.groupHeader": "{group}:",
  "agents.groupHeaderPaused": "{group} (на паузе: {count}):",
  // Живые статусы строки карточки (agents.status).
  "agents.status.idle": "свободен",
  "agents.status.running": "работает",
  "agents.status.paused": "на паузе",
  "agents.status.unknown": "статус неизвестен",
  // Строка агента: имя, роль одной строкой (agents.title), статус, алиасы.
  "agents.line": "• {name} — {role} · {status} ({aliases})",
  "agents.lineNoRole": "• {name} · {status} ({aliases})",
  "to.unsetLine": "Адресат по умолчанию не задан: отвечает {agent}.",
  "to.cleared": "Выбор адресата сброшен. Дальше отвечает агент этого чата по умолчанию.",
  "to.alreadySet": "Адресат уже {agent} ({aliases}).",
  "to.set": "Теперь по умолчанию отвечает {agent} ({aliases}), пока вы не выберете другого.",
  "to.unknownAlias": "Агента с алиасом «{alias}» в этой компании нет. Доступные алиасы:\n{list}",
  "to.unknownAliasNoAliases": "Агента с таким алиасом в этой компании нет. Доступные алиасы пока не заданы — посмотрите /agents.",
  "who.line": "Сейчас отвечает {agent} ({aliases}) — {source}.",
  "who.sourceSticky": "выбран /to",
  "who.sourceDefault": "агент этого чата по умолчанию",
  "who.unavailable": "Текущий адресат недоступен. Выберите нового: /to <алиас>.",

  // Bridge notices
  "bridge.migrated": "Теперь это постоянный чат с {agent}. Прежние задачи остаются на доске{linkSuffix}",
  "bridge.linkWith": ": {url}",
  "bridge.linkNone": ".",
  "bridge.thisAgent": "этим агентом",
  "bridge.refusalUnlinked":
    "Этот бот доступен только участникам рабочего пространства. Попросите администратора привязать ваш аккаунт Telegram.",
};
