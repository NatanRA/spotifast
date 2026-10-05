import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./content.js', import.meta.url), 'utf8');
function runtime(additions = {}) {
  const context = {
    chrome: {runtime: {id: 'test-extension', onMessage: {addListener() {}}}},
    document: {querySelector() { return null; }},
    setTimeout, URL, location: {pathname: '/'},
    ...additions,
  };
  vm.runInNewContext(source, context);
  return context.SpotifastBrowser;
}

test('Spotify-only URI routing rejects alternate hosts, queries and encoded injection', () => {
  const api = runtime();
  assert.equal(api.pathForUri('spotify:track:0123456789abcdefghijkl'), '/track/0123456789abcdefghijkl');
  for (const uri of ['https://evil.invalid', 'spotify:track:../../etc/passwd',
    'spotify:track:0123456789abcdefghijkl?redirect=evil', 'javascript:alert(1)']) {
    assert.throws(() => api.pathForUri(uri));
  }
  assert.equal(api.uriFromLink('/track/0123456789abcdefghijkl?si=share'), 'spotify:track:0123456789abcdefghijkl');
  assert.equal(api.uriFromLink('https://evil.invalid/track/0123456789abcdefghijkl'), null);
});

test('album title links use the public song drag payload, never the album URI', () => {
  let drags = 0;
  class Transfer {
    values = new Map();
    get types() { return Array.from(this.values.keys()); }
    setData(type, value) { this.values.set(type, value); }
    getData(type) { return this.values.get(type); }
  }
  class Drag {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  const title = {textContent: 'A song', querySelector(selector) {
    if (selector === 'a[href]') return {getAttribute() { return '/album/abcdefghijkl0123456789'; }};
    if (selector === '[draggable="true"]') return {dispatchEvent(event) {
      if (event.type === 'dragstart') {
        drags++;
        event.dataTransfer.setData('text/uri-list', 'https://open.spotify.com/track/0123456789abcdefghijkl?si=share');
      }
    }};
  }};
  const api = runtime({DataTransfer: Transfer, DragEvent: Drag});
  assert.equal(api.currentUri(title), 'spotify:track:0123456789abcdefghijkl');
  assert.equal(api.currentUri(title), 'spotify:track:0123456789abcdefghijkl');
  assert.equal(drags, 1);
  title.textContent = 'Next song';
  api.currentUri(title);
  assert.equal(drags, 2);
});

test('shuffle recognizes the live web-player action label', () => {
  const api = runtime();
  const button = label => ({getAttribute(name) { return name === 'aria-label' ? label : null; }});
  assert.equal(api.shuffleEnabled(button('Enable Shuffle for Liked Songs')), false);
  assert.equal(api.shuffleEnabled(button('Disable Shuffle for Liked Songs')), true);
});

test('position parsing supports long episodes and rejects invalid input', () => {
  const api = runtime();
  assert.equal(api.milliseconds('3:14'), 194000);
  assert.equal(api.milliseconds('1:02:03'), 3723000);
  for (const text of ['not a time', '-1:20', '', 'NaN:10']) assert.equal(api.milliseconds(text), 0);
});

test('unknown controls and out-of-range values fail without guessing', async () => {
  const api = runtime();
  await assert.rejects(api.execute({id: 1, action: 'shell', value: 'command'}));
  await assert.rejects(api.execute({id: 1, action: 'volume', value: 20}));
  await assert.rejects(api.execute({id: 1, action: 'shuffle', value: 'true'}));
  await assert.rejects(api.execute({id: 1, action: 'next'}));
});

test('not signed in means no claimed account or connected playback', async () => {
  const snapshot = await runtime().state();
  assert.equal(snapshot.logged_in, false);
  assert.equal(snapshot.account_id, '');
  assert.equal(snapshot.uri, null);
  assert.equal(snapshot.playing, false);
  await assert.rejects(runtime().execute({id: 1, action: 'next'}, 'owner'), /account changed/);
});
