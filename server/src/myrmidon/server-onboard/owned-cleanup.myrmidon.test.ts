import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { OwnedFleetResource } from "@myrmidon/shared";
import { expect, it } from "vitest";
import { MockSshExecutor } from "../../services/fleet/mock-ssh-executor.js";
import { cleanupOwnedResources } from "./owned-cleanup.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const serverId = "22222222-2222-4222-8222-222222222222";
const marker = `myrmidon:${companyId}:${serverId}`;
const username = userInfo().username;

it.each([false, true])("preserves unrelated resources and rejects ambiguous UFW targets (%s)", async (ambiguous) => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-owned-cleanup-"));
  try {
    const ownedId = "a".repeat(64);
    const unrelatedId = "b".repeat(64);
    const ownedKey = "ssh-ed25519 AAAA owner's key $(false)";
    const otherKey = "ssh-ed25519 AAAA different comment";
    const ownedV4 = `[ 1] 22/tcp ALLOW IN Anywhere # ${marker}`;
    const ownedV6 = `[ 2] 22/tcp (v6) ALLOW IN Anywhere (v6) # ${marker}`;
    const unrelatedRule = `[ 3] ${ambiguous ? 22 : 80}/tcp ALLOW IN Anywhere`;
    mkdirSync(join(dir, ".ssh"));
    const keys = join(dir, ".ssh", "authorized_keys");
    writeFileSync(keys, `${ownedKey}\n${otherKey}\n`);
    writeFileSync(join(dir, "containers"), `${ownedId}\n${unrelatedId}\n`);
    writeFileSync(join(dir, "rules"), `Status: active\n${ownedV4}\n${ownedV6}\n${unrelatedRule}\n`);
    const fake = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
    fake("sudo", 'test "$1" = -n; shift; exec "$@"');
    fake("docker", 'test "$1" = container; shift; case "$*" in "ls -aq --no-trunc") cat "$HOME/containers";; "rm -f -- "*) grep -Fxv -- "$4" "$HOME/containers" > "$HOME/remaining"; mv "$HOME/remaining" "$HOME/containers";; *) exit 1;; esac');
    fake("ufw", `case "$*" in 'status numbered') cat "$HOME/rules";; '--force delete allow 22/tcp comment ${marker}') grep -vF '${marker}' "$HOME/rules" > "$HOME/remaining"; mv "$HOME/remaining" "$HOME/rules";; *) exit 1;; esac`);
    class ShellSsh extends MockSshExecutor {
      override async execute(command: string) {
        const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` } });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, durationMs: 0 };
      }
    }
    const resources: OwnedFleetResource[] = [
      { kind: "ssh_key", username, authorizedKey: ownedKey },
      { kind: "firewall_rule", backend: "ufw", rule: "allow 22/tcp", marker },
      { kind: "role_container", containerId: ownedId },
    ];
    const clean = () => cleanupOwnedResources(new ShellSsh(), {
      version: 1, companyId, serverId, resources: resources.map((resource) => ({ jobId: serverId, resource })),
    }, username);
    if (ambiguous) {
      await expect(clean()).rejects.toThrow("firewall_rule");
      expect(readFileSync(keys, "utf8")).toBe(`${ownedKey}\n${otherKey}\n`);
      expect(readFileSync(join(dir, "rules"), "utf8")).toContain(ownedV4);
    } else {
      await clean();
      await clean();
      expect(readFileSync(keys, "utf8")).toBe(`${otherKey}\n`);
      expect(readFileSync(join(dir, "rules"), "utf8")).toBe(`Status: active\n${unrelatedRule}\n`);
    }
    expect(readFileSync(join(dir, "containers"), "utf8")).toBe(`${unrelatedId}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
