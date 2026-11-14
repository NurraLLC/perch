// Perch, page world. While a tab is floating, the site's own fullscreen button fills the
// float window instead of the monitor, so the site keeps its fullscreen layout, controls
// and subtitles. Off by default; the isolated content script switches it on and off.
(() => {
  if (window.__perchMain) return;
  window.__perchMain = true;

  const EP = Element.prototype;
  const DP = Document.prototype;
  let fake = false;
  let fsEl = null;

  const getter = (name) => Object.getOwnPropertyDescriptor(DP, name)?.get;
  const real = {
    req: EP.requestFullscreen,
    wreq: EP.webkitRequestFullscreen,
    wreq2: EP.webkitRequestFullScreen,
    exit: DP.exitFullscreen,
    wexit: DP.webkitExitFullscreen,
    wcancel: DP.webkitCancelFullScreen,
  };

  const fire = (el) => {
    const target = el && el.isConnected ? el : document;
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
      target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
  };

  const up = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const markAncestors = (el) => {
    for (let a = up(el); a && a !== document.documentElement; a = up(a)) a.setAttribute('data-perch-anc', '');
    document.documentElement.setAttribute('data-perch-on', '');
  };

  const define = (name, value) => {
    const get = getter(name);
    if (!get) return;
    Object.defineProperty(DP, name, {
      configurable: true,
      enumerable: true,
      get() { return fake ? value() : get.call(this); },
    });
  };
  define('fullscreenElement', () => fsEl);
  define('webkitFullscreenElement', () => fsEl);
  define('webkitCurrentFullScreenElement', () => fsEl);
  define('fullscreen', () => !!fsEl);
  define('webkitIsFullScreen', () => !!fsEl);

  const request = (fn) => function (options) {
    if (!fake) return fn ? fn.call(this, options) : undefined;
    if (fsEl !== this) {
      if (fsEl) fsEl.removeAttribute('data-perch-fs');
      fsEl = this;
      if (this !== document.documentElement && this !== document.body) {
        this.setAttribute('data-perch-fs', '');
        markAncestors(this);
      }
      setTimeout(() => fire(this), 0);
    }
    return Promise.resolve();
  };

  const exit = (fn) => function () {
    if (!fake || !fsEl) return fn ? fn.call(this) : undefined;
    const el = fsEl;
    fsEl = null;
    el.removeAttribute('data-perch-fs');
    setTimeout(() => fire(el), 0);
    return Promise.resolve();
  };

  if (real.req) EP.requestFullscreen = request(real.req);
  if (real.wreq) EP.webkitRequestFullscreen = request(real.wreq);
  if (real.wreq2) EP.webkitRequestFullScreen = request(real.wreq2);
  if (real.exit) DP.exitFullscreen = exit(real.exit);
  if (real.wexit) DP.webkitExitFullscreen = exit(real.wexit);
  if (real.wcancel) DP.webkitCancelFullScreen = exit(real.wcancel);

  // Layout freeze (X only). X rebuilds its whole page when the window width crosses a
  // breakpoint, which would throw away the video we just floated. While frozen, the page
  // keeps seeing its original size and never hears about the resize.
  let frozen = null;
  const sizeGetters = {};
  for (const name of ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight']) {
    const d = Object.getOwnPropertyDescriptor(window, name);
    if (!d || !d.get || !d.configurable) continue;
    sizeGetters[name] = d.get;
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: d.enumerable,
      get() { return frozen ? frozen[name] : d.get.call(window); },
      set: d.set ? function (v) { d.set.call(window, v); } : undefined,
    });
  }
  const clientGetters = {};
  for (const name of ['clientWidth', 'clientHeight']) {
    const d = Object.getOwnPropertyDescriptor(EP, name);
    if (!d || !d.get) continue;
    clientGetters[name] = d.get;
    Object.defineProperty(EP, name, {
      configurable: true,
      enumerable: d.enumerable,
      get() { return frozen && this === document.documentElement ? frozen[name] : d.get.call(this); },
    });
  }
  window.addEventListener('resize', (e) => { if (frozen) e.stopImmediatePropagation(); }, true);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', (e) => { if (frozen) e.stopImmediatePropagation(); }, true);

  const freeze = () => {
    if (frozen) return;
    const snap = {};
    for (const [name, get] of Object.entries(sizeGetters)) snap[name] = get.call(window);
    for (const [name, get] of Object.entries(clientGetters)) snap[name] = get.call(document.documentElement);
    frozen = snap;
  };
  const unfreeze = () => {
    if (!frozen) return;
    frozen = null;
    window.dispatchEvent(new Event('resize'));
  };

  document.addEventListener('perch:main', (event) => {
    if (event.detail === 'freeze-on') {
      freeze();
    } else if (event.detail === 'freeze-off') {
      unfreeze();
    } else if (event.detail === 'fake-on') {
      fake = true;
    } else if (event.detail === 'fake-off') {
      if (fsEl) {
        const el = fsEl;
        fsEl = null;
        el.removeAttribute('data-perch-fs');
        fire(el);
      }
      fake = false;
    }
  });
})();
