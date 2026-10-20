# REDACT step 0: candidate evaluation

Status: decision record, before implementation.

## Decision

Select Microsoft Presidio as the detection and anonymization core, with a thin Myrmidon adapter. Add only domain-specific recognizers that the candidate does not provide: Russian legal/bank identifiers with checksum validation, tenant dictionaries, tenant policy, and LiteLLM/MCP/HTTP adapters. Use the existing Presidio anonymizer operators for irreversible and reversible transformations. Keep the default policy in report-only mode until the synthetic corpus meets the release thresholds.

LLM Guard is a useful optional composition for prompt-specific scanning and its Vault/deanonymization flow, but it is not the primary core: its documented language coverage is English and Chinese, while this service requires Russian legal and bank identifiers. Natasha/spaCy ru are complementary NER components, not complete redaction engines. Gitleaks and detect-secrets are secret scanners intended primarily for source/repository scanning; they are narrow complements rather than the PII engine.

## Reproducible corpus

The benchmark uses synthetic values only. It contains one positive and one hard-negative case for each required class, plus a mixed 4 KiB payload for latency. Run it after installing the candidate dependencies in the CI image:

```text
python tools/redact-eval/benchmark.py --json results.json
```

The harness is deliberately an adapter contract rather than a home-grown recognizer. It records candidates, spans, precision/recall/F1, false-positive rate, p50/p95 latency, package versions, and unavailable dependencies. It must fail closed for missing dependencies instead of presenting fabricated scores.

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

| Candidate | PII / Russian | Legal and bank identifiers | Reversible transform | Secrets | Offline | Role | Evidence |
|---|---|---|---|---|---|---|---|
| Microsoft Presidio | Analyzer plus configurable NLP engines; Russian model must be supplied | Custom recognizers and PatternRecognizer validation are supported; checksum rules are an adapter responsibility | Anonymizer supports replace, redact, mask, hash, encrypt, and de-anonymization | Not its primary scope | Yes with models vendored in the image | Primary engine and extension point | [analyzer recognizers](https://github.com/microsoft/presidio/blob/main/docs/analyzer/developing_recognizers.md), [anonymization](https://github.com/microsoft/presidio/blob/main/docs/text_anonymization.md) |
| Protect AI LLM Guard | Documented Anonymize scanner is English/Chinese oriented | Not a Russian legal/bank solution; custom patterns are possible but would duplicate the thin layer | Vault plus Deanonymize scanner | Secrets scanner delegates to detect-secrets | Yes when models/config are local | Optional prompt scanner / vault | [Anonymize](https://github.com/protectai/llm-guard/blob/main/docs/input_scanners/anonymize.md), [Deanonymize](https://github.com/protectai/llm-guard/blob/main/docs/output_scanners/deanonymize.md), [Secrets](https://llm-guard.com/input_scanners/secrets/) |
| Natasha / spaCy ru | Natasha provides Russian PER/LOC/ORG NER and address extraction; spaCy supplies the NLP runtime | No complete legal/bank identifier validator | No service-level anonymization vault | No | Yes with local models | Complementary Russian NER | [Natasha](https://github.com/natasha/natasha), [Presidio NLP engines](https://github.com/microsoft/presidio/blob/main/docs/analyzer/developing_recognizers.md) |
| gitleaks | No general PII | No | No | Strong repository/file/stdin secret rules and custom rules | Yes | Secret-scanning complement | [official site](https://gitleaks.org/), [Go docs](https://pkg.go.dev/github.com/gitleaks/gitleaks) |
| detect-secrets | No general PII | No | No | Plugin-based secret detectors and baselines | Yes | Secret-scanning complement | [repository](https://github.com/Yelp/detect-secrets), [plugins](https://github.com/Yelp/detect-secrets/blob/master/docs/plugins.md) |

## Risks and validation plan

1. Presidio's Russian quality depends on the selected local model. Pin the model in the image and measure it rather than assuming English defaults transfer.
2. Built-in entity presence must not block by itself. Apply entity-specific confidence thresholds and keep report-only as the default during rollout.
3. Legal and bank identifiers need checksum-aware thin recognizers and negative fixtures. Do not accept a regex-only match.
4. Secret scanners can over-report high entropy strings. Measure them separately and preserve tenant allowlists.
5. Keep benchmark values synthetic and prohibit network calls in the benchmark job.

This is a selection decision, not an implementation claim. Scores are produced only by the benchmark harness in CI once dependencies and model assets are installed.
