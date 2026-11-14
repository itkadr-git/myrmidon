---
settings-section: Track 5 — operations
---

## changelog-en

### One entry point for cutting a release candidate (RELEASE-CUT-SINGLE-ENTRY)

- `scripts/myrmidon/release/cut-rc.mjs` is the single command that tags a
  release candidate `myr-vX.Y.Z-rc.N`: it checks the board for open tasks
  with the release label and for unmerged attached PRs (including on done
  tasks — the 12.11 rc.24 failure mode), verifies the changelog version
  section (the RELEASE-CUT-CHANGELOG contract) and a green CI on the
  release commit, and refuses with the full list on any violation. A bypass
  requires `--override "reason" --journal OPE-NNNN` and posts the record to
  the board journal issue before tagging (changelog, git and CI problems
  are not bypassable). Docs: `docs/myrmidon/releases/cut-rc.md`.

## changelog-ru

### Одна точка постановки тега кандидата выпуска (RELEASE-CUT-SINGLE-ENTRY)

- `scripts/myrmidon/release/cut-rc.mjs` — одна команда для тега кандидата
  `myr-vX.Y.Z-rc.N`: проверяет по доске открытые задачи с меткой выпуска и
  невлитые привязанные PR (в том числе у закрытых задач — режим отказа
  rc.24 от 12.11), раздел версии в журнале (контракт RELEASE-CUT-CHANGELOG)
  и зелёный CI коммита; при нарушении — отказ со списком. Обход — только с
  `--override "причина" --journal OPE-NNNN`: запись с обоснованием и
  списком открытого пишется в задачу-журнал до тега (журнал, git и CI не
  обходятся). Документация: `docs/myrmidon/releases/cut-rc.md`.

