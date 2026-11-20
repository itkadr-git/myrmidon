import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateReviewComment } from '../run-quality-gates.mjs';

function github(initial = []) {
  const comments = structuredClone(initial);
  const writes = [];
  const fetch = async (path, token, options = {}) => {
    if (!options.method) {
      const page = Number(new URL(`https://example.com${path}`).searchParams.get('page'));
      return comments.slice((page - 1) * 100, page * 100);
    }
    const body = JSON.parse(options.body).body;
    writes.push({ method: options.method, path });
    if (options.method === 'POST') {
      comments.push({ id: 1000 + comments.length, user: { login: 'github-actions[bot]' }, body });
    } else {
      const id = Number(path.split('/').pop());
      const comment = comments.find(c => c.id === id);
      assert.equal(comment.user.login, 'github-actions[bot]', 'must not edit legacy or user comments');
      comment.body = body;
    }
  };
  return { comments, writes, fetch };
}

const legacy = { id: 4, user: { login: 'commitperclip[bot]' }, body: 'Old failure\n\n— commitperclip' };

test('repeated runs update one actions comment and replace failure with success without editing legacy', async () => {
  const api = github([legacy]);
  for (const failures of [['Missing test'], ['Missing test'], []]) {
    await updateReviewComment(api.fetch, 'token', 'owner/repo', 42, 'author', failures, []);
  }
  assert.deepEqual(api.writes.map(w => w.method), ['POST', 'PATCH', 'PATCH']);
  assert.equal(api.comments.length, 2);
  assert.deepEqual(api.comments[0], legacy);
  assert.match(api.comments[1].body, /All checks passing/);
  assert.doesNotMatch(api.comments[1].body, /Missing test/);
  assert.match(api.comments[1].body, /legacy/i);
});

test('finds actions comment on later pages and ignores forged signatures', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: i, user: { login: 'someone' }, body: '— commitperclip' }));
  const api = github([...filler, { id: 500, user: { login: 'github-actions[bot]' }, body: 'Old failure\n\n— commitperclip' }]);
  await updateReviewComment(api.fetch, 'token', 'owner/repo', 42, 'author', [], []);
  assert.deepEqual(api.writes, [{ method: 'PATCH', path: '/repos/owner/repo/issues/comments/500' }]);
  assert.match(api.comments[100].body, /All checks passing/);
});

test('passing run without a previous review does not create a comment', async () => {
  const api = github();
  await updateReviewComment(api.fetch, 'token', 'owner/repo', 42, 'author', [], []);
  assert.deepEqual(api.writes, []);
});
