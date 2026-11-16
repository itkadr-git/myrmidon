# Offline route matrix

Run `node scripts/myrmidon/ipsec/route-matrix.mjs expected.json routes.json`.
Both files are JSON arrays. The second is an `ip -j route` fixture captured separately; this tool does not run network commands or change routes. Use separate fixtures for IPv4 and IPv6 when either contains a `default` route, because the `default` token does not identify its address family.

Each expected route must include all four fields, for example:

```json
[{"prefix":"198.51.100.0/24","table":"main","via":"192.0.2.1","dev":"eth0"}]
```

Use `via: null` for a directly connected route. A missing snapshot table means `main`; numeric table 254 also means `main`. Prefixes are matched exactly, not by longest-prefix lookup; `default` is an explicit token. Duplicate identical routes are accepted; any different route with the same prefix is reported as conflicting, even if another matches. Unsupported route types, multipath, malformed data, and empty expectations are errors rather than a pass. The output contains one `ok`, `missing`, or `conflicting` result per expected route. Exit codes are 0 for all matches, 1 for mismatches, and 2 for input or usage errors.
