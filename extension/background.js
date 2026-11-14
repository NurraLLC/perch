// Perch service worker. Moves a tab into its own window, fills it with the site's player,
// and asks the Windows helper to make that window frameless and keep it above every app.
const HOST_NAME = 'com.perch.helper';
const OPACITY_STEPS = [100, 85, 70, 50];
const ALL_SITES_IDS = ['perch-all-main', 'perch-all'];

/** tabId -> float record */
const floats = new Map();
const helper = { ok: false, hotkeys: true, version: null };
let port = null;
let readyWaiters = [];

const ready = chrome.storage.session.get('floats').then(({ floats: saved }) => {
  for (const f of saved || []) floats.set(f.tabId, f);
});
const save = () => chrome.storage.session.set({ floats: [...floats.values()] });
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendFrame = (tabId, frameId, msg) => chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => null);
const broadcast = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => null);

// ------------------------------------------------------------------ helper connection
function connectHelper() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    port = null;
    return null;
  }
  port.onMessage.addListener(onHelper);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    const was = helper.ok;
    helper.ok = false;
    if (was) for (const f of floats.values()) sendFrame(f.tabId, 0, { type: 'perch:state', helper: false });
  });
  return port;
}

function helperReady(timeout = 900) {
  if (helper.ok) return Promise.resolve(true);
  if (!connectHelper()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(helper.ok), timeout);
    readyWaiters.push(() => { clearTimeout(t); resolve(true); });
  });
}

function post(msg) {
  if (!port || !helper.ok) return;
  try { port.postMessage(msg); } catch {}
}

async function onHelper(msg) {
  await ready;
  const f = floats.get(msg.id);
  switch (msg.type) {
    case 'ready': {
      const fresh = !helper.ok;
      Object.assign(helper, { ok: true, hotkeys: msg.hotkeys, version: msg.version });
      readyWaiters.splice(0).forEach((fn) => fn());
      // A restarted helper has forgotten our windows: hand them back.
      if (fresh) for (const x of floats.values()) if (x.attached) attach(x);
      break;
    }
    case 'attached':
      if (!f) break;
      f.attached = true;
      save();
      sendFrame(f.tabId, 0, { type: 'perch:untoken' });
      break;
    case 'attachFailed':
      if (!f) break;
      sendFrame(f.tabId, 0, { type: 'perch:untoken' });
      sendFrame(f.tabId, 0, { type: 'perch:state', notice: 'Couldn’t pin this window. Try Back to tab, then float again.' });
      break;
    case 'placed': {
      if (!f || f.kind !== 'video' || !msg.rect) break;
      const { placements = {} } = await chrome.storage.local.get('placements');
      placements[f.host] = msg.rect;
      await chrome.storage.local.set({ placements });
      break;
    }
    case 'state':
      if (!f) break;
      Object.assign(f, { ghost: msg.ghost, opacity: msg.opacity, pinned: msg.pinned });
      save();
      sendFrame(f.tabId, 0, { type: 'perch:state', ghost: f.ghost, opacity: f.opacity, pinned: f.pinned });
      break;
    case 'hotkey':
      if (f && msg.name === 'playpause') broadcast(f.tabId, { type: 'perch:playpause' });
      break;
    case 'released': {
      const done = releaseWaiters.get(msg.id);
      if (done) done();
      break;
    }
    case 'gone':
      if (f) forget(f.tabId);
      break;
  }
}

// ------------------------------------------------------------------ floating
async function ensureInjected(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!window.__perch });
    if (r && r.result) return true;
  } catch {
    return false; // chrome:// pages, the Web Store, and so on
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['main-world.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    return true;
  } catch {
    return false;
  }
}

async function pickFrame(tabId, preferFrame) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (window.__perch ? window.__perch.score() : -1),
    });
  } catch {}
  let best = null;
  for (const r of results) {
    const s = typeof r.result === 'number' ? r.result : -1;
    if (s <= 0) continue;
    const weighted = r.frameId === preferFrame ? s * 1000 : s;
    if (!best || weighted > best.weighted) best = { frameId: r.frameId, weighted };
  }
  if (!best && preferFrame != null) return { frameId: preferFrame };
  return best;
}

