# MinerU adapter pilot for CORPUS-2.0

> Russian version: [mineru-corpus-pilot.ru.md](mineru-corpus-pilot.ru.md)

This runbook records the MinerU parser candidate used in the CORPUS-2.0 pilot.
The adapter is maintained in the external `BastionPrime/ops-tools` repository,
not in the Myrmidon product tree.

## Scope

PR #10 (`ope-5003-pilot-harness`, commit `26346616`) adds and wires the
MinerU candidate for a 30-file corpus run:

- `parsers/mineru.py` — MinerU adapter;
- `parsers/register_ope6520.py` and `parsers/run_ope6520.py` — registration and
  entry point;
- `docker/Dockerfile.mineru` and `docker/constraints-mineru.txt` — runtime
  image and pinned constraints;
- `parsers/export_csv.py` and `parsers/tables_check.py` — result export and
  table validation support;
- `results/mineru.csv` and `results/tables_check.mineru.tsv` — pilot evidence;
- `README-part3.md` — operator instructions.

The candidate was deployed on `myr-dev-build` at
`/srv/pilot-corpus-2.0/`. The host root filesystem was also tuned with
`tune2fs -m 1`, freeing 4.2 GB.

## Acceptance evidence

`results/mineru.csv` contains 30/30 files. The run also measures CER on 10
scans and validates tables using the MinerU table-check output.

Run the checks from `/srv/pilot-corpus-2.0/` on the pilot host:

```sh
.venv/bin/python3 -m pytest tests/test_cer.py -q
/home/build/venv-harness/bin/ruff check \
  parsers/mineru.py parsers/register_ope6520.py parsers/run_ope6520.py \
  parsers/tables_check.py parsers/export_csv.py
```

The recorded results are 11 passing CER tests and a clean Ruff run. The
stand's deployment state and the PR are the source of truth; rerun the checks
when validating a new deployment rather than treating this page as a live
status report.

## Related work

This candidate completes the MinerU portion of OPE-6520 / OPE-8313. Review and
merge status belongs to PR #10 in `BastionPrime/ops-tools`; this documentation
only records how to locate and verify the delivered evidence.
