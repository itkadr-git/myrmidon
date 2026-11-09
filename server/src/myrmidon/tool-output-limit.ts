import fs from "node:fs";
import path from "node:path";
import {
  resolveToolOutputLimit,
  truncateToolOutputText,
  type ToolOutputLimitSettings,
} from "@myrmidon/shared";

/**
 * myrmidon(1.6.7-TOKENS-TOOL-OUTPUT, OPE-10730): Server-side enforcement of
 * tool output length limit for model-facing results.
 *
 * Preserves the full output in a trace / workspace file and returns truncated
 * content to the model with the exact Russian marker:
 * «показано N из M символов, полный текст — <путь>».
 */

export interface ApplyToolOutputLimitParams {
  result: unknown;
  invocationId?: string;
  runId?: string | null;
  agentId?: string | null;
  companyId?: string | null;
  workspaceDir?: string | null;
  instanceSettings?: {
    toolOutputLimit?: ToolOutputLimitSettings;
    toolOutputChars?: number;
  };
  agentCardConfig?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
}

export interface ApplyToolOutputLimitResult {
  result: unknown;
  truncated: boolean;
  shownChars: number;
  totalChars: number;
  fullTextPath?: string;
}

function resolveTracesDirectory(params: {
  workspaceDir?: string | null;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  if (params.workspaceDir && typeof params.workspaceDir === "string" && params.workspaceDir.trim().length > 0) {
    return path.join(params.workspaceDir, ".myrmidon", "traces");
  }
  if (env.TMPDIR) {
    return path.join(env.TMPDIR, "traces");
  }
  return path.join(process.cwd(), "traces");
}

export function applyToolOutputLimit(params: ApplyToolOutputLimitParams): ApplyToolOutputLimitResult {
  const maxChars = resolveToolOutputLimit({
    instanceSettings: params.instanceSettings,
    agentCardConfig: params.agentCardConfig,
    env: params.env,
  });

  const rawResult = params.result;
  let textContent: string | null = null;
  let isRecordWithContent = false;
  let isString = false;

  if (typeof rawResult === "string") {
    textContent = rawResult;
    isString = true;
  } else if (
    rawResult &&
    typeof rawResult === "object" &&
    !Array.isArray(rawResult) &&
    typeof (rawResult as Record<string, unknown>).content === "string"
  ) {
    textContent = (rawResult as Record<string, unknown>).content as string;
    isRecordWithContent = true;
  } else if (rawResult !== null && rawResult !== undefined) {
    try {
      textContent = typeof rawResult === "object" ? JSON.stringify(rawResult, null, 2) : String(rawResult);
    } catch {
      textContent = String(rawResult);
    }
  }

  if (textContent === null) {
    return {
      result: rawResult,
      truncated: false,
      shownChars: 0,
      totalChars: 0,
    };
  }

  if (!maxChars || maxChars <= 0 || textContent.length <= maxChars) {
    return {
      result: rawResult,
      truncated: false,
      shownChars: textContent.length,
      totalChars: textContent.length,
    };
  }

  const tracesDir = resolveTracesDirectory({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });

  try {
    fs.mkdirSync(tracesDir, { recursive: true });
  } catch {
    // Best-effort directory creation
  }

  const invocationPart = params.invocationId ? `-${params.invocationId}` : "";
  const runPart = params.runId ? `-${params.runId}` : "";
  const fileName = `tool-output${runPart}${invocationPart || `-${Date.now()}`}.txt`;
  const fullTextPath = path.join(tracesDir, fileName);

  try {
    fs.writeFileSync(fullTextPath, textContent, "utf8");
  } catch {
    // If writing fails, we still protect the model by truncating with a fallback path marker
  }

  const truncated = truncateToolOutputText({
    text: textContent,
    maxChars,
    fullTextPath,
  });

  if (isString) {
    return {
      result: truncated.text,
      truncated: true,
      shownChars: truncated.shownChars,
      totalChars: truncated.totalChars,
      fullTextPath,
    };
  }

  if (isRecordWithContent) {
    return {
      result: {
        ...(rawResult as Record<string, unknown>),
        content: truncated.text,
      },
      truncated: true,
      shownChars: truncated.shownChars,
      totalChars: truncated.totalChars,
      fullTextPath,
    };
  }

  return {
    result: {
      content: truncated.text,
      data: rawResult,
    },
    truncated: true,
    shownChars: truncated.shownChars,
    totalChars: truncated.totalChars,
    fullTextPath,
  };
}
