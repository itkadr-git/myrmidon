import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkWikiPair,
  checkWikiParity,
  classifyWikiFiles,
  countHeadings,
} from '../check-wiki-parity.mjs';

const EN_OK = `# Page

## Section A

Text.

### Subsection A.1

Text.

## Section B

Text.
`;

const RU_OK = `# Страница

## Раздел A

Текст.

### Подраздел A.1

Текст.

## Раздел B

Текст.
`;

test('countHeadings counts ## and ### but not # or ####', () => {
  const content = [
    '# Title',
    '## H2 one',
    '### H3 one',
    'text ## not a heading (not at line start)',
    '## H2 two',
    '#### H4 skipped',
    '### H3 two',
  ].join('\n');
  assert.deepEqual(countHeadings(content), { h2: 2, h3: 2 });
});

test('countHeadings skips headings inside fenced code blocks', () => {
  const content = [
    '## Real',
    '```md',
    '## Inside fence, not a section',
    '### Also inside',
    '```',
    '### Real sub',
    '~~~',
    '## Tilde fence',
    '~~~',
  ].join('\n');
  assert.deepEqual(countHeadings(content), { h2: 1, h3: 1 });
});

test('classifyWikiFiles splits EN and RU bases and reports strays', () => {
  const { en, ru, stray } = classifyWikiFiles([
    'Home.md',
    'Home.ru.md',
    'Channels.md',
    'Channels.ru.md',
    'notes.txt',
  ]);
  assert.deepEqual(en.sort(), ['Channels', 'Home']);
  assert.deepEqual(ru.sort(), ['Channels', 'Home']);
  assert.deepEqual(stray, ['notes.txt']);
});

test('pair OK: matching ## and ### counts pass even with different wording', () => {
  const result = checkWikiPair('Home', EN_OK, RU_OK);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.enCounts, { h2: 2, h3: 1 });
  assert.deepEqual(result.ruCounts, { h2: 2, h3: 1 });
});

test('pair fails when RU has an extra ###', () => {
  const ruExtra = RU_OK + '\n### Лишний подраздел\n\nТекст.\n';
  const result = checkWikiPair('Home', EN_OK, ruExtra);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('###') && f.includes('mismatch')));
});

test('pair fails when EN has an extra ##', () => {
  const enExtra = EN_OK + '\n## Extra section\n\nText.\n';
  const result = checkWikiPair('Home', enExtra, RU_OK);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('##') && !f.includes('###')));
});

test('parity fails when an EN page has no RU counterpart', () => {
  const result = checkWikiParity({
    enFiles: ['Home', 'Channels'],
    ruFiles: ['Home'],
    readFile: () => EN_OK,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.enOnly, ['Channels']);
  assert.deepEqual(result.ruOnly, []);
  assert.ok(result.failures.some(f => f.includes('Channels') && f.includes('missing')));
});

test('parity fails when a RU page has no EN counterpart', () => {
  const result = checkWikiParity({
    enFiles: ['Home'],
    ruFiles: ['Home', 'Channels'],
    readFile: () => RU_OK,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.enOnly, []);
  assert.deepEqual(result.ruOnly, ['Channels']);
});

test('parity fails when a paired page has a heading-count drift', () => {
  const result = checkWikiParity({
    enFiles: ['Home'],
    ruFiles: ['Home'],
    readFile: (base, lang) => (lang === 'ru' ? RU_OK + '\n### Лишний\n' : EN_OK),
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('###') && f.includes('mismatch')));
});

test('parity passes on a fully paired set with matching counts', () => {
  const result = checkWikiParity({
    enFiles: ['Home', 'Channels'],
    ruFiles: ['Home', 'Channels'],
    readFile: (base, lang) => (lang === 'ru' ? RU_OK : EN_OK),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.pairedCount, 2);
});
