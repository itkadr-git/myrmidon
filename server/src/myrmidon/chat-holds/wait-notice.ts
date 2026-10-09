// myrmidon(CHAT-HOLD): no silent queue in a chat.
//
// When an owner's chat message cannot start a turn, the vendor tells the chat
// "Your follow-up is queued." and nothing else — the same words whether the
// bot is finishing the previous answer for a minute or the message is parked
// for good. In a bridged Telegram chat the owner now reads why, in plain words
// in the bot's language, with a time estimate where one is known.
//
// The text is a closed projection: a fixed reason code chosen from the wake
// receipt's own fields maps to a fixed sentence. No scheduler error, run id,
// queue position, input text or model output ever reaches the chat — the same
// rule the vendor's notice text follows (chat-inbound-wakeup-publications.ts).
// See docs/myrmidon/DIVERGENCE.md "CHAT-HOLD".

export type ChatWaitReason =
  | "previous_turn"
  | "recovery"
  | "decision_pending"
  | "message_predates_stop"
  | "task_paused"
  | "agent_paused"
  | "agent_unavailable"
  | "budget"
  | "host_memory";

export type ChatNoticeLanguage = "ru" | "en";

/** `payload.executionWait.reason` values that mean "the stopped turn is still being wound down". */
const RECOVERY_WAIT_REASONS = new Set([
  "execution_recovery",
  "execution_settling",
  "controller_settling",
  "remote_cleanup",
  "local_cleanup",
  "process_running",
  "process_identity_missing",
  "source_missing",
  "source_unavailable",
]);

/** `getAgentInvokability(...).reason` / agent status values that mean a deliberate pause. */
const PAUSED_AGENT_MARKERS = new Set(["paused"]);

export interface ChatWaitReceipt {
  /** `agent_wakeup_requests.status` of the wake that owns the message. */
  status: string;
  /** `agent_wakeup_requests.reason`. */
  reason: string | null;
  /** `agent_wakeup_requests.payload`. */
  payload: Record<string, unknown> | null;
}

