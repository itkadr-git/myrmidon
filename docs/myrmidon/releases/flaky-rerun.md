# Управляемый повтор flaky CI / Controlled flaky CI rerun

`release-flaky-rerun.sh --tag TAG --evidence-file FILE` reruns failed jobs of the tag workflow. It prints and stores JSON evidence bound to the tag head SHA, run id, run attempt, jobs, URL, and dispatch time. `--dry-run` does not call GitHub mutations.

После успешного rerun можно записать исключение:

```sh
node scripts/myrmidon/release/release-flaky-waiver.mjs record \
  --tag myr-v1.8.0-rc.1 --evidence-file evidence.json \
  --reason "Failure is unrelated to release changes" --journal OPE-13003
node scripts/myrmidon/release/release-flaky-waiver.mjs verify --tag myr-v1.8.0-rc.1
```

Запись разрешена только если evidence совпадает с SHA тега и живой run завершён успешно. Журнал append-only. `cut-rc.mjs` по умолчанию сохраняет прежний отказ при красном CI; `--flaky-waiver-verify` допускает только живое проверенное исключение.

The waiver does not alter release-freeze, publish, or workflow scenarios. It is an opt-in, auditable exception.
