// myrmidon(1.6.4-BOT-CONTAINER-CARD): the data migration that completes legacy
// bot container cards. Placeholder data only.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0299_bot_container_card_complete.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("bot container card migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it(
    "completes container blocks, keeps what the card says, and is idempotent",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-bot-container-card-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());
      const migration = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");

      const companyId = randomUUID();
      await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Co', 'COO')`;
      const ids = {
        legacy: randomUUID(), // image only: the 48-bot shape
        partial: randomUUID(), // enabled but one limit missing, one custom limit
        disabled: randomUUID(), // enabled: false stays false
        complete: randomUUID(),
        nullish: randomUUID(), // explicit nulls count as missing
        noBlock: randomUUID(),
        notObject: randomUUID(),
      };
      const cards: Record<keyof typeof ids, Record<string, unknown>> = {
        legacy: { model: "m", container: { image: "example/hermes@sha256:aa" } },
        partial: { container: { enabled: true, image: "example/hermes-dev@sha256:bb", memoryMb: 4096, cpus: 2 } },
        disabled: { container: { enabled: false, image: "example/hermes@sha256:cc" } },
        complete: { container: { enabled: true, image: "i", memoryMb: 1024, cpus: 0.5, pidsLimit: 256 } },
        nullish: { container: { enabled: null, image: "i", memoryMb: null, cpus: 1.5, pidsLimit: null } },
        noBlock: { model: "m" },
        notObject: { container: "yes" },
      };
      for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "adapter_config")
          VALUES (${ids[key]}, ${companyId}, ${key}, ${sql.json(cards[key] as never)})
        `;
      }

      const read = async () => {
        const rows = await sql<Array<{ id: string; adapter_config: Record<string, unknown> }>>`
          SELECT "id", "adapter_config" FROM "agents" WHERE "company_id" = ${companyId}
        `;
        return Object.fromEntries(rows.map((r) => [r.id, r.adapter_config]));
      };

      await sql.unsafe(migration);
      const after = await read();
      expect(after[ids.legacy]).toEqual({
        model: "m",
        container: { image: "example/hermes@sha256:aa", enabled: true, memoryMb: 2048, cpus: 1, pidsLimit: 512 },
      });
      expect(after[ids.partial]).toEqual({
        container: { enabled: true, image: "example/hermes-dev@sha256:bb", memoryMb: 4096, cpus: 2, pidsLimit: 512 },
      });
      // enabled stays what the card said; missing limits are filled
      expect(after[ids.disabled]).toEqual({
        container: { enabled: false, image: "example/hermes@sha256:cc", memoryMb: 2048, cpus: 1, pidsLimit: 512 },
      });
      expect(after[ids.complete]).toEqual(cards.complete);
      expect(after[ids.nullish]).toEqual({
        container: { enabled: true, image: "i", memoryMb: 2048, cpus: 1.5, pidsLimit: 512 },
      });
      expect(after[ids.noBlock]).toEqual(cards.noBlock);
      expect(after[ids.notObject]).toEqual(cards.notObject);

      await sql.unsafe(migration);
      expect(await read()).toEqual(after);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