async function floatTab(tabId, preferFrame) {
  await ready;
  if (floats.has(tabId)) {
    await back(tabId);
    return { ok: true, back: true };
  }
  if (!(await ensureInjected(tabId))) return { ok: false, reason: 'blocked' };
  const target = await pickFrame(tabId, preferFrame);
  if (!target) return { ok: false, reason: 'novideo' };

  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  const width = 560;
  const height = 360;
  const f = {
    tabId,
    kind: 'video',
    host: hostOf(tab.url),
    frameId: target.frameId,
    origin: { windowId: tab.windowId, index: tab.index },
    ghost: false,
    opacity: 100,
    pinned: true,
    chatTabId: null,
    attached: false,
  };
  floats.set(tabId, f);
  save();

  // Sites that rebuild on resize (X) freeze their layout before the window shrinks.
  await broadcast(tabId, { type: 'perch:prefloat' });

  let created;
  try {
    created = await chrome.windows.create({
      tabId,
      type: 'popup',
      focused: true,
      width,
      height,
      left: Math.max(0, win.left + win.width - width - 32),
      top: Math.max(0, win.top + win.height - height - 32),
    });
  } catch (e) {
    forget(tabId);
    broadcast(tabId, { type: 'perch:exit' });
    return { ok: false, reason: 'window', error: String(e && e.message || e) };
  }
  f.windowId = created.id;
  save();

  await broadcast(tabId, { type: 'perch:floating', on: true });
  await sendFrame(tabId, target.frameId, { type: 'perch:fill' });
  await attach(f);
  return { ok: true };
}

async function attach(f) {
  const ok = await helperReady();
  const token = `perch-${Math.random().toString(36).slice(2, 10)}`;
  let metrics = null;
  for (let i = 0; i < 20 && !metrics; i++) {
    metrics = await sendFrame(f.tabId, 0, { type: 'perch:enter', kind: f.kind, token: ok ? token : null, helper: ok });
    if (!metrics) await sleep(250);
  }
  if (!ok || !metrics) return;
  const { placements = {} } = await chrome.storage.local.get('placements');
  post({
    type: 'attach',
    id: f.tabId,
    token,
    kind: f.kind,
    iw: metrics.iw,
    ih: metrics.ih,
    dpr: metrics.dpr,
    rect: f.kind === 'video' ? placements[f.host] || null : null,
    def: { w: 480, h: 270 },
    link: f.parentTabId || 0,
    ghost: !!f.ghost,
    opacity: f.opacity || 100,
    pinned: f.pinned !== false,
  });
}

// The helper hands the Chrome window back as a normal window before we move the tab.
const releaseWaiters = new Map();
function release(tabId) {
  if (!helper.ok) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { releaseWaiters.delete(tabId); resolve(); };
    releaseWaiters.set(tabId, done);
    setTimeout(done, 600);
    post({ type: 'release', id: tabId });
  });
}

async function back(tabId, { close = false } = {}) {
  const f = floats.get(tabId);
  if (!f) return;
  forget(tabId);
  await release(tabId);

  if (f.kind === 'chat') {
    try { await chrome.windows.remove(f.windowId); } catch {}
    return;
  }
  if (f.chatTabId) back(f.chatTabId);
  await broadcast(tabId, { type: 'perch:exit' });
  if (close) {
    try { await chrome.tabs.remove(tabId); } catch {}
    return;
  }
  await returnTab(tabId, f.origin);
}

// Tabs can only be moved between normal windows, so go through a normal window if needed.
async function returnTab(tabId, origin) {
  let home = null;
  try { home = await chrome.windows.get(origin.windowId); } catch {}
  if (!home || home.type !== 'normal') {
    try { await chrome.windows.create({ tabId, type: 'normal', focused: true }); } catch {}
    return;
  }
  try {
    await chrome.tabs.move(tabId, { windowId: origin.windowId, index: origin.index });
  } catch {
    try {
      await chrome.windows.create({ tabId, type: 'normal', focused: false, state: 'minimized' });
      await chrome.tabs.move(tabId, { windowId: origin.windowId, index: origin.index });
    } catch {
      return;
    }
  }
  try {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(origin.windowId, { focused: true });
  } catch {}
}

function forget(tabId) {
  const f = floats.get(tabId);
  if (!f) return;
  floats.delete(tabId);
  if (f.kind === 'chat' && f.parentTabId) {
    const parent = floats.get(f.parentTabId);
    if (parent) {
      parent.chatTabId = null;
      sendFrame(parent.tabId, 0, { type: 'perch:state', chat: false });
    }
  }
  save();
}

