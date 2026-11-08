-- myrmidon(1.6.4-BOT-CONTAINER-CARD): complete the legacy bot container cards.
-- 48 of 74 container bots carried `adapterConfig.container` without `enabled`
-- and without `memoryMb`/`cpus`/`pidsLimit` (the limits lived only in the
-- dockergate config), so the board refused to apply them and the bot image
-- rollout skipped them. Data only, no schema change: for every agent whose
-- adapter_config has a `container` object, `enabled` becomes true when absent
-- and a missing limit takes the product default (memoryMb 2048, cpus 1,
-- pidsLimit 512: the card form's defaults, one set for every bot image
-- family). Values already on the card win, including `enabled: false`.
-- Idempotent: a second run finds nothing missing.
UPDATE "agents"
SET "adapter_config" = jsonb_set(
	"adapter_config",
	'{container}',
	jsonb_build_object('enabled', true, 'memoryMb', 2048, 'cpus', 1, 'pidsLimit', 512)
		|| jsonb_strip_nulls("adapter_config" -> 'container')
)
WHERE jsonb_typeof("adapter_config" -> 'container') = 'object'
	AND (
		NOT ("adapter_config" -> 'container' ? 'enabled')
		OR NOT ("adapter_config" -> 'container' ? 'memoryMb')
		OR NOT ("adapter_config" -> 'container' ? 'cpus')
		OR NOT ("adapter_config" -> 'container' ? 'pidsLimit')
		OR jsonb_typeof("adapter_config" -> 'container' -> 'enabled') = 'null'
		OR jsonb_typeof("adapter_config" -> 'container' -> 'memoryMb') = 'null'
		OR jsonb_typeof("adapter_config" -> 'container' -> 'cpus') = 'null'
		OR jsonb_typeof("adapter_config" -> 'container' -> 'pidsLimit') = 'null'
	);
