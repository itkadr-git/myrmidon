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

# IPsec change and rollback plan

This standalone tool produces an operator checklist, not a verified rollback. It
never connects to a host, checks syntax, applies changes, schedules actions, or
restores a snapshot. The operator must inspect and verify all referenced records.

Run `node scripts/myrmidon/ipsec/rollback-plan.mjs manifest.json`. The manifest
must be a JSON object with exactly these fields (all example values are synthetic):

```json
{
  "version": "1.7",
  "changeId": "change-001",
  "owner": "operator-001",
  "window": "window-001",
  "outOfBand": { "channelRef": "console-001", "verificationRef": "check-001" },
  "current": { "routeRef": "route-old", "firewallRef": "firewall-old", "snapshotRef": "snapshot-old" },
  "target": { "routeRef": "route-new", "firewallRef": "firewall-new" },
  "syntaxCheckRef": "syntax-check-001",
  "stopConditionRef": "stop-condition-001"
}
```

References are opaque identifiers to records maintained separately. The window
record must specify the time and timezone. The out-of-band records must specify a
channel independent of the affected network and how to verify it. The syntax
record must cover the target route and firewall configuration. The stop-condition
record must define when the operator stops. The original snapshot record must
identify the recoverable pre-change route and firewall state. The tool validates
presence and format only; it cannot establish that these records exist or work.

Use non-secret identifiers only. Never put secret values, configuration contents,
commands, URLs, or credentials in the manifest. References are printed verbatim;
no generic filter can detect all secrets. Extra fields and references with
unsupported characters or common secret labels are rejected. Errors never echo
input. A rejected manifest produces no plan.

# Offline IPsec manifest check

Run `node scripts/myrmidon/ipsec/config-check.mjs manifest.json`. The command reads only the JSON manifest; it does not resolve names, connect to hosts, or read referenced secret files. Use synthetic data for tests.

```json
{
  "sides": [
    { "endpoint": "192.0.2.1", "localCidr": "192.0.2.0/24", "remoteCidr": "198.51.100.0/24", "proposal": "aes256-sha256-modp2048", "id": "left.example", "secretFile": "/secrets/left" },
    { "endpoint": "192.0.2.2", "localCidr": "198.51.100.0/24", "remoteCidr": "192.0.2.0/24", "proposal": "aes256-sha256-modp2048", "id": "right.example", "secretFile": "/secrets/right" }
  ]
}
```

Each side requires an IP literal endpoint, local and remote CIDRs, IKEv2 proposal, identity, and secret-file path. CIDR networks on each side must not overlap; endpoints must differ. Unknown properties are rejected, including plaintext PSK fields. Proposal syntax, peer compatibility, secret existence and secret content are not checked.

Output is JSON with `status` and an `errors` array of `{path, message}`. Exit 0 means `PASS`; exit 1 means manifest validation `FAIL`; exit 2 means usage, read or JSON parse `ERROR`. No validation result applies configuration.

Run tests with `node --test scripts/myrmidon/ipsec/config-check.test.mjs`.
# Offline swanctl SA parser

Run `node scripts/myrmidon/ipsec/parse-sas.mjs [file]`; without a file it reads
saved text from stdin. The command never invokes swanctl or connects to a host.
It prints JSON with IKE and CHILD names, numeric IDs, states, installed flags,
and inbound/outbound byte counters as decimal strings (avoiding integer precision
loss). It does not copy addresses, identities, keys, or other source lines.

`healthy` requires at least one IKE SA, every IKE SA to be ESTABLISHED, and
at least one CHILD per IKE, all INSTALLED with both counters present. Empty,
unsupported, incomplete or malformed input is `unknown`; an input read error
exits nonzero. This is a conservative snapshot interpretation, not proof of
connectivity or current traffic.

The fixtures are hand-authored synthetic examples of the standard human-readable
`swanctl --list-sas` layout. Names, documentation addresses, identifiers and
counters are invented; no node output or production data was used. The rekey
fixture models overlapping CHILD SAs. The established fixture includes the
separate negotiated-algorithm and IKE timing lines from the human-readable
layout; unrecognized metadata and truncated or extra record fields are rejected
conservatively. Only the supported human-readable layouts are accepted; other
valid swanctl variants may return `unknown`. Run the tests with
`node --test scripts/myrmidon/ipsec/parse-sas.test.mjs`.
# swanctl configuration renderer

`node scripts/myrmidon/ipsec/render-swanctl.mjs < input.json` writes an
example IKEv2 PSK `swanctl.conf` to stdout. It only renders: it does not call
`swanctl`, alter network state, or read the referenced secrets file. Review the
result and the secret include separately before any use. The example addresses
are synthetic.

The JSON object must have exactly these fields (see `example.json`):

- `name`: nonempty connection/child name, ASCII letters, digits, `_` or `-`.
- `local` and `remote`: objects with exactly `endpoint`, `identity`, and
  `trafficSelectors`. Endpoint and identity are nonempty single tokens;
  identities may start with `@`. Traffic selectors are nonempty arrays of
  single address/subnet tokens.
- `proposals`: nonempty array of single IKE proposal tokens, in preference order.
- `secretFile`: absolute path to a swanctl configuration include containing the
  PSK secrets section; not a raw secret or key file. The include is emitted, not
  opened. The operator is responsible for its contents and file permissions.

Only conservative ASCII token characters are accepted; whitespace, quotes,
control characters, braces, commas inside tokens, glob characters and unknown
fields are rejected. This is syntax/injection validation, not proof that the
addresses, selectors, proposals or secret file are valid for a deployment.
Invalid JSON or schema exits nonzero without writing configuration to stdout.
Order of arrays is preserved; identical inputs produce identical output.

Run `node --test scripts/myrmidon/ipsec/render-swanctl.test.mjs` for the golden
and rejection checks. No real network, keys, or daemon are used.
