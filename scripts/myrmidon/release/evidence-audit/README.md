# Offline release evidence audit

Run `node scripts/myrmidon/release/evidence-audit/audit.mjs snapshot.json`. The tool reads one local JSON snapshot and prints JSON; it makes no network calls and changes no files. Exit 1 means invalid JSON, invalid top-level input, or an unreadable file; a successful exit does not mean every issue passed.

## Input schema

The snapshot is an object with an `issues` array and a `release` object. All identifiers are exact, case-sensitive, non-empty strings. Commit IDs must use the same complete representation in both lists; no Git lookup or abbreviation expansion is performed. The snapshot producer must provide the complete release membership and all linked merged commits. The auditor cannot independently establish provenance or completeness.

```json
{
  "release": { "version": "1.7.0", "commits": ["synthetic-commit"] },
  "issues": [
    { "id": "SYN-1", "kind": "code", "status": "done", "author": "alice", "mergedCommits": ["synthetic-commit"], "verification": { "version": "1.7.0", "method": "manual", "result": "pass", "verifier": "bob" } },
    { "id": "SYN-2", "kind": "non-code", "skipReason": "Documentation only" }
  ]
}
```

`status` is ignored. Only `kind: code` can pass. Each code issue requires at least one linked merged commit and all must be present in the release list. Verification requires the exact release version, a nonempty method, `result: pass`, and a verifier distinct from the nonempty author identity. Identity strings must be canonicalized by the snapshot producer. Non-code issues are `SKIPPED` only with an explicit reason; they never pass.

## Output and unknown semantics

Each issue reports `codeInRelease` and `verified` independently as `yes`, `no`, or `unknown` (non-code: `not-applicable`), plus `outcome` and reasons. `PASS` requires both `yes` and an issue ID. A known missing commit, different version, non-pass result, or self-verification is `FAIL`. Missing or malformed evidence is `UNKNOWN`, never PASS. A known failure dominates an unknown. An empty release commit list is a known empty membership; an empty issue commit list is unknown. Output is an audit of supplied evidence, not proof that the snapshot is complete or authentic, and does not change any live gate.
