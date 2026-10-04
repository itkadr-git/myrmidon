// myrmidon(1.6-CTO-CHAT-B): `/plan <text>` — the owner's DM command that
// reaches the SAME planner the portal chat screen uses.
//
// The command is deliberately thin: identity (is the sender the company
// owner?) is checked here, and everything else is delegated to
// `planFromTelegramTurn` from `cto-chat/telegram-entry.ts`, which runs the
// same planner, posts the same `suggest_tasks` approval card on the
// conversation's task, and returns an outcome a bridge can turn into prose
// without a stack trace ever reaching the chat.
//
// myrmidon(X8-texts): the refusal and the error replies are Russian — the
// language of the pilot chat (see the merge note at the top of
// commands/index.ts). The planner's own reply wording comes from
// `describeTelegramOutcome`, which the portal entry shares.

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";

import { safeChatTaskUrl } from "../../../services/chat-task-url.js";
import { readCtoChatSettings } from "../../cto-chat/settings.js";
import {
  describeTelegramOutcome,
  planFromTelegramTurn,
  type CtoChatTelegramOutcome,
} from "../../cto-chat/telegram-entry.js";
import type { BridgedCommandInput, BridgedCommandResult } from "./index.js";

/** The refusal a non-owner receives; the board stays untouched. */
export const PLAN_NOT_OWNER_TEXT = "Команда /plan доступна только владельцу компании.";
/** The hint when the command arrives with no text to plan. */
export const PLAN_EMPTY_TEXT_TEXT = "Напишите запрос после команды: /plan <что нужно спланировать>.";

/** Active, user-typed membership with the owner role for this company. */
export async function isCompanyOwner(
  db: Db,
  companyId: string,
  boardUserId: string,
): Promise<boolean> {
  const [membership] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalId, boardUserId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
      ),
    )
    .limit(1);
  return Boolean(membership);
}

/**
 * Test-injectable seams for the planner call. Production reads the settings
 * from the environment and the key from the company's secrets; a test passes
 * a fake `fetch`, a deterministic plan id and a stub key resolver — the same
 * seams the cto-chat tests use.
 */
export interface PlanCommandDeps {
  fetch?: typeof fetch;
  mintPlanId?(): string;
  readCompanyKey?(companyId: string): Promise<string | null>;
}

/**
 * Reads the planner settings per call: an operator rotating the address, the
 * key-secret name or the model needs no restart — the next `/plan` already
 * uses the new contour (the same property the portal route has).
 */
export async function handlePlanCommand(
  input: BridgedCommandInput,
  args: string,
  deps: PlanCommandDeps = {},
): Promise<BridgedCommandResult> {
  const text = args.trim();
  if (!text) {
    return { kind: "reply", command: "plan", text: PLAN_EMPTY_TEXT_TEXT };
  }

  if (!(await isCompanyOwner(input.db, input.companyId, input.boardUserId))) {
    return { kind: "reply", command: "plan", text: PLAN_NOT_OWNER_TEXT };
  }

  const settings = readCtoChatSettings();

  let outcome: CtoChatTelegramOutcome;
  try {
    outcome = await planFromTelegramTurn(
      {
        companyId: input.companyId,
        hostIssueId: input.conversationIssueId,
        text,
        agentId: input.agentId,
      },
      {
        db: input.db,
        settings,
        fetch: deps.fetch ?? fetch,
        mintPlanId: deps.mintPlanId ?? (() => randomUUID()),
        readCompanyKey:
          deps.readCompanyKey ??
          (async (companyId) => {
            // The secret NAME came from the settings above; the value is read
            // per call and never outlives it (same as the portal runtime).
            if (!settings.keySecret) return null;
            const { secretService } = await import("../../../services/secrets.js");
            const secrets = secretService(input.db);
            const row = await secrets.getByName(companyId, settings.keySecret);
            if (!row) return null;
            return secrets.resolveSecretValue(companyId, row.id, "latest");
          }),
      },
    );
  } catch {
    // The entry module already reports planner failures as outcomes; this
    // only guards the truly unexpected (e.g. a database fault). A chat turn
    // is not a place for a stack trace, and nothing from the error is echoed.
    return {
      kind: "reply",
      command: "plan",
      text: "Не удалось создать план. Попробуйте позже или напишите запрос текстом.",
    };
  }

  const taskUrl = safeChatTaskUrl(input.publicBaseUrl, input.conversationIssueId);
  return { kind: "reply", command: "plan", text: describeTelegramOutcome(outcome, taskUrl) };
}
