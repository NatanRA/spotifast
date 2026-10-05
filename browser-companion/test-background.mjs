import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime(send = async () => ({logged_in: true, account_id: 'owner'})) {
  let click;
  const timers = [];
  const ports = [];
  const executed = [];
  const chrome = {
    tabs: {
      get: async () => ({url: 'https://open.spotify.com/track/0123456789abcdefghijkl', status: 'complete'}),
      update: async () => {},
      sendMessage: async (tab, message) => {
        if (message.type === 'execute') { executed.push({tab, command: message.command}); return {ok: true}; }
        return send(tab, message);
      },
      onRemoved: {addListener() {}},
    },
    action: {onClicked: {addListener(fn) {click = fn;}}, setBadgeText() {}, setTitle() {}},
    runtime: {connectNative() {
      const port = {posted: [], postMessage(message) {this.posted.push(message);}, disconnect() {},
        onDisconnect: {addListener() {}}, onMessage: {addListener(fn) {port.reply = fn;}}};
      ports.push(port);
      return port;
    }},
  };
  vm.runInNewContext(source, {chrome, setTimeout(fn) {timers.push(fn); return timers.length;}, clearTimeout() {}});
  return {ports, executed, async connect(tab = 1) {await click({id: tab, url: 'https://open.spotify.com/'}); await tick();},
    async pollAgain() {await timers.pop()(); await tick();}};
}

test('reconnecting adopts the native ACK and never repeats an acknowledged skip', async () => {
  const app = runtime();
  await app.connect();
  const port = app.ports[0];
  await port.reply({session: 'current', acknowledged: 7, commands: [], error: 'Old ACK'});
  await app.pollAgain();
  assert.equal(port.posted.at(-1).ack, 7);
  await port.reply({session: 'current', acknowledged: 7, commands: [{id: 8, action: 'next'}]});
  assert.equal(app.executed.length, 1);
  await port.reply({session: 'current', acknowledged: 7, commands: [{id: 8, action: 'next'}]});
  assert.equal(app.executed.length, 1);
});

test('a delayed old poll cannot send another tab state through a new connection', async () => {
  let release;
  const app = runtime(tab => tab === 1 ? new Promise(resolve => {release = resolve;}) : Promise.resolve({logged_in: true}));
  await app.connect(1);
  await app.connect(2);
  release({logged_in: true, account_id: 'old-tab'});
  await tick();
  assert.equal(app.ports[0].posted.length, 0);
  assert.equal(app.ports[1].posted.length, 1);
  assert.equal(app.ports[1].posted[0].state.account_id, undefined);
});

test('callbacks from a replaced native connection cannot execute playback', async () => {
  const app = runtime();
  await app.connect(1);
  const old = app.ports[0];
  await app.connect(2);
  await old.reply({session: 'old', commands: [{id: 1, action: 'next'}]});
  assert.equal(app.executed.length, 0);
});
