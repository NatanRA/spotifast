// Native messaging keeps this worker alive only while the user has paired a tab.
let tabId = null;
let port = null;
let timer = null;
let ack = 0;
let session = null;
let lastError = null;
let outstanding = false;
let polledAccount = null;

async function executeCommand(command, targetTab, connection, expectedAccount) {
  const requireConnection = () => {
    if (port !== connection || tabId !== targetTab) throw new Error('Companion disconnected');
  };
  requireConnection();
  const identity = await chrome.tabs.sendMessage(targetTab, {type: 'state'});
  requireConnection();
  if (!expectedAccount || !identity.logged_in || identity.account_id !== expectedAccount) {
    throw new Error('Spotify account changed');
  }
  if (command.action === 'load' || command.action === 'queue') {
    const uri = command.action === 'load' ? command.value?.uri : command.value;
    const match = uri?.match(/^spotify:(track|episode|album|playlist|artist):([A-Za-z0-9]{22})$/);
    if (!match) throw new Error('Invalid Spotify item');
    const url = `https://open.spotify.com/${match[1]}/${match[2]}`;
    const current = await chrome.tabs.get(targetTab);
    requireConnection();
    if (current.url?.split('?')[0] !== url) await chrome.tabs.update(targetTab, {url});
    // A full navigation is handled by the extension worker, which survives
    // replacing the content script. Never lose a command mid-navigation.
    for (let attempt = 0; attempt < 60; attempt++) {
      requireConnection();
      const tab = await chrome.tabs.get(targetTab);
      requireConnection();
      if (tab.status === 'complete') {
        try {
          const ready = await chrome.tabs.sendMessage(targetTab, {type: 'state'});
          if (ready.logged_in) break;
        } catch { /* content script is not ready yet */ }
      }
      if (attempt === 59) throw new Error('Spotify page did not load');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  requireConnection();
  return chrome.tabs.sendMessage(targetTab, {type: 'execute', command, account_id: expectedAccount});
}

function disconnect() {
  clearTimeout(timer);
  timer = null;
  const oldPort = port;
  port = null;
  outstanding = false;
  if (oldPort) oldPort.disconnect();
  chrome.action.setBadgeText({text: ''});
}

async function poll() {
  if (!port || tabId === null || outstanding) return;
  const connection = port;
  const targetTab = tabId;
  try {
    const state = await chrome.tabs.sendMessage(targetTab, {type: 'state'});
    if (port !== connection || tabId !== targetTab) return;
    outstanding = true;
    polledAccount = state.account_id;
    connection.postMessage({type: 'poll', ack, state, error: lastError});
    lastError = null;
  } catch {
    if (port !== connection || tabId !== targetTab) return;
    lastError = 'Open the paired Spotify tab and sign in';
    chrome.action.setTitle({title: lastError});
    timer = setTimeout(poll, 2000);
  }
}

chrome.action.onClicked.addListener(async tab => {
  disconnect();
  if (!tab.url?.startsWith('https://open.spotify.com/')) {
    tab = await chrome.tabs.create({url: 'https://open.spotify.com/'});
  }
  tabId = tab.id;
  ack = 0;
  session = null;
  lastError = null;
  polledAccount = null;
  port = chrome.runtime.connectNative('io.github.natanra.spotifast_lab');
  const connection = port;
  const targetTab = tabId;
  connection.onDisconnect.addListener(() => {
    if (port !== connection) return;
    port = null;
    outstanding = false;
    chrome.action.setBadgeText({text: '!'});
    chrome.action.setTitle({title: 'Install the Spotifast Lab native companion host, then click to reconnect'});
  });
  connection.onMessage.addListener(async reply => {
    if (port !== connection) return;
    const expectedAccount = polledAccount;
    outstanding = false;
    if (reply.session && reply.session !== session) {
      session = reply.session;
      ack = Number.isSafeInteger(reply.acknowledged) ? reply.acknowledged : 0;
      // First response from a new native session can contain old-ACK errors.
      // Poll it again before executing any command.
      timer = setTimeout(poll, 100);
      return;
    }
    if (reply.error) {
      chrome.action.setBadgeText({text: '!'});
      chrome.action.setTitle({title: reply.error});
    } else {
      chrome.action.setBadgeText({text: 'ON'});
      chrome.action.setTitle({title: 'Spotifast Lab is connected. Click to reconnect.'});
      for (const command of reply.commands ?? []) {
        if (!Number.isSafeInteger(command.id) || command.id <= ack) continue;
        // Every command is acknowledged once, including a visible failure.
        // Never replay a non-idempotent next/toggle after a transport retry.
        ack = command.id;
        try {
          const result = await executeCommand(command, targetTab, connection, expectedAccount);
          if (port === connection && !result?.ok) lastError = 'Playback command failed';
        } catch {
          if (port === connection) lastError = 'Playback command failed';
        }
      }
    }
    if (port === connection) timer = setTimeout(poll, 1000);
  });
  poll();
});

chrome.tabs.onRemoved.addListener(id => {
  if (id === tabId) { disconnect(); tabId = null; }
});
