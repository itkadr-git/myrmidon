# Режимы ограждений

Режимы ограждений хранятся в `guardrail_mode_settings` для каждого правила. Правила: `secrets_output`, `pii_output`, `prompt_injection_input`. Режимы: `flag_only`, `mask`, `block`.

Эффективный режим выбирается в порядке агент, каста, компания, затем безопасный дефолт `flag_only`. `GET /api/myrmidon/companies/:companyId/agents/:agentId/guardrails/modes` возвращает режим, источник значения и правило. Board может изменить настройку через `PUT /api/myrmidon/companies/:companyId/guardrails/modes`.

Кэш эффективных значений инвалидируется после записи и имеет короткий TTL. Изменение видно без перезапуска сервера.
