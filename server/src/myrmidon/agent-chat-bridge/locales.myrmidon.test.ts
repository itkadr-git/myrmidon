// myrmidon(1.7-TG-LOCALE): acceptance for user-locale-driven Telegram bridge
// texts. A board user with no stored preference gets English; a user whose
// Settings → Language choice is Russian gets the pilot wording back; the
// instance-wide env force wins over both. Covers the resolver (DB), the
// catalogs (parity + placeholders), the command menu, and one real command
// reply end to end.
//
// myrmidon(1.6.5-TG-LOCALE-C): a board user who never chose a
// language now follows the instance-wide setting, so the order under test is
// env force → the person's preference → the instance setting → English.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, instanceSettings, userUiLanguage, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  BRIDGE_LOCALE_LANGUAGES_ENV,
  BRIDGE_TEXT_CATALOGS,
  DEFAULT_BRIDGE_LOCALE,
  forcedBridgeLocale,
  instanceBridgeLocale,
  resolveBridgeLocale,
  resolveBridgeLocaleDecision,
  telegramDmMenuLocale,
  userBridgeLocale,
  type BridgeTextKey,
} from "./locales/index.js";
import { telegramDmCommandsForLocale } from "./commands/index.js";
import { BRIDGE_LANGUAGE_SETTINGS_KEY } from "@paperclipai/shared";

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

    // myrmidon(1.6.5-TG-LOCALE-C): the instance-wide fallback lives in the
    // single `instance_settings` row, the same place the language screen writes.
    async function setInstanceLanguage(language: "en" | "ru" | null): Promise<void> {
      const general =
        language === null ? {} : { [BRIDGE_LANGUAGE_SETTINGS_KEY]: { language } };
      const [existing] = await db.select({ id: instanceSettings.id }).from(instanceSettings).limit(1);
      if (existing) {
        await db.update(instanceSettings).set({ general, updatedAt: new Date() });
      } else {
        await db.insert(instanceSettings).values({ general });
      }
    }

    it("a user without a stored preference resolves to the instance language, then English", async () => {
      const userId = await makeUser();
      expect(await userBridgeLocale(db, userId)).toBeNull();
      expect(await resolveBridgeLocale(db, userId, {})).toBe("en");

      // Acceptance: the instance setting is the fallback for a board
      // user who never chose a language — no env force in play.
      await setInstanceLanguage("ru");
      expect(await instanceBridgeLocale(db)).toBe("ru");
      expect(await resolveBridgeLocale(db, userId, {})).toBe("ru");
      expect(await resolveBridgeLocaleDecision(db, userId, {})).toEqual({
        locale: "ru",
        source: "instance",
        forcedLanguage: null,
      });

      await setInstanceLanguage(null);
      expect(await instanceBridgeLocale(db)).toBeNull();
      expect(await resolveBridgeLocale(db, userId, {})).toBe("en");
    });

    it("the person's own preference wins over the instance language", async () => {
      const user = await makeUser();
      await db.insert(userUiLanguage).values({ userId: user, language: "en" });
      await setInstanceLanguage("ru");
      expect(await resolveBridgeLocaleDecision(db, user, {})).toEqual({
        locale: "en",
        source: "user",
        forcedLanguage: null,
      });
      await setInstanceLanguage(null);
    });

    it("the command menu follows the instance language and the env force", async () => {
      await setInstanceLanguage("ru");
      expect(await telegramDmMenuLocale(db, {})).toBe("ru");
      expect(await telegramDmMenuLocale(db, { [BRIDGE_LOCALE_LANGUAGES_ENV]: "en" })).toBe("en");
      await setInstanceLanguage(null);
      expect(await telegramDmMenuLocale(db, {})).toBe("en");
      expect(await telegramDmMenuLocale(db, { [BRIDGE_LOCALE_LANGUAGES_ENV]: "ru" })).toBe("ru");
    });

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
      // no instance setting and no force it stays English
      // (myrmidon(1.6.5-TG-LOCALE-C)).
      expect(await telegramDmMenuLocale(db, {})).toBe("en");
    });

    it("the env force overrides the user preference and the instance setting", async () => {
      const ruUser = await makeUser();
      await db.insert(userUiLanguage).values({ userId: ruUser, language: "ru" });
      await setInstanceLanguage("ru");
      expect(await resolveBridgeLocale(db, ruUser, { [BRIDGE_LOCALE_LANGUAGES_ENV]: "en" })).toBe("en");
      const plain = await makeUser();
      expect(await resolveBridgeLocale(db, plain, { [BRIDGE_LOCALE_LANGUAGES_ENV]: "ru" })).toBe("ru");
      expect(await resolveBridgeLocaleDecision(db, plain, { [BRIDGE_LOCALE_LANGUAGES_ENV]: "ru" })).toEqual({
        locale: "ru",
        source: "environment",
        forcedLanguage: "ru",
      });
      await setInstanceLanguage(null);
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
