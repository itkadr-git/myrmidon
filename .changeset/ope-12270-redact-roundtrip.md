---
'@myrmidon/server': patch
---

Secrets (redact-roundtrip): refuse to persist any plain env binding or adapter config secret field whose value CONTAINS the `***REDACTED***` sentinel, not only values equal to it (OPE-12270). Agent GET redacts plain values, including keys nested inside JSON-string env values such as `adapterConfig.env.PAPERCLIP_OMP_PROVIDERS`; a read-modify-write PATCH then sent the literal mask to the provider (LiteLLM 401). The write-time guard now rejects the whole roundtrip with 422 «value came from a redacted response, send the original value» instead of storing the mask.
