import { describe, expect, it } from "vitest";
import { classifyTerminalCommand, classifyToolCall } from "./myrmidon-run-guard-tools.js";

describe("classifyToolCall (run guard exploration vs write)", () => {
  it.each(["search_files", "read_file", "skill_view", "read_stale_tool_result", "Read_File"])(
    "treats %s as read-only",
    (name) => {
      expect(classifyToolCall(name, "src/a.ts")).toBe("read");
    },
  );

  it.each(["patch", "write_file", "execute_code", "web_search", "browser_navigate", "memory", "some_new_tool"])(
    "treats %s as a write (anything not known to be read-only resets the counters)",
    (name) => {
      expect(classifyToolCall(name, "x")).toBe("write");
    },
  );

  it("classifies the terminal tool by its command, from a preview string or structured arguments", () => {
    expect(classifyToolCall("terminal", "sed -n '55,75p' file.ts")).toBe("read");
    expect(classifyToolCall("terminal", { command: "git commit -m x" })).toBe("write");
    expect(classifyToolCall("terminal", JSON.stringify({ command: "ls -la" }))).toBe("read");
    expect(classifyToolCall("terminal", { cmd: "rg foo" })).toBe("read");
  });

  it("treats a terminal call without a readable command as a write", () => {
    expect(classifyToolCall("terminal", undefined)).toBe("write");
    expect(classifyToolCall("terminal", "")).toBe("write");
    expect(classifyToolCall("terminal", { other: "x" })).toBe("write");
    expect(classifyToolCall("terminal", "{ not json")).toBe("write");
  });
});

describe("classifyTerminalCommand", () => {
  it.each([
    "sed -n '55,75p' file.ts",
    "sed -E 's/a/b/' file.ts",
    "grep -rn \"a|b\" src | head -20",
    "grep 'a > b' file",
    "grep \"it's\" file",
    "cat a.txt | sed -n 1,5p",
    "rg foo",
    "ls -la",
    "ls -la 2>/dev/null",
    "grep foo f 2>&1",
    "grep foo f &>/dev/null",
    "head -n 5 file; tail -n 5 file",
    "wc -l a b",
    "find . -name '*.ts' -not -path './node_modules/*'",
    "git log --oneline -5",
    "git show HEAD~1",
    "git diff HEAD~1",
    "git status",
    "git -C /repo status",
    "git --no-pager diff",
    "cd /repo && rg foo",
    "FOO=1 grep x y",
    "/usr/bin/grep x y",
    "grep x y || true",
    "grep x y || echo none",
  ])("reads: %s", (command) => {
    expect(classifyTerminalCommand(command)).toBe("read");
  });

  it.each([
    "",
    "cd /repo",
    "echo hi",
    "sed -i 's/a/b/' file.ts",
    "sed -ni 's/a/b/p' file.ts",
    "sed --in-place s/a/b/ file.ts",
    "ls > out.txt",
    "cat a >> b",
    "cat > f <<'EOF'\nx\nEOF",
    "grep foo $(git ls-files)",
    "grep foo `git ls-files`",
    "find . -name x -delete",
    "find . -exec rm {} \\;",
    "git commit -m x",
    "git push",
    "git apply patch.diff",
    "git add -A && git commit -m x",
    "gh pr create --title x",
    "gh pr edit 12 --body x",
    "curl -X POST http://example.com/api -d '{}'",
    "curl -X PATCH http://example.com/api -d '{}'",
    "curl -X PUT http://example.com/api -d '{}'",
    "python3 script.py",
    "cat a | python3 -c 'print(1)'",
    "grep foo f | tee out.txt",
    "FOO=1",
  ])("writes: %j", (command) => {
    expect(classifyTerminalCommand(command)).toBe("write");
  });

  it("keeps a redirect to /dev/null and an fd duplication from counting as a file write", () => {
    expect(classifyTerminalCommand("cat file >/dev/null")).toBe("read");
    expect(classifyTerminalCommand("cat file 2> /dev/null")).toBe("read");
    expect(classifyTerminalCommand("cat file 1>&2")).toBe("read");
  });
});
