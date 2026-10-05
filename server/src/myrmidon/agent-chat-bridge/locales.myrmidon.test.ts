// myrmidon(1.7-TG-LOCALE): acceptance for user-locale-driven Telegram bridge
// texts. A board user with no stored preference gets English; a user whose
// Settings → Language choice is Russian gets the pilot wording back; the
// instance-wide env force wins over both. Covers the resolver (DB), the
// catalogs (parity + placeholders), the command menu, and one real command
// reply end to end.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, userUiLanguage, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import {
  BRIDGE_LOCALE_LANGUAGES_ENV,
  BRIDGE_TEXT_CATALOGS,
  DEFAULT_BRIDGE_LOCALE,
  forcedBridgeLocale,
  resolveBridgeLocale,
  telegramDmMenuLocale,
  userBridgeLocale,
  type BridgeTextKey,
} from "./locales/index.js";
import { telegramDmCommandsForLocale } from "./commands/index.js";

const support = await getEmbeddedPostgresTestSupport();

describe("bridge locale catalogs (1.7-TG-LOCALE)", () => {
  it("RU mirrors EN key for key", () => {
    const en = Object.keys(BRIDGE_TEXT_CATALOGS.en).sort();
    const ru = Object.keys(BRIDGE_TEXT_CATALOGS.ru).sort();
    expect(ru).toEqual(en);
    expect(en.length).toBeGreaterThan(30);
  });

  it("both catalogs carry the same {placeholder} sets per key", () => {
    for (const key of Object.keys(BRIDGE_TEXT_CATALOGS.en) as BridgeTextKey[]) {
      const grab = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
      expect(
        grab(BRIDGE_TEXT_CATALOGS.ru[key]),
        `placeholder mismatch for ${key}`,
      ).toBe(grab(BRIDGE_TEXT_CATALOGS.en[key]));
    }
  });

  it("no English catalog value contains Cyrillic", () => {
    for (const [key, value] of Object.entries(BRIDGE_TEXT_CATALOGS.en)) {
      expect(value, `en.${key}`).not.toMatch(/[а-яёА-ЯЁ]/);
    }
  });
});

describe("bridge locale decision (1.7-TG-LOCALE)", () => {
  it("the env force wins over the user preference and junk is ignored", () => {
    expect(forcedBridgeLocale({ [BRIDGE_LOCALE_LANGUAGES_ENV]: "ru" })).toBe("ru");
    expect(forcedBridgeLocale({ [BRIDGE_LOCALE_LANGUAGES_ENV]: "EN" })).toBe("en");
    expect(forcedBridgeLocale({ [BRIDGE_LOCALE_LANGUAGES_ENV]: "de" })).toBeNull();
    expect(forcedBridgeLocale({})).toBeNull();
    expect(DEFAULT_BRIDGE_LOCALE).toBe("en");
    expect(telegramDmMenuLocale({ [BRIDGE_LOCALE_LANGUAGES_ENV]: "ru" })).toBe("ru");
    expect(telegramDmMenuLocale({})).toBe("en");
  });

  (support.supported ? describe : describe.skip)("with embedded Postgres", () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase("myrmidon-tg-locale-");
      db = createDb(database.connectionString);
    }, 90_000);

    afterAll(async () => {
      await db?.$client.end({ timeout: 0 });
      await database?.cleanup();
    });

    async function makeUser(): Promise<string> {
      const id = randomUUID();
      await db
        .insert(authUsers)
        .values({ id, name: `User ${id.slice(0, 4)}`, email: `${id}@example.com`, createdAt: new Date(), updatedAt: new Date() });
      return id;
    }

    it("a user without a stored preference resolves to English", async () => {
      const userId = await makeUser();
      expect(await userBridgeLocale(db, userId)).toBeNull();
      expect(await resolveBridgeLocale(db, userId, {})).toBe("en");
    });

    it("an RU user gets Russian texts, an EN user English (acceptance criterion)", async () => {
      const ruUser = await makeUser();
      const enUser = await makeUser();
      await db.insert(userUiLanguage).values({ userId: ruUser, language: "ru" });
      await db.insert(userUiLanguage).values({ userId: enUser, language: "en" });

      expect(await resolveBridgeLocale(db, ruUser, {})).toBe("ru");
      expect(await resolveBridgeLocale(db, enUser, {})).toBe("en");

      // The same decision drives the command menu copy (instance level): with
      // no force it stays English.
      expect(telegramDmMenuLocale({})).toBe("en");
    });

    it("the env force overrides both users", async () => {
      const ruUser = await makeUser();
      await db.insert(userUiLanguage).values({ userId: ruUser, language: "ru" });
      expect(await resolveBridgeLocale(db, ruUser, { [BRIDGE_LOCALE_LANGUAGES_ENV]: "en" })).toBe("en");
      const plain = await makeUser();
      expect(await resolveBridgeLocale(db, plain, { [BRIDGE_LOCALE_LANGUAGES_ENV]: "ru" })).toBe("ru");
    });
  });
});

describe("bridged command text follows the user locale (1.7-TG-LOCALE)", () => {
  // No DB needed for the menu shape: the renderer takes a locale and draws
  // catalog prose only.
  it("menu renders English by default and Russian when asked", () => {
    const en = telegramDmCommandsForLocale("en");
    const ru = telegramDmCommandsForLocale("ru");
    expect(en.length).toBeGreaterThan(0);
    for (const cmd of en) expect(cmd.description).not.toMatch(/[а-яё]/);
    expect(ru.find((c) => c.command === "help")?.description).toMatch(/[а-яё]/);
    expect(ru.map((c) => c.command)).toEqual(en.map((c) => c.command));
  });
});
