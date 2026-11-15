## changelog-en

### Bot images ship patched aiohttp, httpx2 and certifi (OPE-12760)

- The pinned hermes (v2026.9.24, 0.21.5) locks aiohttp 3.14.3, httpx2 2.7.0 and certifi 2026.5.20, all with known advisories: aiohttp GHSA-2g87-pp6c-29x5 and GHSA-5wr8-gcqf-gqf3 (the gateway API server runs on it), httpx2 GHSA-8xx6-hgc6-gc2m, GHSA-f2fp-rgf2-35cp and others (used by HTTP MCP), certifi GHSA-6q48-6c7w-9gw2. The bot runtime image now installs aiohttp 3.14.5, httpx2 2.12.0 and certifi 2026.10.19 over them and fails the build when any of the three is lower. The override is dropped when the pinned hermes is 0.22.5 or newer.

## changelog-ru

### Образы ботов ставят исправленные aiohttp, httpx2 и certifi (OPE-12760)

- Закреплённый hermes (v2026.9.24, 0.21.5) фиксирует aiohttp 3.14.3, httpx2 2.7.0 и certifi 2026.5.20, и у всех трёх известные уязвимости: aiohttp GHSA-2g87-pp6c-29x5 и GHSA-5wr8-gcqf-gqf3 (на нём работает API-сервер шлюза), httpx2 GHSA-8xx6-hgc6-gc2m, GHSA-f2fp-rgf2-35cp и другие (его использует HTTP MCP), certifi GHSA-6q48-6c7w-9gw2. Образ рантайма ботов теперь ставит поверх них aiohttp 3.14.5, httpx2 2.12.0 и certifi 2026.10.19 и не собирается, если любая из трёх версий ниже. Подмена снимается, когда закреплённый hermes станет 0.22.5 или новее.
