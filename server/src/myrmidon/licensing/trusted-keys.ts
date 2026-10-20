// myrmidon(LICENSING): public keys the board trusts for module licenses.
//
// Verification only. These are PUBLIC keys: the board can check a license
// but never mint one, and no setting or variable adds a key at runtime. The
// list must stay identical to the trust anchors embedded in the closed
// modules, otherwise the licensing screen and the modules disagree about the
// same license.
//
// Rotation: add the new key with its `kid` and keep the old one for as long
// as licenses signed by it are in use. A license without `kid` is checked
// against every key below; one with `kid` only against the key of that `kid`.

import type { TrustedIssuerKey } from "./license.js";

/** The original issuer key; its licenses carry no `kid`. */
const ISSUER_KEY_2026_10 = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA/s0tibLQd6UGQUQ7wtN9Pn9CssbxQ82PL82ZDuud830=
-----END PUBLIC KEY-----
`;

export const TRUSTED_ISSUER_KEYS: readonly TrustedIssuerKey[] = Object.freeze([
  { kid: null, publicKey: ISSUER_KEY_2026_10 },
]);
