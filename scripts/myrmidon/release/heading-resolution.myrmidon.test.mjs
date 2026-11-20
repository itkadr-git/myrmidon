import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resolveSectionHeading, sectionKey } from "./collect-fragments.mjs";

describe("release section heading resolution", () => {
  it("prefers each exact heading even between neighbours with the same key", () => {
    const headings = Object.freeze([
      "1.7.0 — CACHE-SYNC: first",
      "1.7.0 — CACHE-SYNC: второй",
      "1.7.0 — CACHE-SYNC: third",
    ]);
    const doc = headings.map((heading) => `## ${heading}\n| row |`).join("\n");
    for (const heading of headings) {
      assert.equal(sectionKey(heading), "1.7.0|CACHE-SYNC");
      assert.equal(resolveSectionHeading(doc, heading), heading);
    }
  });

  it("resolves a single translated feature key and leaves ambiguous keys unchanged", () => {
    const en = "1.7.0 — QUEUE-SYNC: synchronize queues";
    const ru = "1.7.0 — QUEUE-SYNC: синхронизация очередей";
    const other = "1.7.0 — QUEUE-SYNC: другая секция";
    assert.equal(sectionKey(en), "1.7.0|QUEUE-SYNC");
    assert.equal(sectionKey(ru), "1.7.0|QUEUE-SYNC");
    assert.equal(resolveSectionHeading(`## ${ru}\n`, en), ru);
    assert.equal(resolveSectionHeading(`## ${ru}\n## ${other}\n`, en), en);
  });

  it("uses the relaxed first feature token only for a unique candidate", () => {
    const en = "1.7.0 — RELEASE-GATE UI: release gate";
    const ru = "1.7.0 — RELEASE-GATE: проверка выпуска";
    const competing = "1.7.0 — RELEASE-GATE API: интерфейс";
    assert.equal(resolveSectionHeading(`## ${ru}\n`, en), ru);
    assert.equal(resolveSectionHeading(`## ${ru}\n## ${competing}\n`, en), en);
  });

  it("keeps versions and track numbers separate while translating tracks", () => {
    const doc = "## 1.6.9 — CACHE-SYNC: старая версия\n## 1.7.0 — CACHE-SYNC: новая версия\n## Трек 6 — эксплуатация\n## Трек 7 — платформа\n";
    assert.equal(resolveSectionHeading(doc, "1.7.0 — CACHE-SYNC: new version"), "1.7.0 — CACHE-SYNC: новая версия");
    assert.equal(resolveSectionHeading(doc, "1.8.0 — CACHE-SYNC: future version"), "1.8.0 — CACHE-SYNC: future version");
    assert.equal(sectionKey("Track 7 — platform"), "track:7");
    assert.equal(sectionKey("Трек 7 — платформа"), "track:7");
    assert.equal(resolveSectionHeading(doc, "Track 7 — platform"), "Трек 7 — платформа");
    assert.equal(resolveSectionHeading(doc, "Track 8 — platform"), "Track 8 — platform");
  });

  it("distinguishes MONITORING parts A and B", () => {
    const a = "1.7.0 — MONITORING A: состояние";
    const b = "1.7.0 — MONITORING B: оповещения";
    const doc = `## ${a}\n## ${b}\n`;
    assert.equal(sectionKey(a), "1.7.0|MONITORING-A");
    assert.equal(sectionKey(b), "1.7.0|MONITORING-B");
    assert.equal(resolveSectionHeading(doc, "1.7.0 — MONITORING A: status"), a);
    assert.equal(resolveSectionHeading(doc, "1.7.0 — MONITORING B: alerts"), b);
    assert.equal(resolveSectionHeading(doc, "1.7.0 — MONITORING C: other"), "1.7.0 — MONITORING C: other");
  });
});
