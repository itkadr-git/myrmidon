# LiteLLM key budgets

> Русская версия: [litellm-key-budgets.ru.md](litellm-key-budgets.ru.md)

The Gateway Keys tab displays per-agent and scoped service key budgets projected from the existing OPE-8675 budget projection. It does not create a second budget store and never returns raw gateway key values.

## API

`GET /api/myrmidon/companies/:companyId/litellm/key-budgets`

The response contains:

- `agents`: safe agent key metadata plus the projected caste limit;
- `services`: safe service/scope metadata plus projected limits;
- `signalOnly` and `projectionEnabled` state.

Budget data is read from `instance_settings.general.myrmidonBudgetProjectionCompanies[companyId]`, the same document used by the budget projection settings API. Secret values are never included; only secret names, presence, and value hashes may appear in key views.

## UI behavior

The Gateway Keys tab requests `key-budgets` separately from key metadata. It renders agent and service limits, including amount, period, and effective `soft`/`block` mode. If the budget request fails, the tab shows the error while retaining the keys card. A missing or empty projection is shown as an empty budget state.

Updates must go through the existing OPE-8675 settings mutation (`mutateBudgetProjectionDocument`). That read-modify-write operation is atomic, so a failed validation or database operation cannot leave a partial projection document.
