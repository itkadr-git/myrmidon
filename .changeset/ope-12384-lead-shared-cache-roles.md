---
"@myrmidon/shared": patch
---

Bot disk cache: the default `general.botDisk.sharedCacheRoles` now includes `lead`, so a lead bot gets the same shared package-cache, git-mirror and uv-cache mounts as the coding roles (OPE-12384). A lead runs the same devbuild/build toolchain on the same repositories as the engineers it reviews; before this change its container had no `/cache/*` mounts, so the uv-cache, shared-objects and devbuild startup self-checks failed on every restart. The change applies on the next reconcile pass without a restart: exactly the bots whose role membership changed (the leads) are recreated with the mounts.
