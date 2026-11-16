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
