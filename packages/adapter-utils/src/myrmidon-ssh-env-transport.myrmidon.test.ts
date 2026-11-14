// myrmidon(OPE-12810): secret run env must never appear in ssh argv.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSshCommandManagedRuntimeRunner, buildSshSpawnTarget } from "./ssh.js";
import { buildSshEnvStdinTransport, withSshEnvStdinPrefix } from "./myrmidon-ssh-env-transport.js";
import { EventEmitter } from "node:events";

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; stdin: string }> }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_file: string, args: string[]) => {
      const entry = { args, stdin: "" };
      spawned.calls.push(entry);
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        // spawnText (ssh.ts, #2959) attaches an "error" listener to child.stdin before end().
        on: () => child.stdin,
        end: (chunk?: string) => {
          entry.stdin = chunk ?? "";
          setImmediate(() => child.emit("close", 0, null));
        },
      };
      child.kill = () => true;
      return child;
    },
  };
});

const FAKE_SECRET = "fake-secret-value-0123456789";
const FAKE_SECRET_QUOTE = "fake'secret\"with $pecial `chars`";

const spec = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/work",
  remoteWorkspacePath: "/srv/work",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

describe("ssh env stdin transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buildSshSpawnTarget keeps env values out of the ssh argument list", async () => {
    const target = await buildSshSpawnTarget({
      spec,
      command: "agent-cli",
      args: ["--run"],
      env: { FAKE_API_TOKEN: FAKE_SECRET, FAKE_OTHER: FAKE_SECRET_QUOTE },
    });
    const argv = target.args.join("\n");
    expect(argv).not.toContain(FAKE_SECRET);
    expect(argv).not.toContain("fake'secret");
    expect(argv).not.toContain("FAKE_API_TOKEN");
    expect(target.stdinPrefix).toContain(`export FAKE_API_TOKEN='${FAKE_SECRET}'`);
    expect(argv).toContain("agent-cli");
    await target.cleanup();
  });

  it("declared byte count matches the env block, including multibyte values", () => {
    const transport = buildSshEnvStdinTransport({ FAKE_A: "значение-фиктивное", FAKE_B: "x" });
    const match = /count=(\d+)/.exec(transport.remoteReadSnippet);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(Buffer.byteLength(transport.stdinPrefix, "utf8"));
  });

  it("emits nothing and leaves caller stdin alone when env is empty", () => {
    const transport = buildSshEnvStdinTransport({});
    expect(transport.stdinPrefix).toBe("");
    expect(transport.remoteReadSnippet).toBe("");
    expect(withSshEnvStdinPrefix("", null)).toBeNull();
    expect(withSshEnvStdinPrefix("", "body")).toBe("body");
    expect(withSshEnvStdinPrefix("export A='1'\n", "body")).toBe("export A='1'\nbody");
  });

  it("rejects invalid env keys", () => {
    expect(() => buildSshEnvStdinTransport({ "BAD KEY": "x" })).toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("managed runtime runner sends env on stdin ahead of the caller stdin, never in argv", async () => {
    spawned.calls.length = 0;
    const runner = createSshCommandManagedRuntimeRunner({ spec });
    await runner.execute({
      command: "sh",
      args: ["-c", "echo run"],
      env: { FAKE_API_TOKEN: FAKE_SECRET },
      stdin: "prompt-body",
      timeoutMs: 1000,
    } as never);
    expect(spawned.calls).toHaveLength(1);
    const { args, stdin } = spawned.calls[0]!;
    expect(args.join("\n")).not.toContain(FAKE_SECRET);
    expect(args.join("\n")).not.toContain("FAKE_API_TOKEN");
    expect(stdin.startsWith(`export FAKE_API_TOKEN='${FAKE_SECRET}'\n`)).toBe(true);
    expect(stdin.endsWith("prompt-body")).toBe(true);
  });
});
