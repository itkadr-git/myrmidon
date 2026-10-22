# REDACT step 0: candidate evaluation

Status: preliminary evaluation proposal, not a completed benchmark or final selection. No candidate has measured scores in this document. Repository and upstream evidence below was checked on 2026-10-22; each external claim is tied to a pinned source revision and date. Recheck sources when dependencies are pinned.

## Evidence ledger and decision status

Verified repository facts (checked 2026-10-22): this repository contains this document but does not contain `tools/redact-eval/benchmark.py` or a benchmark corpus. Therefore the command, corpus, metrics, and gates below are proposals; no scores, candidate performance, or CI artifacts are reported here. The repository check is reproducible with `test ! -e tools/redact-eval/benchmark.py` at PR head `d1acf766a1d84f9606052bcc6427341c4cdbc096`.

Verified upstream documentation claims are not service measurements. The dated primary-source revisions are listed in each candidate row. Provisional hypothesis: Presidio is a plausible primary integration candidate because its documented recognizer and anonymizer extension points could accommodate domain-specific needs. This hypothesis is not a selection and has no measured support. The release owner must not treat it as approved until the future run passes the gates below.

All candidates are explicitly UNMEASURED/TBD as of 2026-10-22. “Measured” means a completed run against the versioned fixture with raw JSON published; no row currently meets that definition.

## Proposed reproducible benchmark (not yet implemented)

A separate follow-up must implement and review a harness and versioned synthetic corpus. Pin candidate package versions and all local model assets; prohibit network access. Use fixed seeded inputs with labeled positive and hard-negative examples per required class (INN, OGRN, bank accounts, BIK, cards, secrets), plus a fixed mixed 4 KiB payload. Publish corpus revision, exact candidate/model versions, invocation, environment, and raw JSON. Define span normalization and exact-span scoring before execution; report per-class precision, recall, F1, and false-positive rate with denominators. Unsupported classes/dependencies are `unsupported`, never zero or fabricated measurements.

Benchmark owner: REDACT implementation owner (must be assigned before the follow-up starts). Until that assignment and pinned dependencies are recorded, every candidate remains UNMEASURED/TBD.

## Candidate comparison

