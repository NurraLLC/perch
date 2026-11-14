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

  document.addEventListener('perch:main', (event) => {
    if (event.detail === 'fake-on') {
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
