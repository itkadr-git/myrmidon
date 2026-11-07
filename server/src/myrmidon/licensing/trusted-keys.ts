// myrmidon(LICENSING): public keys the board trusts for module licenses.
//
// Verification only. These are PUBLIC keys: the board can check a license
// but never mint one, and no setting or variable adds a key at runtime. The
// list must stay identical to the trust anchors embedded in the closed
// modules, otherwise the licensing screen and the modules disagree about the
// same license.
//
// Rotation (same rule as the modules' TRUSTED_ISSUER_PUBLIC_KEYS): add the new
// key and keep the old one for as long as licenses signed by it are in use. A
// license verifies if any key below verifies it; its optional `kid` must be
// the id of that key (first 16 hex of sha256 over the raw public key).

import type { TrustedIssuerKey } from "./license.js";

/** The original issuer key (licenses from before rotation support carry no `kid`). */
const ISSUER_KEY_2026_10 = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA/s0tibLQd6UGQUQ7wtN9Pn9CssbxQ82PL82ZDuud830=
-----END PUBLIC KEY-----
`;

export const TRUSTED_ISSUER_KEYS: readonly TrustedIssuerKey[] = Object.freeze([ISSUER_KEY_2026_10]);