function waitReasonOf(payload: Record<string, unknown> | null): string | null {
  const wait = payload?.executionWait;
  if (!wait || typeof wait !== "object" || Array.isArray(wait)) return null;
  const reason = (wait as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : null;
}

function waitStatusOf(payload: Record<string, unknown> | null): string | null {
  const wait = payload?.executionWait;
  if (!wait || typeof wait !== "object" || Array.isArray(wait)) return null;
  const status = (wait as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

/**
 * Why the wake that owns an owner's chat message has not started, from the
 * receipt alone, or null when the receipt carries no reason this module can
 * name (the caller then keeps the vendor's wording).
 */
export function classifyChatWait(receipt: ChatWaitReceipt): ChatWaitReason | null {
  const waitReason = waitReasonOf(receipt.payload);
  if (receipt.status === "deferred_issue_execution") {
    if (!waitReason) return "previous_turn";
    if (waitReason === "execution_active") return "previous_turn";
    if (waitReason === "decision_pending") return "decision_pending";
    if (waitReason === "message_predates_stop") return "message_predates_stop";
    if (waitReason === "issue_tree_hold_active") return "task_paused";
    if (RECOVERY_WAIT_REASONS.has(waitReason)) return "recovery";
    return null;
  }
  if (receipt.status === "skipped") {
    if (receipt.reason === "issue_tree_hold_active" || waitReason === "issue_tree_hold_active") return "task_paused";
    if (receipt.reason === "budget.blocked") return "budget";
    if (receipt.reason === "agent.not_invokable") {
      return PAUSED_AGENT_MARKERS.has(waitStatusOf(receipt.payload) ?? "") || PAUSED_AGENT_MARKERS.has(waitReason ?? "")
        ? "agent_paused"
        : "agent_unavailable";
    }
  }
  return null;
}

/**
 * Classifies the conflict `enqueueWakeup` throws for an agent that cannot take
 * a turn right now (`agent.not_invokable`: `details.status` / `details.reason`).
 * Any other error is not a reason the owner can act on and answers null.
 */
export function classifyAgentNotInvokable(error: unknown): ChatWaitReason | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  if (status !== 409) return null;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  const agentStatus = typeof record.status === "string" ? record.status : null;
  const reason = typeof record.reason === "string" ? record.reason : null;
  if (!agentStatus && !reason) return null;
  // A budget conflict carries scopeType/scopeId, never an agent status.
  if (typeof record.scopeType === "string") return "budget";
  if (PAUSED_AGENT_MARKERS.has(agentStatus ?? "") || PAUSED_AGENT_MARKERS.has(reason ?? "")) return "agent_paused";
  return "agent_unavailable";
}

/**
 * What a waiting message is waiting on, and what happens next when it waits in
 * the queue ("queued": it starts by itself). Each sentence is complete; the
 * time estimate is given only where the wait has a known bound.
 */
// myrmidon(1.6.5 OWNER-CHAT-ADMISSION): `host_memory` is the one gate that can
// hold an owner's own turn in a chat back — `minFreeMemoryMb`, applied to the
// server container and to the host's MemAvailable, not the host floor and the
// CPU ceiling that pace the automatic runs. The sentence therefore says the
// answer is first in the queue and that the queue is re-checked every 15 s
// (no promised start time); the chat notice is staged only while the turn
// really waits (see isOwnerChatTurnWake).
const QUEUED_TEXTS: Record<ChatNoticeLanguage, Record<ChatWaitReason, string>> = {
  ru: {
    previous_turn:
      "Я ещё заканчиваю предыдущий ответ. Ваше сообщение сохранено — возьмусь за него сразу после.",
    recovery:
      "Предыдущий ответ прервался, система его сейчас закрывает. Ваше сообщение сохранено и уйдёт в работу автоматически, обычно в течение пары минут.",
    decision_pending:
      "Сначала нужен ваш ответ на открытый вопрос или подтверждение выше. После него продолжу с этим сообщением.",
    message_predates_stop:
      "Это сообщение пришло, пока прерванный ответ ещё останавливался. Пожалуйста, отправьте его ещё раз.",
    task_paused:
      "Работа в этом чате поставлена на паузу на доске. Сообщение сохранено и уйдёт в работу, когда паузу снимут.",
    agent_paused:
      "Бот сейчас на паузе. Сообщение сохранено и уйдёт в работу, как только паузу снимут.",
    agent_unavailable:
      "Бот сейчас не может принимать сообщения: он отключён или ждёт настройки на доске. Сообщение сохранено и уйдёт в работу, когда бот снова будет доступен.",
    budget:
      "У бота закончился бюджет на работу. Сообщение сохранено и уйдёт в работу, когда бюджет пополнят или поднимут лимит.",
    host_memory:
      "Серверу сейчас не хватает свободной памяти на собственные процессы, поэтому новые ответы ждут очереди. Ваше сообщение стоит первым в очереди и стартует само, как только память освободится (очередь проверяется каждые 15 секунд).",
  },
  en: {
    previous_turn:
      "I'm still finishing the previous answer. Your message is saved and I'll take it right after.",
    recovery:
      "The previous answer was interrupted and is being closed. Your message is saved and will start automatically, usually within a couple of minutes.",
    decision_pending:
      "First I need your answer to the open question or confirmation above. I'll continue with this message after that.",
    message_predates_stop:
      "This message arrived while the interrupted answer was still stopping. Please send it again.",
    task_paused:
      "Work in this chat is paused on the board. Your message is saved and will start when the pause is lifted.",
    agent_paused:
      "The bot is paused. Your message is saved and will start as soon as the pause is lifted.",
    agent_unavailable:
      "The bot can't take messages right now: it is turned off or waiting for setup on the board. Your message is saved and will start once the bot is available again.",
    budget:
      "The bot has run out of budget. Your message is saved and will start once the budget is topped up or the limit raised.",
    host_memory:
      "The server is short of free memory for its own processes, so new answers are waiting. Your message is first in the queue and starts by itself once memory frees up (the queue is checked every 15 seconds).",
  },
};

/** The cause alone, for a message that was not started and will not start by itself. */
const NOT_STARTED_CAUSES: Record<ChatNoticeLanguage, Record<ChatWaitReason, string>> = {
  ru: {
    previous_turn: "Я был занят предыдущим ответом.",
    recovery: "Предыдущий ответ прервался.",
    decision_pending: "Сначала нужен ваш ответ на открытый вопрос или подтверждение выше.",
    message_predates_stop: "Сообщение пришло, пока прерванный ответ ещё останавливался.",
    task_paused: "Работа в этом чате поставлена на паузу на доске.",
    agent_paused: "Бот на паузе.",
    agent_unavailable: "Бот отключён или ждёт настройки на доске.",
    budget: "У бота закончился бюджет на работу.",
    host_memory: "Серверу не хватало свободной памяти на собственные процессы.",
  },
  en: {
    previous_turn: "I was busy with the previous answer.",
    recovery: "The previous answer was interrupted.",
    decision_pending: "First I need your answer to the open question or confirmation above.",
    message_predates_stop: "The message arrived while the interrupted answer was still stopping.",
    task_paused: "Work in this chat is paused on the board.",
    agent_paused: "The bot is paused.",
    agent_unavailable: "The bot is turned off or waiting for setup on the board.",
    budget: "The bot has run out of budget.",
    host_memory: "The server was short of free memory for its own processes.",
  },
};

const NOT_STARTED_ENDING: Record<ChatNoticeLanguage, string> = {
  ru: "Это сообщение не запущено и само не запустится — отправьте его ещё раз, когда это исправят.",
  en: "This message was not started and will not start by itself — send it again once that is fixed.",
};

/**
 * The owner-facing sentence for `reason`, in the chat's language. `state` is
 * the notice's own state: "queued" (the message waits and starts by itself) or
 * "not_started" (it was declined and must be sent again).
 */
export function chatWaitNoticeText(
  reason: ChatWaitReason,
  language: ChatNoticeLanguage,
  state: "queued" | "not_started" = "queued",
): string {
  if (state === "queued") return QUEUED_TEXTS[language][reason];
  return `${NOT_STARTED_CAUSES[language][reason]} ${NOT_STARTED_ENDING[language]}`;
}

/**
 * The language the bot speaks in a chat on `provider`. The Telegram bridge
 * talks to the owner in Russian (the X8-texts rule of the bridge commands);
 * every other provider keeps the vendor's English.
 */
export function chatNoticeLanguage(provider: string | null | undefined): ChatNoticeLanguage {
  return provider === "telegram" ? "ru" : "en";
}

/**
 * Whether a chat on `provider` gets the reasoned notice at all. Only the
 * bridged Telegram chat does; other providers keep the vendor's notice text
 * byte for byte.
 */
export function chatWaitNoticeApplies(provider: string | null | undefined): boolean {
  return provider === "telegram";
}
