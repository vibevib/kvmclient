const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, systemPreferences, nativeTheme, webContents } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const pkg = require('./package.json');

// App name from package.json
const APP_NAME = pkg.productName || pkg.name;

// Set app name for macOS menu bar
app.setName(APP_NAME);

// KVM boxes on the LAN usually serve a self-signed certificate, so some leniency
// is needed — but NOT the global `ignore-certificate-errors` switch, which turns
// validation off for every host this app ever talks to, public internet included.
// The `certificate-error` handler at the bottom of this file instead waives errors
// only for a private-network host the user actually configured.
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('disable-features', 'AutoupgradeMixedContent');

// The local pages we ship. Anything else — above all the remote KVM UI — is
// untrusted content: it may not reach privileged IPC, and a session may not be
// navigated to it.
const LOCAL_PAGES = ['connect.html', 'settings.html', 'color.html', 'tabbar.html'];
const LOCAL_PAGE_URLS = new Set(LOCAL_PAGES.map(f => pathToFileURL(path.join(__dirname, f)).href));

// Permissions a KVM session has a legitimate need for: mouse capture, fullscreen
// and clipboard passthrough. Camera, microphone, geolocation, USB/HID/serial,
// notifications and the rest are denied.
const ALLOWED_PERMISSIONS = new Set([
  'fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-read', 'clipboard-sanitized-write'
]);

// Camera and microphone are deliberately NOT in that set. The KVM web UI can use
// them — it passes them to the remote machine as a virtual webcam/headset — but
// the page is served over plain HTTP on the LAN, so anyone who can rewrite it in
// transit could turn them on. They are therefore off until the user says
// otherwise, and even then only for a KVM they configured. See mediaDecision().
const MEDIA_KINDS = { video: 'camera', audio: 'microphone' };

// Default video adjustment: per-channel white-balance gains (r/g/b) + tone + sharpen.
const VIDEO_WB_DEFAULT = { r: 1.10, g: 1.09, b: 1.22, brightness: 1, contrast: 1, saturate: 1, sharpen: 0 };

// The filter VALUE for a parameter set: an inline SVG feComponentTransfer does the
// per-channel white balance (CSS filter functions can't), chained with the CSS
// brightness/contrast/saturate tone controls, plus an optional SVG sharpen
// (feConvolveMatrix — a 3×3 unsharp kernel; strength k, 0 = off).
function wbFilterValue(p) {
  let v = `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><filter id="wb" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="${p.r}"/><feFuncG type="linear" slope="${p.g}"/><feFuncB type="linear" slope="${p.b}"/></feComponentTransfer></filter></svg>#wb') brightness(${p.brightness}) contrast(${p.contrast}) saturate(${p.saturate})`;
  const k = Number(p.sharpen) || 0;
  if (k > 0) {
    const nk = -k, c = 1 + 4 * k;
    v += ` url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><filter id="sh" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" preserveAlpha="true" divisor="1" kernelMatrix="0 ${nk} 0 ${nk} ${c} ${nk} 0 ${nk} 0"/></filter></svg>#sh')`;
  }
  return v;
}

// Identity params (no correction) — the default for a server's own layer.
const WB_IDENTITY = { r: 1, g: 1, b: 1, brightness: 1, contrast: 1, saturate: 1, sharpen: 0 };
const WB_KEYS = ['r', 'g', 'b', 'brightness', 'contrast', 'saturate', 'sharpen'];

// Initialize store with defaults
const store = new Store({
  name: 'config',
  defaults: {
    // Empty on purpose. A placeholder server here would mean "nothing is
    // configured yet" never happens, and that is exactly the state the first-run
    // setup screen exists for.
    servers: [],
    appearance: 'auto',
    cssOverrides: [
      { selector: '.un-collapse-triangle-collapsed', css: 'opacity: 0.01 !important', enabled: true, scope: 'all' },
      { selector: '.kvm-video-info', css: 'display: none !important', enabled: true, scope: 'all' },
      { selector: '.kvm-page', css: 'height: 100% !important', enabled: true, scope: 'all' }
    ],
    // Video adjustment layers, kept out of cssOverrides so Settings (which writes
    // that whole array back) can never clobber them.
    video: { global: { ...VIDEO_WB_DEFAULT }, servers: {} },
    blockedHotkeys: [
      { key: 'w', meta: true, description: 'Close tab', enabled: true },
      { key: 'q', meta: true, description: 'Quit app', enabled: true },
      { key: 't', meta: true, description: 'New tab', enabled: true },
      { key: 'n', meta: true, description: 'New window', enabled: true },
      { key: 'h', meta: true, description: 'Hide app', enabled: true },
      { key: 'm', meta: true, description: 'Minimize', enabled: true },
      { key: 'Tab', meta: true, description: 'App switcher', enabled: true }
    ],
    // Camera/microphone passthrough, off until asked for. One setting each for
    // every session, so granting once covers every tab and window.
    media: {
      camera: false,
      microphone: false
    },
    // Multi-session tabbed window: one window hosting several sessions, switched
    // via an edge-docked button strip (sits over the letterbox bars).
    tabs: {
      // These four are ONE setting each, shared by every tab — not per tab.
      openNewInTabs: true,     // a server opens as a tab here, not in a new window
      showStrip: true,         // the edge strip is visible on session windows
      behavior: 'keep',        // what a tab does in the background: keep | suspend
      position: 'right',       // left | right | top | bottom
      overlay: true,           // true = strip floats over the content (letterbox); false = own area (shrinks video)
      size: 76,                // strip thickness in px
      // Predefined tabs, in the order they appear. `label` is the short name shown
      // on the tab; blank means the tab just shows its position (1, 2, 3…).
      items: []                // [{ id, serverId, label }]
    }
  }
});

// Migrate a legacy single-host config into the servers list.
//
// Only when `servers` is MISSING — not when it is an empty list. This used to
// seed http://192.168.1.100 into any empty list, so a user who deleted their
// last server got a placeholder pointing at a machine that is probably not
// theirs, and first run began with one fictional server instead of a setup
// screen. An empty list is now a real state and is left alone.
(function migrateServers() {
  if (Array.isArray(store.get('servers'))) return;
  const legacyHost = store.get('host');
  store.set('servers', legacyHost ? [{ id: 'default', name: 'Default', host: legacyHost }] : []);
})();

// One-time migration: video params used to live as a generated `#video-wrapper`
// CSS-override row. Move them into their own `video` key and drop those rows.
(function migrateVideoParams() {
  if (store.get('videoMigrated')) return;
  const overrides = store.get('cssOverrides') || [];
  const rows = overrides.filter(o => o.selector === '#video-wrapper');
  if (rows.length) {
    const video = store.get('video') || { global: { ...VIDEO_WB_DEFAULT }, servers: {} };
    video.servers = video.servers || {};
    for (const row of rows) {
      const params = wbParamsFromCss(row.css);
      if ((row.scope || 'all') === 'all') video.global = params;
      else video.servers[row.scope] = params;
    }
    store.set('video', video);
    store.set('cssOverrides', overrides.filter(o => o.selector !== '#video-wrapper'));
  }
  store.set('videoMigrated', true);
})();

// Open windows keyed by a unique instance id — several windows may show the same
// server, each an independent connection/instance.
// Record shape: { id, win, view, cssKey, error, serverId, server }
const windows = new Map();
let nextInstanceId = 1;
let settingsWindow = null;
let colorWindow = null;
let lastActiveInstanceId = null;

// Sessions are records in `windows`; several may share one BrowserWindow. Per-window
// tab state lives on the window as win.__tab:
//   { overlay: WebContentsView|null, show: bool, sessionIds: number[], activeId: number|null }
// overlayOwner maps a strip overlay's webContents id -> its BrowserWindow (for tab IPC).
const overlayOwner = new Map();

// ---- Config helpers ---------------------------------------------------------

// Servers are addressed by id everywhere: tab buttons, per-server CSS scope,
// per-server video layers, session restore. A hand-edited config.json — which
// ARC.md documents as a supported way to add one — can leave the id out, and
// then `s.id === undefined` matches EVERY server: a tab button resolves to the
// wrong host, and Settings shows every dropdown pinned to the last server.
// Backfill on read, the same way tabItems() does for tab buttons.
function getServers() {
  const list = Array.isArray(store.get('servers')) ? store.get('servers') : [];
  const ids = list.map(s => s && s.id);
  const needsFix = ids.some(id => !id) || new Set(ids).size !== ids.length;
  if (!needsFix) return list;

  const seen = new Set();
  const fixed = list.map((raw, i) => {
    const o = (raw && typeof raw === 'object') ? raw : {};
    let id = safeId(o.id, `s${i}`);
    while (seen.has(id)) id += '_';
    seen.add(id);
    return { ...o, id };
  });
  store.set('servers', fixed);
  return fixed;
}

// A falsy id must never match: `find(s => s.id === undefined)` would return the
// first server that happens to lack one.
function getServerById(id) {
  if (!id) return null;
  return getServers().find(s => s.id === id) || null;
}

// Parse all video params out of a #video-wrapper filter CSS string.
function wbParamsFromCss(css) {
  css = css || '';
  const slopes = (css.match(/slope="([0-9.]+)"/g) || []).map(s => parseFloat(s.replace(/[^0-9.]/g, '')));
  const fn = (name) => {
    const m = css.match(new RegExp(name + '\\(([0-9.]+)\\)'));
    return m ? parseFloat(m[1]) : 1;
  };
  // Sharpen strength k from the convolve kernel's centre value (1 + 4k).
  let sharpen = 0;
  const km = css.match(/kernelMatrix="([^"]+)"/);
  if (km) {
    const nums = km[1].trim().split(/\s+/).map(Number);
    if (nums.length >= 5 && isFinite(nums[4])) sharpen = Math.max(0, (nums[4] - 1) / 4);
  }
  return {
    r: slopes[0] != null ? slopes[0] : 1,
    g: slopes[1] != null ? slopes[1] : 1,
    b: slopes[2] != null ? slopes[2] : 1,
    brightness: fn('brightness'),
    contrast: fn('contrast'),
    saturate: fn('saturate'),
    sharpen
  };
}

// Coerce an arbitrary object to a full, finite param set.
function sanitizeWB(params, base) {
  const out = {};
  for (const k of WB_KEYS) {
    const n = Number((params || {})[k]);
    out[k] = Number.isFinite(n) ? n : base[k];
  }
  return out;
}

// The GLOBAL video layer (applies to every server); defaults to the tuned base.
function globalWB() {
  const v = store.get('video') || {};
  return sanitizeWB(v.global, VIDEO_WB_DEFAULT);
}

// A server's OWN video layer (applies only to that server); identity if unset.
function serverWB(serverId) {
  if (!serverId) return { ...WB_IDENTITY };
  const v = store.get('video') || {};
  return sanitizeWB((v.servers || {})[serverId], WB_IDENTITY);
}

// Compose two layers: gains and tone multiply, so a server layer tweaks the global.
function combineWB(a, b) {
  return {
    r: a.r * b.r, g: a.g * b.g, b: a.b * b.b,
    brightness: a.brightness * b.brightness,
    contrast: a.contrast * b.contrast,
    saturate: a.saturate * b.saturate,
    sharpen: (Number(a.sharpen) || 0) + (Number(b.sharpen) || 0) // sharpen adds
  };
}

// Effective params for a server = global layer × that server's own layer.
function effectiveWB(serverId) {
  return combineWB(globalWB(), serverWB(serverId));
}

