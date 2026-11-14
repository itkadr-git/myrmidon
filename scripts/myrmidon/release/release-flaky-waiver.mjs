#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";

function die(message) { console.error(`RELEASE-FLAKY-WAIVER REFUSED: ${message}`); process.exitCode = 1; }
function args(argv) {
  const out = { mode: argv[0], tag: null, evidenceFile: null, reason: null, journal: null, note: null };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tag") out.tag = argv[++i];
    else if (a === "--evidence-file") out.evidenceFile = argv[++i];
    else if (a === "--reason") out.reason = argv[++i];
    else if (a === "--journal") out.journal = argv[++i];
    else if (a === "--note") out.note = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}
function gh(repo, apiPath) { return JSON.parse(execFileSync("gh", ["api", `repos/${repo}/${apiPath}`], { encoding: "utf8" })); }
function repo() { return process.env.GITHUB_REPOSITORY || "itkadr-git/myrmidon"; }
function tagSha(r, tag) {
  const ref = gh(r, `git/ref/tags/${tag}`);
  if (ref.object.type !== "tag") return ref.object.sha;
  return gh(r, `git/tags/${ref.object.sha}`).object.sha;
}
function evidenceLive(r, evidence, tag) {
  if (!evidence || evidence.tag !== tag || !evidence.headSha || !evidence.runId || !evidence.attempt) throw new Error("evidence must include tag, headSha, runId and attempt");
  if (tagSha(r, tag) !== evidence.headSha) throw new Error("evidence headSha does not match the release tag");
  const run = gh(r, `actions/runs/${evidence.runId}`);
  if (run.head_sha !== evidence.headSha || Number(run.run_attempt) < Number(evidence.attempt)) throw new Error("live run does not match evidence head or attempt");
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("rerun is not completed successfully");
}
function waiverPath(tag) { return new URL(`../../../docs/myrmidon/releases/flaky-waivers/${tag}.json`, import.meta.url).pathname; }
function main(argv) {
  const a = args(argv);
  if (!a.tag || !["record", "verify"].includes(a.mode)) throw new Error("usage: record|verify --tag TAG [--evidence-file FILE --reason TEXT --journal OPE-NNNN]");
  const file = waiverPath(a.tag);
  if (a.mode === "verify") {
    if (!fs.existsSync(file)) throw new Error("no waiver exists");
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(records) || records.length === 0) throw new Error("waiver journal is empty");
    for (const record of records) evidenceLive(repo(), record, a.tag);
    console.log(`waiver verified: ${a.tag}`); return;
  }
  if (!a.evidenceFile || !a.reason?.trim() || !a.journal) throw new Error("record requires --evidence-file, --reason and --journal");
  const evidence = JSON.parse(fs.readFileSync(a.evidenceFile, "utf8"));
  evidenceLive(repo(), evidence, a.tag);
  const record = { tag: a.tag, sha: evidence.headSha, runId: String(evidence.runId), attempt: Number(evidence.attempt), verdict: "not-related-to-changes", reason: a.reason, journal: a.journal, actor: process.env.GITHUB_ACTOR || process.env.USER || "unknown", recordedAt: new Date().toISOString() };
  fs.mkdirSync(new URL("../../../docs/myrmidon/releases/flaky-waivers/", import.meta.url), { recursive: true });
  const records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  fs.writeFileSync(file, `${JSON.stringify([...records, record], null, 2)}\n`);
  console.log(`waiver recorded: ${a.tag}`);
}
try { main(process.argv.slice(2)); } catch (error) { die(error.message); }
