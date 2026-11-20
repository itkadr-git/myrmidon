#!/usr/bin/env python3
"""Exercise the workflow's parsed triggers, expressions, dependency graph and dispatch step.

This models GitHub's job-level default success() and status-function override;
unknown expression syntax fails closed rather than silently assuming a result.
"""
import copy
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
with (ROOT / '.github/workflows/myrmidon-ci.yml').open(encoding='utf-8') as source:
    WORKFLOW = yaml.safe_load(source)

TOKEN = re.compile(r"\s*(\&\&|\|\||==|!=|!|\(|\)|'[^']*'|[\w.-]+)")


def evaluate(expression, context):
    text = str(expression).strip()
    if text.startswith('${{') and text.endswith('}}'):
        text = text[3:-2].strip()
    tokens = []
    while text:
        match = TOKEN.match(text)
        if not match:
            raise ValueError(f'unsupported expression: {text!r}')
        tokens.append(match.group(1))
        text = text[match.end():]
    pos = 0

    def parse(minimum=0):
        nonlocal pos
        token = tokens[pos]
        pos += 1
        if token == '!':
            left = not bool(parse(4))
        elif token == '(':
            left = parse()
            assert tokens[pos] == ')'
            pos += 1
        elif token in ('cancelled', 'success', 'always', 'failure'):
            assert tokens[pos:pos + 2] == ['(', ')']
            pos += 2
            left = {'cancelled': context['cancelled'], 'success': context['success'],
                    'always': True, 'failure': not context['success']}[token]
        elif token.startswith("'"):
            left = token[1:-1]
        elif token in ('true', 'false'):
            left = token == 'true'
        else:
            left = context
            for part in token.split('.'):
                left = left.get(part, {}) if isinstance(left, dict) else {}
            if left == {}:
                left = None
        precedence = {'||': 1, '&&': 2, '==': 3, '!=': 3}
        while pos < len(tokens) and precedence.get(tokens[pos], 0) > minimum:
            operator = tokens[pos]
            pos += 1
            right = parse(precedence[operator])
            if operator == '&&':
                left = right if left else left
            elif operator == '||':
                left = left if left else right
            elif operator == '==':
                left = left == right
            else:
                left = left != right
        return left

    result = parse()
    assert pos == len(tokens), tokens[pos:]
    return result


def triggered(doc, event, action, ref):
    triggers = doc.get(True, doc.get('on'))
    if event not in triggers:
        return False
    config = triggers[event] or {}
    return (not config.get('types') or action in config['types']) and (
        not config.get('branches') or ref.removeprefix('refs/heads/') in config['branches'])


def simulate(doc, event, action='', draft=False, tier='full', plan_result='success'):
    ref = 'refs/heads/main' if event == 'push' else 'refs/pull/1/merge'
    assert triggered(doc, event, action, ref), (event, action)
    github = {'event_name': event, 'ref': ref, 'event': {'action': action,
              'pull_request': {'draft': draft}}}
    pending = dict(doc['jobs'])
    completed = {}
    while pending:
        progress = False
        for name, job in list(pending.items()):
            deps = job.get('needs', [])
            deps = [deps] if isinstance(deps, str) else deps
            if not all(dep in completed for dep in deps):
                continue
            needs = {dep: completed[dep] for dep in deps}
            success = all(item['result'] == 'success' for item in needs.values())
            context = {'github': github, 'needs': needs, 'cancelled': False, 'success': success}
            condition = job.get('if', 'true')
            # An explicit status function replaces GitHub's implicit success().
            status_function = any(x in str(condition) for x in ('cancelled()', 'success()', 'failure()', 'always()'))
            runs = (success or status_function) and bool(evaluate(condition, context))
            result = (plan_result if name == 'plan' else 'success') if runs else 'skipped'
            outputs = {'tier': tier, 'is_release': 'false'} if name == 'plan' and result == 'success' else {}
            display = evaluate(job['name'], context) if str(job.get('name', '')).startswith('${{') else job.get('name', name)
            completed[name] = {'result': result, 'outputs': outputs, 'name': display}
            del pending[name]
            progress = True
        assert progress, f'unknown or cyclic needs: {list(pending)}'
    return completed


