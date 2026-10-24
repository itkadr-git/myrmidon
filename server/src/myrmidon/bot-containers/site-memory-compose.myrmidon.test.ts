// server/src/myrmidon/bot-containers/site-memory-compose.myrmidon.test.ts
//
// myrmidon(1.6.6 C-MEM): the canonical compose of the site memory (docker/site-memory): hs-pg and
// hindsight-work as one managed service of the site. The file is read as text on purpose: the
// checks are about what must never be in it (a published port, a floating image, a secret).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../../../docker/site-memory/", import.meta.url));
const compose = readFileSync(`${dir}docker-compose.yml`, "utf8");
const code = compose
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("site memory compose", () => {
  it("defines hs-pg and hindsight-work, the latter after a healthy hs-pg", () => {
    expect(code).toMatch(/^ {2}hs-pg:$/m);
    expect(code).toMatch(/^ {2}hindsight-work:$/m);
    expect(code).toMatch(/depends_on:\s*\n\s+hs-pg:\s*\n\s+condition: service_healthy/);
    expect(code).toMatch(/healthcheck:[\s\S]*pg_isready/);
  });

  it("pins both images through variables without a default", () => {
    const images = [...code.matchAll(/^\s+image:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    expect(images).toEqual([
      "${HS_PG_IMAGE:?set HS_PG_IMAGE to a digest-pinned pgvector/pgvector image}",
      "${HINDSIGHT_IMAGE:?set HINDSIGHT_IMAGE to a digest-pinned hindsight image}",
    ]);
    expect(code).not.toMatch(/:latest/);
  });

  it("publishes nothing but the loopback port of hindsight-work", () => {
    const ports = [...code.matchAll(/^\s+- "([^"]+:\d+:\d+)"$/gm)].map((m) => m[1]);
    expect(ports).toEqual(["127.0.0.1:8890:8888"]);
    expect(code).not.toMatch(/0\.0\.0\.0:\d+:/);
    expect(code).not.toMatch(/network_mode:\s*host|privileged:\s*true/);
  });

  it("keeps secrets in the profile files, bounded in memory and pids", () => {
    expect(code).toMatch(/\.\/profile\/hs-pg\.env/);
    expect(code).toMatch(/\.\/profile\/hindsight-work\.env/);
    expect(code).not.toMatch(/PASSWORD:|API_KEY:|DATABASE_URL:/);
    expect((code.match(/mem_limit:/g) ?? []).length).toBe(2);
    expect((code.match(/pids_limit:/g) ?? []).length).toBe(2);
    expect(code).toMatch(/restart: unless-stopped/);
  });

  it("ships examples with placeholders only", () => {
    const examples = readdirSync(dir).filter((f) => f.endsWith(".env.example"));
    expect(examples.sort()).toEqual(["hindsight-work.env.example", "hs-pg.env.example", "images.env.example"]);
    for (const file of examples) {
      const body = readFileSync(`${dir}${file}`, "utf8");
      for (const line of body.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const [name = "", ...rest] = line.split("=");
        // Every value that is a secret, an address or a pin is a placeholder.
        if (/KEY|PASSWORD|DATABASE_URL|BASE_URL|IMAGE|USER|_DB$/.test(name)) {
          expect(rest.join("="), `${file}: ${name}`).toMatch(/<[^>]+>/);
        }
      }
    }
  });
});
