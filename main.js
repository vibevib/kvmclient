const { app, BrowserWindow, BrowserView, ipcMain, Menu } = require('electron');
const path = require('path');
const Store = require('electron-store');
const pkg = require('./package.json');

// App name from package.json
const APP_NAME = pkg.productName || pkg.name;

// Set app name for macOS menu bar
app.setName(APP_NAME);

// Disable HTTPS upgrades and certificate errors for local network
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('disable-features', 'AutoupgradeMixedContent');

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

function wbFilterCss(p) {
  return `filter: ${wbFilterValue(p)}`;
}

const VIDEO_WB_CSS = wbFilterCss(VIDEO_WB_DEFAULT);

// Initialize store with defaults
const store = new Store({
  name: 'config',
  defaults: {
    servers: [
      { id: 'default', name: 'Default', host: 'http://192.168.1.100' }
    ],
    cssOverrides: [
      { selector: '.un-collapse-triangle-collapsed', css: 'opacity: 0.01 !important', enabled: true, scope: 'all' },
      { selector: '.kvm-video-info', css: 'display: none !important', enabled: true, scope: 'all' },
      { selector: '#stream-canvas', css: 'filter: contrast(1.1) brightness(1.2)', enabled: true, scope: 'all' },
      { selector: '.kvm-page', css: 'height: 100% !important', enabled: true, scope: 'all' },
      { selector: '#video-wrapper', css: VIDEO_WB_CSS, enabled: true, scope: 'all' }
    ],
    blockedHotkeys: [
      { key: 'w', meta: true, description: 'Close tab', enabled: true },
      { key: 'q', meta: true, description: 'Quit app', enabled: true },
      { key: 't', meta: true, description: 'New tab', enabled: true },
      { key: 'n', meta: true, description: 'New window', enabled: true },
      { key: 'h', meta: true, description: 'Hide app', enabled: true },
      { key: 'm', meta: true, description: 'Minimize', enabled: true },
      { key: 'Tab', meta: true, description: 'App switcher', enabled: true }
    ],
    // Multi-session tabbed window: one window hosting several sessions, switched
    // via an edge-docked button strip (sits over the letterbox bars).
    tabs: {
      enabled: false,          // open the tabbed window on startup (instead of separate sessions)
      position: 'right',       // left | right | top | bottom
      overlay: true,           // true = strip floats over the content (letterbox); false = own area (shrinks video)
      showButtons: true,
      size: 76,                // strip thickness in px
      items: []                // [{ serverId, behavior: 'keep' | 'suspend' }]
    }
  }
});

// Migrate a legacy single-host config into the servers list
(function migrateServers() {
  const servers = store.get('servers');
  if (!Array.isArray(servers) || servers.length === 0) {
    const legacyHost = store.get('host');
    store.set('servers', [
      { id: 'default', name: 'Default', host: legacyHost || 'http://192.168.1.100' }
    ]);
  }
})();

// Seed the video white-balance override into existing configs (one-time, so a
// later manual delete sticks). New installs already get it via the defaults above.
(function seedVideoWrapper() {
  if (store.get('videoWrapperSeeded')) return;
  const overrides = store.get('cssOverrides') || [];
  if (!overrides.some(o => o.selector === '#video-wrapper')) {
    overrides.push({ selector: '#video-wrapper', css: VIDEO_WB_CSS, enabled: true, scope: 'all' });
    store.set('cssOverrides', overrides);
  }
  store.set('videoWrapperSeeded', true);
})();

// Open windows keyed by a unique instance id — several windows may show the same
// server, each an independent connection/instance.
// Record shape: { id, win, view, cssKey, error, serverId, server }
const windows = new Map();
let nextInstanceId = 1;
let settingsWindow = null;
let colorWindow = null;
let colorTargetInstanceId = null; // the server instance the color panel adjusts
let lastActiveInstanceId = null;

// Sessions are records in `windows`; several may share one BrowserWindow. Per-window
// tab state lives on the window as win.__tab:
//   { overlay: BrowserView|null, show: bool, sessionIds: number[], activeId: number|null }
// overlayOwner maps a strip overlay's webContents id -> its BrowserWindow (for tab IPC).
const overlayOwner = new Map();

// ---- Config helpers ---------------------------------------------------------

function getServers() {
  return store.get('servers') || [];
}

