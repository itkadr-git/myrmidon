import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBody } from "./release-body.mjs";

const section = "### Unique release notes\n\n- identity matrix note.";
const rows = Object.freeze([
  `| board | \`ghcr.io/itkadr-git/myrmidon@sha256:${"a".repeat(64)}\` |`,
  `| bot | \`ghcr.io/itkadr-git/myrmidon-hermes@sha256:${"b".repeat(64)}\` |`,
]);

function once(body, text) {
  const first = body.indexOf(text);
  assert.notEqual(first, -1, `missing: ${text}`);
  assert.equal(body.indexOf(text, first + text.length), -1, `duplicated: ${text}`);
  return first;
}

for (const version of ["1.7.0", "1.7.0-rc.3"]) {
  for (const explicitNotes of [false, true]) {
    for (const previous of [null, "1.6.6"]) {
      test(`body identity ${version}, explicit notes ${explicitNotes}, previous ${previous}`, () => {
        const input = { version, previous, section, digestRows: rows };
        if (explicitNotes) input.notesVersion = "1.8.0";
        const originalRows = [...rows];
        const body = buildBody(input);
        assert.equal(buildBody(input), body);
        assert.deepEqual(rows, originalRows);

        const intro = `Myrmidon ${version} replaces ${previous ?? "<previous>"}.`;
        once(body, intro);
        once(body, "`deploy.sh --release <tag>`");
        const anchor = `"Upgrading from ${previous} to ${version}"`;
        if (previous) once(body, anchor);
        else assert.doesNotMatch(body, /Upgrading from /);

        const notesAt = once(body, section);
        const tableAt = once(body, "## Component images (digests)");
        const firstRowAt = once(body, rows[0]);
        const secondRowAt = once(body, rows[1]);
        const crossCheckAt = once(body, `Cross-check: \`scripts/myrmidon/dockergate/check-release-support.sh --from-tag ${version}\``);
        assert.ok(notesAt < tableAt && tableAt < firstRowAt && firstRowAt < secondRowAt && secondRowAt < crossCheckAt);

        if (version.endsWith("-rc.3")) {
          const notes = explicitNotes ? "1.8.0" : "1.7.0";
          assert.ok(body.startsWith(`**Release candidate 3 of ${notes}.**`));
          once(body, `final \`myr-v${notes}\``);
        } else {
          assert.doesNotMatch(body, /\*\*Release candidate /);
          assert.ok(body.startsWith(intro));
        }
      });
    }
  }
}
