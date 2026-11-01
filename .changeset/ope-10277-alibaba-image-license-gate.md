---
'@myrmidon/server': patch
---

Licensing (alibaba-image): register the closed `alibaba-image` module in the client licensing contract. `KNOWN_MODULES` and `MODULE_PLUGIN_KEYS` (`myrmidon.alibaba-image` plugin key) now cover it, so the board's license screen reports its state, includes it in the `MYRQ1` request, and the same fail-closed Ed25519 verifier rejects an absent, expired, tampered, foreign-signed, wrong-installation or ungranted-module license for it. Unit tests cover the granted and `module_not_granted` cases; fixtures use test-generated keys only.
