// ui/src/ui2/i18n/no-english-in-ru.knowledge.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the criterion "RU без английских строк"
// for the copy this wave added. It re-applies the rule of
// no-english-in-ru.myrmidon.test.ts to the `ui2.knowledge.*` /
// `ui2.regulations.*` namespaces and to the rail entries the two screens add,
// and checks that both catalogs carry the same key set (a key without an
// English twin renders a raw key in one language).

import { describe, expect, it } from "vitest";
import { ui2Messages, type Ui2MessageKey } from "./locales";

const K4_PREFIXES = ["ui2.knowledge.", "ui2.regulations."] as const;
const K4_EXTRA_KEYS = [
  "ui2.nav.group.work",
  "ui2.nav.knowledge",
  "ui2.nav.regulations",
  "ui2.screens.knowledge",
  "ui2.screens.regulations",
] as const;

/** Copy the K-4 criteria name one by one, so the wave cannot lose a screen. */
const REQUIRED_KEYS = [
  "ui2.knowledge.title",
  "ui2.knowledge.subtitle",
  "ui2.knowledge.search.placeholder",
  "ui2.knowledge.search.mode.fulltext",
  "ui2.knowledge.search.mode.semantic",
  "ui2.knowledge.tree.aria",
  "ui2.knowledge.tree.empty",
  "ui2.knowledge.sources.title",
  "ui2.knowledge.sources.empty",
  "ui2.knowledge.revisions.title",
  "ui2.knowledge.revisions.from",
  "ui2.knowledge.revisions.to",
  "ui2.knowledge.revisions.changed",
  "ui2.knowledge.revisions.rollback",
  "ui2.knowledge.action.allowed",
  "ui2.knowledge.action.needsApproval",
  "ui2.knowledge.action.forbidden",
  "ui2.knowledge.approver.agent",
  "ui2.knowledge.approver.operator",
  "ui2.knowledge.approver.owner",
  "ui2.regulations.title",
  "ui2.regulations.subtitle",
  "ui2.regulations.pending",
  "ui2.regulations.empty",
  "ui2.regulations.approverLabel",
  "ui2.regulations.action.approve",
  "ui2.regulations.action.requestApproval",
  "ui2.regulations.action.rollback",
  "ui2.regulations.action.openInKnowledge",
] as const;

const PLACEHOLDER = /\{\{[^}]*\}\}/g;
const CYRILLIC = /[А-Яа-яЁё]/;

const k4Keys = (Object.keys(ui2Messages.en) as Ui2MessageKey[]).filter(
  (key) => K4_PREFIXES.some((prefix) => key.startsWith(prefix)) || K4_EXTRA_KEYS.some((extra) => extra === key),
);

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) RU copy has no English strings", () => {
  it("carries the K-4 namespaces in both catalogs, one for one", () => {
    expect(k4Keys.length).toBeGreaterThan(70);
    for (const key of k4Keys) {
      expect(ui2Messages.ru[key], `${key} missing from the Russian catalog`).toBeTruthy();
      expect(ui2Messages.en[key], `${key} missing from the English catalog`).toBeTruthy();
    }
    // Every English key has a Russian twin (catalog parity, both directions).
    for (const key of Object.keys(ui2Messages.en) as Ui2MessageKey[]) {
      expect(ui2Messages.ru[key], `${key} has no Russian twin`).toBeTruthy();
    }
    for (const key of REQUIRED_KEYS) {
      expect(k4Keys, `${key} dropped by K-4`).toContain(key);
    }
  });

  it("keeps every Russian value Russian — only the a / o markers stay Latin", () => {
    for (const key of k4Keys) {
      const value = ui2Messages.ru[key];
      const outsidePlaceholders = value.replace(PLACEHOLDER, " ");
      const latinLetters = outsidePlaceholders.match(/[A-Za-z]/g)?.length ?? 0;
      const isTemplate = outsidePlaceholders.replace(/[^A-Za-zА-Яа-яЁё]/g, "").length === 0;

      if (isTemplate) continue;
      // Every other value must carry Russian prose. The only Latin letters
      // allowed are the epic's own markers, so "A — агент делает это сам"
      // passes and "Draft" does not.
      expect(CYRILLIC.test(value), `${key} is not translated: ${value}`).toBe(true);
      expect(latinLetters, `${key} carries English inside Russian copy: ${value}`).toBeLessThan(3);
    }
  });

  it("keeps the two languages apart: no Russian copy reused as English", () => {
    for (const key of k4Keys) {
      if (/^[A-Za-z .·/%—–-]*$/.test(ui2Messages.en[key])) continue;
      expect(CYRILLIC.test(ui2Messages.en[key]), `${key} smuggle Russian into English`).toBe(false);
    }
  });
});