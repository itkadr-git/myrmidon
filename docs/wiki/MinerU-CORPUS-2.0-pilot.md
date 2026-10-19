# MinerU CORPUS-2.0 pilot

> Russian version: [MinerU-CORPUS-2.0-pilot.ru](MinerU-CORPUS-2.0-pilot.ru)

The MinerU candidate is documented in the operator guide
[MinerU adapter pilot for CORPUS-2.0](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/mineru-corpus-pilot.md).
It is an external `BastionPrime/ops-tools` change, not a Myrmidon product
component.

PR #10 (`ope-5003-pilot-harness`, commit `26346616`) adds the adapter,
registration and entry point, Docker runtime constraints, CSV export and table
checks, and the evidence files for a 30-file CORPUS-2.0 run. The candidate is
deployed at `/srv/pilot-corpus-2.0/` on `myr-dev-build`.

The evidence covers 30/30 files, CER on 10 scans, and table validation. To
repeat the recorded checks, use the commands in the linked guide. The recorded
baseline is 11 passing CER tests and a clean Ruff check.