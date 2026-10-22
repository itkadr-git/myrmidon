# REDACT step 0: candidate evaluation

Status: preliminary evaluation proposal, not a completed benchmark or final selection. No candidate has measured scores in this document. The evidence below was checked against linked upstream documentation and repository contents on 2026-10-22; upstream claims should be rechecked when dependencies are pinned.

## Verified facts and provisional hypothesis

Verified repository fact: at PR head `0e05d3c8f3632afedee5089aa49414b45b458ecb`, the repository contains this evaluation document but does not contain `tools/redact-eval/benchmark.py` or a benchmark corpus. The benchmark command, corpus design, and metric protocol below are proposed work, not an available harness or completed evaluation. No scores, candidate performance, or CI artifacts are reported here.

Verified documentation facts: Presidio documents configurable recognizers and anonymizer operators, including encryption/de-anonymization; see the dated upstream links in its candidate row. These docs do not establish performance with Myrmidon's Russian identifiers or models.

Provisional hypothesis only: Presidio is a plausible primary integration candidate because its documented recognizer/anonymizer extension points could accommodate Myrmidon's Russian/domain-specific needs. This is not an evidence-backed selection yet. LLM Guard, Natasha/spaCy ru, gitleaks, and detect-secrets are comparison candidates or potential complements, not rejected by measured results. Validate actual language/model support and behavior at pinned versions before choosing.

## Proposed reproducible benchmark (not yet implemented)

Before claiming results, implement and review a harness and versioned synthetic corpus as separate follow-up work. Pin candidate package versions and all local model assets; prohibit network access. Use fixed seeded inputs with labeled positive and hard-negative examples per required class (INN, OGRN, bank accounts, BIK, cards, secrets), and a fixed mixed 4 KiB payload. Publish corpus revision, exact candidate/model versions, invocation, environment, and raw JSON artifact. Define span normalization and exact-span scoring in advance; report per-class precision, recall, F1, and false-positive rate with denominators. Measure p50/p95 latency after a documented warm-up over a fixed number of repeated local runs. Test reversible transformation for byte-for-byte round trip and report-only mode for non-blocking behavior. Unsupported classes/dependencies must be marked unsupported/unavailable, never scored as zero or represented by fabricated measurements.

Proposed acceptance gates stated in the REDACT issue (checked 2026-10-22; not observed results): recall >= 0.95 for each required class; false-positive rate <= 0.02; guardrail latency <= 150 ms for 4 KiB; reversible round trip is byte-for-byte equal; report-only does not block; and no network access. A future benchmark PR must confirm exact metric denominators and sample size with the REDACT owner before treating these thresholds as reproducible gates.

## Candidate comparison

All performance/quality measurements below are NOT MEASURED as of 2026-10-22. Capability summaries are upstream documentation claims, not tests of pinned packages in this service. License identifiers are based on linked license files as checked 2026-10-22; recheck exact versions before adoption.

| Candidate | Documented capability / proposed scope | Measured vs. unmeasured | Evidence checked 2026-10-22 |
|---|---|---|---|
| Microsoft Presidio | Configurable analyzer recognizers and anonymizer operators are documented. Russian model compatibility, identifiers, checksum handling, service integration, and offline behavior remain to be validated. | No measurements. Future run: all required classes, exact-span metrics, 4 KiB latency, offline and reversible round-trip checks using pinned local model. | [Recognizer docs](https://github.com/microsoft/presidio/blob/main/docs/analyzer/developing_recognizers.md); [anonymization docs](https://github.com/microsoft/presidio/blob/main/docs/text_anonymization.md); [MIT license](https://github.com/microsoft/presidio/blob/main/LICENSE) |
| Protect AI LLM Guard | Anonymize/Vault and Deanonymize scanners are documented. Suitability for Russian/domain identifiers is unverified here. | No measurements. Future run: compatible subset only; explicitly list unsupported classes; assess secret scanner separately and test vault round trip. | [Anonymize](https://github.com/protectai/llm-guard/blob/main/docs/input_scanners/anonymize.md); [Deanonymize](https://github.com/protectai/llm-guard/blob/main/docs/output_scanners/deanonymize.md); [license](https://github.com/protectai/llm-guard/blob/main/LICENSE) |
| Natasha / spaCy ru | Natasha documents Russian NLP capabilities; evaluated here as an NER component, not assumed to be a complete redaction engine. | No measurements. Future run: NER-supported classes only; report unsupported identifiers and no service-level vault claim. | [Natasha repository](https://github.com/natasha/natasha); [Presidio NLP engine docs](https://github.com/microsoft/presidio/blob/main/docs/analyzer/developing_recognizers.md) |
| gitleaks | Secret-scanning candidate, not assumed to provide general PII detection. | No measurements. Future run: labeled synthetic secrets subset; report false positives and unsupported PII classes. | [Official site](https://gitleaks.org/); [license](https://github.com/gitleaks/gitleaks/blob/master/LICENSE) |
| detect-secrets | Plugin-based secret-scanning candidate, not assumed to provide general PII detection. | No measurements. Future run: labeled synthetic secrets subset; report false positives and unsupported PII classes. | [Repository](https://github.com/Yelp/detect-secrets); [plugins](https://github.com/Yelp/detect-secrets/blob/main/docs/plugins.md); [license](https://github.com/Yelp/detect-secrets/blob/main/LICENSE.md) |

## Follow-ups and risks

- Benchmark/corpus follow-up: no owner or merged implementation is evidenced by this document; the REDACT implementation owner must be assigned and agree corpus, metric protocol, and pinned dependencies before results can be claimed. This is a prerequisite to any final candidate decision, not a blocker to this documentation correction.
- Russian model quality and local/offline behavior must be tested with the exact pinned model; English/default behavior is not a proxy.
- Legal and bank identifier recognition needs checksum-aware validation and negative fixtures; regex presence alone is insufficient.
- Secret scanners may over-report high-entropy values; evaluate their secret subset separately.
- Keep any future benchmark corpus synthetic and deny network access in its CI job.

Until the benchmark follow-up produces reproducible artifacts and the release owner records a decision, Presidio remains a provisional hypothesis only. This document does not establish current runtime behavior or authorize enforcement; report-only is a proposed safe rollout posture pending implementation and verification.
