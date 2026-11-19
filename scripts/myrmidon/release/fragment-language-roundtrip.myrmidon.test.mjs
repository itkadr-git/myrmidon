import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFragment } from "./collect-fragments.mjs";
import { buildFragment } from "./fragments-from-diff.mjs";

const classification = (changes = {}) => ({
  changelog: [], rows: [], news: [], appends: [], replaces: [], unsupported: [], warnings: [], ...changes,
});

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const enLog = "### Search\n\n- Find an English result.";
const ruLog = "### Поиск\n\n- Найти русский результат.";
const enRow = "| `SEARCH` | English description |";
const ruRow = "| `SEARCH` | Русское описание |";

test("bilingual content keeps its language and shared settings metadata", () => {
  const input = deepFreeze({
    "changelog-en": classification({ changelog: [enLog] }),
    "changelog-ru": classification({ changelog: [ruLog] }),
    "settings-en": classification({ rows: [{ section: "Track 5", occurrence: 1, body: enRow }] }),
    "settings-ru": classification({ rows: [{ section: "Track 5", occurrence: 1, body: ruRow }] }),
  });
  assert.deepEqual(parseFragment(buildFragment(input)), {
    meta: { "settings-section": "Track 5" },
    sections: { "changelog-en": enLog, "changelog-ru": ruLog, "settings-en": enRow, "settings-ru": ruRow },
    edits: [],
  });
});

test("a missing language is not invented, in either direction", () => {
  for (const [lang, log, row] of [["en", enLog, enRow], ["ru", ruLog, ruRow]]) {
    const input = deepFreeze({
      [`changelog-${lang}`]: classification({ changelog: [log] }),
      [`settings-${lang}`]: classification({ rows: [{ section: "Track 5", occurrence: 1, body: row }] }),
    });
    assert.deepEqual(parseFragment(buildFragment(input)), {
      meta: { "settings-section": "Track 5" },
      sections: { [`changelog-${lang}`]: log, [`settings-${lang}`]: row },
      edits: [],
    });
  }
});

test("localized settings headings remain distinct and repeated edits retain their order and anchors", () => {
  const input = deepFreeze({
    "settings-en": classification({
      rows: [{ section: "Track 5", occurrence: 1, body: enRow }],
      replaces: [
        { section: "Twin", occurrence: 2, row: "| `A` | English replacement |" },
        { section: "Twin", occurrence: 3, row: "| `B` | Another replacement |" },
      ],
      appends: [
        { section: "Twin", occurrence: 2, body: "English appendix one." },
        { section: "Other", occurrence: 1, body: "English appendix two." },
      ],
    }),
    "settings-ru": classification({
      rows: [{ section: "Трек 5", occurrence: 1, body: ruRow }],
      replaces: [{ section: "Трек 5", occurrence: 2, row: "| `A` | Русская замена |" }],
      appends: [{ section: "Трек 5", occurrence: 2, body: "Русское дополнение." }],
    }),
  });
  assert.deepEqual(parseFragment(buildFragment(input)), {
    meta: { "settings-section": "Track 5" },
    sections: { "settings-en": enRow },
    edits: [
      { key: "settings-en-replace", doc: "settings-en", kind: "replace", directives: { section: "Twin", occurrence: "2" }, body: "| `A` | English replacement |" },
      { key: "settings-en-replace", doc: "settings-en", kind: "replace", directives: { section: "Twin", occurrence: "3" }, body: "| `B` | Another replacement |" },
      { key: "settings-en-append", doc: "settings-en", kind: "append", directives: { section: "Twin", occurrence: "2" }, body: "English appendix one." },
      { key: "settings-en-append", doc: "settings-en", kind: "append", directives: { section: "Other", occurrence: "1" }, body: "English appendix two." },
      { key: "settings-ru-append", doc: "settings-ru", kind: "append", directives: { section: "Трек 5", occurrence: "1" }, body: ruRow },
      { key: "settings-ru-replace", doc: "settings-ru", kind: "replace", directives: { section: "Трек 5", occurrence: "2" }, body: "| `A` | Русская замена |" },
      { key: "settings-ru-append", doc: "settings-ru", kind: "append", directives: { section: "Трек 5", occurrence: "2" }, body: "Русское дополнение." },
    ],
  });
});
