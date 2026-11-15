# REDACT per nest

The configuration is stored in `nest_redact_settings` and read for each request; updates apply immediately without a restart.

The instance admin manages a nest with `PATCH /api/myrmidon/nests/:nestId/redact`. The payload can set `mode`, enable `counterparties`, `signers`, `contracts`, and `invoices`, and replace the contract/invoice number lists. The counterparties and signers dictionaries map source text to its replacement. The current nest identity is company-backed: `nest_id` is the corresponding `companies.id` (one nest per company in the current knowledge contract).

`redactNestText(db, nestId, text)` resolves the selected nest configuration and applies only its enabled rules. A missing nest uses the safe default configuration.
