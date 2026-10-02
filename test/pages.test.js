const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { renderHomePage } = require('../views/home');
const { renderMicRoutePage } = require('../views/mic-route');
const { renderTokenFilePage } = require('../views/token-file');

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

// Every el('id') in the inline script has to exist in the markup, otherwise the
// page throws on load. This is what catches a removed control whose script was
// not cleaned up with it.
function danglingElementRefs(html) {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const refs = inlineScripts(html)
    .join('\n')
    .matchAll(/\bel\('([^']+)'\)/g);
  return [...new Set([...refs].map((match) => match[1]))].filter((id) => !ids.has(id));
}

test('dashboard page ships valid inline JavaScript', () => {
  const html = renderHomePage();
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]), 'dashboard script must parse');
  assert.match(html, /<a href="\/mic-route">/);
  assert.doesNotMatch(html, /__NEXT__/);
  // Adding is available again: one at a time, in bulk, or by editing the file.
  assert.match(html, /id="tokenInput"/, 'single token field');
  assert.match(html, /id="tokenBulkInput"/, 'bulk paste field');
  assert.match(html, /id="addTokenBtn"/);
  assert.match(html, /id="addBulkBtn"/);
  assert.match(html, /Edit tokens\.txt/);
  // The per-account cards that used to render under Add Token are gone: the
  // message line and the token file counters are the only output now.
  assert.doesNotMatch(html, /id="tokenList"/, 'no account list under Add Token');
  assert.doesNotMatch(html, /Remove from file/, 'no per-token delete buttons');
  assert.doesNotMatch(html, /renderTokenList|fetchTokens/, 'list rendering is removed');
  assert.match(html, /id="tokenFileCount"/, 'the count still reports below the add form');
  assert.match(html, /id="tokenMessage"/, 'the result still comes back as a message');
  // A silent server has to be visible rather than looking healthy.
  assert.match(html, /id="ffmpegState"/);
  assert.match(html, /id="connectedState"/);
  assert.match(html, /id="flagState"/);
  // The loudness knobs were removed: the chain is server-configured now, so the
  // page only reports the values it is running with.
  for (const id of ['volSlider', 'driveSlider', 'lufsInput', 'limiterCheck', 'duckCheck', 'duckSlider']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} control is removed`);
  }
  assert.doesNotMatch(html, /the limiter holds the peak at 0\.95/, 'volume hint is removed');
  assert.doesNotMatch(html, /in your face/, 'drive hint is removed');
  assert.doesNotMatch(html, /Target Loudness \(LUFS/, 'LUFS label is removed');
  assert.doesNotMatch(html, /Limiter on \(prevents clipping/, 'limiter label is removed');
  assert.doesNotMatch(html, /saveLoudness|pushLoudness/, 'no loudness saving from this page');
  assert.match(html, /id="chainState"/, 'the active chain is still reported');
  assert.match(html, /id="gainState"/, 'the live pre-gain is reported');
  assert.match(html, /id="micLevelState"/, 'the mic input level is reported');
  assert.match(html, /id="flowState"/, 'the audio flow is traced on the page');
  assert.match(html, /id="audioFile"/, 'the player itself is untouched');
  assert.match(html, /id="uploadPlayBtn"/);
  assert.match(html, /id="playSavedBtn"/);
  assert.match(html, /id="stopAudioBtn"/);
});

test('mic routing page ships valid inline JavaScript', () => {
  const html = renderMicRoutePage();
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.throws(() => new vm.Script('function ('), 'sanity check the validator itself');
  assert.doesNotThrow(() => new vm.Script(scripts[0]), 'mic route script must parse');
  assert.match(html, /veera-pcm-tap/, 'references the server-side worklet');
  assert.match(html, /\/mic\/stream/, 'streams over the websocket');
});

test('token file page ships valid inline JavaScript and the add controls', () => {
  const html = renderTokenFilePage();
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]), 'token file script must parse');
  assert.match(html, /id="singleInput"/, 'add one');
  assert.match(html, /id="bulkInput"/, 'add many');
  assert.match(html, /id="fileText"/, 'edit the file');
  assert.match(html, /api\/tokens\/append/);
  assert.match(html, /api\/tokens\/save/);
  assert.doesNotMatch(html, /__NEXT__/);
});

test('pages share the base stylesheet and navigation', () => {
  for (const html of [renderHomePage(), renderMicRoutePage(), renderTokenFilePage()]) {
    assert.match(html, /body \{ background:#0b1220/, 'styles are inlined');
    assert.match(html, /href="\/"/);
    assert.match(html, /href="\/token-file"/);
    assert.match(html, /href="\/mic-route"/);
  }
});

test('no page reaches for an element that is not in its markup', () => {
  for (const [name, html] of [
    ['dashboard', renderHomePage()],
    ['mic routing', renderMicRoutePage()],
    ['token file', renderTokenFilePage()],
  ]) {
    assert.deepEqual(danglingElementRefs(html), [], `${name} has no dangling el() refs`);
  }
});
