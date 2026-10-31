# REDACT step 0: candidate evaluation

Status: preliminary decision record, before implementation. This document does not report benchmark results. The selection becomes final only after the benchmark gates below pass in CI.

## Decision

Select Microsoft Presidio as the detection and anonymization core, with a thin Myrmidon adapter. Add only domain-specific recognizers that the candidate does not provide: Russian legal/bank identifiers with checksum validation, tenant dictionaries, tenant policy, and LiteLLM/MCP/HTTP adapters. Use the existing Presidio anonymizer operators for irreversible and reversible transformations. Keep the default policy in report-only mode until the synthetic corpus meets the release thresholds.

LLM Guard is a useful optional composition for prompt-specific scanning and its Vault/deanonymization flow, but it is not the primary core: its documented language coverage is English and Chinese, while this service requires Russian legal and bank identifiers. Natasha/spaCy ru are complementary NER components, not complete redaction engines. Gitleaks and detect-secrets are secret scanners intended primarily for source/repository scanning; they are narrow complements rather than the PII engine.

## Reproducible corpus and measurement

The benchmark uses synthetic values only. It contains 20 positive and 20 hard-negative cases for each required class, plus a fixed mixed 4 KiB payload for latency. The corpus is versioned with the benchmark. The run uses seed 3233, exact-span matching for precision and recall, and reports false-positive rate as false positives divided by hard-negative cases. It records p50 and p95 latency over 100 local runs after one warm-up run.

Run it after installing each candidate's pinned dependencies and local model assets in the CI image:

```text
python tools/redact-eval/benchmark.py --json results.json
```

The harness is deliberately an adapter contract rather than a home-grown recognizer. It records candidates, spans, precision/recall/F1, false-positive rate, p50/p95 latency, package and model versions, license metadata, liveness evidence, and unavailable dependencies. It must fail closed for missing dependencies instead of presenting fabricated scores. A CI artifact stores the JSON result and exact corpus revision.

Required gates from the issue:

| Metric | Gate |
|---|---:|
| Recall: INN, OGRN, bank accounts, BIK, cards, secrets | >= 0.95 |
| False-positive rate | <= 0.02 |
| Guardrail latency, 4 KiB | <= 150 ms |
| Reversible round trip | byte-for-byte equality |
| Report-only mode | does not block |
| Network access | none |

## Candidate comparison

| Candidate | PII / Russian | Legal and bank identifiers | Reversible transform | Secrets | Offline | License | Liveness checked 2026-10-20 | Measured benchmark |
|---|---|---|---|---|---|---|---|---|
| Microsoft Presidio | Analyzer plus configurable NLP engines; Russian model must be supplied | Custom recognizers and PatternRecognizer validation are supported; checksum rules are an adapter responsibility | Anonymizer supports replace, redact, mask, hash, encrypt, and de-anonymization | Not its primary scope | Yes with models vendored in the image | MIT | Active GitHub repository and release history; verify again in CI | Not measured; run with the corpus and pinned Russian model; [recognizers](https://github.com/microsoft/presidio/blob/main/docs/analyzer/developing_recognizers.md), [anonymization](https://github.com/microsoft/presidio/blob/main/docs/text_anonymization.md), [license](https://github.com/microsoft/presidio/blob/main/LICENSE) |
| Protect AI LLM Guard | Documented Anonymize scanner is English/Chinese oriented | Not a Russian legal/bank solution; custom patterns are possible but would duplicate the thin layer | Vault plus Deanonymize scanner | Secrets scanner delegates to detect-secrets | Yes when models/config are local | Apache-2.0 | Active GitHub repository and release history; verify again in CI | Not measured; run compatible subset and record unsupported classes; [Anonymize](https://github.com/protectai/llm-guard/blob/main/docs/input_scanners/anonymize.md), [Deanonymize](https://github.com/protectai/llm-guard/blob/main/docs/output_scanners/deanonymize.md), [license](https://github.com/protectai/llm-guard/blob/main/LICENSE) |
| Natasha / spaCy ru | Natasha provides Russian PER/LOC/ORG NER and address extraction; spaCy supplies the NLP runtime | No complete legal/bank identifier validator | No service-level anonymization vault | No | Yes with local models | Apache-2.0 / MIT | Active repositories and release history; verify again in CI | Not measured; run NER subset only and record unsupported classes; [Natasha](https://github.com/natasha/natasha), [Presidio NLP engines](https://github.com/microsoft/presidio/blob/main/docs/analyzer/developing_recognizers.md) |
| gitleaks | No general PII | No | No | Strong repository/file/stdin secret rules and custom rules | Yes | GPL-3.0 | Active repository and release history; verify again in CI | Not measured; run secret subset only; [official site](https://gitleaks.org/), [license](https://github.com/gitleaks/gitleaks/blob/master/LICENSE) |
| detect-secrets | No general PII | No | No | Plugin-based secret detectors and baselines | Yes | Apache-2.0 | Active repository and release history; verify again in CI | Not measured; run secret subset only; [repository](https://github.com/Yelp/detect-secrets), [plugins](https://github.com/Yelp/detect-secrets/blob/master/docs/plugins.md), [license](https://github.com/Yelp/detect-secrets/blob/master/LICENSE.md) |

## Risks and validation plan

1. Presidio's Russian quality depends on the selected local model. Pin the model in the image and measure it rather than assuming English defaults transfer.
2. Built-in entity presence must not block by itself. Apply entity-specific confidence thresholds and keep report-only as the default during rollout.
3. Legal and bank identifiers need checksum-aware thin recognizers and negative fixtures. Do not accept a regex-only match.
4. Secret scanners can over-report high entropy strings. Measure them separately and preserve tenant allowlists.
5. Keep benchmark values synthetic and prohibit network calls in the benchmark job.

The REDACT implementation owner runs the benchmark in CI after dependency and
model pins are merged. The release owner reviews the CI JSON artifact. The
report-only policy may change to enforcement only after all required recall,
false-positive, latency, reversible-round-trip, and offline gates pass in two
consecutive CI runs and the release owner records that decision. Until then,
report-only is mandatory and never blocks a request.

This is a selection decision, not an implementation claim. Scores are produced only by the benchmark harness in CI once dependencies and model assets are installed.
