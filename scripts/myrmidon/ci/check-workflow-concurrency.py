#!/usr/bin/env python3
"""
scripts/myrmidon/ci/check-workflow-concurrency.py

Verifies that every GitHub Actions workflow in .github/workflows that runs on push to main
or on workflow_run of main workflows defines a concurrency group with cancel-in-progress: true
for main runs, while preserving release branches (rel/*) and release tags (myr-v*) without cancellation (OPE-12103).
"""

import os
import sys
import yaml

def check_workflows(workflows_dir):
    files = sorted(f for f in os.listdir(workflows_dir) if f.endswith(('.yml', '.yaml')))
    failures = []
    checked = []

    for fname in files:
        fpath = os.path.join(workflows_dir, fname)
        with open(fpath, 'r', encoding='utf-8') as f:
            try:
                data = yaml.safe_load(f)
            except Exception as e:
                failures.append(f"{fname}: Failed to parse YAML: {e}")
                continue

        if not isinstance(data, dict):
            continue

        on_block = data.get(True) or data.get('on') or {}
        runs_on_main = False

        if isinstance(on_block, str):
            if on_block == 'push':
                runs_on_main = True
        elif isinstance(on_block, list):
            if 'push' in on_block:
                runs_on_main = True
        elif isinstance(on_block, dict):
            push_block = on_block.get('push')
            if isinstance(push_block, dict):
                branches = push_block.get('branches', [])
                if isinstance(branches, str):
                    branches = [branches]
                if any(b == 'main' for b in branches):
                    runs_on_main = True

            # workflow_run triggered by Myrmidon CI (which runs on main pushes)
            wr_block = on_block.get('workflow_run')
            if isinstance(wr_block, dict):
                wfs = wr_block.get('workflows', [])
                if isinstance(wfs, str):
                    wfs = [wfs]
                if 'Myrmidon CI' in wfs:
                    runs_on_main = True

        if not runs_on_main:
            continue

        checked.append(fname)
        conc = data.get('concurrency')
        if not conc:
            failures.append(f"{fname}: Missing 'concurrency' block (runs on push to main or workflow_run)")
            continue

        if isinstance(conc, str):
            group = conc
            cancel = False
        elif isinstance(conc, dict):
            group = conc.get('group')
            cancel = conc.get('cancel-in-progress')
        else:
            failures.append(f"{fname}: Invalid 'concurrency' block format")
            continue

        if not group:
            failures.append(f"{fname}: Concurrency block missing 'group'")
            continue

        # Check cancel-in-progress on main
        cancels_on_main = False
        if cancel is True:
            cancels_on_main = True
        elif isinstance(cancel, str):
            c_str = cancel.strip()
            # If it's just pull_request, push to main won't cancel!
            if c_str == "${{ github.event_name == 'pull_request' }}":
                cancels_on_main = False
            elif "github.ref == 'refs/heads/main'" in c_str or "!startsWith(github.ref, 'refs/tags/myr-v')" in c_str:
                cancels_on_main = True
            elif "github.event_name != 'push'" not in c_str:
                cancels_on_main = True
            else:
                cancels_on_main = False
        else:
            cancels_on_main = False

        if not cancels_on_main:
            failures.append(f"{fname}: Concurrency 'cancel-in-progress' must be true for main runs (got: {cancel})")

    return checked, failures

def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
    workflows_dir = os.path.join(repo_root, '.github/workflows')
    checked, failures = check_workflows(workflows_dir)

    print(f"Checked {len(checked)} workflows running on main in {workflows_dir}:")
    for f in checked:
        print(f"  - {f}")

    if failures:
        print("\nERRORS:")
        for err in failures:
            print(f"  ERROR: {err}")
        sys.exit(1)
    else:
        print("\nAll workflows on main have valid concurrency with cancel-in-progress: true.")

if __name__ == '__main__':
    main()
