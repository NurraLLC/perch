// Perch, isolated content script. Runs in every frame of supported pages.
// Finds the video, shows the Float pill, fills the float window with the site's player,
// and draws the float's hover strip (drag, resize, ghost, opacity, chat, back).
// All DOM is built with createElement: YouTube enforces Trusted Types, so no innerHTML.
(() => {
  if (window.__perch) return;

  const TOP = window === window.top;
  const HOST = location.hostname.replace(/^www\./, '');
  const ACCENT = '#FFB547';

  const state = { floating: false, kind: null, helper: false, video: null, ghost: false, opacity: 100, pinned: true, chat: false };
  let chosen = null;
  let hovered = null;
  let hoveredAt = 0;

  // ---------------------------------------------------------------- site adapters
  const channel = () => location.pathname.split('/').filter(Boolean)[0] || '';
  const ADAPTERS = [
    {
      match: /(^|\.)youtube\.com$/,
      player: (v) => v.closest('#movie_player'),
      fullscreenButton: '.ytp-fullscreen-button',
      chat: () => {
        const id = new URLSearchParams(location.search).get('v');
        const live = document.querySelector('.ytp-live, .ytp-live-badge[disabled]') || document.querySelector('ytd-live-chat-frame');
        return id && live ? `https://www.youtube.com/live_chat?is_popout=1&v=${id}` : null;
      },
    },
    {
      match: /(^|\.)twitch\.tv$/,
      player: (v) => v.closest('.video-player') || v.closest('[data-a-target="video-player"]'),
      fullscreenButton: '[data-a-target="player-fullscreen-button"]',
      chat: () => {
        const ch = channel();
        const skip = ['videos', 'directory', 'popout', 'settings', 'search', 'downloads', 'subscriptions', 'inventory', 'wallet'];
        return ch && !skip.includes(ch) && !location.pathname.includes('/videos/') ? `https://www.twitch.tv/popout/${ch}/chat?popout=` : null;
      },
    },
    {
      match: /(^|\.)kick\.com$/,
      player: (v) => v.closest('#injected-embedded-channel-player-video') || v.closest('[id*="video-player"]'),
      fullscreenButton: null,
      chat: () => {
        const ch = channel();
        return ch && !['categories', 'following', 'browse', 'video', 'popout'].includes(ch) ? `https://kick.com/popout/${ch}/chat` : null;
      },
    },
    {
      // *.x.com.localhost is only for local testing (Chrome resolves .localhost to this PC).
      match: /(^|\.)(x|twitter)\.com(\.localhost)?$/,
      player: (v) => v.closest('[data-testid="videoPlayer"]') || v.closest('[data-testid="videoComponent"]'),
      fullscreenButton: null,
      // X rebuilds the whole timeline when the window narrows; keep its layout still.
      freezeLayout: true,
      // Identify a video by its post's link plus its position in that post, so a quoted
      // post's video is found again if X re-renders the timeline anyway.
      key: (v) => {
        const article = v.closest('article');
        const link = article && article.querySelector('a[href*="/status/"]');
        if (!link) return null;
        return { href: link.getAttribute('href'), index: Array.from(article.querySelectorAll('video')).indexOf(v) };
      },
      findByKey: (k) => {
        for (const article of document.querySelectorAll('article')) {
          const link = article.querySelector('a[href*="/status/"]');
          if (link && link.getAttribute('href') === k.href) return article.querySelectorAll('video')[Math.max(0, k.index)] || null;
        }
        return null;
      },
    },
    {
      match: /(^|\.)crunchyroll\.com$/,
      player: (v) => v.closest('#vilosRoot') || v.closest('#velocity-player-package') || v.closest('[data-testid="vilos-player"]'),
      fullscreenButton: '[data-testid="vilos-fullscreen_button"]',
    },
  ];
  const adapter = ADAPTERS.find((a) => a.match.test(location.hostname)) || {};

  // ---------------------------------------------------------------- tiny DOM helper
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }

  const ICONS = {
    fit: ['M4 9V5h4', 'M20 9V5h-4', 'M4 15v4h4', 'M20 15v4h-4'],
    chat: ['M5 5.5h14v10H10l-5 4z'],
    opacity: ['M12 4.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15z', '*M12 4.5a7.5 7.5 0 0 1 0 15z'],
    ghost: ['M6 20V11a6 6 0 0 1 12 0v9l-2-1.6-2 1.6-2-1.6-2 1.6-2-1.6z', '*M9.6 11.2a1.1 1.1 0 1 0 0.01 0z', '*M14.4 11.2a1.1 1.1 0 1 0 0.01 0z'],
    pin: ['M9 4.5h6l-1 5.5 3 3H7l3-3z', 'M12 13v6.5'],
    back: ['M9.5 14.5 5 10l4.5-4.5', 'M5 10h9.5a4.75 4.75 0 0 1 0 9.5H12'],
    close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    float: ['M3.5 6.5v11h11', '*M9 4h11.5v8.5H9z'],
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const p = document.createElementNS(NS, 'path');
      const filled = d.startsWith('*');
      p.setAttribute('d', filled ? d.slice(1) : d);
      if (filled) p.setAttribute('class', 'fill');
      svg.append(p);
    }
    return svg;
  }

  function sheet(css) {
    const s = new CSSStyleSheet();
    s.replaceSync(css);
    return s;
  }

  // After Perch updates or reloads, copies already running in open tabs are cut off from the
  // extension ("Extension context invalidated"). Such a copy steps aside quietly: it hides its
  // Float button and stops listening, so the updated copy can take over the tab.
  let retired = false;
  const alive = () => { try { return !!chrome.runtime && !!chrome.runtime.id; } catch { return false; } };
  function retire() {
    if (retired) return;
    retired = true;
    if (pill) pill.host.remove();
    if (window.__perch && window.__perch.owner === token0) delete window.__perch;
  }
  const token0 = {};
  const send = (msg) => {
    if (retired || !alive()) { retire(); return Promise.resolve(null); }
    try {
      return chrome.runtime.sendMessage(msg).catch((e) => {
        if (!alive() || /context invalidated/i.test(String(e && e.message))) retire();
        return null;
      });
    } catch {
      retire();
      return Promise.resolve(null);
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toMain = (cmd) => document.dispatchEvent(new CustomEvent('perch:main', { detail: cmd }));

  // ---------------------------------------------------------------- finding the video
  const up = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);

  let shadowVideos = [];
  let shadowAt = 0;
  function videos(deep) {
    const list = Array.from(document.querySelectorAll('video'));
    if (deep || (list.length === 0 && Date.now() - shadowAt > 4000)) {
      shadowAt = Date.now();
      shadowVideos = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            shadowVideos.push(...el.shadowRoot.querySelectorAll('video'));
            walk(el.shadowRoot);
          }
        }
      };
      try { walk(document); } catch {}
    }
    return list.concat(shadowVideos.filter((v) => v.isConnected));
  }

  function score(v) {
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const hgt = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (w < 160 || hgt < 90) return 0;
    let s = w * hgt;
    if (!v.paused && !v.ended) s *= 4;
    if (v.readyState >= 2) s *= 1.5;
    if (!v.muted && v.volume > 0) s *= 1.5;
    if (v === chosen) s *= 50;
    if (v === hovered && Date.now() - hoveredAt < 15000) s *= 3;
    return s;
  }

  function pick() {
    let video = null;
    let best = 0;
    for (const v of videos(true)) {
      const s = score(v);
      if (s > best) { best = s; video = v; }
    }
    return { video, score: best };
  }

  // Walk up from the video to the largest wrapper that is still the same box: the player.
  function genericPlayer(v) {
    const r = v.getBoundingClientRect();
    let best = v;
    for (let p = up(v); p && p !== document.body && p !== document.documentElement; p = up(p)) {
      const pr = p.getBoundingClientRect();
      if (pr.width <= r.width * 1.15 + 4 && pr.height <= r.height * 1.3 + 4 && pr.width >= r.width - 4) best = p;
      else break;
    }
    return best;
  }
  const findPlayer = (v) => (adapter.player && adapter.player(v)) || genericPlayer(v);

  // ---------------------------------------------------------------- fill mode
  const FILL_CSS = `
    [data-perch-fill],[data-perch-fs]{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;transform:none!important;z-index:2147483646!important;background:#000!important;border:0!important;border-radius:0!important;visibility:visible!important}
    [data-perch-anc]{transform:none!important;filter:none!important;contain:none!important;will-change:auto!important;clip-path:none!important;z-index:2147483646!important;visibility:visible!important}
    video[data-perch-fill]{object-fit:contain!important}`;
  let fillSheet = null;
  const marked = new Set();

  function mark(el, attr) { el.setAttribute(attr, ''); marked.add(el); }

  // Document CSS can't reach inside shadow roots, so give each one on the path our rules.
  function styleShadowPath(el) {
    for (let n = el; n; n = up(n)) {
      const root = n.getRootNode();
      if (root instanceof ShadowRoot && !root.__perch) {
        root.__perch = true;
        fillSheet = fillSheet || sheet(FILL_CSS);
        try { root.adoptedStyleSheets = [...root.adoptedStyleSheets, fillSheet]; } catch {}
      }
    }
  }

  function fillElement(el) {
    mark(el, 'data-perch-fill');
    styleShadowPath(el);
    for (let a = up(el); a && a !== document.documentElement; a = up(a)) mark(a, 'data-perch-anc');
    document.documentElement.setAttribute('data-perch-on', '');
  }

  function enterFill() {
    const v = (chosen && chosen.isConnected && chosen) || pick().video;
    if (!v) return false;
    fillVideo(v);
    state.key = adapter.key ? adapter.key(v) : null;
    watchVideo();
    return true;
  }

  function clearMarks() {
    for (const el of marked) {
      el.removeAttribute('data-perch-fill');
      el.removeAttribute('data-perch-anc');
    }
    marked.clear();
  }

  // Sites can replace the floated <video> (re-render, next item). Find it again and refill;
  // if it's really gone, say so in the float instead of showing the rest of the page.
  let watchTimer = null;
  function watchVideo() {
    clearInterval(watchTimer);
    let lostAt = 0;
    watchTimer = setInterval(() => {
      if (!state.floating) return clearInterval(watchTimer);
      if (state.video && state.video.isConnected) { lostAt = 0; return; }
      let next = null;
      if (adapter.findByKey && state.key) next = adapter.findByKey(state.key);
      else if (!adapter.key) {
        const { video, score: s } = pick();
        if (video && s > 0 && video.getBoundingClientRect().width >= 200) next = video;
      }
      if (next) {
        clearMarks();
        fillVideo(next);
        lostAt = 0;
        return;
      }
      if (!lostAt) lostAt = Date.now();
      else if (Date.now() - lostAt > 2500 && lostAt > 0) {
        lostAt = -1;
        if (TOP) showLost();
      }
    }, 500);
  }

  function showLost() {
    toastMsg('This video left the page. Press Esc or ↩ to go back to the tab.', 0);
  }

  function fillVideo(v) {
    state.video = v;
    v.setAttribute('data-perch-video', '');
    toMain('fake-on');
    fillElement(findPlayer(v));
    if (!TOP) window.parent.postMessage({ __perch: 'fill-me' }, '*');
    // Let the site switch into its own fullscreen layout (bigger subtitles, fullscreen
    // controls). Its requestFullscreen call lands in our page-world patch, not the monitor.
    const btn = adapter.fullscreenButton && document.querySelector(adapter.fullscreenButton);
    if (btn && !document.fullscreenElement) setTimeout(() => btn.click(), 60);
    return true;
  }

  let waiting = false;
  async function waitAndFill() {
    if (waiting) return;
    waiting = true;
    for (let i = 0; i < 90 && state.floating && !state.video; i++) {
      const { video, score: s } = pick();
      const r = video && video.getBoundingClientRect();
      if (video && s > 0 && r.width >= 280) { enterFill(); break; }
      await sleep(700);
    }
    waiting = false;
  }

  function exitFill() {
    clearInterval(watchTimer);
    clearMarks();
    for (const el of document.querySelectorAll('[data-perch-anc],[data-perch-fill],[data-perch-fs]')) {
      el.removeAttribute('data-perch-anc');
      el.removeAttribute('data-perch-fill');
      el.removeAttribute('data-perch-fs');
    }
    document.documentElement.removeAttribute('data-perch-on');
    if (state.video) state.video.removeAttribute('data-perch-video');
    state.video = null;
    state.key = null;
    toMain('fake-off');
    toMain('freeze-off');
  }

  // A child frame (Crunchyroll's player, embeds) asks its parent to give it the whole window.
  window.addEventListener('message', (e) => {
    if (!state.floating || !e.data || e.data.__perch !== 'fill-me') return;
    const el = Array.from(document.querySelectorAll('iframe, frame')).find((f) => f.contentWindow === e.source);
    if (!el) return;
    toMain('fake-on');
    fillElement(el);
    if (!TOP) window.parent.postMessage({ __perch: 'fill-me' }, '*');
  });

  // ---------------------------------------------------------------- title token
  // The helper finds the float's native window by a short token in its title.
  let token = null;
  let tokenTimer = null;
  function setToken(t) {
    token = t;
    const apply = () => {
      if (token && !document.title.includes(token)) document.title = `${token} ${document.title}`;
    };
    apply();
    clearInterval(tokenTimer);
    tokenTimer = setInterval(apply, 150);
    setTimeout(clearToken, 8000);
  }
  function clearToken() {
    clearInterval(tokenTimer);
    if (token && document.title.includes(token)) document.title = document.title.replace(`${token} `, '').replace(token, '');
    token = null;
  }

  // Uses plain timers, not animation frames: while the helper parks the new window off-screen,
  // Chrome treats the page as hidden and pauses animation frames, which would hang this forever.
  async function stableViewport() {
    let last = '';
    for (let i = 0; i < 12; i++) {
      await sleep(40);
      const key = `${innerWidth}x${innerHeight}`;
      if (key === last) break;
      last = key;
    }
    return { iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio };
  }

  // ---------------------------------------------------------------- the float strip
  const STRIP_CSS = `
    :host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;color:#F4F1EA;
      font:500 12px/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--accent:${ACCENT}}
    .bar{position:absolute;left:0;right:0;top:0;height:46px;display:flex;align-items:center;gap:6px;padding:0 8px 0 14px;
      pointer-events:auto;background:linear-gradient(to bottom,rgba(9,10,13,.82),rgba(9,10,13,.45) 60%,rgba(9,10,13,0));
      opacity:0;transition:opacity .14s ease-out}
    .bar.on{opacity:1}
    .grab{flex:1;align-self:stretch;display:flex;align-items:center;gap:9px;min-width:0;cursor:grab;user-select:none}
    .grab:active{cursor:grabbing}
    .dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px rgba(255,181,71,.2)}
    .site{opacity:.78;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.01em}
    .btns{display:flex;gap:1px;flex:none}
    button{all:unset;box-sizing:border-box;height:30px;min-width:30px;display:inline-flex;align-items:center;justify-content:center;gap:5px;
      border-radius:8px;cursor:pointer;color:inherit;padding:0 7px}
    button:hover{background:rgba(255,255,255,.13)}
    button:active{background:rgba(255,255,255,.2)}
    button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    button.on{color:var(--accent)}
    button .num{font-variant-numeric:tabular-nums;font-size:11px;opacity:.9}
    svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
    svg .fill{fill:currentColor;stroke:none}
    .edge{position:absolute;pointer-events:auto}
    .e-l{left:0;top:14px;bottom:14px;width:6px;cursor:ew-resize}
    .e-r{right:0;top:14px;bottom:14px;width:6px;cursor:ew-resize}
    .e-b{bottom:0;left:14px;right:14px;height:6px;cursor:ns-resize}
    .e-t{top:0;left:14px;right:14px;height:4px;cursor:ns-resize}
    .e-tl,.e-tr,.e-bl,.e-br{width:14px;height:14px}
    .e-tl{left:0;top:0;cursor:nwse-resize}.e-br{right:0;bottom:0;cursor:nwse-resize}
    .e-tr{right:0;top:0;cursor:nesw-resize}.e-bl{left:0;bottom:0;cursor:nesw-resize}
    .off .edge{display:none}
    .toast{position:absolute;left:50%;top:54px;transform:translate(-50%,-4px);max-width:calc(100% - 32px);
      background:rgba(14,15,19,.92);border:1px solid rgba(255,255,255,.09);padding:9px 13px;border-radius:999px;
      line-height:1.3;opacity:0;transition:opacity .16s ease-out,transform .16s ease-out;text-align:center}
    .toast.on{opacity:1;transform:translate(-50%,0)}
    kbd{font:inherit;padding:1px 5px;border-radius:5px;background:rgba(255,255,255,.12)}
    @media (prefers-reduced-motion:reduce){.bar,.toast{transition:none}}`;

  let ui = null;

  function button(name, label, cmd, extra) {
    return h('button', { title: label, 'aria-label': label, 'data-cmd': cmd, onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); run(cmd); } }, icon(name), extra);
  }

  function run(cmd, extra = {}) { send({ type: 'perch:cmd', cmd, ...extra }); }

  function buildStrip() {
    removeStrip();
    const host = h('div', { id: 'perch-ui' });
    const root = host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet(STRIP_CSS)];

    const video = state.kind === 'video';
    const chatUrl = video && adapter.chat ? adapter.chat() : null;
    const opacityNum = h('span', { class: 'num' });
    const btns = h('div', { class: 'btns' },
      video && button('fit', 'Fit window to video (double-click the bar)', 'fit'),
      chatUrl && button('chat', 'Float chat beside the video', 'chat'),
      button('opacity', 'Opacity', 'opacity', opacityNum),
      button('ghost', 'Ghost: click through it (Ctrl+Alt+G)', 'ghost'),
      button('pin', 'Keep above other apps', 'pin'),
      video && button('back', 'Back to tab (Esc)', 'back'),
      button('close', video ? 'Close video' : 'Close chat', 'close'));

    const grab = h('div', {
      class: 'grab',
      onpointerdown: (e) => { if (e.button === 0) { e.preventDefault(); run('drag'); } },
      ondblclick: () => video && run('fit'),
    }, h('span', { class: 'dot' }), h('span', { class: 'site', text: video ? HOST : `${HOST} chat` }));

    const bar = h('div', { class: 'bar' }, grab, btns);
    const edges = ['l', 'r', 'b', 't', 'tl', 'tr', 'bl', 'br'].map((edge) => h('div', {
      class: `edge e-${edge}`,
      onpointerdown: (e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); run('resize', { edge }); } },
    }));
    const toast = h('div', { class: 'toast', role: 'status' });
    const wrap = h('div', { class: state.helper ? '' : 'off' }, bar, ...edges, toast);
    root.append(wrap);
    document.documentElement.append(host);
    viewportObserver.observe(host);

    let hideTimer = null;
    const show = (ms) => {
      bar.classList.add('on');
      clearTimeout(hideTimer);
      if (ms) hideTimer = setTimeout(() => bar.classList.remove('on'), ms);
    };
    bar.addEventListener('pointerenter', () => show(0));
    bar.addEventListener('pointerleave', () => show(1300));
    bar.addEventListener('focusin', () => show(0));
    show(2600);

    ui = { host, root, wrap, bar, btns, toast, opacityNum, show, toastTimer: null };
    renderState();
    if (!state.helper) toastMsg('Install the Perch helper to keep floats above other apps', 0);
  }

  function removeStrip() {
    if (ui) { viewportObserver.unobserve(ui.host); ui.host.remove(); }
    ui = null;
  }

  function renderState() {
    if (!ui) return;
    const set = (cmd, on) => ui.btns.querySelector(`[data-cmd="${cmd}"]`)?.classList.toggle('on', on);
    set('ghost', state.ghost);
    set('pin', state.pinned);
    set('chat', state.chat);
    set('opacity', state.opacity < 100);
    ui.opacityNum.textContent = state.opacity < 100 ? `${state.opacity}%` : '';
    ui.wrap.className = state.helper ? '' : 'off';
    for (const cmd of ['opacity', 'ghost', 'pin', 'fit']) {
      const b = ui.btns.querySelector(`[data-cmd="${cmd}"]`);
      if (b) b.hidden = !state.helper;
    }
  }

  function toastMsg(text, ms = 2600) {
    if (!ui) return;
    ui.toast.replaceChildren(...text.split(/(Ctrl\+Alt\+\w+)/).map((part) => (/^Ctrl\+Alt\+/.test(part) ? h('kbd', { text: part }) : part)));
    ui.toast.classList.add('on');
    clearTimeout(ui.toastTimer);
    if (ms) ui.toastTimer = setTimeout(() => ui && ui.toast.classList.remove('on'), ms);
  }

  // Keep the helper's idea of the frame in sync with the page viewport. Watches our own
  // full-window overlay rather than window resize events, which X's layout freeze holds back.
  let calibTimer = null;
  function onViewportChange() {
    if (!TOP || !state.floating || !state.helper) return;
    clearTimeout(calibTimer);
    calibTimer = setTimeout(() => send({ type: 'perch:calib', iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio }), 140);
  }
  const viewportObserver = new ResizeObserver(onViewportChange);

  addEventListener('keydown', (e) => {
    if (!state.floating || state.kind !== 'video' || e.key !== 'Escape') return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.stopPropagation();
    run('back');
  }, true);

  // ---------------------------------------------------------------- the Float pill
  const PILL_CSS = `
    :host{all:initial;position:fixed;z-index:2147483647;pointer-events:none;top:0;left:0}
    button{all:unset;pointer-events:auto;position:fixed;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 13px 0 11px;
      border-radius:999px;cursor:pointer;color:#F4F1EA;background:rgba(14,15,19,.78);
      border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 20px rgba(0,0,0,.35);
      backdrop-filter:blur(12px) saturate(1.3);-webkit-backdrop-filter:blur(12px) saturate(1.3);
      font:600 12.5px/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;letter-spacing:.01em;
      opacity:0;transform:translateY(-3px);transition:opacity .14s ease-out,transform .14s ease-out,background .12s}
    button.on{opacity:1;transform:none}
    button:hover{background:rgba(24,25,30,.92)}
    button:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}
    svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
    svg .fill{fill:${ACCENT};stroke:none}
    @media (prefers-reduced-motion:reduce){button{transition:none}}`;
  let pill = null;
  let pillVideo = null;
  let pillHide = null;
  let moveQueued = false;

  function ensurePill() {
    if (pill) return pill;
    const host = h('div', { id: 'perch-pill' });
    const root = host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet(PILL_CSS)];
    const label = h('span', { text: 'Float' });
    const btn = h('button', {
      title: 'Float this video above every app (Alt+P)',
      onpointerdown: (e) => e.stopPropagation(),
      onmousedown: (e) => e.stopPropagation(),
      onclick: async (e) => {
        e.stopPropagation();
        e.preventDefault();
        chosen = pillVideo;
        label.textContent = 'Floating…';
        const res = await send({ type: 'perch:float' });
        label.textContent = res && res.ok === false ? 'Can’t float this one' : 'Float';
        setTimeout(() => { label.textContent = 'Float'; hidePill(); }, res && res.ok === false ? 1800 : 300);
      },
    }, icon('float'), label);
    root.append(btn);
    btn.addEventListener('pointerenter', () => clearTimeout(pillHide));
    pill = { host, btn };
    return pill;
  }

  function showPill(v) {
    const p = ensurePill();
    if (!p.host.isConnected) document.documentElement.append(p.host);
    const r = v.getBoundingClientRect();
    p.btn.style.top = `${Math.max(8, r.top + 12)}px`;
    p.btn.style.right = `${Math.max(8, innerWidth - r.right + 12)}px`;
    p.btn.classList.add('on');
    pillVideo = v;
    clearTimeout(pillHide);
    pillHide = setTimeout(hidePill, 2200);
  }

  function hidePill() {
    if (pill) pill.btn.classList.remove('on');
  }

  function videoAt(x, y) {
    for (const v of videos(false)) {
      const r = v.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 112 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
    }
    return null;
  }

  document.addEventListener('pointermove', (e) => {
    if (retired) return;
    if (!alive()) { retire(); return; }
    if (moveQueued) return;
    moveQueued = true;
    const { clientX: x, clientY: y } = e;
    requestAnimationFrame(() => {
      moveQueued = false;
      if (state.floating || document.fullscreenElement) return hidePill();
      const v = videoAt(x, y);
      if (v) {
        hovered = v;
        hoveredAt = Date.now();
        showPill(v);
      }
    });
  }, { passive: true, capture: true });
  addEventListener('scroll', hidePill, { passive: true, capture: true });

  // ---------------------------------------------------------------- messages
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.type) {
      case 'perch:token':
        if (TOP && msg.token) setToken(msg.token);
        return false;
      case 'perch:prefloat':
        if (adapter.freezeLayout) toMain('freeze-on');
        return false;
      case 'perch:floating':
        state.floating = msg.on;
        if (msg.on) hidePill();
        return false;
      case 'perch:enter':
        if (!TOP) return false;
        Object.assign(state, { floating: true, kind: msg.kind, helper: msg.helper });
        if (msg.token) setToken(msg.token);
        buildStrip();
        stableViewport().then(reply);
        return true;
      case 'perch:untoken':
        clearToken();
        return false;
      case 'perch:fill':
        state.floating = true;
        reply({ ok: enterFill() });
        return false;
      case 'perch:exit':
        exitFill();
        removeStrip();
        clearToken();
        Object.assign(state, { floating: false, kind: null, ghost: false, opacity: 100, chat: false });
        chosen = null;
        return false;
      case 'perch:state': {
        const wasGhost = state.ghost;
        for (const k of ['ghost', 'opacity', 'pinned', 'chat', 'helper']) if (k in msg) state[k] = msg[k];
        renderState();
        if (TOP && state.ghost && !wasGhost) toastMsg('Ghost on: clicks pass through. Ctrl+Alt+G to grab it back', 3200);
        if (TOP && msg.notice) toastMsg(msg.notice, 3200);
        return false;
      }
      case 'perch:chatUrl':
        if (!TOP) return false;
        reply(adapter.chat ? adapter.chat() : null);
        return false;
      case 'perch:aspect':
        if (!state.video || !state.video.videoWidth) return false;
        reply(state.video.videoWidth / state.video.videoHeight);
        return false;
      case 'perch:playpause':
        if (!state.video) return false;
        if (state.video.paused) state.video.play().catch(() => {});
        else state.video.pause();
        return false;
      default:
        return false;
    }
  });

  window.__perch = {
    owner: token0,
    alive: () => { if (!retired && !alive()) retire(); return !retired; },
    score: () => (window.__perch && !retired && alive() ? pick().score : (retire(), -1)),
  };

  // A floating tab that navigates (next episode, new stream) re-enters fill mode by itself.
  send({ type: 'perch:hello' }).then((res) => {
    if (!res || !res.floating) return;
    Object.assign(state, { floating: true, kind: res.kind, helper: res.helper, ghost: !!res.ghost, opacity: res.opacity || 100, pinned: res.pinned !== false, chat: !!res.chat });
    if (TOP) buildStrip();
    if (res.kind === 'video') waitAndFill();
  });
})();