function getServerById(id) {
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

// Identity params (no correction) — the default for a server's own layer.
const WB_IDENTITY = { r: 1, g: 1, b: 1, brightness: 1, contrast: 1, saturate: 1, sharpen: 0 };

// The GLOBAL video layer (applies to every server); defaults to the tuned base.
function globalWB() {
  const overrides = store.get('cssOverrides') || [];
  const g = overrides.find(o => o.selector === '#video-wrapper' && (o.scope || 'all') === 'all');
  return g ? wbParamsFromCss(g.css) : { ...VIDEO_WB_DEFAULT };
}

// A server's OWN video layer (applies only to that server); identity if unset.
function serverWB(serverId) {
  if (!serverId) return { ...WB_IDENTITY };
  const overrides = store.get('cssOverrides') || [];
  const s = overrides.find(o => o.selector === '#video-wrapper' && o.scope === serverId);
  return s ? wbParamsFromCss(s.css) : { ...WB_IDENTITY };
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

// Ensure a host string has a scheme (accepts a bare IP like "192.168.1.100")
function normalizeHost(host) {
  const h = (host || '').trim();
  if (!h) return '';
  return /^https?:\/\//i.test(h) ? h : `http://${h}`;
}

// Build the CSS for one server: enabled overrides scoped to "all" or this server.
function buildCSS(serverId) {
  const overrides = store.get('cssOverrides') || [];
  return overrides
    // #video-wrapper (the video adjustment) is applied via element detection, not
    // as a selector rule, so the stream is hit whatever its markup — see applyVideoFilter.
    .filter(o => o.enabled && o.selector !== '#video-wrapper' && ((o.scope || 'all') === 'all' || o.scope === serverId))
    .map(o => `${o.selector} { ${o.css} }`)
    .join(' ');
}

// Check if a hotkey should be blocked from native handling
function isHotkeyBlocked(input) {
  const hotkeys = store.get('blockedHotkeys') || [];
  return hotkeys.some(h =>
    h.enabled &&
    h.key.toLowerCase() === input.key.toLowerCase() &&
    h.meta === input.meta
  );
}

// ---- CSS injection ----------------------------------------------------------

// Apply CSS overrides to a single view, replacing any previously injected styles.
// insertCSS() is additive and returns a key; without removing the old key first, a
// disabled/edited/deleted rule would linger until a full page reload.
async function applyCSSToView(rec) {
  if (!rec || !rec.view || rec.view.webContents.isDestroyed()) return;
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
  if (css) {
    try {
      rec.cssKey = await wc.insertCSS(css);
    } catch (e) {
      // webContents may have navigated away mid-apply; ignore.
    }
  }
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
    rec.view.webContents.loadURL(url);
  } else {
    showConnectPage(rec, 'No host configured');
  }
}

// Resolve the window record that sent an IPC message (used by the connect page,
// which runs inside a server's BrowserView).
function findRecBySender(event) {
  for (const rec of windows.values()) {
    if (!rec.view.webContents.isDestroyed() && rec.view.webContents === event.sender) {
      return rec;
    }
  }
  return null;
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
    if (active && active.serverId) out.push({ serverId: active.serverId, show: !!w.__tab.show });
  }
  store.set('openSessions', out);
}

// Create one session (a BrowserView) inside a window and start loading. `server`
// null shows the connect/splash page. Returns the session record (also in `windows`).
function createSession(win, server) {
  const id = nextInstanceId++;
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-remote.js'),
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: true,
      webSecurity: false,
      backgroundThrottling: false // keep hidden 'keep' sessions alive
    }
  });
  const behItem = server ? getTabsConfig().items.find(it => it.serverId === server.id) : null;
  const rec = {
    id, win, view, cssKey: null, error: null,
    serverId: server ? server.id : null, server: server || null,
    behavior: (behItem && behItem.behavior === 'suspend') ? 'suspend' : 'keep', suspended: false
  };
  windows.set(id, rec);

  view.webContents.on('did-finish-load', () => { rec.cssKey = null; applyCSSToView(rec); applyVideoFilter(rec); });
  view.webContents.on('did-navigate-in-page', () => { applyCSSToView(rec); applyVideoFilter(rec); });
  view.webContents.on('did-fail-load', (e, code, desc, url) => {
    if (code === -3) return;
    if (url.includes('connect.html') || url.startsWith('about:')) return;
    showConnectPage(rec, `Could not connect to ${url}\n${desc} (${code})`);
    if (win.__tab) pushWinTabsState(win);
  });
  view.webContents.on('did-navigate', (e, url, httpCode) => {
    if (httpCode >= 400) { showConnectPage(rec, `HTTP Error ${httpCode} from ${url}`); if (win.__tab) pushWinTabsState(win); }
  });
  view.webContents.on('before-input-event', (e, input) => {
    if (input.meta && input.key === '`') { app.isQuitting = true; app.quit(); return; }
    if (input.meta && input.key === ',') { e.preventDefault(); openSettings(); return; }
  });

  if (server) loadHostInView(rec, server.host);
  else view.webContents.loadFile('connect.html');
  return rec;
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
    win.setTopBrowserView(active.view);
  }
  if (t.overlay && !t.overlay.webContents.isDestroyed()) {
    win.setTopBrowserView(t.overlay);
  }
}