| Candidate | Status at 2026-10-22 | Primary evidence (revision and date) | Future fixture and method |
|---|---|---|---|
| Microsoft Presidio | UNMEASURED/TBD; provisional hypothesis only, not a selection. | Recognizer extension points: [94f866a](https://github.com/data-privacy-stack/presidio/commit/94f866a96b733bfccaef11e630a5ee3cf7279ba6), 2026-06-28. Anonymizer docs: [4aaa05f](https://github.com/data-privacy-stack/presidio/commit/4aaa05fca8c162853d47046954ed65d78f838e9b), 2023-10-25. License: [7b6a43a](https://github.com/data-privacy-stack/presidio/commit/7b6a43abf8828ce77924abeabd3a15c0622f60bc), 2026-06-30. | `redact-corpus-v1`, seeded positives/hard negatives for all seven required classes and mixed 4 KiB payload; pinned local model. Measure exact spans, p50/p95 latency, offline behavior, reversible round trip, and report-only mode. |
| Protect AI LLM Guard | UNMEASURED/TBD; comparison candidate, not rejected by measured results. | Anonymize docs: [2d5d4a6](https://github.com/protectai/llm-guard/commit/2d5d4a6fe4028e5f14c39851f3671e446bbf1609), 2024-04-26. Deanonymize docs: [d4635c8](https://github.com/protectai/llm-guard/commit/d4635c8e5dae60a860e93effb367a18fabbf5ec3), 2023-12-18. License: [91a476e](https://github.com/protectai/llm-guard/commit/91a476e2355edc998061943e16bec1e4481e1235), 2024-04-09. | `redact-corpus-v1`; compatible classes only must be listed, unsupported classes reported, secret subset assessed separately, and vault round trip tested under the same offline run. |
| Natasha / spaCy ru | UNMEASURED/TBD; NER comparison component, not assumed to be a redaction engine. | Natasha repository: [efa2520](https://github.com/natasha/natasha/commit/efa252023298840a27c24bcbecdf6c068c5b2074), 2024-02-28. Presidio engine integration reference: [94f866a](https://github.com/data-privacy-stack/presidio/commit/94f866a96b733bfccaef11e630a5ee3cf7279ba6), 2026-06-28. | `redact-corpus-v1`; evaluate NER-supported classes only, report unsupported identifiers, and make no service-level vault claim. |
| gitleaks | UNMEASURED/TBD; secret-scanning candidate, not general PII detection. | Repository: [80093b8](https://github.com/gitleaks/gitleaks/commit/80093b8a7b600e52d96ec5d49e9657f5c74b77fa), 2026-05-21. License: [274e821](https://github.com/gitleaks/gitleaks/commit/274e8212a6aa833c4723d151af35e9377ba70e8b), 2019-12-04. | `redact-corpus-v1` secrets subset; measure false positives and report all unsupported PII classes as unsupported. |
| detect-secrets | UNMEASURED/TBD; plugin-based secret-scanning candidate, not general PII detection. | Repository: [01886c8](https://github.com/Yelp/detect-secrets/commit/01886c8a910c64595c47f186ca1ffc0b77fa5458), 2024-05-06. Plugins: [018c9d1](https://github.com/Yelp/detect-secrets/commit/018c9d1ee2a152a82c612ee82c0cd952a4f3eae4), 2020-12-01. License path is `LICENSE` in the repository; verify its pinned revision before adoption. | `redact-corpus-v1` secrets subset; measure false positives and report all unsupported PII classes as unsupported. |

## Future gate contract

The following are proposed gates from the REDACT issue, not observed results. A future benchmark run must use fixture `redact-corpus-v1` (seed and revision recorded in the artifact), pinned package/model versions, an offline CI job, and 30 repeated local runs after 5 warm-up runs on the same declared runner. The benchmark owner is the assigned REDACT implementation owner; the owner must attach raw JSON and take the listed action on failure.

| Gate | Threshold and window | Pass/fail rule | Owner and failure action |
|---|---|---|---|
| Per-class recall | >= 0.95 for each required class; all labeled positives in `redact-corpus-v1` | Pass only when every class meets threshold; missing/unsupported class is fail, not zero-scored | Benchmark owner; mark candidate not ready, publish failing class and open a follow-up fixture/recognizer issue |
| False-positive rate | <= 0.02 over all labeled hard negatives in `redact-corpus-v1` | Compute FP/(FP+TN) with denominator in raw JSON; any class over threshold fails | Benchmark owner; publish confusion counts and open tuning/follow-up issue |
| Guardrail latency | p95 <= 150 ms for mixed 4 KiB payload, after 5 warm-ups and over 30 runs | Fail if p95 exceeds threshold or runner/version is missing | Benchmark owner; publish raw timings and open performance follow-up |
| Reversible round trip | 100% byte-for-byte equality on every reversible fixture in `redact-corpus-v1` | Any mismatch fails | Benchmark owner; stop candidate recommendation and open reversible-storage follow-up |
| Report-only behavior | 100% of report-only fixtures return without blocking the caller | Any block/error fails | Benchmark owner; open rollout/adapter follow-up and keep enforcement disabled |
| Network isolation | Zero network requests during the complete run | Any request or unavailable offline asset fails | Benchmark owner; publish network trace and pin local assets before rerun |

A failed gate means no final candidate decision: publish the raw artifact, record the exact fixture/version and denominator, assign the follow-up owner, and rerun only after the corrective change is reviewed. Until all gates have a passing artifact, Presidio remains a provisional hypothesis only.

## Risks and scope

Russian model quality and local/offline behavior must be tested with the exact pinned model; English/default behavior is not a proxy. Legal and bank identifier recognition needs checksum-aware validation and negative fixtures; regex presence alone is insufficient. Secret scanners may over-report high-entropy values and are evaluated only on the secrets subset. The future corpus must be synthetic and network-disabled.

This documentation correction does not create a service, recognizer, adapter, storage system, benchmark harness, or benchmark corpus. It does not establish current runtime behavior or authorize enforcement; report-only is a proposed safe rollout posture pending implementation and verification.
