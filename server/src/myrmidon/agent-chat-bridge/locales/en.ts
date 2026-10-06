// myrmidon(1.7-TG-LOCALE): English catalog of every human-readable service
// text the bridged Telegram DM produces. English is the base language of the
// fork (the board default) — the Russian catalog in ./ru.ts mirrors this
// object key for key (a parity test guards it). Templates use {placeholders}
// filled at render time; identifiers, model ids and reasoning levels are
// never part of the catalog — they are data, not prose.
export const bridgeTextEn = {
  // Telegram command-menu descriptions (setMyCommands per language).
  "menu.help": "Show commands",
  "menu.new": "Start a new session (optional: /new <model>)",
  "menu.model": "Show or change the model for this chat",
  "menu.think": "Show or set the reasoning effort",
  "menu.stop": "Stop the current reply",
  "menu.status": "Show model, session and current reply",
  "menu.plan": "Turn a message into an epic plan (company owner only)",

  // /help
  "help.intro": "You are talking to {agent} here. Tasks from this chat are created as needed.",
  "help.menuLine": "/{command} — {description}",
  "help.footer": "/model and /think apply to this Telegram chat only.",

  // Shared refusals
  "chat.notAvailable": "This chat is not available.",
  "turn.inProgress": "A reply is in progress right now. Try after it finishes or send /stop.",

  // /close and /task compatibility replies
  "close.reply": "This chat does not close. To start over, send /new.",
  "task.reply": "In a personal chat, just type your request.",

  // Unknown command
  "unknown.command": "Unknown command /{name}. The command list is in /help.",

  // /new
  "new.notice": "New session started. The history stays on the board.",
  "new.withModel.notice": "New session started with model {model}. The history stays on the board.",

  // Value-source labels for /model, /think and /status
  "source.thisChat": "this chat",
  "source.agentDefault": "agent default",
  "source.adapterDefault": "adapter default",

  // /model and /think
  "model.statusLabel": "Model",
  "reasoning.statusLabel": "Reasoning",
  "model.unavailable": "Changing the model is unavailable for this agent.",
  "reasoning.unavailable": "Changing the reasoning effort is unavailable for this agent.",
  "model.unknownNoun": "model",
  "reasoning.unknownNoun": "reasoning effort",
  "chooser.effective": "{label}: {value} ({source}).",
  "chooser.availableHeader": "Available:",
  "chooser.usage": "Use /{command} <name or number> or /{command} default.",
  "chooser.agentDefaultParen": "agent default ({value})",
  "chooser.defaultApplied": "{label} for this chat: {agentDefault}.",
  "chooser.set": "{label} for this chat: {value}. The next reply starts a new model session with this chat's recent history.",
  "chooser.unknownError": "Unknown {noun} “{value}”.\n{list}",

  // /stop
  "stop.unavailable": "Stopping is unavailable right now.",
  "stop.stopping": "Stopping the current reply.",
  "stop.idle": "Nothing is running right now.",

  // /status
  "status.header": "{agent} · chat in Telegram",
  "status.board": "Board: {url}",
  "status.model": "Model: {value} ({source})",
  "status.reasoning": "Reasoning: {value} ({source})",
  "status.session": "Session: #{number}, model session {state}",
  "status.sessionActive": "is active",
  "status.sessionPending": "will start fresh with the next reply",
  "status.nowIdle": "Now: idle",
  "status.nowQueued": "Now: queued",
  "status.nowReplying": "Now: replying since {time}",
  "status.usage": "Last reply: {input} in / {output} out tokens{cost}",
  "status.webChat": "Web chat: {state}",
  "status.webChat.shared": "shared (last {number} messages)",
  "status.webChat.none": "none",
  "status.webChat.off": "not shared",

  // /plan (bridge-owned refusals and fallback; the planner's own reply is
  // the portal English text)
  "plan.notOwner": "The /plan command is available to the company owner only.",
  "plan.empty": "Write the request after the command: /plan <what to plan>.",
  "plan.failed": "Could not create the plan. Try later or write the request as plain text.",

  // Bridge notices
  "bridge.migrated": "This is now a standing chat with {agent}. Previous tasks stay on the board{linkSuffix}",
  "bridge.linkWith": ": {url}",
  "bridge.linkNone": ".",
  "bridge.thisAgent": "this agent",
  "bridge.refusalUnlinked":
    "This bot is available to workspace members only. Ask an administrator to link your Telegram account.",
} as const;

export type BridgeTextKey = keyof typeof bridgeTextEn;
