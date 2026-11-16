# Offline IPsec diagnostic redactor

Run `node scripts/myrmidon/ipsec/redact-support.mjs --format json` or
`--format text`, with diagnostics on standard input. Output is written only
when the whole input is valid. Errors contain no input and the exit code is
nonzero. Do not use partial output from a failed command.

This is a deliberately narrow format, not a general log scrubber. JSON accepts
objects and arrays containing secret fields or the scalar diagnostic fields
below. Text accepts one `key: value` or `key = value` per line. Secret keys
contain PSK, password, passwd, token, secret, bearer, authorization or private
key, case-insensitively. Their entire values are replaced, including nested JSON
values and multiline PEM private keys in text. Text PEM blocks must start on the
secret field line and have a matching end marker. Unknown fields and malformed
input are rejected. Do not wrap diagnostics in arbitrary log lines.

Allowed non-secret scalar fields: `state`, `sa_state` (known SA states),
`bytes_in`, `bytes_out`, `bytesin`, `bytesout`, `in_bytes`, `out_bytes`,
`byte_counter`, `byte_counters` (nonnegative integers), and `route`, `prefix`,
`route_prefix`, `route_prefixes` (IP CIDR prefixes). Keys are case-insensitive.
Arrays may contain values of their parent field type. Arbitrary JSON strings
are not safe, even in fields with familiar names. This tool does not collect,
connect to, or archive any node. Review the redacted result before sharing.

# Offline route matrix

Run `node scripts/myrmidon/ipsec/route-matrix.mjs expected.json routes.json`.
Both files are JSON arrays. The second is an `ip -j route` fixture captured separately; this tool does not run network commands or change routes. Use separate fixtures for IPv4 and IPv6 when either contains a `default` route, because the `default` token does not identify its address family.

Each expected route must include all four fields, for example:

```json
[{"prefix":"198.51.100.0/24","table":"main","via":"192.0.2.1","dev":"eth0"}]
```

Use `via: null` for a directly connected route. A missing snapshot table means `main`; numeric table 254 also means `main`. Prefixes are matched exactly, not by longest-prefix lookup; `default` is an explicit token. Duplicate identical routes are accepted; any different route with the same prefix is reported as conflicting, even if another matches. Unsupported route types, multipath, malformed data, and empty expectations are errors rather than a pass. The output contains one `ok`, `missing`, or `conflicting` result per expected route. Exit codes are 0 for all matches, 1 for mismatches, and 2 for input or usage errors.
