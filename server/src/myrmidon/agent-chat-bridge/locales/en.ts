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
  "menu.accept": "Accept a suggested plan card (company owner only)",
  "menu.reject": "Reject a suggested plan card (company owner only)",

  // /accept and /reject (1.6.3-CTO-CHAT-B)
  "accept.noId": "Specify the card id: /accept <id> — the id of the plan card from the bot reply.",
  "accept.notPlanOrProcessed": "This card is not a task proposal or has already been processed.",
  "accept.ok": "✅ Plan accepted.\n\nEpic: {epicLink}\nTasks created: {count}",
  "accept.error": "Failed to accept the card: {message}",
  "accept.notOwner": "The /accept command is available to the company owner only.",
  "reject.notOwner": "The /reject command is available to the company owner only.",
  "reject.noId": "Specify the card id: /reject <id> — the id of the plan card from the bot reply.",
  "reject.alreadyProcessed": "This card has already been processed.",
  "reject.notPlan": "This card is not a task proposal; /reject applies only to plans.",
  "reject.ok": "❌ Plan rejected. No tasks created.",
  "reject.error": "Failed to reject the card: {message}",
  // myrmidon(X9c): /agents, /to, /who — addressing the company's agents.
  "menu.agents": "Show the company's agents and their aliases",
  "menu.to": "Choose the default addressee (/to <alias>; no argument resets)",
  "menu.who": "Show the current addressee",

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
// myrmidon(F06-D): not just "Reasoning": a line that starts «Reasoning:» is a
  // hidden-reasoning marker to the external-publication filter and is dropped
  // from what the chat shows (so /think lost its current-value line).
  "reasoning.statusLabel": "Reasoning effort",
  // myrmidon(1.6.5-TG-LOCALE-C): when a chooser cannot be changed from the chat,
  // the refusal names the adapter and the blockage AND says where the value IS
  // changed (the agent card on the board) and what happens next — the bare
  // "unavailable for adapter X" left the operator without a next step.
  "model.unavailable":
    "Changing the model is unavailable for adapter {adapterType}: {reason}. The model is changed on the board — the agent card's models section — and applies from the next reply.",
  "reasoning.unavailable":
    "Changing the reasoning effort is unavailable for adapter {adapterType}: {reason}. The reasoning effort is changed on the board — the agent card's models section — and applies from the next reply.",
  "model.unknownNoun": "model",
  "reasoning.unknownNoun": "reasoning effort",
  "chooser.effective": "{label}: {value} ({source}).",
  "chooser.availableHeader": "Available:",
  "chooser.usage": "Reply to this message with a number or a name, or use /{command} <name or number> or /{command} default.",
  "chooser.agentDefaultParen": "agent default ({value})",
  "chooser.defaultApplied": "{label} for this chat: {agentDefault}.",
  "chooser.set": "{label} for this chat: {value}. The next reply starts a new model session with this chat's recent history.",
  "chooser.unknownError": "Unknown {noun} “{value}”.\n{list}",
  // myrmidon(F06-A): a gateway agent's own model list, the profile apply that
  // makes a chat's choice reach its running container, and the reason a
  // chooser is unavailable (rendered into model./reasoning.unavailable).
  "chooser.catalogWhole":
    "The whole gateway catalog is listed — this agent's own model list could not be read.",
  "chooser.effortNotAllowed": "Reasoning effort “{value}” is not accepted by model {model}; allowed: {list}.",
  "chooser.applyNextTurn":
    "The agent profile is applied without a restart; the change takes effect from the next reply.",
  "chooser.applyFailed":
    "The change was written for this chat, but the agent profile could not be applied: {reason}",
  "chooser.applyNotApplied":
    "The agent is not running the new profile yet ({reason}); the change takes effect when its profile is applied next.",
  "chooser.applyRolledBack": "The previous value was restored.",
  "chooser.reason.unsupportedAdapter": "this adapter does not support changing it from the chat",
  "chooser.reason.noCandidates": "no choices could be read for this chat",
  "chooser.button.default": "↩ Agent default",
  "chooser.moreHidden": "Buttons cover the first {count} models; pick the rest by number or name from the list.",
  // myrmidon(F06-D): why a gateway agent's own model list was not used.
  "chooser.keyFailure": "Reason: {reason}.",
  "chooser.keyFailure.noGatewayUrl": "the board has no LLM gateway address configured",
  "chooser.keyFailure.noKey": "no gateway key is bound to this agent",
  "chooser.keyFailure.secretError": "the gateway key could not be read from the secret store",
  "chooser.keyFailure.gatewayError": "the gateway did not return a model list for this agent's key",
  "chooser.keyFailure.emptyList": "this agent's key allows no models",

  // /stop
  "stop.unavailable": "Stopping is unavailable right now.",
  "stop.stopping": "Stopping the current reply.",
  "stop.idle": "Nothing is running right now.",

  // /status
  "status.header": "{agent} · chat in Telegram",
  "status.board": "Board: {url}",
  "status.model": "Model: {value} ({source})",
  "status.reasoning": "Reasoning effort: {value} ({source})",
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

  // myrmidon(X9c): /agents, /to and /who — which agent of the company this
  // chat addresses. Agent names and aliases are data, not prose.
  // myrmidon(1.6.5 OPE-6318 part A) adds the group titles of /agents, the
  // live-status words and the grouped line template.
  "agents.header": "The company's agents:",
  "agents.noAliases": "—",
  "agents.currentSuffix": "current addressee",
  "agents.none": "This company has no agents available for addressing.",
  "agents.hint": "Choose the default addressee: /to <alias>. /to without an argument resets the choice.",
  // Group titles used when the agent card carries no `telegramGroup` of its
  // own (the name prefix decides the group — see ../grouping.ts).
  "agents.group.infra": "Infrastructure / Myrmidon",
  "agents.group.bbq": "bbq",
  "agents.group.work": "work",
  "agents.group.other": "Other",
  // "{group}" is already the visible group title, built-in or from the card.
  "agents.groupHeader": "{group}:",
  "agents.groupHeaderPaused": "{group} (on pause: {count}):",
  // Live statuses of a card line (agents.status).
  "agents.status.idle": "idle",
  "agents.status.running": "running",
  "agents.status.paused": "on pause",
  "agents.status.unknown": "unknown status",
  // One agent line: name, one-line role (agents.title), status, aliases.
  "agents.line": "• {name} — {role} · {status} ({aliases})",
  "agents.lineNoRole": "• {name} · {status} ({aliases})",
  "to.unsetLine": "No default addressee set: {agent} replies.",
  "to.cleared": "Addressee choice reset. The chat's default agent replies from now on.",
  "to.alreadySet": "The addressee is already {agent} ({aliases}).",
  "to.set": "{agent} ({aliases}) replies by default now, until you choose another one.",
  "to.unknownAlias": "There is no agent with the alias “{alias}” in this company. Available aliases:\n{list}",
  "to.unknownAliasNoAliases": "There is no agent with such an alias in this company. No aliases are set yet — see /agents.",
  "who.line": "{agent} ({aliases}) replies now — {source}.",
  "who.sourceSticky": "chosen with /to",
  "who.sourceDefault": "the chat's default agent",
  "who.unavailable": "The current addressee is unavailable. Choose a new one: /to <alias>.",

  // Bridge notices
  "bridge.migrated": "This is now a standing chat with {agent}. Previous tasks stay on the board{linkSuffix}",
  "bridge.linkWith": ": {url}",
  "bridge.linkNone": ".",
  "bridge.thisAgent": "this agent",
  "bridge.refusalUnlinked":
    "This bot is available to workspace members only. Ask an administrator to link your Telegram account.",
} as const;

export type BridgeTextKey = keyof typeof bridgeTextEn;
