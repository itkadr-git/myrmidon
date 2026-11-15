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
