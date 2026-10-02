const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTokenList, addTokenToList, persistTokenList, readTokenFile, writeTokenFile, diffTokenLists } = require('../token-store');

test('parseTokenList reads comma and newline separated tokens', () => {
  const tokens = parseTokenList('abc, def\nghi, jkl');
  assert.deepEqual(tokens, ['abc', 'def', 'ghi', 'jkl']);
});

test('addTokenToList prevents duplicates and allows unlimited tokens by default', () => {
  const tokens = ['a', 'b'];
  const result = addTokenToList(tokens, 'b');
  assert.deepEqual(result, ['a', 'b']);

  const next = addTokenToList(tokens, 'c');
  assert.deepEqual(next, ['a', 'b', 'c']);

  const unlimited = addTokenToList(['a', 'b', 'c', 'd', 'e'], 'f');
  assert.deepEqual(unlimited, ['a', 'b', 'c', 'd', 'e', 'f']);

  const limited = addTokenToList(['a', 'b'], 'c', 2);
  assert.deepEqual(limited, ['a', 'b']);
});

test('persistTokenList writes BOT_TOKENS using comma list', () => {
  const filePath = 'test/.env.mock';
  const tokens = ['token1', 'token2'];
  const output = persistTokenList(filePath, tokens);
  assert.equal(output, 'token1,token2');
});

test('parseTokenList skips comments, blanks and duplicates', () => {
  const parsed = parseTokenList([
    '# header comment',
    '',
    '  token-a  ',
    '// another comment',
    '; third style',
    'token-a',
    'token-b,token-c',
  ]);
  assert.deepEqual(parsed, ['token-a', 'token-b', 'token-c']);
});

test('readTokenFile and writeTokenFile round-trip through a text file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-'));
  const file = path.join(dir, 'nested', 'tokens.txt');

  assert.deepEqual(readTokenFile(file), [], 'missing file reads as empty');

  writeTokenFile(file, ['token-1', ' token-2 ', 'token-1', '']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'token-1\ntoken-2\n');
  assert.deepEqual(readTokenFile(file), ['token-1', 'token-2']);

  fs.writeFileSync(file, '# only comments here\n\n');
  assert.deepEqual(readTokenFile(file), []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('diffTokenLists reports added and removed tokens', () => {
  assert.deepEqual(
    diffTokenLists(['a', 'b', 'c'], ['b', 'c', 'd']),
    { added: ['d'], removed: ['a'] },
  );
  assert.deepEqual(diffTokenLists(['a'], ['a']), { added: [], removed: [] });
});
