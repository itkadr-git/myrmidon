# Startup benchmark comparison

Compare two JSON outputs from `measure-board-start.mjs --json` offline:

```
node scripts/myrmidon/bundle-audit/compare-bench.mjs baseline.json candidate.json
```

Each input must contain the recorded `cmd`, `envKeys`, and at least four ordered runs: one cold run followed by at least three warm runs. The report recalculates warm min, median, and max from the run values, not the input summary. The ratio is baseline warm median divided by candidate warm median. Exit 0 means ratio >= 2; exit 1 means the ratio is below 2; exit 2 means invalid input or usage.

Different commands or environment key sets require `--override-reason "reason"`. The reason and differing fields appear in the report. The input does not record environment values or all machine conditions, so matching keys alone cannot prove equivalent environments. A PASS establishes only the observed median ratio, not that the measurements were controlled. Use synthetic or explicitly authorized measurements; this command does not run a server or contact a network.

Test with `node --test scripts/myrmidon/bundle-audit/compare-bench.test.mjs`.