// Ensure a host string has a scheme (accepts a bare IP like "192.168.1.100") and
// is a real http(s) URL. Anything else — file:, javascript:, data:, garbage —
// yields '' so it is never handed to loadURL().
function normalizeHost(host) {
  const h = (host || '').trim();
  if (!h) return '';
  // Require '://' to count as a scheme, so a bare "kvm.local:8080" is a host
  // and port rather than a "kvm.local:" scheme.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(h) ? h : `http://${h}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch (e) {
    return '';
  }
}

// normalizeHost as a parsed URL, or null.
function parseHostUrl(host) {
  const s = normalizeHost(host);
  if (!s) return null;
  try { return new URL(s); } catch (e) { return null; }
}

// Is this hostname on the local network? Only such a host may have a TLS
// certificate error waived — a KVM appliance's self-signed cert is expected,
// a bad cert from the public internet is an attack.
function isPrivateHostname(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;   // IPv6 unique-local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;   // IPv6 link-local fe80::/10
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return false;
  const [a, b] = o;
  if (a === 10 || a === 127) return true;                 // RFC1918 / loopback
  if (a === 192 && b === 168) return true;                // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;       // RFC1918
  if (a === 169 && b === 254) return true;                // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT
  return false;
}

// Hostnames the user has pointed this app at: every configured server, plus the
// host any live session was last told to load (the connect box can target a host
// that is not saved as a server yet).
function knownHostnames() {
  const out = new Set();
  const add = (host) => {
    const u = parseHostUrl(host);
    if (u) out.add(u.hostname.toLowerCase());
  };
  for (const srv of getServers()) add(srv.host);
  for (const rec of windows.values()) add(rec.lastHost);
  return out;
}

// Is `url` one of the local pages we ship? Used as the trust boundary for IPC and
// for navigation — a prefix test on 'file://' would accept any file on disk.
function isLocalPageUrl(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== 'file:') return false;
  u.search = '';
  u.hash = '';
  return LOCAL_PAGE_URLS.has(u.href);
}

// ---- Config sanitizing ------------------------------------------------------
// Settings writes whole arrays back into the store, and whatever lands there is
// later injected as CSS into the remote page and used as object keys. Coerce it
// to the expected shape so a malformed or hostile payload cannot break out.

// Keys that would mutate Object.prototype if used as an index.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const asStr = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
// Injected as `selector { css }` — a stray brace would let one row escape its own
// rule and restyle (or exfiltrate from) the whole page.
const asCss = (v, max = 2000) => asStr(v, max).replace(/[{}]/g, '');
const safeId = (v, fallback) => {
  const id = asStr(v, 100).replace(/[^\w.-]/g, '');
  return (!id || RESERVED_KEYS.has(id)) ? fallback : id;
};

function sanitizeServers(list) {
  if (!Array.isArray(list)) return getServers();
  const seen = new Set();
  return list.slice(0, 500).map((raw, i) => {
    const o = (raw && typeof raw === 'object') ? raw : {};
    let id = safeId(o.id, `s${i}`);
    while (seen.has(id)) id += '_';
    seen.add(id);
    return { id, name: asStr(o.name, 200), host: asStr(o.host, 500) };
  });
}

function sanitizeOverrides(list) {
  if (!Array.isArray(list)) return store.get('cssOverrides') || [];
  return list.slice(0, 500).map(raw => {
    const o = (raw && typeof raw === 'object') ? raw : {};
    return {
      selector: asCss(o.selector, 500),
      css: asCss(o.css),
      enabled: !!o.enabled,
      scope: safeId(o.scope, 'all') || 'all'
    };
  }).filter(o => o.selector);
}

function sanitizeHotkeys(list) {
  if (!Array.isArray(list)) return store.get('blockedHotkeys') || [];
  return list.slice(0, 200).map(raw => {
    const o = (raw && typeof raw === 'object') ? raw : {};
    return {
      key: asStr(o.key, 20),
      meta: !!o.meta,
      description: asStr(o.description, 200),
      enabled: !!o.enabled
    };
  }).filter(h => h.key);
}

// Light or dark, or whatever macOS is doing. This drives `prefers-color-scheme`
// in every page the app itself serves — Settings, the connect screen, the colour
// panel, the tab strip. It deliberately does NOT reach the remote KVM page: that
// is the device's own UI and not ours to restyle.
function getAppearance() {
  const a = store.get('appearance');
  return a === 'dark' || a === 'light' ? a : 'auto';
}

function applyAppearance() {
  // Electron spells "follow the OS" as 'system'.
  const a = getAppearance();
  nativeTheme.themeSource = a === 'auto' ? 'system' : a;
  broadcastTheme();
}

// 'dark' or 'light' — never 'auto'. The pages want an answer, not a policy.
function resolvedTheme() {
  const a = getAppearance();
  if (a === 'dark' || a === 'light') return a;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// Setting nativeTheme.themeSource is NOT enough on its own. It flips
// shouldUseDarkColors in the main process, but on this Electron/macOS pair
// `prefers-color-scheme` in a renderer stays light regardless — verified on a
// brand-new window with a data: URL, so it is not our pages or our timing. So
// the theme is pushed to the pages instead and they key off [data-theme]; the
// media query is left in their CSS as the correct fallback, not as the mechanism.
function broadcastTheme() {
  const theme = resolvedTheme();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    // Our own pages only. The remote KVM page is the device's UI, not ours.
    let url = '';
    try { url = wc.getURL(); } catch (e) { continue; }
    if (!isLocalPageUrl(url)) continue;
    try { wc.send('theme', theme); } catch (e) { /* going away */ }
  }
}

// Auto has to keep up with macOS, not just with launch.
nativeTheme.on('updated', () => { if (getAppearance() === 'auto') broadcastTheme(); });

// Camera/microphone passthrough. One setting each, shared by every session, so
// granting once covers every tab and window rather than being asked per tab.
function getMediaConfig() {
  const m = store.get('media') || {};
  return { camera: !!m.camera, microphone: !!m.microphone };
}

function sanitizeMedia(cfg) {
  const m = (cfg && typeof cfg === 'object') ? cfg : {};
  return { camera: !!m.camera, microphone: !!m.microphone };
}

function sanitizeTabs(cfg) {
  const t = (cfg && typeof cfg === 'object') ? cfg : {};
  const size = Number(t.size);
  return {
    openNewInTabs: t.openNewInTabs !== false,
    showStrip: t.showStrip !== false,
    behavior: t.behavior === 'suspend' ? 'suspend' : 'keep',
    position: ['left', 'right', 'top', 'bottom'].includes(t.position) ? t.position : 'right',
    overlay: t.overlay !== false,
    size: Number.isFinite(size) ? Math.min(400, Math.max(8, size)) : 76,
    items: (Array.isArray(t.items) ? t.items : []).slice(0, 200).map((raw, i) => {
      const it = (raw && typeof raw === 'object') ? raw : {};
      return {
        id: safeId(it.id, `t${Date.now().toString(36)}-${i}`),
        serverId: safeId(it.serverId, ''),
        // Free text, not an id — it is only ever rendered as a tab's name.
        label: asStr(it.label, 40).trim()
      };
    })
  };
}

// One-time migration: three tab settings used to be per-tab or per-window and are
// now one setting each for every tab.
//   - `behavior` lived on each button; the global value keeps 'suspend' only if
//     every button asked for it, so nobody's tabs start suspending unexpectedly.
//   - `show` lived on each restored window; if any had the strip up, keep it up.
//   - `enabled`/`showButtons` drove nothing and are dropped.
(function migrateTabSettings() {
  if (store.get('tabsSettingsMigrated')) return;
  const t = store.get('tabs') || {};
  const items = Array.isArray(t.items) ? t.items : [];
  const next = { ...t };

  if (next.behavior === undefined) {
    next.behavior = items.length && items.every(i => i && i.behavior === 'suspend')
      ? 'suspend' : 'keep';
  }
  if (next.showStrip === undefined) {
    const opened = store.get('openSessions');
    next.showStrip = Array.isArray(opened) && opened.length
      ? opened.some(e => e && e.show)
      : true;
  }
  if (next.openNewInTabs === undefined) next.openNewInTabs = true;
  delete next.enabled;
  delete next.showButtons;
  next.items = items.map(i => {
    const o = { ...(i || {}) };
    delete o.behavior;
    if (typeof o.label !== 'string') o.label = '';
    return o;
  });

  store.set('tabs', sanitizeTabs(next));
  store.set('tabsSettingsMigrated', true);
})();

// Build the CSS for one server: enabled overrides scoped to "all" or this server.
function buildCSS(serverId) {
  const overrides = store.get('cssOverrides') || [];
  return overrides
    .filter(o => o.enabled && ((o.scope || 'all') === 'all' || o.scope === serverId))
    .map(o => `${o.selector} { ${o.css} }`)
    .join(' ');
}

// Stored hotkeys, read back defensively. One malformed row — a hand-edited
// config.json, or anything written before these were validated — used to throw
// inside isHotkeyBlocked, which aborted createMenu() before it could install the
// menu. The app was then left on Electron's DEFAULT menu: no Connections, no
// Tabs, and a Cmd+Q bound to Quit instead of passing through to the remote.
function getBlockedHotkeys() {
  const raw = store.get('blockedHotkeys');
  return (Array.isArray(raw) ? raw : [])
    .filter(h => h && typeof h.key === 'string' && h.key.length > 0);
}

// Check if a hotkey should be blocked from native handling
function isHotkeyBlocked(input) {
  const want = String((input && input.key) || '').toLowerCase();
  if (!want) return false;
  return getBlockedHotkeys().some(h =>
    h.enabled &&
    h.key.toLowerCase() === want &&
    !!h.meta === !!input.meta
  );
}

// ---- CSS injection ----------------------------------------------------------

// Apply CSS overrides to a single view, replacing any previously injected styles.
// insertCSS() is additive and returns a key; without removing the old key first, a
// disabled/edited/deleted rule would linger until a full page reload.
// Serialized per session: two overlapping calls would both read the same old key,
// both remove it, then both insert — orphaning one stylesheet that can never be
// removed (a disabled rule would stay applied until a full reload).
function applyCSSToView(rec) {
  if (!rec || !rec.view || rec.view.webContents.isDestroyed()) return Promise.resolve();

  const run = async () => {
    if (!rec.view || rec.view.webContents.isDestroyed()) return;
    const wc = rec.view.webContents;

    if (rec.cssKey) {
      try {
        await wc.removeInsertedCSS(rec.cssKey);
      } catch (e) {
        // Key may already be gone (e.g. the page reloaded); ignore.
      }
      rec.cssKey = null;
    }

    const css = buildCSS(rec.serverId);
    if (css && !wc.isDestroyed()) {
      try {
        rec.cssKey = await wc.insertCSS(css);
      } catch (e) {
        // webContents may have navigated away mid-apply; ignore.
      }
    }
  };

  rec.cssQueue = (rec.cssQueue || Promise.resolve()).then(run, run);
  return rec.cssQueue;
}

// Re-apply CSS to every open server window
function applyCSSAll() {
  for (const rec of windows.values()) {
    applyCSSToView(rec);
  }
}

// ---- Connect / error page ---------------------------------------------------

function showConnectPage(rec, error) {
  rec.error = error;
  if (rec.view && !rec.view.webContents.isDestroyed()) {
    rec.view.webContents.loadFile('connect.html');
  }
}

