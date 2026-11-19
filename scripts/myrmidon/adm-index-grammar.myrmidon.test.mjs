import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryIndex } from './adm-migrate.mjs';

const headings = [
  ['Policies', 'Политики', 'rule'],
  ['Triggers', 'Триггеры', 'trigger'],
  ['References', 'Справочники', 'reference'],
  ['Lessons', 'Уроки', 'lesson'],
  ['Skills', 'Навыки', 'skill_card'],
];

test('English and Russian category headings work at all six Markdown levels', () => {
  for (const [english, russian, kind] of headings) {
    for (const heading of [english, russian]) {
      for (let level = 1; level <= 6; level++) {
        const index = parseMemoryIndex(`${'#'.repeat(level)} ${heading}\n- item.md\n`);
        assert.equal(index.get('item.md'), kind, `${heading} h${level}`);
        assert.equal(index.get('memory/item.md'), kind, `${heading} h${level} alias`);
        assert.equal(index.size, 2);
      }
    }
  }
});

test('CRLF index accepts links, backticks and bare names, with basename aliases', () => {
  const index = parseMemoryIndex([
    '# Policies',
    '- [linked](nested/linked.md)',
    '- `nested/quoted.md`',
    '- bare.md',
  ].join('\r\n'));
  for (const name of ['linked.md', 'quoted.md', 'bare.md']) {
    assert.equal(index.get(name), 'rule');
    assert.equal(index.get(`memory/${name}`), 'rule');
  }
  assert.equal(index.has('nested/linked.md'), false);
  assert.equal(index.size, 6);
});

test('unknown headings reset category and links outside sections are ignored', () => {
  const index = parseMemoryIndex([
    '- before.md',
    '# Policies',
    '- kept.md',
    '## Unrelated',
    '- ignored.md',
    '### Triggers',
    '- after.md',
    '#### Other',
    '- last.md',
  ].join('\n'));
  assert.equal(index.get('kept.md'), 'rule');
  assert.equal(index.get('after.md'), 'trigger');
  for (const name of ['before.md', 'ignored.md', 'last.md']) {
    assert.equal(index.has(name), false, name);
    assert.equal(index.has(`memory/${name}`), false, name);
  }
  assert.equal(index.size, 4);
});

test('the last category wins for both aliases of a repeated basename', () => {
  const index = parseMemoryIndex('# Policies\n- [first](nested/shared.md)\n# Lessons\n- `memory/shared.md`\n');
  assert.equal(index.get('shared.md'), 'lesson');
  assert.equal(index.get('memory/shared.md'), 'lesson');
  assert.equal(index.size, 2);
});
