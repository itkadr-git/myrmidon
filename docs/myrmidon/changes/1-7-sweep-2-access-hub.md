---
settings-section: Track 5 — operations
---

<!-- myrmidon(1.7 SWEEP-2, OPE-12619): ACCESS-HUB switch and ssh timeout — movable from env to «Тонкие настройки» (write). OPE-12124 rule: explicit env is the forced override; otherwise the saved Fine settings value applies without a restart; otherwise the default (section stays OFF, timeout 30000). The ssh admin-key secret name and host addresses stay in env/secrets, outside the registry. EN rows already exist in SETTINGS.md — replaced in place; RU appends new rows. -->

## settings-en-replace

| `MYRMIDON_ACCESS_HUB_ENABLED` | OPE-12619 | `false` | Master switch of the Access Hub section. A saved Fine settings value applies without a restart | An explicit environment value is the forced override; otherwise save the switch in Fine settings |
| `MYRMIDON_ACCESS_HUB_SSH_TIMEOUT_MS` | OPE-12619 | `30000` | Ceiling for a single access-hub ssh operation in milliseconds, 1000–300000; out-of-range values fall back to the next source. A saved Fine settings value applies without a restart | An explicit environment value is the forced override; otherwise save the timeout in Fine settings |

## settings-ru

| `MYRMIDON_ACCESS_HUB_ENABLED` | OPE-12619 | `false` | Главный переключатель раздела Access Hub. Сохранённое значение «Тонких настроек» применяется без перезапуска | Явное значение env — принудительное; иначе переключатель задаётся в «Тонких настройках» |
| `MYRMIDON_ACCESS_HUB_SSH_TIMEOUT_MS` | OPE-12619 | `30000` | Потолок времени одной ssh-операции access-hub в миллисекундах, 1000–300000; значения вне диапазона откатываются к следующему источнику. Сохранённое значение применяется без перезапуска | Явное значение env — принудительное; иначе таймаут задаётся в «Тонких настройках» |
