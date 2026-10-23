import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine } from "@myrmidon/adapter-claude-local/ui";
import { ClaudeLocalConfigFields } from "./config-fields";
import { buildClaudeLocalConfig } from "@myrmidon/adapter-claude-local/ui";

export const claudeLocalUIAdapter: UIAdapterModule = {
  type: "claude_local",
  label: "Claude Code",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeLocalConfigFields,
  buildAdapterConfig: buildClaudeLocalConfig,
};
