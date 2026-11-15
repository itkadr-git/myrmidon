---
'@myrmidon/server': patch
---

Stack registry (OPE-12957): `POST /api/myrmidon/stack/refresh` and `POST /api/myrmidon/stack/check` failed with 503 on a split board. An api process served them and its image probes reached dockergate, which admits only the main board process (`write EPIPE`, `caller_not_board_main`). Both routes now join the `bot_container` group of single routes, so an api process forwards them to the main process. `GET /api/myrmidon/stack` still reads the database and stays on the api process.