function loadHostInView(rec, host) {
  const url = normalizeHost(host);
  if (url) {
    rec.error = null;
    rec.lastHost = url; // what this session is allowed to navigate within
    rec.view.webContents.loadURL(url);
  } else {
    showConnectPage(rec, 'No host configured');
  }
}

// Resolve the window record that sent an IPC message (used by the connect page,
// which runs inside a server's WebContentsView).
function findRecBySender(event) {
  for (const rec of windows.values()) {
    if (!rec.view.webContents.isDestroyed() && rec.view.webContents === event.sender) {
      return rec;
    }
  }
  return null;
}

// Privileged IPC is only for our own local pages. The remote KVM page shares the
// session view (and therefore preload-remote), so without this check it —
// or anyone MITM-ing it on the LAN — could read every configured host via
// get-config or redirect the session via connect.
function isTrustedSender(event) {
  try {
    return isLocalPageUrl(event.sender.getURL());
  } catch (e) {
    return false;
  }
}

// Where a session view may navigate on its OWN initiative: our local pages,
// about:blank (used to suspend a tab), or the device it is connected to. Without
// this the remote page can redirect the session anywhere — and the site it lands
// on inherits this view's preload and privileges. Scheme and port are not pinned
// because a KVM box legitimately redirects http->https or onto another port.
function sessionAllowsUrl(rec, url) {
  if (!url) return false;
  if (url === 'about:blank' || url.startsWith('about:blank#') || url.startsWith('about:blank?')) return true;
  if (isLocalPageUrl(url)) return true;
  const target = parseHostUrl(url);
  if (!target) return false;
  const current = parseHostUrl(rec.lastHost || (rec.server && rec.server.host) || '');
  return !!current && current.hostname.toLowerCase() === target.hostname.toLowerCase();
}

// The session record that owns this webContents, or null for anything else.
function recForWebContents(wc) {
  for (const rec of windows.values()) {
    if (!rec.view.webContents.isDestroyed() && rec.view.webContents === wc) return rec;
  }
  return null;
}

// May this webContents open the camera or microphone?
//
// Three things all have to hold, and the order matters:
//   1. it is a SESSION view — the settings/colour/tab pages have no business
//      with a camera, and neither does anything else;
//   2. the page asking is the device the session is pinned to, not somewhere it
//      was redirected to;
//   3. the user has turned that device on in Settings.
// `types` is the media kinds Chromium is asking for ('video' and/or 'audio').
function mediaDecision(wc, types) {
  const rec = recForWebContents(wc);
  if (!rec) return false;

  const pinned = parseHostUrl(rec.lastHost || (rec.server && rec.server.host) || '');
  let asking;
  try { asking = new URL(wc.getURL()); } catch (e) { return false; }
  if (!pinned || !asking.hostname) return false;
  if (pinned.hostname.toLowerCase() !== asking.hostname.toLowerCase()) return false;

  const cfg = getMediaConfig();
  const wanted = (Array.isArray(types) && types.length) ? types : ['video', 'audio'];
  return wanted.every(t => {
    const kind = MEDIA_KINDS[t];
    return kind ? cfg[kind] : false;   // anything that is not camera/mic: no
  });
}

// macOS gates camera and microphone at the OS level too, so the app itself has
// to hold the permission before a page inside it can. Asking at the moment the
// user enables the setting puts the system prompt where they expect it.
async function ensureSystemMediaAccess(kinds) {
  if (process.platform !== 'darwin') return true;
  let ok = true;
  for (const kind of kinds) {
    try {
      if (systemPreferences.getMediaAccessStatus(kind) === 'granted') continue;
      const granted = await systemPreferences.askForMediaAccess(kind);
      if (!granted) {
        ok = false;
        console.warn(`[${APP_NAME}] macOS denied ${kind} access to the app`);
      }
    } catch (e) {
      console.warn(`[${APP_NAME}] could not request ${kind} access:`, e.message);
      ok = false;
    }
  }
  return ok;
}

// Refuse renderer-driven navigation off the device, and refuse popups outright.
// (will-navigate does not fire for our own loadURL() calls, so this only
// constrains navigation the page itself starts.)
function guardSessionNavigation(rec) {
  const wc = rec.view.webContents;
  const block = (e, url) => {
    if (sessionAllowsUrl(rec, url)) return;
    e.preventDefault();
    console.warn(`[${APP_NAME}] blocked navigation to ${url}`);
  };
  wc.on('will-navigate', block);
  wc.on('will-redirect', block);
  wc.setWindowOpenHandler(({ url }) => {
    console.warn(`[${APP_NAME}] blocked popup to ${url}`);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

// ---- Windows ----------------------------------------------------------------

// Remember which servers have windows open, so the same set reopens next launch.
// Chooser windows (no serverId) are not sessions and are skipped.
// Remember each open window's active server + whether its tab strip was shown, so
// the same windows reopen next launch.
function persistOpenSessions() {
  const out = [];
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.__tab) continue;
    const active = windows.get(w.__tab.activeId);
    if (active && active.serverId) out.push({ serverId: active.serverId });
  }
  store.set('openSessions', out);
}

// Create one session (a WebContentsView) inside a window and start loading. `server`
// null shows the connect/splash page. Returns the session record (also in `windows`).
function createSession(win, server, itemId) {
  const id = nextInstanceId++;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-remote.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // webSecurity MUST stay on. With it off the remote KVM page — or anyone
      // MITM-ing it over plain HTTP on the LAN, or any site it redirects to —
      // can read arbitrary local files via fetch('file:///…') and read any
      // cross-origin response, then post both anywhere.
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false // keep hidden 'keep' sessions alive
    }
  });
  const rec = {
    id, win, view, cssKey: null, error: null,
    serverId: server ? server.id : null, server: server || null,
    itemId: itemId || null, suspended: false
  };
  windows.set(id, rec);
  guardSessionNavigation(rec);

  view.webContents.on('did-finish-load', () => { rec.cssKey = null; applyCSSToView(rec); applyVideoFilter(rec); });
  view.webContents.on('did-navigate-in-page', () => { applyCSSToView(rec); applyVideoFilter(rec); });
  view.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (code === -3) return;
    // A failing sub-frame (an iframe inside the KVM UI) must not tear down the session
    if (!isMainFrame) return;
    if (url.includes('connect.html') || url.startsWith('about:')) return;
    showConnectPage(rec, `Could not connect to ${url}\n${desc} (${code})`);
    if (win.__tab) pushWinTabsState(win);
  });
  view.webContents.on('did-navigate', (e, url, httpCode) => {
    if (httpCode >= 400) { showConnectPage(rec, `HTTP Error ${httpCode} from ${url}`); if (win.__tab) pushWinTabsState(win); }
  });
  view.webContents.on('before-input-event', (e, input) => {
    // Quit is Cmd+Shift+Q. Plain Cmd+Q belongs to the remote machine, so it is
    // never bound here — the shift is what separates "quit this app" from a key
    // the session is meant to receive.
    if (input.meta && input.shift && input.key.toLowerCase() === 'q') {
      app.isQuitting = true; app.quit(); return;
    }
    if (input.meta && input.key === ',') { e.preventDefault(); openSettings(); return; }
  });

  if (server) loadHostInView(rec, server.host);
  else view.webContents.loadFile('connect.html');
  return rec;
}

// A view's webContents is NOT destroyed when its window closes (it lives
// until the view is garbage collected), so release it explicitly — otherwise the
// remote stream keeps running and holding memory after the window is gone.
function destroyView(view) {
  if (!view) return;
  const wc = view.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    if (typeof wc.destroy === 'function') wc.destroy();
    else if (typeof wc.close === 'function') wc.close();
  } catch (e) { /* already gone */ }
}

function getWinSessions(win) {
  return ((win.__tab && win.__tab.sessionIds) || []).map(id => windows.get(id)).filter(Boolean);
}

// Lay out a window: active session fills its area, others hidden; dock the strip.
function layoutWindow(win) {
  if (!win || win.isDestroyed() || !win.__tab) return;
  const t = win.__tab;
  const { width, height } = win.getContentBounds();
  const cfg = getTabsConfig();
  const size = cfg.size, pos = cfg.position;
  const stripVisible = t.show && !!t.overlay;
  const inset = stripVisible && !cfg.overlay;

  let cb = { x: 0, y: 0, width, height };
  if (inset) {
    if (pos === 'left') cb = { x: size, y: 0, width: width - size, height };
    else if (pos === 'top') cb = { x: 0, y: size, width, height: height - size };
    else if (pos === 'bottom') cb = { x: 0, y: 0, width, height: height - size };
    else cb = { x: 0, y: 0, width: width - size, height };
  }
  // Keep EVERY session view at full (content) size and always rendered. Switching
  // is done purely by stacking order below — never by resizing a hidden view,
  // which was repainting blank/white on the way back.
  for (const s of getWinSessions(win)) {
    if (!s.view || s.view.webContents.isDestroyed()) continue;
    s.view.setBounds(cb);
  }
  if (t.overlay && !t.overlay.webContents.isDestroyed()) {
    t.overlay.setBackgroundColor(cfg.overlay ? '#00000000' : '#FF0B0B0B');
    if (!t.show) t.overlay.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    else if (pos === 'left') t.overlay.setBounds({ x: 0, y: 0, width: size, height });
    else if (pos === 'top') t.overlay.setBounds({ x: 0, y: 0, width, height: size });
    else if (pos === 'bottom') t.overlay.setBounds({ x: 0, y: height - size, width, height: size });
    else t.overlay.setBounds({ x: width - size, y: 0, width: size, height });
  }

  // Restack: active session on top of the others (which stay full-size & painted,
  // just covered), and the strip on top of everything.
  const active = windows.get(t.activeId);
  if (active && active.view && !active.view.webContents.isDestroyed()) {
    win.contentView.addChildView(active.view);
  }
  if (t.overlay && !t.overlay.webContents.isDestroyed()) {
    win.contentView.addChildView(t.overlay);
  }
}

// The tabs of one window, in strip order: every predefined tab first, in the
// order they are configured, then anything else open here. A server opened
// ad-hoc is a real tab too, it just has no saved slot — so it goes after the
// predefined ones rather than shuffling them.
function winTabEntries(win) {
  const items = getTabsConfig().items;
  const sessions = getWinSessions(win);
  const claimed = new Set();

  const entries = items.map(it => {
    // Prefer the session opened FOR this button; otherwise adopt one already
    // showing the same server, so a restored window fills its buttons.
    const s = sessions.find(x => x.itemId === it.id && !claimed.has(x.id))
      || sessions.find(x => !x.itemId && x.serverId === it.serverId && !claimed.has(x.id));
    if (s) {
      claimed.add(s.id);
      // Record the adoption the moment it is rendered, not when the tab is next
      // clicked. The strip has already told the user this session IS that tab,
      // so deleting the row has to be able to find it — otherwise the row goes
      // and the session stays, reappearing as an ad-hoc tab.
      if (!s.itemId) s.itemId = it.id;
    }
    return { item: it, session: s || null, serverId: it.serverId, label: it.label || '' };
  });

  for (const s of sessions) {
    if (claimed.has(s.id)) continue;
    // The splash — a session with no server — is not a tab. It is what the
    // window shows when there are none, so giving it a button would mean closing
    // the last tab left one behind.
    if (!s.serverId) continue;
    entries.push({ item: null, session: s, serverId: s.serverId, label: '' });
  }
  return entries;
}