def result_step(doc, jobs):
    step = next(s for s in doc['jobs']['ci-result']['steps'] if s.get('name') == 'Check lane results')
    env = dict(os.environ, RESULTS=json.dumps({name: {'result': job['result']} for name, job in jobs.items()
                                             if name in doc['jobs']['ci-result']['needs']}),
               TIER=jobs['plan']['outputs'].get('tier', ''))
    return subprocess.run(['bash', '-e', '-c', step['run']], env=env, capture_output=True, text=True).returncode


def dispatch(reason):
    job = WORKFLOW['jobs']['plan']
    step = next(s for s in job['steps'] if s.get('name') == 'Record manual run reason')
    context = {'github': {'event_name': 'workflow_dispatch'}, 'success': True, 'cancelled': False}
    assert evaluate(step['if'], context)
    assert step['env']['REASON'] == '${{ github.event.inputs.reason }}'
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
        summary = Path(directory) / 'summary'
        env = dict(os.environ, REASON=reason, GITHUB_STEP_SUMMARY=str(summary))
        result = subprocess.run(['bash', '-e', '-c', step['run']], env=env, capture_output=True, text=True)
        return result.returncode, summary.read_text() if summary.exists() else ''


def check():
    doc = WORKFLOW
    for action in ('opened', 'synchronize'):
        jobs = simulate(doc, 'pull_request', action, draft=True)
        for name in ('plan', 'typecheck', 'tests', 'tests-other', 'checks', 'ci-result'):
            assert jobs[name]['result'] == 'skipped', (action, name, jobs[name])
        assert jobs['ci-result']['name'] != 'CI result', jobs['ci-result']
    for event, action in (('pull_request', 'ready_for_review'), ('push', ''), ('merge_group', 'checks_requested'), ('workflow_dispatch', '')):
        jobs = simulate(doc, event, action)
        for name in ('plan', 'typecheck', 'tests', 'tests-other', 'checks', 'ci-result'):
            assert jobs[name]['result'] == 'success', (event, name, jobs[name])
        assert jobs['ci-result']['name'] == 'CI result'
        assert result_step(doc, jobs) == 0
        labels = [entry['label'] for entry in doc['jobs']['tests']['strategy']['matrix']['include']]
        assert any(label.startswith('server ') for label in labels)
        assert any(label.startswith('workspaces-') for label in labels)
    fast = simulate(doc, 'pull_request', 'synchronize', tier='fast')
    assert fast['typecheck']['result'] == fast['tests-affected']['result'] == 'success'
    assert fast['tests']['result'] == 'skipped'
    failed = simulate(doc, 'pull_request', 'ready_for_review', plan_result='failure')
    assert failed['ci-result']['result'] == 'success' and failed['ci-result']['name'] == 'CI result'
    # The final job must execute on a red plan, not publish a satisfying skip.
    assert failed['plan']['result'] == 'failure' and failed['typecheck']['result'] == 'skipped'
    assert result_step(doc, failed) != 0
    for reason in ('', '  \t  '):
        code, summary = dispatch(reason)
        assert code != 0 and not summary, (reason, code, summary)
    code, summary = dispatch('release validation')
    assert code == 0 and summary == 'Manual CI reason: release validation\n', (code, summary)
    mutated = copy.deepcopy(doc)
    mutated['jobs']['plan']['if'] = '${{ true }}'
    assert simulate(mutated, 'pull_request', 'opened', draft=True)['plan']['result'] == 'success'
    mutated = copy.deepcopy(doc)
    mutated['jobs']['ci-result']['name'] = 'CI result'
    assert simulate(mutated, 'pull_request', 'opened', draft=True)['ci-result']['name'] == 'CI result'
    print('workflow behavior scenarios and mutation controls passed')


if __name__ == '__main__':
    check()
