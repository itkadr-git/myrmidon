---

divergence-section: 1.6.6 — licensing
settings-section: 1.6.6 — licensing
---

## changelog-en

### Alibaba image connector is covered by the closed-module license gate (LICENSING)

- The board now lists `alibaba-image` as a known closed module.
- Installed `myrmidon.alibaba-image` plugins appear in the license status and request.
- The existing Ed25519 verifier applies installation, expiry, module, and feature checks.
- Missing, invalid, expired, tampered, foreign, or ungranted licenses remain fail-closed.
- No private signing key is shipped to the board.

## changelog-ru

### Коннектор Alibaba Image защищён гейтом лицензии закрытого модуля (LICENSING)

- Доска теперь знает закрытый модуль `alibaba-image`.
- Установленный плагин `myrmidon.alibaba-image` появляется в статусе лицензии и запросе.
- Существующий Ed25519-проверяющий код применяет проверки установки, срока, модуля и функций.
- При отсутствии, ошибке, истечении срока, подмене, чужой подписи или отсутствии модуля доступ остаётся закрыт.
- Закрытый ключ подписи не поставляется на доску.
