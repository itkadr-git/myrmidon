# REDACT entity recognition

The guardrails `POST /api/myrmidon/guardrails/entities` endpoint returns entity spans and a confidence score for each match. Recognition is deterministic and does not call an LLM. Scores are heuristic, not probabilities; callers must choose a threshold appropriate to their risk and must not block solely because a match exists.

Tax identifiers, SNILS, cards and registration numbers use check digits. For a bank account on a line with exactly one explicitly labelled BIC, the account is checked against that BIC; a mismatch is not emitted as an account. With no unique labelled BIC on the same line, the account is emitted at lower confidence without that check. This heuristic cannot establish which bank owns an account in an arbitrary document. The dictionary matcher is an integration interface; no dictionary is configured by this endpoint.