// Strip state = the tabs above + this window's connection status.
function buildWinTabsState(win) {
  const cfg = getTabsConfig();
  const activeId = win.__tab ? win.__tab.activeId : null;
  const tabs = winTabEntries(win).map((e, i) => {
    const server = getServerById(e.serverId) || (e.session && e.session.server);
    const s = e.session;
    return {
      index: i,
      // The short name if one is set, otherwise just the tab's position.
      label: e.label || String(i + 1),
      title: server ? (server.name || server.host) : (e.serverId || 'Session'),
      active: !!(s && s.id === activeId),
      connected: !!(s && !s.suspended),
      suspended: !!(s && s.suspended)
    };
  });
  return { position: cfg.position, size: cfg.size, overlay: cfg.overlay, tabs };
}

function pushWinTabsState(win) {
  const t = win && win.__tab;
  if (t && t.overlay && !t.overlay.webContents.isDestroyed()) {
    t.overlay.webContents.send('tabs-state', buildWinTabsState(win));
  }
}

// Switch a window to one of its tabs: focus the session if it exists here, else
// create + connect it. Suspends the outgoing session if the shared background
// behavior says to.
function activateEntryInWin(win, entry) {
  if (!win || win.isDestroyed() || !win.__tab || !entry) return;
  const item = entry.item;
  const server = getServerById(entry.serverId)
    || (entry.session && entry.session.server)
    || null;
  // An ad-hoc tab with no saved server can still be focused if it is already
  // open; it just cannot be re-created from nothing.
  if (!server && !entry.session) return;
  const t = win.__tab;
  let sess = entry.session || null;
  // winTabEntries already decided which session belongs to which tab, including
  // adopting a restored item-less one. Make that stick, so the NEXT tab for the
  // same server does not adopt it all over again instead of opening its own.
  if (sess && item && !sess.itemId) sess.itemId = item.id;
  const cur = windows.get(t.activeId);

  if (cur && (!sess || cur.id !== sess.id) && cur.view && !cur.view.webContents.isDestroyed()
      && backgroundBehavior() === 'suspend') {
    cur.suspended = true;
    try { cur.view.webContents.loadURL('about:blank'); } catch (e) {}
  }

  if (!sess) {
    sess = createSession(win, server, item ? item.id : null);
    t.sessionIds.push(sess.id);
    win.contentView.addChildView(sess.view);
  } else if (sess.suspended && server) {
    sess.suspended = false;
    loadHostInView(sess, server.host);
  }

  t.activeId = sess.id;
  lastActiveInstanceId = sess.id;
  layoutWindow(win);
  if (t.overlay) win.contentView.addChildView(t.overlay);
  sess.view.webContents.focus();
  if (server) win.setTitle(`${APP_NAME} — ${server.name || server.host}`);
  pushWinTabsState(win);
  createMenu();
  persistOpenSessions();
  // If the color panel is open, re-sync it to the now-active tab/server.
  if (colorWindow && !colorWindow.isDestroyed()) colorWindow.webContents.send('wb-reload');
}

// ---- Closing a tab ----------------------------------------------------------

// Tear one session down and forget it. Explicit, because a view's webContents
// outlives its window until GC — dropping the reference alone leaves the remote
// stream running. The caller decides what the window shows next.
function closeSession(sess) {
  if (!sess) return;
  const win = sess.win;
  destroyView(sess.view);
  windows.delete(sess.id);
  if (lastActiveInstanceId === sess.id) lastActiveInstanceId = null;
  if (win && !win.isDestroyed() && win.__tab) {
    const t = win.__tab;
    t.sessionIds = t.sessionIds.filter(id => id !== sess.id);
    if (t.activeId === sess.id) t.activeId = null;
  }
}

// A window that has just lost its last tab shows the splash, not a black
// rectangle with no way out.
function ensureWindowHasSession(win) {
  if (!win || win.isDestroyed() || !win.__tab) return;
  const t = win.__tab;
  if (t.activeId && windows.has(t.activeId)) return;
  const live = winTabEntries(win).filter(e => e.session);
  if (live.length) return activateEntryInWin(win, live[0]);

  const splash = createSession(win, null, null);
  t.sessionIds.push(splash.id);
  t.activeId = splash.id;
  win.contentView.addChildView(splash.view);
  lastActiveInstanceId = splash.id;
  layoutWindow(win);
  if (t.overlay) win.contentView.addChildView(t.overlay);
  win.setTitle(APP_NAME);
  pushWinTabsState(win);
  createMenu();
  persistOpenSessions();
}

// A row deleted in Settings takes its session with it.
//
// Without this the session stays open with no row behind it, winTabEntries
// re-adopts it as an ad-hoc tab, and the button the user just deleted is still
// on the strip — so deleting every row removed every row and no buttons.
function closeSessionsForRemovedItems() {
  const live = new Set(getTabsConfig().items.map(i => i.id));
  const touched = new Set();
  for (const rec of [...windows.values()]) {
    if (!rec.itemId || live.has(rec.itemId)) continue;
    if (rec.win && !rec.win.isDestroyed()) touched.add(rec.win);
    closeSession(rec);
  }
  for (const w of touched) ensureWindowHasSession(w);
}

// Close one tab: its saved row AND its session. Both halves are the point —
// leave the row and the button returns on the next render; leave the session and
// it comes back as an ad-hoc tab.
function closeTabInWin(win, index) {
  if (!win || win.isDestroyed() || !win.__tab) return false;
  const entry = winTabEntries(win)[index];
  if (!entry) return false;
  if (entry.session) closeSession(entry.session);
  if (entry.item) {
    const cfg = getTabsConfig();
    store.set('tabs', sanitizeTabs({ ...cfg, items: cfg.items.filter(i => i.id !== entry.item.id) }));
  }
  ensureWindowHasSession(win);
  applyTabsConfigLive();
  createMenu();
  persistOpenSessions();
  return true;
}

// Drop a tab's connection without dropping the tab. This is the same state a
// background tab enters when "suspend" is on, so clicking the tab reconnects it —
// closing is what removes it.
function disconnectTabInWin(win, index) {
  if (!win || win.isDestroyed() || !win.__tab) return false;
  const entry = winTabEntries(win)[index];
  const sess = entry && entry.session;
  if (!sess || sess.suspended || !sess.serverId) return false;
  sess.suspended = true;
  try { sess.view.webContents.loadURL('about:blank'); } catch (e) {}
  pushWinTabsState(win);
  createMenu();
  return true;
}

// The tab the active window is showing, or -1.
function activeTabIndex(win) {
  if (!win || win.isDestroyed() || !win.__tab) return -1;
  const cur = windows.get(win.__tab.activeId);
  if (!cur) return -1;
  return winTabEntries(win).findIndex(e => e.session && e.session.id === cur.id);
}

function disconnectActiveTab() {
  const win = activeTabbedWin();
  const i = activeTabIndex(win);
  if (i >= 0) disconnectTabInWin(win, i);
}

// Close whichever tab the active window is showing.
function closeActiveTab() {
  const win = activeTabbedWin();
  const i = activeTabIndex(win);
  if (i >= 0) closeTabInWin(win, i);
}

// Show/hide the tab strip on a window, live, without recreating the window.
function setStripShown(win, show) {
  if (!win || win.isDestroyed() || !win.__tab) return;
  const t = win.__tab;
  t.show = show;
  if (show && !t.overlay) {
    const overlay = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload-tabbar.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    t.overlay = overlay;
    overlayOwner.set(overlay.webContents.id, win);
    win.contentView.addChildView(overlay);
    overlay.webContents.loadFile('tabbar.html');
    overlay.webContents.once('did-finish-load', () => pushWinTabsState(win));
  }
  layoutWindow(win);
  if (t.overlay) win.contentView.addChildView(t.overlay);
  pushWinTabsState(win);
  persistOpenSessions();
}

// The strip is one setting for the whole app, not a per-window toggle: set it
// once and every session window follows.
function setStripShownGlobally(show) {
  store.set('tabs', sanitizeTabs({ ...getTabsConfig(), showStrip: !!show }));
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.__tab) setStripShown(w, !!show);
  }
  createMenu();
}

// The window to act on for session commands (focused session window, or last active)
function activeTabbedWin() {
  const f = BrowserWindow.getFocusedWindow();
  if (f && f.__tab) return f;
  const s = lastActiveInstanceId ? windows.get(lastActiveInstanceId) : null;
  return s && s.win && s.win.__tab ? s.win : null;
}

function switchWinRelative(delta) {
  const win = activeTabbedWin();
  if (!win) return;
  const entries = winTabEntries(win);
  if (!entries.length) return;
  const cur = windows.get(win.__tab.activeId);
  let idx = cur ? entries.findIndex(e => e.session && e.session.id === cur.id) : -1;
  // Not on a tab yet: step onto the first one going forward, the last going back.
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  idx = (idx + delta + entries.length) % entries.length;
  activateEntryInWin(win, entries[idx]);
}

// Live-apply the shared tabs config (position/size/overlay/buttons) to every open
// window's strip — no window is recreated.
function applyTabsConfigLive() {
  closeSessionsForRemovedItems();
  const show = getTabsConfig().showStrip;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.__tab) continue;
    // Visibility is part of the shared config now, so a settings change pushes
    // it out here rather than each window remembering its own answer.
    if (w.__tab.show !== show) setStripShown(w, show);
    layoutWindow(w);
    if (w.__tab.overlay) { w.contentView.addChildView(w.__tab.overlay); pushWinTabsState(w); }
  }
}

// Open a server the way the shared setting says to: as another tab in the one
// session window, or in a window of its own when tabs are off. A tab opened this
// way has no saved slot, so it lands after the predefined tabs (see
// winTabEntries).
function openServer(server) {
  if (!server) return openServerWindow(null);
  // "Use tabs" means tabs ONLY: one window holds every session. So fall back to
  // any open session window rather than opening a second one — without that,
  // opening a server while Settings had focus quietly made another window.
  const win = getTabsConfig().openNewInTabs
    ? (activeTabbedWin() || BrowserWindow.getAllWindows().find(w => w.__tab && !w.isDestroyed()))
    : null;
  if (win && !win.isDestroyed() && win.__tab) {
    const sess = createSession(win, server, null);
    win.__tab.sessionIds.push(sess.id);
    win.contentView.addChildView(sess.view);
    activateEntryInWin(win, { item: null, session: sess, serverId: server.id, label: '' });
    win.focus();
    return win;
  }
  return openServerWindow(server);
}

