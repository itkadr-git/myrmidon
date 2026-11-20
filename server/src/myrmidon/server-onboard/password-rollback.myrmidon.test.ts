import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "ssh2";
import { expect, it } from "vitest";
import { FleetOnboardExecutor, defaultGenerateKeyPair } from "./executor.js";
import type { OnboardJobClaim } from "./store.js";

it.each([
  { present: true, operatorEdit: false },
  { present: false, operatorEdit: false },
  { present: true, operatorEdit: true },
])("scopes timer rollback after SSH loss ($present prior file, $operatorEdit operator edit)", async ({ present, operatorEdit }) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "myrmidon-password-rollback-"));
  const configDir = join(dir, "sshd_config.d");
  const config = join(configDir, "50-myrmidon-hardening.conf");
  const timer = join(dir, "timer");
  const effective = join(dir, "effective");
  const previous = "PasswordAuthentication yes\nKbdInteractiveAuthentication yes\n";
  const operatorConfig = "# operator edit\n";
  mkdirSync(configDir);
  if (present) writeFileSync(config, previous);
  writeFileSync(effective, previous);
  const script = (name: string, text: string) => writeFileSync(join(dir, name), `#!/bin/sh\nset -eu\n${text}\n`, { mode: 0o700 });
  script("sudo", 'exec "$@"');
  script("systemd-run", 'shift 2; printf "%s\\n" "$2" > "$FIXTURE/timer"');
  script("systemctl", `case "$1" in
    is-active) test -s "$FIXTURE/timer" ;;
    stop) rm -f "$FIXTURE/timer" ;;
    reload) if test -f "$CONFIG"; then cp "$CONFIG" "$FIXTURE/effective"; else printf 'PasswordAuthentication yes\\nKbdInteractiveAuthentication yes\\n' > "$FIXTURE/effective"; fi ;;
    show) exit 0 ;;
    *) exit 99 ;;
  esac`);
  script("sshd", 'case "$1" in -t) exit 0;; *) exit 99;; esac');
  const run = (command: string) => spawnSync("/bin/sh", ["-c", command
    .replaceAll("/var/tmp/myrmidon-sshd-", `${dir}/myrmidon-sshd-`)
    .replaceAll("/etc/ssh/sshd_config.d", configDir)
    .replaceAll("/run/lock/myrmidon-sshd.lock", join(dir, "host.lock"))], {
    encoding: "utf8", timeout: 3000,
    env: { PATH: `${dir}:/usr/bin:/bin`, FIXTURE: dir, CONFIG: config },
  });
  const events: string[] = [];
  let drop = false;
  let fired = false;
  let timerWasArmed = false;
  let timerExit: number | null = null;
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const clients = new Set<import("ssh2").Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "none") { ctx.reject(["publickey"]); return; }
      if (ctx.method !== "publickey") { ctx.reject(); return; }
      if (drop && !fired) {
        ctx.reject();
        if (events.includes("reconnect-before-timer")) return;
        events.push("reconnect-before-timer");
        // The first recovery handshake fails before the host timer runs.
        setImmediate(() => {
          if (operatorEdit) writeFileSync(config, operatorConfig);
          const restorePath = readFileSync(timer, "utf8").trim();
          timerExit = run(`/bin/sh '${restorePath}'`).status;
          fired = true;
          events.push("timer-fired");
        });
        return;
      }
      ctx.accept();
    });
    client.on("ready", () => {
      events.push(fired ? "fresh-login-after-timer" : "login");
      client.on("session", (accept) => accept().on("exec", (acceptExec, _, { command }) => {
        const channel = acceptExec();
        if (command.includes("authorized_keys")) {
          channel.exit(0); channel.end(); return;
        }
        const result = run(command);
        if (!drop && existsSync(config) && readFileSync(config, "utf8").includes("PasswordAuthentication no")) {
          timerWasArmed = existsSync(timer);
          // Model a write that took effect but whose acknowledgement was lost.
          run("systemctl reload ssh");
          events.push("config-written");
          drop = true;
          client.end();
          return;
        }
        channel.exit(result.status ?? 1);
        channel.end(result.stdout ?? "");
      }));
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("missing loopback address");
    const now = new Date().toISOString();
    const claim: Parameters<FleetOnboardExecutor["execute"]>[0] = {
      job: { id: "job", companyId: "company", serverId: "server", kind: "onboard", status: "claimed", step: "access", stepLog: [], error: null, createdBy: null, startedAt: now, finishedAt: null, createdAt: now, updatedAt: now },
      server: { id: "server", slug: "server", hostname: "127.0.0.1", port: addr.port, username: "test", protocol: "ssh", keepPassword: false, passwordSecretKey: null, accessKeySecretKey: "stored", hostKeyFingerprint: null },
      steps: ["access"] satisfies OnboardJobClaim["steps"],
      options: { keepPassword: false, installDocker: false, role: "generic" },
      secretValues: { accessKey: defaultGenerateKeyPair().privateKey },
    };
    const result = await new FleetOnboardExecutor().execute(claim, {
      async pinHostKey() { return true; }, async reportStep() {}, async reportCompletion() {},
    });
    expect(result.status).toBe("failed");
    expect(timerWasArmed).toBe(true);
    if (operatorEdit) {
      expect(timerExit).not.toBe(0);
      expect(readFileSync(config, "utf8")).toBe(operatorConfig);
      expect(result.error).toContain("password configuration rollback unconfirmed");
      return;
    }
    expect(timerExit).toBe(0);
    expect(result.error).not.toContain("rollback unconfirmed");
    expect(events).toEqual(["login", "login", "config-written", "reconnect-before-timer", "timer-fired", "fresh-login-after-timer", "fresh-login-after-timer"]);
    expect(existsSync(config)).toBe(present);
    if (present) expect(readFileSync(config, "utf8")).toBe(previous);
    expect(readFileSync(effective, "utf8")).toBe(previous);
  } finally {
    for (const client of clients) client.end();
    if (server.address()) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
