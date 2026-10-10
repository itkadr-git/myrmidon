import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { main, parseGitLog, scanCommit, scanSignatureText } from "./ai-signature-scan.mjs";

// The forbidden strings are assembled at runtime so this file does not
// contain them literally.
const vendor = ["Anth", "ropic"].join("");
const assistant = ["Cla", "ude"].join("");
const trailer = (name, mail) => ["Co-Authored", "By"].join("-") + `: ${name} <${mail}>`;
const botMail = ["noreply", `${vendor.toLowerCase()}.com`].join("@");
const banner = (extra = "") => ["Generated", "with", `${assistant} Code${extra}`].join(" ");
const botName = ["OpenClaw", "ADM"].join(" ");

describe("scanSignatureText", () => {
  it("flags an AI co-author trailer by name and by vendor address", () => {
    assert.deepEqual(scanSignatureText(`fix\n\n${trailer(`${assistant} Opus 5.5`, "x@example.org")}`), ["ai-co-authored-by"]);
    assert.deepEqual(scanSignatureText(`fix\n\n${trailer("Someone", botMail)}`), ["ai-co-authored-by"]);
  });
  it("flags the generated-with banners, with and without the robot", () => {
    assert.deepEqual(scanSignatureText(banner()), ["ai-generated-banner"]);
    assert.deepEqual(scanSignatureText(`\u{1F916} ${banner()}`).sort(), ["ai-generated-banner", "ai-generated-robot-banner"]);
    assert.deepEqual(scanSignatureText(`[${banner()}](https://example.org)`), ["ai-generated-banner"]);
  });
  it("lets ordinary text and human co-authors through", () => {
    assert.deepEqual(scanSignatureText("fix(db): repair the journal\n\nCloses the ticket."), []);
    assert.deepEqual(scanSignatureText(trailer("Jane Doe", "jane@example.org")), []);
    assert.deepEqual(scanSignatureText("Generated with the in-house exporter"), []);
  });
});

describe("scanCommit", () => {
  it("flags the bot identity as author and as committer", () => {
    assert.deepEqual(scanCommit({ message: "ok", authorName: botName, committerName: "ItKadr" }), ["bot-author"]);
    assert.deepEqual(scanCommit({ message: "ok", authorName: "ItKadr", committerName: ` ${botName.toLowerCase()} ` }), ["bot-committer"]);
    assert.deepEqual(scanCommit({ message: "ok", authorName: "ItKadr", committerName: "GitHub" }), []);
  });
});

describe("parseGitLog / main", () => {
  const record = (sha, an, cn, msg) => `${sha}\u001f${an}\u001f${cn}\u001f${msg}\u001e\n`;
  it("parses records", () => {
    const parsed = parseGitLog(record("a".repeat(40), "A", "B", "m1\n") + record("b".repeat(40), "C", "D", "m2\n"));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].committerName, "D");
  });
  it("is red for a signed commit and green for a clean range", () => {
    const out = [];
    const io = (commits, stdin) => ({ log: (m) => out.push(m), error: (m) => out.push(m), readCommits: () => commits, stdin });
    const signed = [{ sha: "c".repeat(40), authorName: "ItKadr", committerName: "ItKadr", message: `x\n\n${trailer(assistant, botMail)}` }];
    assert.equal(main(["--commits", "a..b"], io(signed, "")), 1);
    assert.ok(out.join("\n").includes("commit cccccccccc: ai-co-authored-by"));
    assert.ok(!out.join("\n").includes(botMail), "the matched text is never printed");
    const clean = [{ sha: "d".repeat(40), authorName: "ItKadr", committerName: "ItKadr", message: "x" }];
    assert.equal(main(["--commits", "a..b"], io(clean, "title\nbody")), 0);
    assert.equal(main(["--commits", "a..b"], io(clean, banner())), 1);
  });
  it("fails closed on an unreadable range and on bad arguments", () => {
    const quiet = { log() {}, error() {}, readCommits: () => { throw new Error("git log failed"); }, stdin: "" };
    assert.equal(main(["--commits", "nope..nope"], quiet), 2);
    assert.equal(main(["--bogus"], quiet), 2);
    assert.equal(main(["--commits"], quiet), 2);
  });
});

describe("against a real git history", () => {
  it("reads the commits of a range from git", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sig-"));
    const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "ItKadr");
    git("config", "user.email", "itkadr-git@users.noreply.github.com");
    fs.writeFileSync(path.join(dir, "a"), "1");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    fs.writeFileSync(path.join(dir, "a"), "2");
    git("commit", "-q", "-am", `change\n\n${trailer(assistant, botMail)}`);
    const script = fileURLToPath(new URL("./ai-signature-scan.mjs", import.meta.url));
    const red = spawnSync("node", [script, "--commits", `${base}..HEAD`], { cwd: dir, encoding: "utf8" });
    assert.equal(red.status, 1);
    const green = spawnSync("node", [script, "--commits", `${base}..${base}`], { cwd: dir, encoding: "utf8" });
    assert.equal(green.status, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