async function toggleChat(tabId) {
  const f = floats.get(tabId);
  if (!f || f.kind !== 'video') return;
  if (f.chatTabId) {
    await back(f.chatTabId);
    return;
  }
  const url = await sendFrame(tabId, 0, { type: 'perch:chatUrl' });
  if (!url) return;
  const win = await chrome.windows.create({ url, type: 'popup', focused: false, width: 360, height: 520 });
  const chatTab = win.tabs[0];
  const c = { tabId: chatTab.id, windowId: win.id, kind: 'chat', host: hostOf(url), parentTabId: tabId, ghost: false, opacity: 100, pinned: true, attached: false };
  floats.set(c.tabId, c);
  f.chatTabId = c.tabId;
  save();
  sendFrame(tabId, 0, { type: 'perch:state', chat: true });
  for (let i = 0; i < 40; i++) {
    const t = await chrome.tabs.get(c.tabId).catch(() => null);
    if (!t) return;
    if (t.status === 'complete') break;
    await sleep(250);
  }
  await attach(c);
}

async function command(tabId, msg) {
  const f = floats.get(tabId);
  if (!f) return;
  switch (msg.cmd) {
    case 'drag': post({ type: 'drag', id: tabId }); break;
    case 'resize': post({ type: 'resize', id: tabId, edge: msg.edge }); break;
    case 'ghost': post({ type: 'ghost', id: tabId, on: !f.ghost }); break;
    case 'pin': post({ type: 'pin', id: tabId, on: !f.pinned }); break;
    case 'opacity': {
      const i = OPACITY_STEPS.indexOf(f.opacity);
      post({ type: 'opacity', id: tabId, value: OPACITY_STEPS[(i + 1) % OPACITY_STEPS.length] });
      break;
    }
    case 'fit': {
      const aspect = await broadcast(tabId, { type: 'perch:aspect' });
      post({ type: 'fit', id: tabId, aspect: typeof aspect === 'number' && aspect > 0 ? aspect : 16 / 9 });
      break;
    }
    case 'chat': await toggleChat(tabId); break;
    case 'back': await back(tabId); break;
    case 'close': await back(tabId, { close: true }); break;
  }
}

// ------------------------------------------------------------------ "Float button on every site"
async function syncAllSites() {
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  const existing = (await chrome.scripting.getRegisteredContentScripts({ ids: ALL_SITES_IDS })).map((s) => s.id);
  if (has && existing.length < 2) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing });
    const exclude = ['*://*.youtube.com/*', '*://*.x.com/*', '*://*.twitter.com/*', '*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.crunchyroll.com/*'];
    await chrome.scripting.registerContentScripts([
      { id: 'perch-all-main', matches: ['<all_urls>'], excludeMatches: exclude, js: ['main-world.js'], world: 'MAIN', runAt: 'document_start', allFrames: true },
      { id: 'perch-all', matches: ['<all_urls>'], excludeMatches: exclude, js: ['content.js'], css: ['content.css'], runAt: 'document_idle', allFrames: true },
    ]);
  } else if (!has && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: existing });
  }
  return has;
}

// ------------------------------------------------------------------ events
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;
  (async () => {
    await ready;
    switch (msg.type) {
      case 'perch:hello': {
        const f = floats.get(tabId);
        return f ? { floating: true, kind: f.kind, helper: helper.ok, ghost: f.ghost, opacity: f.opacity, pinned: f.pinned, chat: !!f.chatTabId } : { floating: false };
      }
      case 'perch:float': return floatTab(tabId, sender.frameId);
      case 'perch:cmd': return command(tabId, msg);
      case 'perch:calib': post({ type: 'calib', id: tabId, iw: msg.iw, ih: msg.ih, dpr: msg.dpr }); return true;
      case 'popup:status': {
        await helperReady(500);
        const allSites = await syncAllSites();
        const floating = floats.has(tabId);
        let canFloat = false;
        let blocked = false;
        if (!floating && tabId != null) {
          blocked = !(await ensureInjected(tabId));
          canFloat = !blocked && !!(await pickFrame(tabId));
        }
        const count = [...floats.values()].filter((f) => f.kind === 'video').length;
        return { helper: helper.ok, hotkeys: helper.hotkeys, floating, canFloat, blocked, allSites, count };
      }
      case 'popup:float': return floatTab(tabId);
      case 'popup:backAll':
        for (const f of [...floats.values()]) if (f.kind === 'video') await back(f.tabId);
        return true;
      case 'popup:allSites': return syncAllSites();
      default: return null;
    }
  })().then(reply, (e) => reply({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'float-toggle' && tab) floatTab(tab.id);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const f = floats.get(tabId);
  if (!f) return;
  forget(tabId);
  post({ type: 'release', id: tabId });
  if (f.chatTabId) back(f.chatTabId);
});

chrome.runtime.onStartup.addListener(() => { chrome.storage.session.remove('floats'); });
chrome.runtime.onInstalled.addListener(() => { syncAllSites(); });

// Keep the helper connected so its global hotkeys work; an open native port also keeps
// this worker alive. If the helper isn't installed, this fails quietly.
connectHelper();