// Open a window with a first session for `server` (or the splash if null).
function openServerWindow(server) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: server ? `${APP_NAME} — ${server.name || server.host}` : APP_NAME,
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'assets', 'icons', '512x512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.__tab = { overlay: null, show: false, sessionIds: [], activeId: null };

  const first = createSession(win, server);
  win.__tab.sessionIds.push(first.id);
  win.__tab.activeId = first.id;
  win.contentView.addChildView(first.view);
  lastActiveInstanceId = first.id;

  win.on('resize', () => layoutWindow(win));
  win.on('enter-full-screen', () => layoutWindow(win));
  win.on('leave-full-screen', () => layoutWindow(win));
  win.on('focus', () => {
    if (win.__tab && win.__tab.activeId) lastActiveInstanceId = win.__tab.activeId;
    // Keep the colour panel pointed at the session the user is actually looking at
    if (colorWindow && !colorWindow.isDestroyed()) {
      colorWindow.webContents.send('wb-reload');
      // …and follow that window. The panel adjusts whichever session is active,
      // so while parented to the window it was OPENED from it would sit behind
      // the one it is actually adjusting as soon as a second window came forward.
      if (colorWindow.getParentWindow() !== win) colorWindow.setParentWindow(win);
    }
  });

  win.on('closed', () => {
    // Tear the views down explicitly: a view's webContents outlives its
    // window until GC, so the KVM stream would keep running after close.
    for (const s of getWinSessions(win)) {
      destroyView(s.view);
      windows.delete(s.id);
    }
    if (win.__tab && win.__tab.overlay) {
      overlayOwner.delete(win.__tab.overlay.webContents.id);
      destroyView(win.__tab.overlay);
    }
    win.__tab = null;
    if (!app.isQuitting) persistOpenSessions();
    createMenu();
  });

  layoutWindow(win);
  first.view.webContents.focus();
  persistOpenSessions();
  createMenu();
  return win;
}

// Resolve the active session (the focused window's active tab, else last active).
function getActiveServerRec() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && focused.__tab) {
    const s = windows.get(focused.__tab.activeId);
    if (s) return s;
  }
  if (lastActiveInstanceId) { const s = windows.get(lastActiveInstanceId); if (s) return s; }
  return null;
}

// Reload the active server window
function reloadActiveSession() {
  const rec = getActiveServerRec();
  if (!rec) return;
  // The splash session (and one connected via the manual host box) has no server
  const latest = rec.serverId ? getServerById(rec.serverId) : null;
  const host = latest ? latest.host : (rec.server ? rec.server.host : null);
  if (host) {
    loadHostInView(rec, host);
  } else if (rec.view && !rec.view.webContents.isDestroyed()) {
    rec.view.webContents.reload();
  }
}

// Toggle DevTools for whatever is in front. A server window shows the remote
// session in a WebContentsView, so devtools must target the view's webContents — the
// window's own webContents is empty, which is why role:'toggleDevTools' did nothing.
function toggleDevToolsForActive() {
  const focused = BrowserWindow.getFocusedWindow();
  // Session window: devtools for the active session's content view
  if (focused && focused.__tab) {
    const s = windows.get(focused.__tab.activeId);
    if (s && s.view && !s.view.webContents.isDestroyed()) { s.view.webContents.toggleDevTools(); return; }
  }
  // Settings/other window: toggle its own devtools
  if (focused && !focused.webContents.isDestroyed()) {
    focused.webContents.toggleDevTools();
    return;
  }
  // Nothing focused: fall back to the last active session view
  const fallback = getActiveServerRec();
  if (fallback && fallback.view && !fallback.view.webContents.isDestroyed()) {
    fallback.view.webContents.toggleDevTools();
  }
}

// ---- Settings window --------------------------------------------------------

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    // Content size, not frame size — the title bar used to eat 32px of this and
    // push the Save button below the fold. Tall enough for the Tabs pane, which
    // is the tallest of the four.
    useContentSize: true,
    width: 780,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: `${APP_NAME} Settings`,
    // Deliberately parentless. This used to be getFocusedWindow(), which made
    // Settings a CHILD of whatever was in front — including the colour panel.
    // Closing that panel then destroyed the Settings window along with any
    // unsaved edits. Settings is a singleton editing global config; it belongs
    // to no single window.
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ---- Video color (white-balance) panel --------------------------------------

// Apply a filter VALUE to the real video element(s) via CSSOM — the known wrappers
// plus the largest media element (video/canvas/img), across same-origin iframes.
// This finds the stream whatever its markup, so slider moves always hit the video.
// !important beats any page style; an empty value removes the inline filter.
function videoFilterScript(value) {
  return `(function(){
    var v=${JSON.stringify(value || '')};
    function docs(){var d=[document];try{document.querySelectorAll('iframe').forEach(function(f){try{if(f.contentDocument)d.push(f.contentDocument);}catch(e){}});}catch(e){}return d;}
    var set=new Set();
    docs().forEach(function(doc){try{
      doc.querySelectorAll('#video-wrapper,#stream-canvas,video,canvas').forEach(function(e){set.add(e);});
      var best=null,area=0;
      doc.querySelectorAll('video,canvas,img').forEach(function(e){var r=e.getBoundingClientRect();var a=r.width*r.height;if(a>area){area=a;best=e;}});
      if(best)set.add(best);
    }catch(e){}});
    // Drop any element contained by another match: filtering a wrapper AND the
    // canvas inside it would apply the correction twice (compounded).
    var arr=Array.from(set);
    var outer=arr.filter(function(e){return !arr.some(function(o){return o!==e&&o.contains&&o.contains(e);});});
    outer.forEach(function(e){ if(v){e.style.setProperty('filter',v,'important');}else{e.style.removeProperty('filter');} });
    return outer.length;
  })();`;
}

// Apply the SAVED video adjustment for a window (its base look).
function applyVideoFilter(rec) {
  if (!rec || !rec.view || rec.view.webContents.isDestroyed()) return;
  rec.view.webContents.executeJavaScript(videoFilterScript(wbFilterValue(effectiveWB(rec.serverId)))).catch(() => {});
}

function applyVideoFilterAll() {
  for (const rec of windows.values()) applyVideoFilter(rec);
}

// Live-preview a filter VALUE on one window (from the color panel).
function previewVideoFilter(rec, value) {
  if (!rec || !rec.view || rec.view.webContents.isDestroyed()) return;
  rec.view.webContents.executeJavaScript(videoFilterScript(value)).catch(() => {});
}

