import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, validateArgs, tagName, UsageError } from "./cut-rc.mjs";

function parsed(version, rc, extra = []) {
  return parseArgs(["--version", version, "--rc", rc, ...extra]);
}

function rejects(args, category) {
  assert.throws(() => validateArgs(args), (error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, category);
    return true;
  });
}

test("valid version and decimal rc tokens survive parsing and tag construction", () => {
  for (const [version, rc, tag] of [
    ["1.7.0", "25", "myr-v1.7.0-rc.25"],
    ["0.0.0", "0", "myr-v0.0.0-rc.0"],
    ["01.002.0003", "004", "myr-v01.002.0003-rc.004"],
    ["123.45.678", "999", "myr-v123.45.678-rc.999"],
  ]) {
    const args = parsed(version, rc);
    assert.equal(args.version, version);
    assert.equal(args.rc, rc);
    assert.equal(validateArgs(args), undefined);
    assert.equal(tagName(args), tag);
  }
});

test("version rejects missing, partial, extra, prerelease and nonnumeric segments", () => {
  rejects(parseArgs(["--rc", "1"]), /--version/);
  for (const version of ["", "1", "1.7", "1.7.0.1", "1.7.0-rc.1", "1.7.0+build", "v1.7.0", "1.x.0", "1..0", " 1.7.0", "1.7.0 "]) {
    rejects(parsed(version, "1"), /--version/);
  }
});

test("rc rejects missing, nondecimal and whitespace values", () => {
  rejects(parseArgs(["--version", "1.7.0"]), /--rc/);
  for (const rc of ["", " ", "-1", "+1", "1.0", "1e2", "0x10", "one", "1a", " 1", "1 "]) {
    rejects(parsed("1.7.0", rc), /--rc/);
  }
});

test("override requires nonblank text and a journal identifier", () => {
  for (const override of ["", " ", "\t\n"]) {
    rejects(parsed("1.7.0", "1", ["--override", override, "--journal", "OPE-12408"]), /--override.*non-empty/);
  }
  rejects(parsed("1.7.0", "1", ["--override", "reason"]), /--override requires --journal/);
  rejects(parsed("1.7.0", "1", ["--override", "reason", "--journal", ""]), /--override requires --journal/);
  for (const journal of ["OPE-12408", "ope-12408", "OpE-0"]) {
    const args = parsed("1.7.0", "01", ["--override", " reason ", "--journal", journal]);
    assert.equal(args.override, " reason ");
    assert.equal(args.journal, journal);
    assert.equal(validateArgs(args), undefined);
    assert.equal(tagName(args), "myr-v1.7.0-rc.01");
  }
});

test("journal rejects malformed identifiers even without an override", () => {
  for (const journal of ["12408", "OPE", "OPE-", "OPE-1x", "OPE-1-2", "OTHER-1", " OPE-1", "OPE-1 "]) {
    rejects(parsed("1.7.0", "1", ["--journal", journal]), /--journal must be an issue identifier/);
    rejects(parsed("1.7.0", "1", ["--override", "reason", "--journal", journal]), /--journal must be an issue identifier/);
  }
  const args = parsed("1.7.0", "1", ["--journal", "ope-12"]);
  assert.equal(args.journal, "ope-12");
  assert.equal(validateArgs(args), undefined);
  assert.equal(tagName(args), "myr-v1.7.0-rc.1");
});
