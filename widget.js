/* StreamElements custom widget JS tab
 *
 * Tallies YouTube Super Chats that RestreamBot relays into Twitch chat, e.g.
 *   RestreamBot: [YouTube: @user] Super Chat - 7.77 USD
 * converts each to USD, and keeps a running per-stream total.
 */

// --- configuration (populated from the widget's Settings panel) --------------
const cfg = {
  labelText: 'YouTube Tips:',
  includeSuperStickers: true,
  maxSuperChatUsd: 500,
  resetCommand: '!tipsreset',
  addCommand: '!tipsadd',
  removeCommand: '!tipsremove',
  commandUsers: [],
  resetAfterHours: 5,
  hideWhenZero: false,
  storeKey: 'ytSuperChatTotal',
  debug: false,
};

// --- persisted state --------------------------------------------------------
// Individual events are kept (not just a running sum) so that two copies of the
// widget say the SE editor preview and OBS converge instead of double
// counting: merging is a union by message id.
const MAX_EVENTS = 150;

let state = {
  version: 1,
  startedAt: 0,
  lastEventAt: 0,
  /** Cents from events already pruned out of the list below. */
  carriedCents: 0,
  events: [],
};

let rates = null;
let ratesFetchedAt = 0;
let persistTimer = null;
let prevMsgId = '';

// Last-resort rates (units per 1 USD) if the rate feed cannot be reached.
const FALLBACK_RATES = {
  usd: 1, eur: 0.92, gbp: 0.77, sek: 10.5, nok: 10.8, dkk: 6.85, jpy: 150,
  cad: 1.38, aud: 1.53, nzd: 1.66, chf: 0.82, pln: 3.95, czk: 22.5, huf: 360,
  ron: 4.57, bgn: 1.8, try: 38, uah: 41, rub: 95, inr: 85, php: 58, idr: 16000,
  myr: 4.4, sgd: 1.34, thb: 34, twd: 32, krw: 1380, hkd: 7.8, vnd: 25000,
  brl: 5.5, mxn: 18.5, ars: 1150, clp: 950, cop: 4100, pen: 3.75, uyu: 42,
  zar: 18.3, ngn: 1550, kes: 129, egp: 48, ils: 3.65, sar: 3.75, aed: 3.67,
  qar: 3.64, pkr: 278, lkr: 300, isk: 138, crc: 510, gtq: 7.7, bob: 6.91,
};

const log = (...args) => {
  if (cfg.debug) console.log('[yt-tips]', ...args);
};

// --- parsing ----------------------------------------------------------------

/**
 * Reads a number written in either convention: "1,234.56" or "1.234,56".
 * Whichever separator comes last is the decimal point.
 */
function parseAmount(raw) {
  let s = String(raw).replace(/\s/g, '');
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');

  if (comma > -1 && dot > -1) {
    s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (comma > -1) {
    // Two or fewer trailing digits means it is a decimal comma, not a group separator.
    s = s.length - comma - 1 <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  }

  const value = Number(s);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// --- currency ---------------------------------------------------------------

async function loadRates() {
  const urls = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const body = await res.json();
      if (body && body.usd && Object.keys(body.usd).length > 20) {
        rates = body.usd;
        ratesFetchedAt = Date.now();
        log('exchange rates loaded:', Object.keys(rates).length, 'currencies');
        return;
      }
    } catch (err) {
      log('rate fetch failed', url, err);
    }
  }
  console.warn('[yt-tips] could not fetch exchange rates using built-in approximate rates');
}

function toUsdCents(amount, currency) {
  const code = String(currency).toLowerCase();
  if (code === 'usd') return Math.round((amount + Number.EPSILON) * 100);

  const rate = (rates && rates[code]) || FALLBACK_RATES[code];
  if (!rate || rate <= 0) {
    console.warn(`[yt-tips] unknown currency "${currency}" counted as $0.00`);
    return 0;
  }
  return Math.round((amount / rate + Number.EPSILON) * 100);
}

// --- totals -----------------------------------------------------------------

function totalCents() {
  return state.events.reduce((sum, e) => sum + (e.cents || 0), state.carriedCents || 0);
}