function openColorAdjust() {
  // Only used to position the panel; the panel itself always targets whichever
  // session is active at the time of each IPC call.
  const target = getActiveServerRec();

  if (colorWindow && !colorWindow.isDestroyed()) {
    colorWindow.show();
    colorWindow.focus();
    return;
  }

  colorWindow = new BrowserWindow({
    width: 430,
    height: 720,
    title: 'Video Color',
    show: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    // A child of the session window: macOS keeps a child above its parent — including
    // when the parent is full-screen — and, unlike always-on-top, it sinks with the
    // app when you switch to another application.
    parent: target && !target.win.isDestroyed() ? target.win : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // This used to be setAlwaysOnTop(true, 'screen-saver') plus
  // setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }), to get the panel
  // above a full-screened session. The side effect was that the panel floated above
  // every OTHER application too and followed you onto their Spaces: you would see a
  // KVM panel sitting on top, assume KVM was active, and find the menu bar still
  // belonged to whatever app was actually in front. Parenting the window (above)
  // gets it over the session without hijacking the rest of the desktop.

  // Place it over the target window's top-right corner so it's obvious
  if (target && !target.win.isDestroyed()) {
    const b = target.win.getBounds();
    colorWindow.setPosition(Math.round(b.x + b.width - 454), Math.round(b.y + 48));
  }

  colorWindow.loadFile('color.html');
  colorWindow.once('ready-to-show', () => {
    colorWindow.show();
    colorWindow.focus();
  });
  colorWindow.on('closed', () => {
    colorWindow = null;
    // Drop any un-saved live preview so every video reverts to its saved look
    applyVideoFilterAll();
  });
}

// ---- White point ------------------------------------------------------------

// The slider ranges the colour panel offers. A computed correction is pinned to
// these so the result is always something the user can see and then nudge.
const WB_LIMITS = {
  r: [0.5, 1.5], g: [0.5, 1.5], b: [0.5, 1.5],
  brightness: [0.5, 1.5], contrast: [0.5, 1.5], saturate: [0, 2], sharpen: [0, 1.5]
};

function clampWB(params) {
  const out = {};
  let clamped = false;
  for (const k of WB_KEYS) {
    const [lo, hi] = WB_LIMITS[k];
    const n = Number(params[k]);
    const v = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : WB_IDENTITY[k];
    if (Number.isFinite(n) && v !== n) clamped = true;
    out[k] = v;
  }
  return { params: out, clamped };
}

// Sample the stream's RAW pixels — what the KVM sent, before our correction.
// Working from the raw image is what keeps the maths honest: if a patch that
// ought to be white reads (r,g,b), the gains that neutralise it are k/r, k/g,
// k/b, with no need to unpick whatever filter is already on the element.
//
//   auto  — scan the frame for the block that most looks like it should be white
//   point — average a box around one viewport coordinate the user clicked
function sampleWhiteScript(opts) {
  const o = JSON.stringify(Object.assign({ mode: 'auto', x: 0, y: 0, size: 5 }, opts || {}));
  return `(function(){
    var O = ${o};
    function docs(){var d=[document];try{document.querySelectorAll('iframe').forEach(function(f){
      try{if(f.contentDocument)d.push(f.contentDocument);}catch(e){}});}catch(e){}return d;}

    // The stream is the largest media element. A wrapper div has no pixels of
    // its own, so it cannot be sampled.
    var best=null, area=0;
    docs().forEach(function(d){try{
      d.querySelectorAll('video,canvas,img').forEach(function(e){
        var r=e.getBoundingClientRect(); var a=r.width*r.height;
        if(a>area){area=a;best=e;}
      });
    }catch(e){}});
    if(!best) return JSON.stringify({ok:false,reason:'no video element on this page'});

    var rect=best.getBoundingClientRect();
    var nw=best.videoWidth||best.naturalWidth||best.width||Math.round(rect.width);
    var nh=best.videoHeight||best.naturalHeight||best.height||Math.round(rect.height);
    if(!(nw>0&&nh>0&&rect.width>2&&rect.height>2))
      return JSON.stringify({ok:false,reason:'the video has no size yet'});

    // Where the source actually lands inside the element's box. object-fit
    // letterboxes it, and a click has to map through that or it lands elsewhere.
    function contentBox(){
      var fit='fill';
      try{fit=getComputedStyle(best).objectFit||'fill';}catch(e){}
      var sx=rect.width/nw, sy=rect.height/nh, s;
      if(fit==='contain'){s=Math.min(sx,sy);}
      else if(fit==='cover'){s=Math.max(sx,sy);}
      else if(fit==='none'){s=1;}
      else if(fit==='scale-down'){s=Math.min(1,Math.min(sx,sy));}
      else {return {ox:0,oy:0,ow:rect.width,oh:rect.height};}
      var ow=nw*s, oh=nh*s;
      return {ox:(rect.width-ow)/2, oy:(rect.height-oh)/2, ow:ow, oh:oh};
    }

    function avgBox(sx,sy,sw,sh){
      sw=Math.max(1,Math.round(sw)); sh=Math.max(1,Math.round(sh));
      sx=Math.max(0,Math.min(nw-sw,Math.round(sx)));
      sy=Math.max(0,Math.min(nh-sh,Math.round(sy)));
      var c=document.createElement('canvas'); c.width=sw; c.height=sh;
      var x=c.getContext('2d',{willReadFrequently:true});
      x.drawImage(best,sx,sy,sw,sh,0,0,sw,sh);
      var d=x.getImageData(0,0,sw,sh).data;
      var r=0,g=0,b=0,n=0,clip=0;
      for(var i=0;i<d.length;i+=4){
        r+=d[i];g+=d[i+1];b+=d[i+2];n++;
        if(d[i]>=250||d[i+1]>=250||d[i+2]>=250)clip++;
      }
      return {r:r/n,g:g/n,b:b/n,px:n,clipped:clip/n};
    }

    try {
      if(O.mode==='point'){
        var cb=contentBox();
        var px=(O.x-rect.left-cb.ox)/cb.ow*nw;
        var py=(O.y-rect.top -cb.oy)/cb.oh*nh;
        if(!(px>=0&&py>=0&&px<nw&&py<nh))
          return JSON.stringify({ok:false,reason:'that point is outside the video'});
        var sz=Math.max(1,O.size|0);
        var a=avgBox(px-sz/2,py-sz/2,sz,sz);
        a.ok=true; a.mode='point'; a.sourceX=Math.round(px); a.sourceY=Math.round(py);
        return JSON.stringify(a);
      }

      // auto: scan a downscaled copy for the block that most looks like white.
      var cap=320, sc=Math.min(1,cap/Math.max(nw,nh));
      var w=Math.max(8,Math.round(nw*sc)), h=Math.max(8,Math.round(nh*sc));
      var c=document.createElement('canvas'); c.width=w; c.height=h;
      var x=c.getContext('2d',{willReadFrequently:true});
      x.drawImage(best,0,0,w,h);
      var d=x.getImageData(0,0,w,h).data;
      // Two candidates, because a clipped block is worth less but is not
      // worthless. A screen that is too blue very often HAS blue pegged at 255
      // in its white areas — refusing those outright would fail on exactly the
      // picture the feature exists for. So: prefer a block that is not blown
      // out, and fall back to the best blown-out one, flagged, if there is none.
      var B=4, clean={score:-1,col:null}, any={score:-1,col:null};
      for(var yy=0; yy+B<=h; yy+=B){
        for(var xx=0; xx+B<=w; xx+=B){
          var r=0,g=0,bl=0,n=0,clip=0;
          for(var j=0;j<B;j++)for(var i2=0;i2<B;i2++){
            var k=((yy+j)*w+(xx+i2))*4;
            r+=d[k];g+=d[k+1];bl+=d[k+2];n++;
            if(d[k]>=250||d[k+1]>=250||d[k+2]>=250)clip++;
          }
          r/=n;g/=n;bl/=n;
          var mx=Math.max(r,g,bl), mn=Math.min(r,g,bl);
          if(mx<40) continue;                        // too dark to tell anything
          var sat=mx>0?(mx-mn)/mx:1;
          var score=(mx/255)*Math.pow(1-sat,2);      // bright AND close to neutral
          var cand={score:score,x:xx,y:yy,col:{r:r,g:g,b:bl}};
          if(score>any.score) any=cand;
          if(clip/n<=0.25 && score>clean.score) clean=cand;
        }
      }
      // Prefer a measurable block, but not at any cost. The dim, barely-lit
      // block that happens to be unclipped (antialiased text on a dark
      // background, say) is a far worse white reference than a bright
      // clipped one. Only take it if it is in the same league.
      var pick = (clean.col && clean.score >= any.score * 0.6) ? clean : any;
      if(!pick.col) return JSON.stringify({ok:false,reason:'no usable light area on screen'});
      // Re-read that block at full resolution — the WHOLE block, not a 5x5
      // crop of it. A 4px block of a downscale covers many source pixels,
      // and a crop at its centre can easily land between the strokes of
      // whatever made the block bright and report the background instead.
      var bw=Math.max(O.size, Math.round(B*nw/w)), bh=Math.max(O.size, Math.round(B*nh/h));
      var fx=(pick.x+B/2)/w*nw, fy=(pick.y+B/2)/h*nh;
      var a2=avgBox(fx-bw/2, fy-bh/2, bw, bh);
      a2.ok=true; a2.mode='auto'; a2.sourceX=Math.round(fx); a2.sourceY=Math.round(fy);
      return JSON.stringify(a2);
    } catch(e) {
      // A cross-origin or protected frame taints the canvas and getImageData throws.
      return JSON.stringify({ok:false,reason:'could not read the video pixels ('+e.name+')'});
    }
  })();`;
}

// A crosshair over the session, resolving with the point the user clicked.
// Injected into the remote page because that page is the only place that knows
// where its own video actually is on screen.
function pickOverlayScript() {
  return `(function(){
    return new Promise(function(resolve){
      var old=document.getElementById('__lekvm_pick'); if(old) old.remove();
      var host=document.createElement('div');
      host.id='__lekvm_pick';
      host.setAttribute('style','position:fixed;inset:0;z-index:2147483647;cursor:crosshair');
      var tip=document.createElement('div');
      tip.setAttribute('style','position:fixed;left:50%;top:18px;transform:translateX(-50%);'
        +'font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;'
        +'background:rgba(18,18,18,0.92);padding:8px 14px;border-radius:8px;'
        +'pointer-events:none;box-shadow:0 2px 14px rgba(0,0,0,0.5)');
      tip.textContent='Click something that should be white   ·   Esc to cancel';
      var ring=document.createElement('div');
      ring.setAttribute('style','position:fixed;width:19px;height:19px;margin:-10px 0 0 -10px;'
        +'border:1px solid #fff;pointer-events:none;display:none;'
        +'box-shadow:0 0 0 1px rgba(0,0,0,0.7),inset 0 0 0 1px rgba(0,0,0,0.7)');
      host.appendChild(tip); host.appendChild(ring);

      var timer=null;
      function done(v){
        if(timer) clearTimeout(timer);
        try{host.remove();}catch(e){}
        window.removeEventListener('keydown',onKey,true);
        resolve(JSON.stringify(v));
      }
      function onKey(e){ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); done({cancelled:true}); } }
      host.addEventListener('mousemove',function(e){
        ring.style.display='block'; ring.style.left=e.clientX+'px'; ring.style.top=e.clientY+'px';
      });
      host.addEventListener('click',function(e){
        e.preventDefault(); e.stopPropagation(); done({x:e.clientX,y:e.clientY});
      },true);
      host.addEventListener('contextmenu',function(e){ e.preventDefault(); done({cancelled:true}); });
      window.addEventListener('keydown',onKey,true);
      (document.body||document.documentElement).appendChild(host);
      // Never leave the caller waiting forever if the session is switched away.
      timer=setTimeout(function(){ done({cancelled:true,timedOut:true}); }, 60000);
    });
  })();`;
}

// The gains that neutralise a sampled colour, keeping overall brightness put.
function gainsForSample(sample) {
  const r = Math.max(1, Number(sample.r) || 0);
  const g = Math.max(1, Number(sample.g) || 0);
  const b = Math.max(1, Number(sample.b) || 0);
  const k = (r + g + b) / 3;
  return { r: k / r, g: k / g, b: k / b };
}

// Write one layer of the video config and re-apply it everywhere.
function persistWB(scopeKey, params) {
  const base = scopeKey === 'all' ? VIDEO_WB_DEFAULT : WB_IDENTITY;
  const p = sanitizeWB(params, base);
  const video = store.get('video') || { global: { ...VIDEO_WB_DEFAULT }, servers: {} };
  video.servers = video.servers || {};
  if (scopeKey === 'all') {
    video.global = p;
  } else if (WB_KEYS.every(k => p[k] === WB_IDENTITY[k])) {
    delete video.servers[scopeKey];
  } else {
    video.servers[scopeKey] = p;
  }
  store.set('video', video);
  applyVideoFilterAll();
  return p;
}

// The last white-point application, so it can be taken back in one step.
let lastWhitePoint = null;

// Turn a sample into a correction and store it.
//
// The two layers multiply, so whichever one is being written has to be solved
// for rather than simply set: the EFFECTIVE gains are what must come out equal
// to the target.
function applyWhitePoint(rec, sample, scope) {
  const target = gainsForSample(sample);
  const useServer = scope !== 'global' && !!rec.serverId;
  const scopeKey = useServer ? rec.serverId : 'all';
  const other = useServer ? globalWB() : serverWB(rec.serverId);
  const before = useServer ? serverWB(rec.serverId) : globalWB();

  const wanted = {
    ...before,
    r: target.r / (other.r || 1),
    g: target.g / (other.g || 1),
    b: target.b / (other.b || 1)
  };
  const { params, clamped } = clampWB(wanted);
  const saved = persistWB(scopeKey, params);

  lastWhitePoint = { scopeKey, before: { ...before } };
  createMenu();   // the Undo item is enabled off this
  return {
    ok: true,
    scope: useServer ? 'server' : 'global',
    scopeName: useServer ? (rec.server && (rec.server.name || rec.server.host)) : 'Global',
    sample: { r: Math.round(sample.r), g: Math.round(sample.g), b: Math.round(sample.b) },
    gains: { r: saved.r, g: saved.g, b: saved.b },
    clipped: sample.clipped > 0.25,
    clamped,
    mode: sample.mode
  };
}

// Put back whatever the last white-point application replaced.
function undoWhitePoint() {
  if (!lastWhitePoint) return { ok: false, reason: 'nothing to undo' };
  persistWB(lastWhitePoint.scopeKey, lastWhitePoint.before);
  lastWhitePoint = null;
  createMenu();
  return { ok: true };
}

// Sample the session in front and correct its white balance. `mode` is 'auto'
// (find the whitest-looking area) or 'point' (let the user click one).
async function whiteBalance(mode, scope) {
  const rec = getActiveServerRec();
  if (!rec || !rec.view || rec.view.webContents.isDestroyed()) {
    return { ok: false, reason: 'no session in front' };
  }
  const wc = rec.view.webContents;

  let opts = { mode: 'auto', size: 5 };
  if (mode === 'point') {
    // The panel usually has focus when this is started. Bring the session
    // forward first, or the user's first click is spent focusing the window.
    if (rec.win && !rec.win.isDestroyed()) { rec.win.focus(); wc.focus(); }
    let picked;
    try {
      picked = JSON.parse(await wc.executeJavaScript(pickOverlayScript(), true));
    } catch (e) {
      return { ok: false, reason: 'could not open the picker' };
    }
    if (!picked || picked.cancelled) return { ok: false, cancelled: true };
    opts = { mode: 'point', x: picked.x, y: picked.y, size: 5 };
  }

  let sample;
  try {
    sample = JSON.parse(await wc.executeJavaScript(sampleWhiteScript(opts), true));
  } catch (e) {
    return { ok: false, reason: 'could not sample the video' };
  }
  if (!sample || !sample.ok) return { ok: false, reason: (sample && sample.reason) || 'sampling failed' };

  const result = applyWhitePoint(rec, sample, scope);
  // The panel shows these numbers, so pull it back into step.
  if (colorWindow && !colorWindow.isDestroyed()) colorWindow.webContents.send('wb-reload');
  return result;
}

// ---- Tabbed (multi-session) window ------------------------------------------

function getTabsConfig() {
  const t = store.get('tabs') || {};
  return {
    openNewInTabs: t.openNewInTabs !== false,
    showStrip: t.showStrip !== false,
    behavior: t.behavior === 'suspend' ? 'suspend' : 'keep',
    position: ['left', 'right', 'top', 'bottom'].includes(t.position) ? t.position : 'right',
    overlay: t.overlay !== false,
    size: Number(t.size) > 0 ? Number(t.size) : 76,
    items: tabItems(t)
  };
}

// Write one field of the shared tabs config and apply it everywhere at once.
function setTabsConfig(patch) {
  store.set('tabs', sanitizeTabs({ ...getTabsConfig(), ...patch }));
  applyTabsConfigLive();
  createMenu();
}

let tabItemSeq = 0;
// Sessions are keyed by BUTTON id (not serverId) so two buttons for the same
// server stay independent. Backfill ids for configs written before they existed.
function tabItems(t) {
  let items = Array.isArray(t.items) ? t.items : [];
  if (items.some(it => !it || !it.id)) {
    items = items.map((it, i) => (it && it.id)
      ? it
      : { ...(it || {}), id: `t${Date.now().toString(36)}-${i}-${tabItemSeq++}` });
    items = items.map(it => ({ ...it, label: typeof it.label === 'string' ? it.label : '' }));
    store.set('tabs', { ...t, items });
  }
  return items;
}

// What a tab does once it is in the background. One setting for every tab, read
// live so changing it in Settings affects sessions that are already open.
function backgroundBehavior() {
  return getTabsConfig().behavior === 'suspend' ? 'suspend' : 'keep';
}

// Don't claim an accelerator the user asked to pass through to the remote session.
function accelUnlessBlocked(accelerator, key) {
  return isHotkeyBlocked({ key, meta: true }) ? undefined : accelerator;
}


// ---- Application menu -------------------------------------------------------

// The essentials, used only if building the real menu ever throws. It must stay
// trivially safe to build — and must NOT bind Cmd+Q, which belongs to the remote
// machine; quitting is Cmd+Shift+Q here, as in the real menu.
function fallbackMenuTemplate() {
  return [
    {
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        { label: 'Settings...', accelerator: 'Cmd+,', click: () => openSettings() },
        { type: 'separator' },
        {
          label: `Quit ${APP_NAME}`,
          accelerator: 'Cmd+Shift+Q',
          click: () => { app.isQuitting = true; app.quit(); }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    }
  ];
}

// Build and install the application menu. createMenu runs on every window focus,
// so a throw in here does not just fail once — it leaves the app on Electron's
// default menu for the rest of the session.
function createMenu() {
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  } catch (e) {
    console.error(`[${APP_NAME}] could not build the application menu:`, e);
    try {
      Menu.setApplicationMenu(Menu.buildFromTemplate(fallbackMenuTemplate()));
    } catch (e2) {
      console.error(`[${APP_NAME}] fallback menu failed too:`, e2);
    }
  }
}

function buildMenuTemplate() {
  const servers = getServers();

  const connectionsSubmenu = servers.length
    ? servers.map(s => ({
        label: s.name || s.host,
        // A tab on the current window, or a new window — "Open Servers in Tabs".
        click: () => openServer(s)
      }))
    : [{ label: 'No servers configured', enabled: false }];

  connectionsSubmenu.push(
    { type: 'separator' },
    { label: 'Manage Servers…', click: () => openSettings() }
  );

  // Tabs are a trait of the focused window: show/hide the strip, switch between
  // the preset session buttons — all in that window.
  // The session window the menu acts on. Deliberately NOT getFocusedWindow():
  // the colour panel and Settings are windows with no sessions, so focusing one
  // used to disable the whole Tabs menu and drop every per-session entry until a
  // session window was clicked again. activeTabbedWin() falls back to the last
  // active session, which is the window these menu items should still target.
  const focusedWin = activeTabbedWin();
  const winTab = focusedWin && focusedWin.__tab;
  const tabsCfg = getTabsConfig();
  const entries = focusedWin ? winTabEntries(focusedWin) : [];
  const tabsSubmenu = [
    // One setting for every window, so this is not a per-window checkbox any more.
    { label: 'Show Tab Strip', type: 'checkbox', checked: tabsCfg.showStrip,
      click: () => setStripShownGlobally(!tabsCfg.showStrip) },
    { label: 'Open Servers in Tabs', type: 'checkbox', checked: tabsCfg.openNewInTabs,
      click: () => setTabsConfig({ openNewInTabs: !tabsCfg.openNewInTabs }) },
    { label: 'Suspend Background Tabs', type: 'checkbox', checked: tabsCfg.behavior === 'suspend',
      click: () => setTabsConfig({ behavior: tabsCfg.behavior === 'suspend' ? 'keep' : 'suspend' }) },
    { type: 'separator' },
    { label: 'Next Session', accelerator: 'Ctrl+Tab', enabled: entries.length > 1, click: () => switchWinRelative(1) },
    { label: 'Previous Session', accelerator: 'Ctrl+Shift+Tab', enabled: entries.length > 1, click: () => switchWinRelative(-1) },
    { type: 'separator' },
    // Disconnect keeps the tab and drops the stream; close removes the tab.
    { label: 'Disconnect Tab', enabled: activeTabIndex(focusedWin) >= 0,
      click: () => disconnectActiveTab() },
    // Cmd+W only if the user has not asked for it to reach the remote machine.
    { label: 'Close Tab', accelerator: accelUnlessBlocked('Cmd+W', 'w'),
      enabled: entries.length > 0, click: () => closeActiveTab() }
  ];
  if (winTab && entries.length) {
    tabsSubmenu.push({ type: 'separator' });
    entries.forEach((e, i) => {
      const server = getServerById(e.serverId) || (e.session && e.session.server);
      const name = server ? (server.name || server.host) : (e.serverId || 'Session');
      tabsSubmenu.push({
        // Short name first when there is one, so the menu reads like the strip.
        label: e.label ? `${e.label} — ${name}` : `${i + 1}. ${name}`,
        type: 'checkbox',
        checked: !!(e.session && e.session.id === winTab.activeId),
        click: () => activateEntryInWin(focusedWin, e)
      });
    });
  }
  tabsSubmenu.push(
    { type: 'separator' },
    { label: 'Configure Tabs…', click: () => openSettings() }
  );

  const template = [
    {
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'Cmd+,',
          click: () => openSettings()
        },
        { type: 'separator' },
        {
          label: `Quit ${APP_NAME}`,
          accelerator: 'Cmd+Shift+Q',
          click: () => {
            app.isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Connections',
      submenu: connectionsSubmenu
    },
    {
      label: 'Tabs',
      submenu: tabsSubmenu
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Session',
          accelerator: accelUnlessBlocked('Cmd+R', 'r'),
          click: () => reloadActiveSession()
        },
        {
          label: 'Adjust Video Color…',
          accelerator: 'Alt+Cmd+C',
          click: () => openColorAdjust()
        },
        {
          // Alt+Cmd+W, not Cmd+W — the plain chord belongs to the remote machine.
          label: 'Auto White Balance',
          accelerator: 'Alt+Cmd+W',
          click: () => whiteBalance('auto')
        },
        {
          label: 'Pick White Point…',
          accelerator: 'Shift+Alt+Cmd+W',
          click: () => whiteBalance('point')
        },
        {
          label: 'Undo White Balance',
          enabled: !!lastWhitePoint,
          click: () => undoWhitePoint()
        },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: 'Alt+Cmd+I', click: () => toggleDevToolsForActive() }
      ]
    },
    {
      label: 'Window',
      submenu: [
        // Electron attaches a ROLE's own default accelerator even when we pass
        // `accelerator: undefined`, so `role: 'minimize'` re-claims Cmd+M and the
        // menu swallows it before it can reach the remote machine. When the user
        // has blocked Cmd+M, drop the role and minimise from an explicit click,
        // which carries no accelerator at all.
        isHotkeyBlocked({ key: 'm', meta: true })
          ? {
              label: 'Minimize',
              click: () => {
                const w = BrowserWindow.getFocusedWindow();
                if (w && !w.isDestroyed()) w.minimize();
              }
            }
          : { label: 'Minimize', accelerator: 'Cmd+M', role: 'minimize' },
        { label: 'Zoom', role: 'zoom' }
      ]
    }
  ];

  return template;
}

