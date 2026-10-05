// Isolated content script. Only DOM playback controls and public metadata are
// inspected. No fetch interception, cookies, tokens, or private Spotify APIs.
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let accountId = null;
  let accountLabel = null;
  let mutedForAdvertisement = false;
  let previousMuted = false;
  let trackIdentity = null;
  let trackUri = null;

  function currentUri(title) {
    const direct = uriFromLink(title?.querySelector('a[href]')?.getAttribute('href'));
    if (direct?.startsWith('spotify:track:') || direct?.startsWith('spotify:episode:')) return direct;
    const key = [title?.textContent, control('playback-duration')?.textContent,
      control('context-item-info-subtitles')?.textContent,
      control('cover-art-image')?.getAttribute('src')].join('|');
    if (key === trackIdentity) return trackUri;
    trackIdentity = key;
    trackUri = null;
    // Spotify's title links to the album. Its public drag-and-drop payload
    // carries the actual song link, without inspecting private application
    // state or touching the clipboard. Cache only this public URI.
    const draggable = title?.querySelector('[draggable="true"]');
    if (!draggable || typeof DataTransfer === 'undefined') return null;
    const transfer = new DataTransfer();
    draggable.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: transfer}));
    for (const type of transfer.types) {
      const value = transfer.getData(type);
      const match = value.match(/(?:spotify:|https:\/\/open\.spotify\.com\/)(track|episode)[:/]([A-Za-z0-9]{22})(?=$|[^A-Za-z0-9])/);
      if (match) { trackUri = `spotify:${match[1]}:${match[2]}`; break; }
    }
    draggable.dispatchEvent(new DragEvent('dragend', {bubbles: true, dataTransfer: transfer}));
    return trackUri;
  }

  function uriFromLink(href) {
    const match = href?.match(/^\/(track|episode|album|playlist|artist)\/([A-Za-z0-9]{22})(?:[/?#]|$)/);
    return match ? `spotify:${match[1]}:${match[2]}` : null;
  }
  function pathForUri(uri) {
    const match = uri?.match(/^spotify:(track|episode|album|playlist|artist):([A-Za-z0-9]{22})$/);
    if (!match) throw new Error('Unsupported Spotify item');
    return `/${match[1]}/${match[2]}`;
  }
  function milliseconds(text) {
    const fields = text?.trim().split(':').map(Number);
    if (!fields || fields.length < 2 || fields.length > 3 || fields.some(n => !Number.isFinite(n) || n < 0)) return 0;
    return fields.reduce((total, field) => total * 60 + field, 0) * 1000;
  }
  function control(testId) {
    if (testId === 'control-button-shuffle') {
      return $('[data-testid="now-playing-bar"] button[aria-label*="Shuffle"]');
    }
    return $(`[data-testid="${testId}"]`);
  }
  function shuffleEnabled(button) {
    return button?.getAttribute('aria-checked') === 'true' ||
      /^Disable Shuffle/i.test(button?.getAttribute('aria-label') ?? '');
  }
  function click(element) {
    if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') {
      throw new Error('Playback control unavailable');
    }
    element.click();
  }
  async function identifyAccount() {
    if ($('a[href*="accounts.spotify.com/login"]') || $('button[data-testid="login-button"]')) {
      accountId = null;
      accountLabel = null;
      return null;
    }
    const widget = control('user-widget-link');
    const label = widget?.getAttribute('aria-label') ?? widget?.textContent;
    if (label !== accountLabel) accountId = null;
    if (accountId) return accountId;
    if (!widget) return null;
    const wasOpen = widget.getAttribute('aria-expanded') === 'true';
    if (!wasOpen) widget.click();
    await delay(100);
    const link = $('[role="menu"] a[href^="/user/"]');
    const match = link?.getAttribute('href')?.match(/^\/user\/([^/?#]+)(?:[/?#]|$)/);
    // The profile link is the browser's identity, never a user-entered claim.
    if (match) { accountId = decodeURIComponent(match[1]); accountLabel = label; }
    if (!wasOpen && $('[role="menu"]')) widget.click();
    return accountId;
  }
  async function state() {
    const identity = await identifyAccount();
    const title = control('context-item-info-title');
    const trackUri = currentUri(title);
    const audio = $('audio');
    const nowPlaying = $('[data-testid="now-playing-widget"]') ?? title?.parentElement;
    const visible = element => element && element.getClientRects().length > 0;
    const advertisement = Boolean(visible(control('ad-banner')) || visible(control('ad-progress-bar')) ||
      (!trackUri && /^(Advertisement|Spotify Advertisement)$/i.test(title?.textContent?.trim() ?? '')));
    // Dedicated request filters are the first layer. If Spotify still serves
    // an audio advertisement, mute only that media element and restore it.
    // Muting is not skipping: the break can remain, and must be reported.
    if (audio) {
      if (advertisement && !mutedForAdvertisement) {
        previousMuted = audio.muted;
        audio.muted = true;
        mutedForAdvertisement = true;
      } else if (!advertisement && mutedForAdvertisement) {
        audio.muted = previousMuted;
        mutedForAdvertisement = false;
      }
    }
    const repeatButton = control('control-button-repeat');
    const repeatActive = repeatButton?.getAttribute('aria-checked') === 'true' || repeatButton?.getAttribute('aria-pressed') === 'true';
    const repeatLabel = repeatButton?.getAttribute('aria-label') ?? '';
    const repeat = /enable repeat one/i.test(repeatLabel) ? 'context' :
      /disable repeat/i.test(repeatLabel) ? 'track' :
      /enable repeat/i.test(repeatLabel) ? 'off' : repeatActive ? 'context' : 'off';
    const volume = $('[data-testid="volume-bar"] input[type="range"]');
    const volumeValue = Number(volume?.value);
    const volumeMax = Number(volume?.max || 1);
    return {
      account_id: identity ?? '', logged_in: Boolean(identity),
      playing: control('control-button-playpause')?.getAttribute('aria-label') === 'Pause',
      uri: trackUri, title: title?.textContent?.trim().slice(0, 512) ?? '',
      artists: Array.from(nowPlaying?.querySelectorAll('a[href^="/artist/"]') ?? []).slice(0, 10).map(a => a.textContent.trim().slice(0, 128)),
      position_ms: milliseconds(control('playback-position')?.textContent),
      duration_ms: milliseconds(control('playback-duration')?.textContent),
      volume: volume && Number.isFinite(volumeValue) && volumeMax > 0 ? volumeValue / volumeMax : 1,
      shuffle: shuffleEnabled(control('control-button-shuffle')),
      repeat, advertisement,
    };
  }
  async function setSlider(containerId, value) {
    const slider = $(`[data-testid="${containerId}"] input[type="range"]`);
    if (!slider) throw new Error('Slider unavailable');
    const minimum = Number(slider.min || 0);
    const maximum = Number(slider.max || 1);
    const bounded = Math.min(maximum, Math.max(minimum, value));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(slider, String(bounded));
    slider.dispatchEvent(new Event('input', {bubbles: true}));
    slider.dispatchEvent(new Event('change', {bubbles: true}));
  }
  async function setShuffle(enabled) {
    const button = control('control-button-shuffle');
    if (!button) throw new Error('Shuffle unavailable');
    const checked = shuffleEnabled(button);
    if (checked !== enabled) click(button);
  }
  async function setRepeat(mode) {
    if (!['off', 'context', 'track'].includes(mode)) throw new Error('Invalid repeat mode');
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await state()).repeat === mode) return;
      click(control('control-button-repeat'));
      await delay(150);
    }
    if ((await state()).repeat !== mode) throw new Error('Repeat selection failed');
  }
  async function openItem(uri) {
    const path = pathForUri(uri);
    // Navigation happens in the extension worker. Wait only for this page's
    // controls; a content script cannot survive navigating its own document.
    if (location.pathname !== path) throw new Error('Spotify item is not open');
    for (let attempt = 0; attempt < 50; attempt++) {
      if (location.pathname === path && control('play-button')) return;
      await delay(100);
    }
    throw new Error('Spotify item did not load');
  }
  async function execute(command, expectedAccount = null) {
    if (!command || !Number.isSafeInteger(command.id) || typeof command.action !== 'string') throw new Error('Invalid command');
    if (expectedAccount !== null && (typeof expectedAccount !== 'string' ||
        !expectedAccount || await identifyAccount() !== expectedAccount)) {
      throw new Error('Spotify account changed');
    }
    switch (command.action) {
      case 'toggle': click(control('control-button-playpause')); break;
      case 'next': click(control('control-button-skip-forward')); break;
      case 'previous': click(control('control-button-skip-back')); break;
      case 'activate': break;
      case 'shuffle':
        if (typeof command.value !== 'boolean') throw new Error('Invalid shuffle');
        await setShuffle(command.value); break;
      case 'repeat': await setRepeat(command.value); break;
      case 'volume': {
        if (!Number.isFinite(command.value) || command.value < 0 || command.value > 1) throw new Error('Invalid volume');
        const slider = $('[data-testid="volume-bar"] input[type="range"]');
        await setSlider('volume-bar', command.value * Number(slider?.max || 1)); break;
      }
      case 'seek': {
        if (!Number.isSafeInteger(command.value) || command.value < 0) throw new Error('Invalid position');
        const duration = (await state()).duration_ms;
        const slider = $('[data-testid="playback-progressbar"] input[type="range"]');
        if (!duration || !slider) throw new Error('Seeking unavailable');
        await setSlider('playback-progressbar', command.value / duration * Number(slider.max || 1)); break;
      }
      case 'load': {
        if (typeof command.value !== 'object' || command.value === null) throw new Error('Invalid item');
        await openItem(command.value.uri);
        const before = await state();
        if (command.value.play && (!before.playing || before.uri !== command.value.uri)) click(control('play-button'));
        if (typeof command.value.shuffle === 'boolean') await setShuffle(command.value.shuffle);
        if (command.value.repeat) await setRepeat(command.value.repeat);
        if (command.value.position_ms > 0) {
          await delay(500);
          await execute({id: command.id, action: 'seek', value: command.value.position_ms});
        }
        break;
      }
      case 'queue': {
        await openItem(command.value);
        const menu = control('more-button');
        click(menu);
        await delay(100);
        const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(item => item.textContent.trim() === 'Add to queue');
        click(item); break;
      }
      default: throw new Error('Unsupported command');
    }
    return {ok: true};
  }
  // Exposed only in isolated script scope for deterministic contract tests.
  globalThis.SpotifastBrowser = {uriFromLink, pathForUri, milliseconds, currentUri, shuffleEnabled, state, execute};
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    const task = message.type === 'state' ? state() :
      message.type === 'execute' && typeof message.account_id === 'string' ?
        execute(message.command, message.account_id) : null;
    if (!task) return false;
    task.then(reply).catch(() => reply({ok: false, error: 'Playback control unavailable'}));
    return true;
  });
})();
