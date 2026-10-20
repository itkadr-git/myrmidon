# REDACT per nest

The REDACT configuration is keyed by `nest_id` and stored in the service database under `instance_settings.general.nestRedactByNest`. It is hot-reloaded on every request, so changing one nest does not affect another and does not require a restart.

The instance admin manages a nest with `PATCH /api/myrmidon/nests/:nestId/redact`. The payload can set `mode`, enable `counterparties`, `signers`, `contracts`, and `invoices`, and replace the contract/invoice number lists. The counterparties and signers dictionaries map source text to its replacement.

`redactNestText(db, nestId, text)` resolves the selected nest configuration and applies only its enabled rules. A missing nest uses the safe default configuration.