function formatUsd(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

let lastRendered = null;

function render() {
  const line = document.getElementById('line');
  const totalEl = document.getElementById('total');
  const labelEl = document.getElementById('label');
  if (!line || !totalEl) return;

  labelEl.textContent = cfg.labelText;
  const next = formatUsd(totalCents());

  if (lastRendered !== null && next !== lastRendered) {
    line.classList.add('bump');
    setTimeout(() => line.classList.remove('bump'), 700);
  }
  lastRendered = next;
  totalEl.textContent = next;

  line.classList.toggle('hide-when-zero', cfg.hideWhenZero && totalCents() === 0);
}

// --- persistence ------------------------------------------------------------

function persist() {
  clearTimeout(persistTimer);
  // Debounced: a burst of Super Chats results in one write, not five.
  persistTimer = setTimeout(() => {
    if (typeof SE_API === 'undefined' || !SE_API.store) return;
    SE_API.store.set(cfg.storeKey, state).catch?.((err) => log('store.set failed', err));
  }, 800);
}

function prune() {
  while (state.events.length > MAX_EVENTS) {
    const dropped = state.events.shift();
    state.carriedCents += dropped.cents || 0;
  }
}

/** Union by message id, so concurrent widget instances converge. */
function mergeState(incoming) {
  if (!incoming || incoming.version !== state.version) return false;

  const known = new Set(state.events.map((e) => e.id));
  const added = (incoming.events || []).filter((e) => e && !known.has(e.id));
  const carriedGrew = (incoming.carriedCents || 0) > (state.carriedCents || 0);

  if (!added.length && !carriedGrew) return false;

  state.carriedCents = Math.max(state.carriedCents || 0, incoming.carriedCents || 0);
  state.events = state.events.concat(added).sort((a, b) => (a.at || 0) - (b.at || 0));
  state.startedAt = Math.min(state.startedAt || Infinity, incoming.startedAt || Infinity) || Date.now();
  state.lastEventAt = Math.max(state.lastEventAt || 0, incoming.lastEventAt || 0);
  prune();
  return true;
}

function resetTally(reason) {
  state = {
    version: 1,
    startedAt: Date.now(),
    lastEventAt: 0,
    carriedCents: 0,
    events: [],
  };
  lastRendered = null;
  log('tally reset:', reason);
  persist();
  render();
}

async function restore() {
  if (typeof SE_API === 'undefined' || !SE_API.store) {
    render();
    return;
  }
  try {
    const stored = await SE_API.store.get(cfg.storeKey);
    if (stored && stored.version === 1 && Array.isArray(stored.events)) {
      const idleMs = Date.now() - (stored.lastEventAt || stored.startedAt || 0);
      const staleMs = cfg.resetAfterHours * 3600 * 1000;

      // The widget reloads when the overlay loads, i.e. when you start
      // streaming. A long gap means this is a new stream, so start at zero;
      // a short one means OBS restarted mid-stream, so pick the total back up.
      if (cfg.resetAfterHours > 0 && idleMs > staleMs) {
        log(`stored total is ${Math.round(idleMs / 3600000)}h old starting a new stream total`);
        resetTally('stale');
        return;
      }
      state = stored;
      prune();
      log('resumed total', formatUsd(totalCents()), `(${state.events.length} events)`);
    } else {
      state.startedAt = Date.now();
    }
  } catch (err) {
    log('store.get failed', err);
    state.startedAt = Date.now();
  }
  render();
}

// --- chat handling ----------------------------------------------------------

/** Broadcaster and moderators only. Everyone else is ignored. */
function isPrivileged(data, nick) {
  const isModerator = data.authorDetails.isChatModerator;
  const isOwner = data.authorDetails.isChatOwner;
  // Explicit moderator flag from Twitch.
  if( isModerator === true || isOwner === true) {
    return true;
  } else {
    return false;
  }

  // Badges arrive either as an array of objects or as the raw IRC string
  // ("broadcaster/1,subscriber/12"). Compare badge names exactly — a substring
  // test would also match a badge URL that merely contains the word.
  const raw = data.badges || tags.badges || '';
  const names = Array.isArray(raw)
    ? raw.map((b) => String((b && (b.type || b.name)) || ''))
    : String(raw).split(',').map((b) => b.split('/')[0]);
  if (names.some((n) => n.toLowerCase() === 'broadcaster' || n.toLowerCase() === 'moderator')) {
    return true;
  } else {
    return false;
  }

  // Escape hatch: if StreamElements ever delivers badges in a shape we do not
  // recognise, naming yourself in the settings keeps the commands usable.
  return cfg.commandUsers.includes(String(nick || '').toLowerCase());
}

/**
 * Manual correction from chat, for when the relay misses a Super Chat or posts
 * a wrong amount: "!tipsadd 7.77", "!tipsadd 50 SEK", "!tipsremove 5".
 * Recorded as an ordinary event so it persists, de-duplicates and merges like
 * the rest.
 */
function adjustTotal(sign, args, msgId, nick) {
  const amount = parseAmount(args[0] || '');
  if (!amount) {
    log(`could not read an amount from "${args.join(' ')}" try e.g. !tipsadd 7.77`);
    return;
  }

  const currency = String(args[1] || 'USD').toUpperCase();
  let cents = toUsdCents(amount, currency) * sign;

  // Never let a correction push the visible total below zero.
  if (cents < 0) cents = -Math.min(Math.abs(cents), totalCents());
  if (cents === 0) {
    log('adjustment came to $0.00, nothing to do');
    return;
  }

  if (state.events.some((e) => e.id === msgId)) return;

  state.events.push({ id: msgId, at: Date.now(), amount, currency, cents, manual: true, by: nick });
  state.lastEventAt = Date.now();
  if (!state.startedAt) state.startedAt = Date.now();
  prune();

  log(`${nick} adjusted the total by ${formatUsd(cents)}; total ${formatUsd(totalCents())}`);
  persist();
  render();
}

function handleSuperStickerMessage(event) {
  const snippet = event.data.snippet;
  const superStickerDetails = snippet.superStickerDetails;
  const currency = superStickerDetails.currency;
  const msgId = event.data.msgId;
  const amount = Number(superStickerDetails.amountMicros)/1000000;
  const user = event.data.displayName;

  let ytTip = {
    msgId: msgId,
    user: user,
    amount: amount,
    currency: currency
  }

  log('super sticker info: event', event);
  log('super sticker object', ytTip);

  handleTipData(ytTip);
}

function handleTipMessage(event) {
  const eventData = event.data;
  const user = eventData.username;
  const donationAmount = eventData.amount;
  const donationMessage = eventData.message;
  const currency = eventData.currency;
  const msgId = event.activityId;
  const type = event.type;

  let ytTip = {
    msgId: msgId,
    user: user,
    amount: donationAmount,
    currency: currency
  }

  handleTipData(ytTip);
}

function handleTipData(ytTip) {
  if (state.events.some((e) => e.id === ytTip.msgId)) {
    log('duplicate message id, ignoring');
    return;
  }

  const cents = toUsdCents(ytTip.amount, ytTip.currency);

  // YouTube caps a single Super Chat at $500, so anything larger did not come
  // from a real purchase. Cheap insurance against a viewer typing a fake line.
  if (cfg.maxSuperChatUsd > 0 && cents > cfg.maxSuperChatUsd * 100) {
    console.warn(
      `[yt-tips] ignoring an implausible Super Chat of ${formatUsd(cents)} from ${ytTip.user} ` +
        `(limit ${formatUsd(cfg.maxSuperChatUsd * 100)}). Raise it in the widget settings if this was real.`,
    );
    return;
  }

  state.events.push({
    id: ytTip.msgId,
    at: Date.now(),
    amount: ytTip.amount,
    currency: ytTip.currency,
    cents: cents
  });
  state.lastEventAt = Date.now();
  if (!state.startedAt) state.startedAt = Date.now();
  prune();

  log(`counted ${ytTip.amount} ${ytTip.currency} -> ${formatUsd(cents)}; total ${formatUsd(totalCents())}`);
  persist();
  render();
}

function handleMessage(event) {
  const data = event.data;
  const msgId = data.id;
  const user = data.displayName;
  const text = data.text;
  
  if (state.events.some((e) => e.id === msgId)) {
    log('duplicate message id, ignoring');
    return;
  }

  // Compare on the first word so "!tipsremove 5" can never be mistaken for
  // "!tipsreset", and so trailing text is ignored.
  const words = text.split(/\s+/);
  const command = String(words[0] || '').toLowerCase();
  const args = words.slice(1);
  const is = (setting) => setting && command === setting.toLowerCase();

  if (is(cfg.resetCommand) || is(cfg.addCommand) || is(cfg.removeCommand)) {
    if (!isPrivileged(data, user)) {
      log('ignoring command from non-moderator', user);
      return;
    }
    if (is(cfg.resetCommand)) resetTally(`chat command from ${user}`);
    else adjustTotal(is(cfg.addCommand) ? 1 : -1, args, msgId, user);
    return;
  }

  log('relay message:', text);

  state.events.push({
    id: msgId,
    at: Date.now(),
    amount: 0,
    currency: '',
    cents: 0
  });

  state.lastEventAt = Date.now();
  if (!state.startedAt) state.startedAt = Date.now();
  prune();

  persist();
  render();
}

// --- settings ---------------------------------------------------------------

function loadGoogleFont(name) {
  const href =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}` +
    ':wght@400;600;700;800&display=swap';
  let link = document.getElementById('yt-tips-font');
  if (!link) {
    link = document.createElement('link');
    link.id = 'yt-tips-font';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function applyFields(f) {
  const pick = (key, fallback) => (f[key] === undefined || f[key] === '' ? fallback : f[key]);

  cfg.labelText = String(pick('labelText', cfg.labelText));
  cfg.includeSuperStickers = pick('includeSuperStickers', 'yes') !== 'no';
  cfg.maxSuperChatUsd = Number(pick('maxSuperChatUsd', cfg.maxSuperChatUsd)) || 0;
  cfg.resetCommand = String(pick('resetCommand', cfg.resetCommand)).trim();
  cfg.addCommand = String(pick('addCommand', cfg.addCommand)).trim();
  cfg.removeCommand = String(pick('removeCommand', cfg.removeCommand)).trim();
  cfg.commandUsers = String(pick('commandUsers', ''))
    .toLowerCase()
    .split(',')
    .map((name) => name.trim().replace(/^@/, ''))
    .filter(Boolean);
  cfg.resetAfterHours = Number(pick('resetAfterHours', cfg.resetAfterHours)) || 0;
  cfg.hideWhenZero = pick('hideWhenZero', 'no') === 'yes';
  cfg.storeKey = String(pick('storeKey', cfg.storeKey)).trim() || 'ytSuperChatTotal';
  cfg.debug = pick('debug', 'no') === 'yes';

  // Colours, size and alignment come straight from the CSS tab via {{...}}
  // interpolation the only thing left to do here is make sure the chosen font
  // is actually loaded.
  if (f.fontFamily) loadGoogleFont(f.fontFamily);
}

// --- StreamElements lifecycle ----------------------------------------------

window.addEventListener('onWidgetLoad', (obj) => {
  const detail = (obj && obj.detail) || {};
  applyFields(detail.fieldData || {});
  loadRates();
  restore();

  // Rates are published daily; refresh occasionally for very long streams.
  setInterval(() => {
    if (Date.now() - ratesFetchedAt > 12 * 3600 * 1000) loadRates();
  }, 30 * 60 * 1000);
});

window.addEventListener('onEventReceived', (obj) => {
  const detail = (obj && obj.detail) || {};
  if (!detail.event) return;
  const event = detail.event;

  // StreamElements suffixes some listeners ("tip-latest", "follower-latest"),
  // so compare on the part before the dash the way SE's own widgets do.

  const listener = String(detail.listener);

  if (listener === 'event' && event.type === 'superchat') {
    handleTipMessage(event);
    return;
  } else if(listener === 'message' && event.data.snippet && event.data.snippet.type === 'superStickerEvent') {
    handleSuperStickerMessage(event);
    return;
  } else if(listener === 'message') {
    handleMessage(event);
    return;
  }

  // Another copy of this widget updated the shared store.
  if (listener === 'kvstore:update') {
    const payload = (event && event.data) || detail.event || {};
    if (payload.key !== cfg.storeKey) return;
    if (mergeState(payload.value)) render();
  }
});
