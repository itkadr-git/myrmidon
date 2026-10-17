// myrmidon(1.6.5-OWNER-VIA-BOT): the agent tools of the owner dialogue.
//
// In the default owner-delivery mode (`via_bot`) the owner gets no card with
// buttons. The agent that raised an owner decision explains it in ONE direct
// message (`myrmidonMessageOwner`), and closes the interaction only from the
// owner's explicit text answer (`myrmidonResolveInteractionByOwnerReply`).
//
// These tools live beside `tools.ts`, not in it: the runner package parses the
// `makeTool("paperclip…")` literals of `tools.ts` (names, descriptions, line
// numbers) for its capability-inventory contract, and these tools carry the
// product prefix from the start, so there is no `paperclip*` name to alias.
import { z } from "zod";
import {
  OWNER_MESSAGE_MAX_CHARS,
  OWNER_REPLY_RESOLUTION_ACTIONS,
} from "@paperclipai/shared";
import { PaperclipApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";
import type { ToolDefinition } from "./tools.js";

function makeOwnerTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        return formatTextResponse(await execute(schema.parse(input)));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

const messageOwnerSchema = z.object({
  interactionIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    .describe(
      "Ids of YOUR open owner decisions (human-only ask_user_questions / request_confirmation) this message explains. With several open decisions list all of them: one message, one summary.",
    ),
  text: z
    .string()
    .trim()
    .min(1)
    .max(OWNER_MESSAGE_MAX_CHARS)
    .describe(
      "The message to the owner, in the language the owner writes to you: what has to be decided, why now, every option with its consequence, your recommendation, and that a short reply is enough. Plain text; no internal ids or tool names.",
    ),
});

const resolveByOwnerReplySchema = z.object({
  interactionId: z.string().uuid().describe("The open interaction the owner's answer decides."),
  ownerReplyCommentId: z
    .string()
    .uuid()
    .describe("Id of the owner's comment in your direct chat that carries the answer (given in your turn prompt)."),
  action: z
    .enum(OWNER_REPLY_RESOLUTION_ACTIONS)
    .describe("accept or reject for a confirmation, respond for a question form."),
  body: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Body of the matching interaction route: accept {} ; reject {"reason": "..."} ; respond {"answers": [{"questionId": "...", "optionIds": ["..."], "otherText": null}]}.',
    ),
});

export function createOwnerToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeOwnerTool(
      "myrmidonMessageOwner",
      "Write the task owner ONE direct Telegram message that explains your own open owner decisions. Only the agent that raised a human-only question or confirmation can call it, once per question; with several open decisions one message must cover all of them. The owner's text answer comes back to you in your direct chat, marked as an answer to the interaction.",
      messageOwnerSchema,
      async (body) => client.requestJson("POST", "/myrmidon/owner-message", { body }),
    ),
    makeOwnerTool(
      "myrmidonResolveInteractionByOwnerReply",
      "Close one of your open owner decisions from the owner's explicit text answer in your direct chat (the comment id is in your turn prompt). The server checks that the comment is the owner's own answer to your message and records the decision as made by the owner. Never call it from silence, a guess, or a message of anyone else.",
      resolveByOwnerReplySchema,
      async (body) => client.requestJson("POST", "/myrmidon/owner-message/resolve", { body }),
    ),
  ];
}
