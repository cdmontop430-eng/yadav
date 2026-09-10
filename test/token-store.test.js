const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTokenList, addTokenToList, persistTokenList } = require('../token-store');

test('parseTokenList reads comma and newline separated tokens', () => {
  const tokens = parseTokenList('abc, def\nghi, jkl');
  assert.deepEqual(tokens, ['abc', 'def', 'ghi', 'jkl']);
});

test('addTokenToList prevents duplicates and respects maxBots', () => {
  const tokens = ['a', 'b'];
  const result = addTokenToList(tokens, 'b', 2);
  assert.deepEqual(result, ['a', 'b']);

  const next = addTokenToList(tokens, 'c', 3);
  assert.deepEqual(next, ['a', 'b', 'c']);

  const overflow = addTokenToList(['a', 'b', 'c'], 'd', 3);
  assert.deepEqual(overflow, ['a', 'b', 'c']);
});

test('persistTokenList writes BOT_TOKENS using comma list', () => {
  const filePath = 'test/.env.mock';
  const tokens = ['token1', 'token2'];
  const output = persistTokenList(filePath, tokens);
  assert.equal(output, 'token1,token2');
});