// Strip state = the PRESET session buttons + this window's connection status.
function buildWinTabsState(win) {
  const cfg = getTabsConfig();
  const sessions = getWinSessions(win);
  const activeId = win.__tab ? win.__tab.activeId : null;
  const tabs = cfg.items.map((it, i) => {
    const server = getServerById(it.serverId);
    const s = sessions.find(x => x.serverId === it.serverId);
    return {
      index: i,
      label: server ? (server.name || server.host) : (it.serverId || '?'),
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

// Switch a window to the session for `serverId`: focus it if connected here, else
// create + connect it. Suspends the outgoing session if its button is 'suspend'.
function activateServerInWin(win, serverId) {
  if (!win || win.isDestroyed() || !win.__tab) return;
  const server = getServerById(serverId);
  if (!server) return;
  const t = win.__tab;
  let sess = getWinSessions(win).find(s => s.serverId === serverId);
  const cur = windows.get(t.activeId);

  if (cur && (!sess || cur.id !== sess.id) && cur.view && !cur.view.webContents.isDestroyed() && cur.behavior === 'suspend') {
    cur.suspended = true;
    try { cur.view.webContents.loadURL('about:blank'); } catch (e) {}
  }

  if (!sess) {
    sess = createSession(win, server);
    t.sessionIds.push(sess.id);
    win.addBrowserView(sess.view);
  } else if (sess.suspended) {
    sess.suspended = false;
    loadHostInView(sess, sess.server.host);
  }

  t.activeId = sess.id;
  lastActiveInstanceId = sess.id;
  layoutWindow(win);
  if (t.overlay) win.setTopBrowserView(t.overlay);
  sess.view.webContents.focus();
  win.setTitle(`${APP_NAME} — ${server.name || server.host}`);
  pushWinTabsState(win);
  createMenu();
  persistOpenSessions();
  // If the color panel is open, re-sync it to the now-active tab/server.
  if (colorWindow && !colorWindow.isDestroyed()) colorWindow.webContents.send('wb-reload');
}

// Show/hide the tab strip on a window, live, without recreating the window.
function setStripShown(win, show) {
  if (!win || win.isDestroyed() || !win.__tab) return;
  const t = win.__tab;
  t.show = show;
  if (show && !t.overlay) {
    const overlay = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, 'preload-tabbar.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    t.overlay = overlay;
    overlayOwner.set(overlay.webContents.id, win);
    win.addBrowserView(overlay);
    overlay.webContents.loadFile('tabbar.html');
    overlay.webContents.once('did-finish-load', () => pushWinTabsState(win));
  }
  layoutWindow(win);
  if (t.overlay) win.setTopBrowserView(t.overlay);
  pushWinTabsState(win);
  createMenu();
  persistOpenSessions();
}

function toggleStripActive() {
  const win = BrowserWindow.getFocusedWindow();
  if (win && win.__tab) setStripShown(win, !win.__tab.show);
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
  const items = getTabsConfig().items;
  if (!items.length) return;
  const cur = windows.get(win.__tab.activeId);
  let idx = cur ? items.findIndex(it => it.serverId === cur.serverId) : -1;
  idx = (idx + delta + items.length) % items.length;
  activateServerInWin(win, items[idx].serverId);
}

// Live-apply the shared tabs config (position/size/overlay/buttons) to every open
// window's strip — no window is recreated.
function applyTabsConfigLive() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.__tab) continue;
    layoutWindow(w);
    if (w.__tab.overlay) { w.setTopBrowserView(w.__tab.overlay); pushWinTabsState(w); }
  }
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
      nodeIntegration: false
    }
  });
  win.__tab = { overlay: null, show: false, sessionIds: [], activeId: null };

  const first = createSession(win, server);
  win.__tab.sessionIds.push(first.id);
  win.__tab.activeId = first.id;
  win.addBrowserView(first.view);
  lastActiveInstanceId = first.id;

  win.on('resize', () => layoutWindow(win));
  win.on('enter-full-screen', () => layoutWindow(win));
  win.on('leave-full-screen', () => layoutWindow(win));
  win.on('focus', () => { if (win.__tab && win.__tab.activeId) lastActiveInstanceId = win.__tab.activeId; });

  win.on('closed', () => {
    for (const s of getWinSessions(win)) windows.delete(s.id);
    if (win.__tab && win.__tab.overlay) overlayOwner.delete(win.__tab.overlay.webContents.id);
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
  if (rec) {
    const latest = getServerById(rec.serverId);
    loadHostInView(rec, latest ? latest.host : rec.server.host);
  }
}

// Toggle DevTools for whatever is in front. A server window shows the remote
// session in a BrowserView, so devtools must target the view's webContents — the
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
    width: 700,
    height: 600,
    title: `${APP_NAME} Settings`,
    parent: BrowserWindow.getFocusedWindow() || undefined,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
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
    set.forEach(function(e){ if(v){e.style.setProperty('filter',v,'important');}else{e.style.removeProperty('filter');} });
    return set.size;
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
  const target = getActiveServerRec();
  colorTargetInstanceId = target ? target.id : null;

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
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Float above everything — including a full-screened video window. Without this,
  // macOS opens the panel on a different Space (behind the full-screen video), so
  // it looks like nothing happened.
  colorWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    colorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

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

// ---- Tabbed (multi-session) window ------------------------------------------

function getTabsConfig() {
  const t = store.get('tabs') || {};
  return {
    enabled: !!t.enabled,
    position: ['left', 'right', 'top', 'bottom'].includes(t.position) ? t.position : 'right',
    overlay: t.overlay !== false,
    showButtons: t.showButtons !== false,
    size: Number(t.size) > 0 ? Number(t.size) : 76,
    items: Array.isArray(t.items) ? t.items : []
  };
}


// ---- Application menu -------------------------------------------------------

function createMenu() {
  const servers = getServers();

  const connectionsSubmenu = servers.length
    ? servers.map(s => ({
        label: s.name || s.host,
        click: () => openServerWindow(s) // each click opens a new window/instance
      }))
    : [{ label: 'No servers configured', enabled: false }];

  connectionsSubmenu.push(
    { type: 'separator' },
    { label: 'Manage Servers…', click: () => openSettings() }
  );

  // Tabs are a trait of the focused window: show/hide the strip, switch between
  // the preset session buttons — all in that window.
  const focusedWin = BrowserWindow.getFocusedWindow();
  const winTab = focusedWin && focusedWin.__tab;
  const presetItems = getTabsConfig().items;
  const tabsSubmenu = [
    { label: 'Show Session Tabs', type: 'checkbox', checked: !!(winTab && winTab.show), enabled: !!winTab, click: () => toggleStripActive() },
    { type: 'separator' },
    { label: 'Next Session', accelerator: 'Ctrl+Tab', enabled: !!winTab && presetItems.length > 1, click: () => switchWinRelative(1) },
    { label: 'Previous Session', accelerator: 'Ctrl+Shift+Tab', enabled: !!winTab && presetItems.length > 1, click: () => switchWinRelative(-1) }
  ];
  if (winTab && presetItems.length) {
    tabsSubmenu.push({ type: 'separator' });
    const sessions = getWinSessions(focusedWin);
    presetItems.forEach((it) => {
      const server = getServerById(it.serverId);
      const sess = sessions.find(s => s.serverId === it.serverId);
      tabsSubmenu.push({
        label: server ? (server.name || server.host) : (it.serverId || '?'),
        type: 'checkbox',
        checked: !!(sess && sess.id === winTab.activeId),
        click: () => activateServerInWin(focusedWin, it.serverId)
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
          accelerator: 'Cmd+`',
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
          accelerator: 'Cmd+R',
          click: () => reloadActiveSession()
        },
        {
          label: 'Adjust Video Color…',
          accelerator: 'Alt+Cmd+C',
          click: () => openColorAdjust()
        },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: 'Alt+Cmd+I', click: () => toggleDevToolsForActive() }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: 'Cmd+M', role: 'minimize' },
        { label: 'Zoom', role: 'zoom' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ---- IPC --------------------------------------------------------------------

ipcMain.handle('get-config', (event) => {
  const rec = findRecBySender(event);
  return {
    servers: getServers(),
    cssOverrides: store.get('cssOverrides'),
    blockedHotkeys: store.get('blockedHotkeys'),
    tabs: getTabsConfig(),
    // connect.html (running inside a server view) prefills this to retry the host
    host: rec ? (rec.server.host || '') : ''
  };
});

ipcMain.handle('save-config', (event, newConfig) => {
  if (newConfig.servers !== undefined) store.set('servers', newConfig.servers);
  if (newConfig.cssOverrides !== undefined) store.set('cssOverrides', newConfig.cssOverrides);
  if (newConfig.blockedHotkeys !== undefined) store.set('blockedHotkeys', newConfig.blockedHotkeys);
  if (newConfig.tabs !== undefined) {
    store.set('tabs', newConfig.tabs);
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
        rec.server = latest;
        rec.win.setTitle(`${APP_NAME} — ${latest.name || latest.host}`);
      }
    }
  }

  return true;
});

ipcMain.handle('update-css', (event, overrides) => {
  store.set('cssOverrides', overrides);
  applyCSSAll();
  applyVideoFilterAll();
  return true;
});

ipcMain.handle('reload-session', () => {
  reloadActiveSession();
});

ipcMain.handle('get-connection-error', (event) => {
  const rec = findRecBySender(event);
  return rec ? rec.error : null;
});

ipcMain.handle('get-app-name', () => {
  return APP_NAME;
});

ipcMain.handle('open-settings', () => {
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
  const it = getTabsConfig().items[index];
  if (win && it) activateServerInWin(win, it.serverId);
  return true;
});

// Show the tab strip on the active session window (from the Settings button).
ipcMain.handle('show-tabs-here', () => {
  const win = activeTabbedWin();
  if (win) setStripShown(win, true);
  return true;
});

// Live-apply the shared tabs config (from Settings) to every window's strip.
ipcMain.handle('update-tabs', (event, cfg) => {
  store.set('tabs', cfg);
  applyTabsConfigLive();
  createMenu();
  return true;
});

ipcMain.handle('connect', (event, host) => {
  const rec = findRecBySender(event);
  if (rec) loadHostInView(rec, host);
});

// ---- Video color IPC --------------------------------------------------------

// Both layers (global + this server) + which server the panel is adjusting.
ipcMain.handle('get-video-wb', () => {
  const rec = getActiveServerRec(); // the tab currently in front
  const serverId = rec ? rec.serverId : null;
  const serverName = rec && rec.server ? (rec.server.name || rec.server.host) : null;
  return { global: globalWB(), server: serverWB(serverId), serverId, serverName };
});

// Live preview of the COMBINED (global × server) look on the CURRENT active tab.
ipcMain.handle('preview-video-wb', (event, vals) => {
  const rec = getActiveServerRec();
  if (!rec) return false;
  const combined = combineWB(vals.global || WB_IDENTITY, vals.server || WB_IDENTITY);
  previewVideoFilter(rec, wbFilterValue(combined));
  return true;
});

// Persist one layer. scope 'all' → the global #video-wrapper override; a server id
// → that server's own override (removed when it's identity, to stay clean).
ipcMain.handle('save-video-wb', (event, vals) => {
  const scope = vals.scope || 'all';
  const params = vals.params || vals; // {r,g,b,brightness,contrast,saturate}
  const overrides = store.get('cssOverrides') || [];
  const idx = overrides.findIndex(o => o.selector === '#video-wrapper' && (o.scope || 'all') === scope);

  const isIdentity = ['r', 'g', 'b', 'brightness', 'contrast', 'saturate'].every(k => Number(params[k]) === 1)
    && (Number(params.sharpen) || 0) === 0;
  if (scope !== 'all' && isIdentity) {
    if (idx >= 0) overrides.splice(idx, 1); // drop an all-neutral per-server layer
  } else {
    const css = wbFilterCss(params);
    if (idx >= 0) { overrides[idx].css = css; overrides[idx].enabled = true; }
    else overrides.push({ selector: '#video-wrapper', css, enabled: true, scope });
  }

  store.set('cssOverrides', overrides);
  applyVideoFilterAll(); // re-apply the combined filter to every open window
  return true;
});

// Open one or several configured servers from the connect screen. The current
// (connect) window is reused for the first selection; the rest open as new
// windows/instances.
ipcMain.handle('open-servers', (event, ids) => {
  const rec = findRecBySender(event);
  const list = (Array.isArray(ids) ? ids : [ids]).map(getServerById).filter(Boolean);
  list.forEach((server, i) => {
    if (i === 0 && rec && !rec.win.isDestroyed()) {
      rec.serverId = server.id;
      rec.server = server;
      rec.win.setTitle(`${APP_NAME} — ${server.name || server.host}`);
      loadHostInView(rec, server.host);
    } else {
      openServerWindow(server);
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

// macOS: prevent cmd+q / OS quit from quitting immediately
app.on('will-quit', (event) => {
  if (!app.isQuitting) {
    event.preventDefault();
  }
});

// Accept all certificates for local network
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

app.whenReady().then(() => {
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
    sessions.forEach(e => {
      const win = openServerWindow(getServerById(e.serverId));
      if (e.show) setStripShown(win, true);
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
