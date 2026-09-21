import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTags, releaseForTag } from './promote-release.mjs';

test('encontra release draft pela listagem autenticada', () => {
  const draft = { id: 31, tag_name: 'v0.5.31', draft: true, assets: [] };
  assert.equal(releaseForTag([{ id: 27, tag_name: 'v0.5.27' }, draft], 'v0.5.31'), draft);
});

test('recusa release ausente ou tag duplicada', () => {
  assert.throws(() => releaseForTag([], 'v0.5.31'), /ausente ou duplicada/);
  assert.throws(() => releaseForTag([{ tag_name: 'v0.5.31' }, { tag_name: 'v0.5.31' }], 'v0.5.31'), /ausente ou duplicada/);
});

test('ordena versoes sem comparacao lexicografica', () => {
  assert.ok(compareTags('v0.5.31', 'v0.5.9') > 0);
  assert.ok(compareTags('v1.0.0', 'v0.99.99') > 0);
  assert.equal(compareTags('v0.5.31', 'v0.5.31'), 0);
});
