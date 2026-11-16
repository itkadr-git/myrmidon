#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
export function validateEvidence(evidence, run, liveTagSha, tag) {
  if (!evidence || evidence.tag !== tag || !evidence.headSha || !evidence.runId || !evidence.attempt || !evidence.previousAttempt) throw new Error("evidence must include tag, headSha, runId and rerun attempt transition");
  if (liveTagSha !== evidence.headSha) throw new Error("evidence headSha does not match the release tag");
  if (run.head_sha !== evidence.headSha || Number(run.run_attempt) !== Number(evidence.attempt) || Number(evidence.attempt) <= Number(evidence.previousAttempt)) throw new Error("live run does not match the exact evidenced rerun attempt");
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("rerun is not completed successfully");
  if (!Array.isArray(evidence.jobs) || evidence.jobs.length === 0 || evidence.jobs.some((job) => job.status !== "completed" || job.conclusion !== "success" || Number(job.runAttempt) !== Number(evidence.attempt))) throw new Error("evidence must prove every job succeeded on the exact rerun attempt");
  // Offline callers may omit jobs; when supplied, live results are authoritative.
  if (Object.hasOwn(run, "jobs")) {
    if (!Array.isArray(run.jobs) || run.jobs.length === 0 || run.jobs.some((job) =>
      job.id == null || job.status !== "completed" || job.conclusion !== "success" ||
      Number(job.run_attempt) !== Number(evidence.attempt) ||
      !evidence.jobs.some((proof) => proof.id === job.id)
    )) throw new Error("live jobs must all succeed on the exact attempt and appear in evidence");
  }
}
export function waiverRecordFromEvidence(evidence, { reason, journal, actor = process.env.GITHUB_ACTOR || process.env.USER || "unknown", recordedAt = new Date().toISOString() }) {
  return {
    tag: evidence.tag,
    headSha: evidence.headSha,
    runId: String(evidence.runId),
    previousAttempt: Number(evidence.previousAttempt),
    attempt: Number(evidence.attempt),
    jobs: evidence.jobs,
    url: evidence.url,
    verdict: "not-related-to-changes",
    reason,
    journal,
    actor,
    recordedAt,
  };
}

function evidenceLive(r, evidence, tag) {
  const liveSha = tagSha(r, tag);
  const run = gh(r, `actions/runs/${evidence.runId}`);
  const jobs = gh(r, `actions/runs/${evidence.runId}/jobs?per_page=100`);
  validateEvidence(evidence, { ...run, jobs: jobs.jobs || [] }, liveSha, tag);
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
  const record = waiverRecordFromEvidence(evidence, { reason: a.reason, journal: a.journal });
  fs.mkdirSync(new URL("../../../docs/myrmidon/releases/flaky-waivers/", import.meta.url), { recursive: true });
  const records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  fs.writeFileSync(file, `${JSON.stringify([...records, record], null, 2)}\n`);
  console.log(`waiver recorded: ${a.tag}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (error) { die(error.message); }
}
