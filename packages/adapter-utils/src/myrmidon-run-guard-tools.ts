// myrmidon(RUN-GUARD-LOOPS): classify one agent tool call as "read" (exploration
// that cannot change anything) or "write" (everything else) for the run guard's
// no-progress and repeated-call checks.
//
// The classification is deliberately conservative in one direction: a call that
// is not positively recognised as read-only counts as a "write" and resets the
// guard's exploration counters. A misread write only delays the stop; a misread
// read would kill a run that is making progress.
//
// What the guard sees is whatever the adapter hands it. For the hermes gateway
// that is the tool name plus the `preview` string of the `tool.started` event,
// which is a short display form of the primary argument (for `terminal` the
// command line), not the full argument object. Structured arguments are
// supported as well (`{ command: "..." }`, or a JSON string of that shape).

export type RunGuardToolKind = "read" | "write";

/** Tools that only look at things. Everything not listed here is a write. */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_files",
  "read_file",
  "skill_view",
  "read_stale_tool_result",
]);

const TERMINAL_TOOL_NAMES: ReadonlySet<string> = new Set(["terminal"]);

/** Shell commands (first word of a pipeline segment) that only read. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "cat",
  "ls",
  "head",
  "tail",
  "wc",
]);

/** Harmless in a read-only pipeline, but never enough to make a command a read on their own. */
const NEUTRAL_COMMANDS: ReadonlySet<string> = new Set([
  "cd",
  "pushd",
  "popd",
  "pwd",
  "true",
  "false",
  "echo",
  "printf",
]);

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["log", "show", "diff", "status"]);

/** `find` actions that run commands or write files. */
const MUTATING_FIND_ACTIONS: ReadonlySet<string> = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/** `git` global options that consume the next word. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

interface ShellScan {
  /** Words of each command, split at `;`, `&&`, `||`, `|`, `&` and newlines (quotes removed). */
  segments: string[][];
  /** An unquoted output redirection to something other than /dev/null. */
  writesFile: boolean;
  /** Command substitution or backticks: the real command is not visible. */
  dynamic: boolean;
}

function isWordBreak(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r";
}

/**
 * Minimal shell lexer: enough to split a command line into commands and words,
 * honouring single/double quotes and backslashes, and to notice output
 * redirection. It does not try to be a shell; anything it cannot understand
 * ends up classified as a write by the caller.
 */
function scanShell(command: string): ShellScan {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let writesFile = false;
  let dynamic = false;

  const pushWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const pushSegment = () => {
    pushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  // Handles a redirection whose `>` sits at `index`. Returns the index of the
  // last consumed character.
  const consumeRedirect = (index: number): number => {
    // A file descriptor directly before the operator ("2>") belongs to it.
    if (inWord && /^[0-9]$/.test(word)) {
      word = "";
      inWord = false;
    } else {
      pushWord();
    }
    let j = index + 1;
    if (command[j] === ">") j += 1; // >>
    if (command[j] === "&") {
      // fd duplication such as 2>&1: no file is written.
      j += 1;
      while (j < command.length && /[0-9-]/.test(command[j]!)) j += 1;
      return j - 1;
    }
    if (command[j] === "|") j += 1; // >|
    while (j < command.length && isWordBreak(command[j]!)) j += 1;
    let target = "";
    let targetQuote: "'" | '"' | null = null;
    while (j < command.length) {
      const ch = command[j]!;
      if (targetQuote) {
        if (ch === targetQuote) targetQuote = null;
        else target += ch;
      } else if (ch === "'" || ch === '"') {
        targetQuote = ch;
      } else if (isWordBreak(ch) || ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "<" || ch === ">") {
        break;
      } else {
        target += ch;
      }
      j += 1;
    }
    if (target !== "/dev/null") writesFile = true;
    return j - 1;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && next !== undefined) {
        word += next;
        i += 1;
      } else {
        if (ch === "`" || (ch === "$" && next === "(")) dynamic = true;
        word += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      if (next === "\n") {
        i += 1;
        continue;
      }
      word += next;
      inWord = true;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(")) {
      dynamic = true;
      word += ch;
      inWord = true;
      continue;
    }
    if (isWordBreak(ch)) {
      pushWord();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      pushSegment();
      continue;
    }
    if (ch === "|") {
      pushSegment();
      if (next === "|") i += 1;
      continue;
    }
    if (ch === "&") {
      if (next === ">") {
        // &> and &>> redirect both streams.
        i = consumeRedirect(i + 1);
        continue;
      }
      pushSegment();
      if (next === "&") i += 1;
      continue;
    }
    if (ch === ">") {
      i = consumeRedirect(i);
      continue;
    }
    if (ch === "<") {
      // Input redirection or here-document: the target is an ordinary word.
      pushWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  pushSegment();
  return { segments, writesFile, dynamic };
}

function isInPlaceSedFlag(arg: string): boolean {
  if (arg === "--in-place" || arg.startsWith("--in-place=")) return true;
  if (arg.startsWith("--")) return false;
  return /^-[A-Za-z]+/.test(arg) && arg.slice(1).includes("i");
}

function classifyGit(args: string[]): "read" | "write" {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = args[index];
  return subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) ? "read" : "write";
}

function classifySegment(words: string[]): "read" | "neutral" | "write" {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  if (index >= words.length) return "write"; // a bare assignment changes shell state
  const command = (words[index]!.split("/").pop() ?? "").trim();
  const args = words.slice(index + 1);
  if (NEUTRAL_COMMANDS.has(command)) return "neutral";
  if (READ_ONLY_COMMANDS.has(command)) return "read";
  if (command === "sed") return args.some(isInPlaceSedFlag) ? "write" : "read";
  if (command === "find") return args.some((arg) => MUTATING_FIND_ACTIONS.has(arg)) ? "write" : "read";
  if (command === "git") return classifyGit(args);
  return "write";
}

/**
 * A shell command line is a read when every command in it is a known read-only
 * command, nothing is redirected into a file and no command substitution hides
 * part of it. A line made only of neutral commands (`cd dir`) is not a read.
 */
export function classifyTerminalCommand(command: string): RunGuardToolKind {
  const scan = scanShell(command);
  if (scan.writesFile || scan.dynamic) return "write";
  let sawRead = false;
  for (const words of scan.segments) {
    const verdict = classifySegment(words);
    if (verdict === "write") return "write";
    if (verdict === "read") sawRead = true;
  }
  return sawRead ? "read" : "write";
}

function commandFromArguments(args: unknown): string | null {
  if (typeof args === "string") {
    const text = args.trim();
    if (text.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") return commandFromArguments(parsed);
      } catch {
        // Not JSON (a truncated preview, or a command that starts with a brace): use the text as is.
      }
    }
    return text.length > 0 ? text : null;
  }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return null;
}

/**
 * Classifies one tool call. `args` is whatever the adapter has for the call:
 * the structured arguments or a preview string (only used for the terminal tool).
 */
export function classifyToolCall(name: string, args: unknown): RunGuardToolKind {
  const tool = name.trim().toLowerCase();
  if (READ_ONLY_TOOL_NAMES.has(tool)) return "read";
  if (TERMINAL_TOOL_NAMES.has(tool)) {
    const command = commandFromArguments(args);
    return command === null ? "write" : classifyTerminalCommand(command);
  }
  return "write";
}