// ---- IPC --------------------------------------------------------------------

ipcMain.handle('get-config', (event) => {
  if (!isTrustedSender(event)) return { servers: [], cssOverrides: [], blockedHotkeys: [], tabs: getTabsConfig(), media: { camera: false, microphone: false }, appearance: getAppearance(), host: '' };
  const rec = findRecBySender(event);
  return {
    servers: getServers(),
    cssOverrides: store.get('cssOverrides'),
    blockedHotkeys: getBlockedHotkeys(),
    tabs: getTabsConfig(),
    media: getMediaConfig(),
    appearance: getAppearance(),
    // connect.html (running inside a session view) prefills this to retry the host.
    // The splash session has no server, hence the null guard.
    host: rec && rec.server ? (rec.server.host || '') : ''
  };
});

ipcMain.handle('save-config', (event, newConfig) => {
  if (!isTrustedSender(event)) return false;
  newConfig = (newConfig && typeof newConfig === 'object') ? newConfig : {};
  // Remember the hosts we were on, so an edited host reconnects its open sessions
  const prevHosts = new Map(getServers().map(s => [s.id, s.host]));
  if (newConfig.servers !== undefined) store.set('servers', sanitizeServers(newConfig.servers));
  if (newConfig.cssOverrides !== undefined) store.set('cssOverrides', sanitizeOverrides(newConfig.cssOverrides));
  if (newConfig.blockedHotkeys !== undefined) store.set('blockedHotkeys', sanitizeHotkeys(newConfig.blockedHotkeys));
  if (newConfig.appearance !== undefined) {
    const a = newConfig.appearance;
    store.set('appearance', a === 'dark' || a === 'light' ? a : 'auto');
    applyAppearance();
  }
  if (newConfig.media !== undefined) {
    const next = sanitizeMedia(newConfig.media);
    const prev = getMediaConfig();
    store.set('media', next);
    // Ask macOS the moment a device is switched on, not at the surprising moment
    // the remote page reaches for it.
    const turnedOn = [];
    if (next.camera && !prev.camera) turnedOn.push('camera');
    if (next.microphone && !prev.microphone) turnedOn.push('microphone');
    if (turnedOn.length) ensureSystemMediaAccess(turnedOn);
  }
  if (newConfig.tabs !== undefined) {
    store.set('tabs', sanitizeTabs(newConfig.tabs));
    applyTabsConfigLive(); // live-apply to every window's strip
    createMenu();
  }

  // Re-apply CSS to every open session
  applyCSSAll();
  applyVideoFilterAll();

  // Refresh the Connections menu and open-window titles to match the new server list
  if (newConfig.servers !== undefined) {
    createMenu();
    for (const rec of windows.values()) {
      const latest = getServerById(rec.serverId);
      if (latest && !rec.win.isDestroyed()) {
        const hostChanged = prevHosts.get(rec.serverId) !== latest.host;
        rec.server = latest;
        rec.win.setTitle(`${APP_NAME} — ${latest.name || latest.host}`);
        // Editing a server's host should reconnect the sessions showing it
        if (hostChanged && !rec.suspended) loadHostInView(rec, latest.host);
      }
    }
  }

  return true;
});

ipcMain.handle('update-css', (event, overrides) => {
  if (!isTrustedSender(event)) return false;
  store.set('cssOverrides', sanitizeOverrides(overrides));
  applyCSSAll();
  applyVideoFilterAll();
  return true;
});

ipcMain.handle('reload-session', (event) => {
  if (!isTrustedSender(event)) return;
  reloadActiveSession();
});

ipcMain.handle('get-connection-error', (event) => {
  if (!isTrustedSender(event)) return null;
  const rec = findRecBySender(event);
  return rec ? rec.error : null;
});

ipcMain.handle('get-app-name', () => {
  return APP_NAME;
});

ipcMain.handle('open-settings', (event) => {
  if (!isTrustedSender(event)) return;
  openSettings();
});

// ---- Tab strip IPC ----------------------------------------------------------

