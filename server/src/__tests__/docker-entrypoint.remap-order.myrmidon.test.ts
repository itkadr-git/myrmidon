import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/docker-entrypoint.sh");
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Call = string[];
type Case = { name: string; uid?: string; gid?: string; nodeUid: string; nodeGid: string; changes: Call[] };
const cases: Case[] = [
  { name: "UID only", uid: "1234", gid: "1000", nodeUid: "1000", nodeGid: "1000", changes: [["usermod", "-o", "-u", "1234", "node"]] },
  { name: "GID only", uid: "1000", gid: "2345", nodeUid: "1000", nodeGid: "1000", changes: [["groupmod", "-o", "-g", "2345", "node"], ["usermod", "-g", "2345", "node"]] },
  { name: "both differ", uid: "1234", gid: "2345", nodeUid: "1000", nodeGid: "1000", changes: [["usermod", "-o", "-u", "1234", "node"], ["groupmod", "-o", "-g", "2345", "node"], ["usermod", "-g", "2345", "node"]] },
  { name: "both match", uid: "1234", gid: "2345", nodeUid: "1234", nodeGid: "2345", changes: [] },
  { name: "unset defaults match", nodeUid: "1000", nodeGid: "1000", changes: [] },
  { name: "unset defaults remap", nodeUid: "1234", nodeGid: "2345", changes: [["usermod", "-o", "-u", "1000", "node"], ["groupmod", "-o", "-g", "1000", "node"], ["usermod", "-g", "1000", "node"]] },
  { name: "empty defaults match", uid: "", gid: "", nodeUid: "1000", nodeGid: "1000", changes: [] },
  { name: "empty defaults remap", uid: "", gid: "", nodeUid: "1234", nodeGid: "2345", changes: [["usermod", "-o", "-u", "1000", "node"], ["groupmod", "-o", "-g", "1000", "node"], ["usermod", "-g", "1000", "node"]] },
];

describe("docker entrypoint root remap order", () => {
  it.each(cases)("preserves the complete trace: $name", async ({ uid, gid, nodeUid, nodeGid, changes }) => {
    const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "remap-order-"));
    scratch.push(dir);
    const trace = join(dir, "trace.jsonl");
    const logger = join(dir, "logger.cjs");
    writeFileSync(logger, `const fs = require('node:fs');
const [name, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify([name, ...args]) + '\\n');
if (name === 'id') console.log(args.length === 1 ? '0' : args[0] === '-u' ? process.env.NODE_UID : process.env.NODE_GID);
`);
    for (const name of ["id", "usermod", "groupmod", "find", "chown", "gosu", "payload"]) {
      const continuation = name === "gosu" ? '\nshift\nexec "$@"' : "";
      writeFileSync(join(dir, name), `#!/bin/sh\n"${process.execPath}" "${logger}" ${name} "$@"${continuation}\n`, { mode: 0o755 });
    }
    const env: NodeJS.ProcessEnv = {
      PATH: dir, HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PAPERCLIP_HOME: dir,
      TRACE: trace, NODE_UID: nodeUid, NODE_GID: nodeGid,
    };
    if (uid !== undefined) env.USER_UID = uid;
    if (gid !== undefined) env.USER_GID = gid;
    const result = await execFileAsync("/bin/sh", [entrypoint, join(dir, "payload"), "run"], { env, timeout: 10000, killSignal: "SIGKILL" });
    expect(result.stderr).toBe("");
    const calls: Call[] = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const uidChanges = changes.filter((call) => call[0] === "usermod" && call[1] === "-o");
    const gidChanges = changes.filter((call) => !uidChanges.includes(call));
    expect(calls).toEqual([
      ["id", "-u"], ["id", "-u", "node"], ...uidChanges,
      ["id", "-g", "node"], ...gidChanges,
      ["find", dir, "(", "!", "-user", "node", "-o", "!", "-group", "node", ")", "-print", "-quit"],
      ["gosu", "node", join(dir, "payload"), "run"], ["payload", "run"],
    ]);
  });
});
