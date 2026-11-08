---
'@myrmidon/server': patch
---

Botd git-base repack now supports partial clones: disable bitmap writing, remove stale temporary pack/index files older than 30 minutes when no Git lock exists (after a failed repack and at botd startup), and back off failed repack attempts for six hours with the failure reason logged. High pack count does not bypass the backoff.