// The tab strip (tabbar.html) talks to its own window, found via the overlay sender.
ipcMain.handle('tabs-get-state', (event) => {
  const win = overlayOwner.get(event.sender.id);
  return win && !win.isDestroyed() ? buildWinTabsState(win) : { position: 'right', size: 76, overlay: true, tabs: [] };
});
ipcMain.handle('tabs-switch', (event, index) => {
  const win = overlayOwner.get(event.sender.id);
  if (!win || win.isDestroyed()) return true;
  const entry = winTabEntries(win)[index];
  if (entry) activateEntryInWin(win, entry);
  return true;
});

ipcMain.handle('tabs-close', (event, index) => {
  const win = overlayOwner.get(event.sender.id);
  if (win && !win.isDestroyed()) closeTabInWin(win, Number(index));
  return true;
});

// Right-click on a tab. Built here rather than in the page because the strip is
// a sandboxed renderer — and so the item can name what it is about to close.
ipcMain.handle('tabs-context-menu', (event, index) => {
  const win = overlayOwner.get(event.sender.id);
  if (!win || win.isDestroyed()) return true;
  const i = Number(index);
  const entry = winTabEntries(win)[i];
  if (!entry) return true;
  const server = getServerById(entry.serverId) || (entry.session && entry.session.server);
  const name = entry.label || (server ? (server.name || server.host) : `Tab ${i + 1}`);
  const live = !!(entry.session && !entry.session.suspended && entry.serverId);
  Menu.buildFromTemplate([
    { label: 'Disconnect', enabled: live, click: () => disconnectTabInWin(win, i) },
    { type: 'separator' },
    { label: `Close ${name}`, click: () => closeTabInWin(win, i) }
  ]).popup({ window: win });
  return true;
});

// Show the tab strip on the active session window (from the Settings button).
ipcMain.handle('show-tabs-here', (event) => {
  if (!isTrustedSender(event)) return false;
  setStripShownGlobally(true);
  return true;
});

// Live-apply the shared tabs config (from Settings) to every window's strip.
ipcMain.handle('update-tabs', (event, cfg) => {
  if (!isTrustedSender(event)) return false;
  store.set('tabs', sanitizeTabs(cfg));
  applyTabsConfigLive();
  createMenu();
  return true;
});

// First run: the whole starting configuration in one call, from connect.html
// when no servers exist yet. Deliberately narrower than save-config — it can
// create the first servers and set the three switches that screen shows, and
// nothing else.
ipcMain.handle('setup-complete', (event, setup) => {
  if (!isTrustedSender(event)) return false;
  const s = (setup && typeof setup === 'object') ? setup : {};
  const rows = (Array.isArray(s.servers) ? s.servers : []).filter(r => r && asStr(r.host).trim());
  const servers = sanitizeServers(rows.map((r, i) => ({
    id: `s${i}`, name: asStr(r.name, 200).trim(), host: asStr(r.host, 500).trim()
  })));
  if (!servers.length) return false;

  store.set('servers', servers);
  store.set('tabs', sanitizeTabs({ ...getTabsConfig(), openNewInTabs: !!s.useTabs }));
  const media = sanitizeMedia({ camera: !!s.camera, microphone: !!s.microphone });
  store.set('media', media);
  // Ask macOS now, while the user is still looking at the screen that asked.
  const turnedOn = [];
  if (media.camera) turnedOn.push('camera');
  if (media.microphone) turnedOn.push('microphone');
  if (turnedOn.length) ensureSystemMediaAccess(turnedOn);

  applyTabsConfigLive();
  createMenu();

  // Open what was just configured, reusing the view that asked for the first one.
  const rec = findRecBySender(event);
  servers.forEach((server, i) => {
    if (i === 0 && rec && !rec.win.isDestroyed()) {
      rec.serverId = server.id;
      rec.server = server;
      rec.win.setTitle(`${APP_NAME} — ${server.name || server.host}`);
      loadHostInView(rec, server.host);
    } else {
      openServer(server);
    }
  });
  persistOpenSessions();
  return true;
});

// Read synchronously from a <head> script, so a dark window never paints white
// first. Not guarded by isTrustedSender: it is two words, 'dark' or 'light', and
// the preload that asks is shared with the remote page.
ipcMain.on('theme-sync', (event) => { event.returnValue = resolvedTheme(); });

ipcMain.handle('connect', (event, host) => {
  if (!isTrustedSender(event)) return;
  const rec = findRecBySender(event);
  if (rec) loadHostInView(rec, host);
});

// ---- Video color IPC --------------------------------------------------------

// Both layers (global + this server) + which server the panel is adjusting.
ipcMain.handle('get-video-wb', (event) => {
  if (!isTrustedSender(event)) return null;
  const rec = getActiveServerRec(); // the tab currently in front
  const serverId = rec ? rec.serverId : null;
  const serverName = rec && rec.server ? (rec.server.name || rec.server.host) : null;
  return { global: globalWB(), server: serverWB(serverId), serverId, serverName };
});

// Live preview of the COMBINED (global × server) look on the CURRENT active tab.
ipcMain.handle('preview-video-wb', (event, vals) => {
  if (!isTrustedSender(event)) return false;
  const rec = getActiveServerRec();
  if (!rec) return false;
  vals = (vals && typeof vals === 'object') ? vals : {};
  // Sanitize before these numbers are interpolated into the injected filter string.
  const combined = combineWB(
    sanitizeWB(vals.global, WB_IDENTITY),
    sanitizeWB(vals.server, WB_IDENTITY)
  );
  previewVideoFilter(rec, wbFilterValue(combined));
  return true;
});

// Persist one layer: scope 'all' → the global layer, a server id → that server's
// own layer (dropped when it's identity, to stay clean).
ipcMain.handle('save-video-wb', (event, vals) => {
  if (!isTrustedSender(event)) return false;
  vals = (vals && typeof vals === 'object') ? vals : {};
  // `scope` indexes video.servers, so pin it to 'all' or a real server id. A
  // '__proto__' scope is inert today, but keeping arbitrary strings out of an
  // object index is cheap.
  const rawScope = asStr(vals.scope, 100) || 'all';
  const scope = (rawScope === 'all' || (!RESERVED_KEYS.has(rawScope) && getServerById(rawScope)))
    ? rawScope
    : 'all';
  const base = scope === 'all' ? VIDEO_WB_DEFAULT : WB_IDENTITY;
  const params = sanitizeWB(vals.params || vals, base);

  persistWB(scope, params);
  return true;
});

// White point: sample the stream and correct its white balance.
ipcMain.handle('white-balance', (event, mode, scope) => {
  if (!isTrustedSender(event)) return { ok: false, reason: 'not allowed' };
  return whiteBalance(mode === 'point' ? 'point' : 'auto',
                      scope === 'global' ? 'global' : 'server');
});

ipcMain.handle('undo-white-balance', (event) => {
  if (!isTrustedSender(event)) return { ok: false };
  const r = undoWhitePoint();
  if (colorWindow && !colorWindow.isDestroyed()) colorWindow.webContents.send('wb-reload');
  return r;
});

ipcMain.handle('can-undo-white-balance', (event) =>
  isTrustedSender(event) ? !!lastWhitePoint : false);

// Open one or several configured servers from the connect screen. The current
// (connect) window is reused for the first selection; the rest open as new
// windows/instances.
ipcMain.handle('open-servers', (event, ids) => {
  if (!isTrustedSender(event)) return false;
  const rec = findRecBySender(event);
  const list = (Array.isArray(ids) ? ids : [ids]).map(getServerById).filter(Boolean);
  list.forEach((server, i) => {
    if (i === 0 && rec && !rec.win.isDestroyed()) {
      rec.serverId = server.id;
      rec.server = server;
      rec.win.setTitle(`${APP_NAME} — ${server.name || server.host}`);
      loadHostInView(rec, server.host);
    } else {
      openServer(server);
    }
  });
  persistOpenSessions();
  return true;
});

// ---- App lifecycle ----------------------------------------------------------

app.on('before-quit', () => {
  persistOpenSessions(); // capture the open set before windows tear down
  app.isQuitting = true;
});

// There used to be a `will-quit` handler here that called preventDefault() unless
// app.isQuitting — meant to stop Cmd+Q from killing a session. It never ran:
// `before-quit` fires first and sets that flag on every quit path, so the guard
// was dead code.
//
// It is gone rather than repaired, because repairing it is worse than the bug —
// refusing quit requests also blocks the dock's Quit and system logout/shutdown,
// and leaves the app killable only by force.
//
// Cmd+Q is passed to the remote machine the right way instead: the application
// menu simply never binds it (Quit is on Cmd+Shift+Q), so the key falls through
// session. That only holds while the real menu is installed — which is why
// createMenu() can no longer fail into Electron's default menu, whose Quit *is*
// bound to Cmd+Q.

// A KVM appliance's self-signed certificate is expected, so waive certificate
// errors — but ONLY for a private-network host the user pointed this app at.
// The previous blanket callback(true) accepted any certificate from any host,
// which made every HTTPS connection the app made trivially MITM-able.
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch (e) { /* unparseable */ }

  if (hostname && isPrivateHostname(hostname) && knownHostnames().has(hostname)) {
    event.preventDefault();
    callback(true);
    return;
  }
  console.warn(`[${APP_NAME}] rejected certificate for ${url}: ${error}`);
  callback(false);
});

app.whenReady().then(() => {
  applyAppearance();

  // The remote KVM page is untrusted content. Grant it only what a KVM session
  // needs (mouse capture, fullscreen, clipboard) and deny camera, microphone,
  // geolocation, notifications, USB/HID/serial and everything else outright.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = details && details.mediaTypes;
      if (!mediaDecision(wc, types)) { callback(false); return; }
      // Granted here, but macOS may still be holding it at the OS level.
      const kinds = (Array.isArray(types) && types.length ? types : ['video', 'audio'])
        .map(t => MEDIA_KINDS[t]).filter(Boolean);
      ensureSystemMediaAccess(kinds).then(callback).catch(() => callback(false));
      return;
    }
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  // Synchronous counterpart, used by navigator.permissions.query and by
  // Chromium's own pre-checks. It must give the same answer as above, minus the
  // OS prompt — which cannot be awaited here.
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission === 'media') {
      const types = [];
      if (details && details.mediaType === 'video') types.push('video');
      if (details && details.mediaType === 'audio') types.push('audio');
      return mediaDecision(wc, types.length ? types : undefined);
    }
    return ALLOWED_PERMISSIONS.has(permission);
  });

  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icons', '512x512.png'));
  }

  // Name shown in the "About" panel (works in dev too, unlike the menu-bar title)
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: pkg.version
  });

  createMenu();

  // Reopen exactly the windows that were open at last quit (restoring each one's
  // tab-strip state). If none, show the splash/connect screen — which lists
  // existing connections to pick, or prompts to create the first one.
  const sessions = (store.get('openSessions') || [])
    .map(e => (typeof e === 'string' ? { serverId: e, show: false } : e)) // migrate old shape
    .filter(e => e && getServerById(e.serverId));
  if (sessions.length) {
    const showStrip = getTabsConfig().showStrip;
    sessions.forEach(e => {
      const win = openServerWindow(getServerById(e.serverId));
      if (showStrip) setStripShown(win, true);
    });
  } else {
    openServerWindow(null); // splash: connect.html (existing connections / create first)
  }

  // Keep the Tabs menu in sync with whichever window is focused.
  app.on('browser-window-focus', () => createMenu());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openServerWindow(null); // reopen the picker
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
