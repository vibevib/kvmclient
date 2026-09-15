const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  startFakeKvm, launchApp, windowsInfo, sessionUrls,
  evalInView, evalInWindow, clickMenu, menuAccelerator, webContentsCount,
  menuTopLevel, menuAccelerators, waitForMenuItem
} = require('./helpers');

let kvm;
test.beforeAll(async () => { kvm = await startFakeKvm(); });
test.afterAll(async () => { await kvm.close(); });

const servers = () => [
  { id: 'a', name: 'Alpha', host: kvm.url },
  { id: 'b', name: 'Beta', host: kvm.url }
];

// Open Settings through the real menu and wait for the window.
async function openSettings(app) {
  await clickMenu(app, 'Settings...');
  await expect.poll(async () => (await windowsInfo(app)).some(w => w.url.includes('settings.html')),
    { timeout: 15000 }).toBe(true);
}

test.describe('splash / connect screen', () => {
  test('lists configured servers (get-config survives the splash session having no server)', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [] });
    try {
      // Regression: get-config used to deref rec.server.host and throw for exactly
      // this window, leaving the picker empty.
      await expect.poll(
        () => evalInView(h.app, 'connect.html', 'document.querySelectorAll("#server-list .server-item").length'),
        { timeout: 15000 }
      ).toBe(2);

      const cfg = await evalInView(h.app, 'connect.html', 'window.kvmAPI.getConfig().then(c => c.servers.length)');
      expect(cfg).toBe(2);
    } finally { await h.close(); }
  });

  test('Reload Session on the splash does not throw', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [] });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('connect.html')]));

      // Used to null-deref rec.server.host for a session with no server.
      await clickMenu(h.app, 'Reload Session');
      await new Promise(r => setTimeout(r, 800));

      const urls = await sessionUrls(h.app);
      expect(urls.some(u => u.includes('connect.html'))).toBe(true);
    } finally { await h.close(); }
  });

  test('opening a server from the splash reuses the window', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [] });
    try {
      await expect.poll(
        () => evalInView(h.app, 'connect.html', 'document.querySelectorAll("#server-list .server-item").length'),
        { timeout: 15000 }
      ).toBe(2);

      await evalInView(h.app, 'connect.html', 'window.kvmAPI.openServers(["a"])');

      await expect.poll(() => sessionUrls(h.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));
      expect((await windowsInfo(h.app)).length).toBe(1);
    } finally { await h.close(); }
  });
});

test.describe('sessions', () => {
  test('a failing sub-frame does not tear down the session', async () => {
    const h = await launchApp({
      servers: [{ id: 'a', name: 'Alpha', host: kvm.url + '/bad-iframe' }],
      openSessions: [{ serverId: 'a' }]
    });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('/bad-iframe')]));

      // The dead iframe fires did-fail-load; without the isMainFrame guard this
      // replaced the whole session with the connect page.
      await new Promise(r => setTimeout(r, 2000));

      const urls = await sessionUrls(h.app);
      expect(urls.some(u => u.includes('/bad-iframe'))).toBe(true);
      expect(urls.some(u => u.includes('connect.html'))).toBe(false);
    } finally { await h.close(); }
  });

  test('a real main-frame failure still shows the connect page', async () => {
    const h = await launchApp({
      servers: [{ id: 'a', name: 'Alpha', host: 'http://127.0.0.1:9' }],
      openSessions: [{ serverId: 'a' }]
    });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 20000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('connect.html')]));
    } finally { await h.close(); }
  });

  test('closing a window tears down its session webContents', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }, { serverId: 'b' }]
    });
    try {
      await expect.poll(async () => (await windowsInfo(h.app)).length, { timeout: 15000 }).toBe(2);
      const before = await webContentsCount(h.app);

      await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await new Promise(r => setTimeout(r, 1500));

      // The BrowserView's webContents outlives its window until GC unless we
      // destroy it, leaving the KVM stream running after close.
      const after = await webContentsCount(h.app);
      expect(after).toBeLessThan(before);
    } finally { await h.close(); }
  });

  test('previously open windows are restored on next launch', async () => {
    const first = await launchApp({ servers: servers(), openSessions: [{ serverId: 'b' }] });
    let saved;
    try {
      await expect.poll(() => sessionUrls(first.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));
      saved = first.readConfig();
    } finally { await first.close(); }

    expect(saved.openSessions).toEqual([{ serverId: 'b' }]);
  });
});

test.describe('tab strip', () => {
  test('two buttons for the same server are independent sessions', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      tabs: {
        position: 'right', overlay: true, showStrip: true, size: 76,
        items: [
          { id: 'i1', serverId: 'a' },
          { id: 'i2', serverId: 'a' }
        ]
      }
    });
    try {
      await expect.poll(async () => {
        const w = (await windowsInfo(h.app))[0];
        return !!w && w.views.some(u => u.includes('tabbar.html'));
      }, { timeout: 15000 }).toBe(true);

      // Button 0 adopts the window's existing session; button 1 must create its own.
      await evalInView(h.app, 'tabbar.html', 'window.tabbar.switchTab(0)');
      await new Promise(r => setTimeout(r, 500));
      await evalInView(h.app, 'tabbar.html', 'window.tabbar.switchTab(1)');

      // Keyed by serverId, both buttons aliased ONE session and this stayed at 1.
      await expect.poll(async () => (await sessionUrls(h.app)).length, { timeout: 15000 }).toBe(2);
    } finally { await h.close(); }
  });

  test('strip state marks only the active button', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      tabs: {
        position: 'right', overlay: true, showStrip: true, size: 76,
        items: [
          { id: 'i1', serverId: 'a' },
          { id: 'i2', serverId: 'b' }
        ]
      }
    });
    try {
      await expect.poll(
        () => evalInView(h.app, 'tabbar.html', 'document.querySelectorAll(".tab").length'),
        { timeout: 15000 }
      ).toBe(2);

      await evalInView(h.app, 'tabbar.html', 'window.tabbar.switchTab(1)');
      await expect.poll(
        () => evalInView(h.app, 'tabbar.html',
          'JSON.stringify([...document.querySelectorAll(".tab")].map(t => t.classList.contains("active")))'),
        { timeout: 15000 }
      ).toBe(JSON.stringify([false, true]));
    } finally { await h.close(); }
  });
});

// The tab settings that used to be per-tab or per-window are now one setting
// each, shared by every tab.
test.describe('tab settings', () => {
  const stripState = (app) => evalInView(app, 'tabbar.html', 'window.tabbar.getState()');

  const waitForStrip = async (h) => {
    await expect.poll(async () => {
      const w = (await windowsInfo(h.app))[0];
      return !!w && w.views.some(u => u.includes('tabbar.html'));
    }, { timeout: 15000 }).toBe(true);
  };

  const sessionWindows = async (h) => (await windowsInfo(h.app)).filter(w => !w.url).length;

  test('a server opens as a tab on the current window by default', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await expect.poll(() => sessionWindows(h), { timeout: 15000 }).toBe(1);
      await clickMenu(h.app, 'Beta');
      // Two sessions, still one window.
      await expect.poll(async () => (await sessionUrls(h.app)).length, { timeout: 15000 }).toBe(2);
      expect(await sessionWindows(h)).toBe(1);
    } finally { await h.close(); }
  });

  test('turning that off gives each server its own window again', async () => {
    const h = await launchApp({
      servers: servers(), openSessions: [{ serverId: 'a' }],
      tabs: { openNewInTabs: false, position: 'right', overlay: true, showStrip: true, size: 76, items: [] }
    });
    try {
      await expect.poll(() => sessionWindows(h), { timeout: 15000 }).toBe(1);
      await clickMenu(h.app, 'Beta');
      await expect.poll(() => sessionWindows(h), { timeout: 15000 }).toBe(2);
    } finally { await h.close(); }
  });

  test('a tab shows its short name, or its position when it has none', async () => {
    const h = await launchApp({
      servers: servers(), openSessions: [{ serverId: 'a' }],
      tabs: { showStrip: true, position: 'right', overlay: true, size: 76,
              items: [{ id: 'i1', serverId: 'a', label: '' },
                      { id: 'i2', serverId: 'b', label: 'Web' }] }
    });
    try {
      await waitForStrip(h);
      const state = await stripState(h.app);
      expect(state.tabs.map(t => t.label)).toEqual(['1', 'Web']);
      // The server it points at stays available as the secondary line.
      expect(state.tabs.map(t => t.title)).toEqual(['Alpha', 'Beta']);
    } finally { await h.close(); }
  });

  test('a server opened later is added after the predefined tabs', async () => {
    const h = await launchApp({
      servers: servers(), openSessions: [{ serverId: 'a' }],
      tabs: { showStrip: true, position: 'right', overlay: true, size: 76,
              items: [{ id: 'i1', serverId: 'a', label: 'One' }] }
    });
    try {
      await waitForStrip(h);
      await expect.poll(async () => (await stripState(h.app)).tabs.length, { timeout: 15000 }).toBe(1);

      await clickMenu(h.app, 'Beta');
      await expect.poll(async () => (await stripState(h.app)).tabs.length, { timeout: 15000 }).toBe(2);

      const state = await stripState(h.app);
      // The configured tab keeps slot 1; the ad-hoc one lands behind it and, having
      // no name of its own, shows its position.
      expect(state.tabs[0].label).toBe('One');
      expect(state.tabs[1].label).toBe('2');
      expect(state.tabs[1].title).toBe('Beta');
    } finally { await h.close(); }
  });

  test('the shared suspend setting applies to every tab', async () => {
    const h = await launchApp({
      servers: servers(), openSessions: [{ serverId: 'a' }],
      tabs: { behavior: 'suspend', showStrip: true, position: 'right', overlay: true, size: 76,
              items: [{ id: 'i1', serverId: 'a' }, { id: 'i2', serverId: 'b' }] }
    });
    try {
      await waitForStrip(h);
      await evalInView(h.app, 'tabbar.html', 'window.tabbar.switchTab(1)');
      // Switching away suspends the tab we left, for every tab — no per-tab opt-in.
      await expect.poll(async () => {
        const s = await stripState(h.app);
        return s.tabs[0].suspended;
      }, { timeout: 15000 }).toBe(true);
    } finally { await h.close(); }
  });

  test('an old per-tab config migrates to the shared settings', async () => {
    const h = await launchApp({
      servers: servers(), openSessions: [],
      // The shape before this change: behavior on each tab, no shared switches.
      tabs: { enabled: false, showButtons: true, position: 'left', overlay: false, size: 90,
              items: [{ id: 'i1', serverId: 'a', behavior: 'suspend' },
                      { id: 'i2', serverId: 'b', behavior: 'suspend' }] }
    });
    try {
      await expect.poll(() => h.readConfig().tabs && h.readConfig().tabs.behavior,
        { timeout: 15000 }).toBe('suspend');
      const tabs = h.readConfig().tabs;

      // Every tab asked to suspend, so the shared setting does.
      expect(tabs.behavior).toBe('suspend');
      expect(tabs.openNewInTabs).toBe(true);
      // Settings that still mean something are preserved.
      expect(tabs.position).toBe('left');
      expect(tabs.overlay).toBe(false);
      expect(tabs.size).toBe(90);
      // Per-tab behavior is gone; the tabs themselves survive, in order.
      expect(tabs.items.map(i => i.serverId)).toEqual(['a', 'b']);
      expect(tabs.items.every(i => i.behavior === undefined)).toBe(true);
      expect(tabs.items.every(i => typeof i.label === 'string')).toBe(true);
      // Dead settings are dropped rather than carried forever.
      expect(tabs.enabled).toBeUndefined();
      expect(tabs.showButtons).toBeUndefined();
    } finally { await h.close(); }
  });

  test('a mixed old config does not start suspending tabs that were not', async () => {
    const h = await launchApp({
      servers: servers(), openSessions: [],
      tabs: { position: 'right', overlay: true, size: 76,
              items: [{ id: 'i1', serverId: 'a', behavior: 'suspend' },
                      { id: 'i2', serverId: 'b', behavior: 'keep' }] }
    });
    try {
      await expect.poll(() => h.readConfig().tabs && h.readConfig().tabs.behavior,
        { timeout: 15000 }).toBe('keep');
    } finally { await h.close(); }
  });
});

test.describe('settings + css', () => {
  test('rapid CSS toggles settle on the final state', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      cssOverrides: [{ selector: '#marker', css: 'color: rgb(1, 2, 3)', enabled: true, scope: 'all' }]
    });
    const markerColor = () => evalInView(h.app, '127.0.0.1',
      'getComputedStyle(document.getElementById("marker")).color');
    try {
      await expect.poll(markerColor, { timeout: 15000 }).toBe('rgb(1, 2, 3)');

      await openSettings(h.app);

      // Two overlapping applies: the unserialized version orphaned a stylesheet
      // and left the disabled rule applied.
      await evalInWindow(h.app, 'settings.html', `
        window.kvmAPI.updateCSS([{selector:'#marker',css:'color: rgb(1, 2, 3)',enabled:true,scope:'all'}]);
        window.kvmAPI.updateCSS([{selector:'#marker',css:'color: rgb(1, 2, 3)',enabled:false,scope:'all'}]);
        'sent'`);

      await expect.poll(markerColor, { timeout: 15000 }).not.toBe('rgb(1, 2, 3)');
    } finally { await h.close(); }
  });

  test('deleting a server also drops its session buttons', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [],
      tabs: { position: 'right', overlay: true, showStrip: true, size: 76, items: [{ id: 'i1', serverId: 'b' }] }
    });
    try {
      await openSettings(h.app);
      await evalInWindow(h.app, 'settings.html', `
        (async () => {
          await new Promise(r => setTimeout(r, 300));
          document.querySelector('#servers-list .delete-btn[data-type="server"][data-index="1"]').click();
          return document.querySelectorAll('#tab-items-list .tab-item-row').length;
        })()`);

      await expect.poll(
        () => evalInWindow(h.app, 'settings.html', 'document.querySelectorAll("#tab-items-list .tab-item-row").length'),
        { timeout: 15000 }
      ).toBe(0);
    } finally { await h.close(); }
  });
});

// ARC.md documents hand-editing config.json as a supported way to add a server.
// Such a server has no `id` — and ids are what every lookup keys on. With both
// sides undefined, `s.id === it.serverId` matched EVERY server: getServerById()
// returned the first id-less one (wrong host, wrong window title, wrong reload
// target) and the Settings dropdowns marked every option selected, so each tab
// button displayed the LAST server while pointing somewhere else entirely.
test.describe('hand-edited config', () => {
  const noIds = () => ({
    servers: [{ name: 'Alpha', host: kvm.url }, { name: 'Beta', host: 'http://192.168.1.55' }],
    cssOverrides: [], blockedHotkeys: [],
    tabs: { position: 'right', overlay: true, showStrip: true, size: 76,
            items: [{}, {}] }
  });

  test('servers written without ids get stable, distinct ones', async () => {
    const h = await launchApp(noIds());
    try {
      await openSettings(h.app); // any read of the config is enough to trigger the backfill
      await expect.poll(() => (h.readConfig().servers || []).every(s => s.id), { timeout: 15000 }).toBe(true);

      const ids = h.readConfig().servers.map(s => s.id);
      expect(new Set(ids).size).toBe(ids.length); // distinct
      // Names and hosts must survive the backfill untouched.
      expect(h.readConfig().servers.map(s => s.name)).toEqual(['Alpha', 'Beta']);
    } finally { await h.close(); }
  });

  test('a tab button with no server shows as unset instead of the wrong one', async () => {
    const h = await launchApp(noIds());
    try {
      await openSettings(h.app);
      const rows = JSON.parse(await evalInWindow(h.app, 'settings.html', `(function(){
        document.querySelectorAll('.tab-content').forEach(function(p){
          p.classList.toggle('active', p.id === 'tabsview'); });
        return JSON.stringify([].slice.call(document.querySelectorAll('.tab-item-row')).map(function(r){
          var sel = r.querySelector('.tab-server');
          return {
            shown: sel.options[sel.selectedIndex].text,
            value: sel.value,
            // More than one selected attribute is the bug: the browser silently
            // keeps the last, so the row displays a server it does not point at.
            markedSelected: [].slice.call(sel.options).filter(function(o){ return o.defaultSelected; }).length,
            url: r.querySelector('.tab-url').textContent
          };
        }));
      })()`));

      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.markedSelected).toBe(1);
        expect(r.value).toBe('');
        expect(r.shown).toBe('(choose a server)');
        // Says so, rather than showing the first server's host.
        expect(r.url).toBe('no server');
      }
    } finally { await h.close(); }
  });
});

test.describe('video adjustments', () => {
  test('layers persist outside cssOverrides and survive a Settings save', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await openSettings(h.app);

      await evalInWindow(h.app, 'settings.html',
        `window.kvmAPI.saveVideoWB({ params: { r: 1.5, g: 1, b: 1, brightness: 1, contrast: 1, saturate: 1, sharpen: 0 }, scope: 'all' })`);

      // Settings writes the whole cssOverrides array back from its open-time
      // snapshot — which used to wipe the just-saved video layer.
      await evalInWindow(h.app, 'settings.html',
        `window.kvmAPI.saveConfig({ cssOverrides: [{selector:'.x',css:'color: red',enabled:true,scope:'all'}] })`);

      const wb = await evalInWindow(h.app, 'settings.html', 'window.kvmAPI.getVideoWB().then(w => w.global.r)');
      expect(wb).toBe(1.5);

      const cfg = h.readConfig();
      expect(cfg.video.global.r).toBe(1.5);
      expect((cfg.cssOverrides || []).some(o => o.selector === '#video-wrapper')).toBe(false);
    } finally { await h.close(); }
  });

  test('a per-server layer stacks on the global one', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      video: { global: { r: 1.2, g: 1, b: 1, brightness: 1, contrast: 1, saturate: 1, sharpen: 0 }, servers: {} }
    });
    try {
      await openSettings(h.app);
      await evalInWindow(h.app, 'settings.html',
        `window.kvmAPI.saveVideoWB({ params: { r: 2, g: 1, b: 1, brightness: 1, contrast: 1, saturate: 1, sharpen: 0 }, scope: 'a' })`);

      const cfg = h.readConfig();
      expect(cfg.video.servers.a.r).toBe(2);
      expect(cfg.video.global.r).toBe(1.2);
    } finally { await h.close(); }
  });

  test('the filter lands on one element, not the wrapper and its canvas', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      video: { global: { r: 1.2, g: 1, b: 1, brightness: 1, contrast: 1, saturate: 1, sharpen: 0 }, servers: {} }
    });
    try {
      // Filtering #video-wrapper AND the #stream-canvas inside it compounds the
      // correction; only the outermost match may be stamped.
      await expect.poll(
        () => evalInView(h.app, '127.0.0.1',
          'JSON.stringify({w: !!document.getElementById("video-wrapper").style.filter, c: !!document.getElementById("stream-canvas").style.filter})'),
        { timeout: 15000 }
      ).toBe(JSON.stringify({ w: true, c: false }));
    } finally { await h.close(); }
  });
});

test.describe('application menu', () => {
  // One malformed row used to throw inside createMenu(), so setApplicationMenu()
  // never ran and the app was left on Electron's DEFAULT menu for the rest of the
  // session: no Connections, no Tabs, and a Cmd+Q bound to Quit. createMenu runs
  // on every window focus, so it never recovered.
  const brokenRows = [
    ['a missing key', { meta: true, description: 'broken', enabled: true }],
    ['a non-string key', { key: 5, meta: true, description: 'broken', enabled: true }],
    ['a null row', null]
  ];

  for (const [label, row] of brokenRows) {
    test(`a hotkey row with ${label} does not cost the app its menu`, async () => {
      const h = await launchApp({
        servers: servers(),
        openSessions: [{ serverId: 'a' }],
        blockedHotkeys: [row, { key: 'w', meta: true, description: 'Close tab', enabled: true }]
      });
      try {
        await expect.poll(() => menuTopLevel(h.app), { timeout: 15000 })
          .toEqual(expect.arrayContaining(['Connections', 'Tabs']));
      } finally { await h.close(); }
    });
  }

  // Cmd+Q has to reach the remote machine, so the menu must not claim it — it
  // quits on Cmd+` instead. Electron's default menu DOES bind Cmd+Q, which is
  // what made the lost-menu bug quit the app out from under the user.
  test('the menu never claims Cmd+Q, even when the hotkey config is broken', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      blockedHotkeys: [{ meta: true, description: 'broken', enabled: true }]
    });
    try {
      expect(await menuAccelerator(h.app, 'Quit KVM')).toBe('Cmd+`');
      const accels = await menuAccelerators(h.app);
      expect(accels.filter(a => /\+Q$/i.test(a))).toEqual([]);
    } finally { await h.close(); }
  });

  // A valid blocked row must still take effect after the defensive read.
  test('a valid blocked hotkey is still honoured alongside a broken one', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      blockedHotkeys: [
        { meta: true, description: 'broken', enabled: true },
        { key: 'r', meta: true, description: 'Reload', enabled: true }
      ]
    });
    try {
      // Cmd+R is blocked, so Reload Session must give the accelerator up.
      await expect.poll(() => menuAccelerator(h.app, 'Reload Session'), { timeout: 15000 }).toBe(null);
    } finally { await h.close(); }
  });
});

test.describe('video colour panel', () => {
  const withPanel = async (h) => {
    await clickMenu(h.app, 'Adjust Video Color…');
    await expect.poll(async () => (await windowsInfo(h.app)).some(w => w.url.includes('color.html')),
      { timeout: 15000 }).toBe(true);
  };

  const panelInfo = (app) => app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows().find(w => (w.webContents.getURL() || '').includes('color.html'));
    if (!p) return null;
    return {
      alwaysOnTop: p.isAlwaysOnTop(),
      visibleOnAllWorkspaces: p.isVisibleOnAllWorkspaces(),
      hasParent: !!p.getParentWindow()
    };
  });

  // The panel used to be always-on-top at 'screen-saver' level and visible on all
  // workspaces. It therefore floated above OTHER applications and followed you onto
  // their Spaces: the panel sat on top looking like KVM was active, while the menu
  // bar still belonged to whatever app was actually in front. As a child of the
  // session window it stays above the session but sinks with the app.
  test('the panel floats above its session, not above other applications', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await withPanel(h);
      expect(await panelInfo(h.app)).toEqual({
        alwaysOnTop: false, visibleOnAllWorkspaces: false, hasParent: true
      });
    } finally { await h.close(); }
  });

  // createMenu() built the Tabs menu from getFocusedWindow(). Focusing the panel —
  // a window with no sessions — disabled every Tabs item and dropped the per-session
  // entries, and it stayed that way while the panel held focus.
  test('opening the panel does not empty the Tabs menu', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      tabs: { position: 'right', overlay: true, showStrip: true, size: 76,
              items: [{ id: 'i1', serverId: 'a' },
                      { id: 'i2', serverId: 'b' }] }
    });
    try {
      await waitForMenuItem(h.app, 'Show Tab Strip');
      await withPanel(h);

      const tabs = await h.app.evaluate(({ Menu }) => {
        const m = Menu.getApplicationMenu();
        const t = m.items.find(i => i.label === 'Tabs');
        return t.submenu.items
          .filter(i => i.type !== 'separator')
          .map(i => ({ label: i.label, enabled: i.enabled }));
      });
      // Session entries survive, and the switching items stay usable.
      expect(tabs.map(t => t.label)).toEqual(
        expect.arrayContaining(['Show Tab Strip', 'Next Session', '1. Alpha', '2. Beta']));
      expect(tabs.filter(t => t.label === 'Show Tab Strip')[0].enabled).toBe(true);
      expect(tabs.filter(t => t.label === 'Next Session')[0].enabled).toBe(true);
    } finally { await h.close(); }
  });

  // Parenting the panel fixed it floating over other apps, but pinned it to the
  // window it was OPENED from. The panel always adjusts whichever session is
  // active, so once a second window came forward the panel sat behind the very
  // session it was adjusting. It now follows focus.
  test('the panel follows the session window that comes forward', async () => {
    // Explicitly one window per server: this test is about window z-order, and
    // the default now puts a second server in a TAB of the same window.
    const h = await launchApp({
      servers: servers(), openSessions: [{ serverId: 'a' }],
      tabs: { openNewInTabs: false, position: 'right', overlay: true, showStrip: true, size: 76, items: [] }
    });
    try {
      await withPanel(h);
      await clickMenu(h.app, 'Beta'); // opens a second session window
      await expect.poll(async () => (await windowsInfo(h.app)).filter(w => !w.url).length,
        { timeout: 15000 }).toBe(2);

      await expect.poll(() => h.app.evaluate(({ BrowserWindow }) => {
        const p = BrowserWindow.getAllWindows().find(w => (w.webContents.getURL() || '').includes('color.html'));
        const parent = p && p.getParentWindow();
        return !!(parent && parent.getTitle().includes('Beta'));
      }), { timeout: 15000 }).toBe(true);
    } finally { await h.close(); }
  });
});

test.describe('settings window', () => {
  // A stress config: every list long enough to push the pane past its height.
  const bigConfig = () => ({
    servers: [...servers(), ...Array.from({ length: 6 }, (_, i) => ({
      id: `x${i}`, name: `Server number ${i}`, host: `http://192.168.1.${100 + i}` }))],
    cssOverrides: Array.from({ length: 8 }, (_, i) => ({
      selector: `.rule-${i}`, css: 'display: none !important', enabled: true, scope: 'all' })),
    blockedHotkeys: ['w', 'q', 't', 'n', 'h', 'm', 'Tab'].map(k => ({
      key: k, meta: true, enabled: true, description: `Blocked ${k}` })),
    tabs: { position: 'right', overlay: true, showStrip: true, size: 76,
            items: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, serverId: `x${i}` })) },
    openSessions: [{ serverId: 'a' }]
  });

  // The window was 700x600 INCLUDING the title bar, so the page only ever had
  // 568px — less than any of the four panes needed. The whole document scrolled,
  // which put Save & Close below the fold on every tab.
  test('Save stays reachable on every pane', async () => {
    const h = await launchApp(bigConfig());
    try {
      await openSettings(h.app);
      const panes = JSON.parse(await evalInWindow(h.app, 'settings.html', `(function(){
        var panes=[].slice.call(document.querySelectorAll('.tab-content'));
        var active=document.querySelector('.tab-content.active').id;
        var row=document.querySelector('.button-row');
        var tabbar=document.querySelector('.tabs');
        var out={};
        panes.forEach(function(p){
          panes.forEach(function(q){ q.classList.toggle('active', q===p); });
          var r=row.getBoundingClientRect(), t=tabbar.getBoundingClientRect();
          out[p.id]={
            saveVisible: r.bottom <= innerHeight + 1 && r.top >= 0,
            tabBarVisible: t.top >= 0 && t.bottom <= innerHeight + 1,
            bodyScrolls: document.body.scrollHeight > document.body.clientHeight + 1,
            hClip: document.documentElement.scrollWidth > innerWidth + 1
          };
        });
        panes.forEach(function(q){ q.classList.toggle('active', q.id===active); });
        return JSON.stringify(out);
      })()`));

      for (const [id, m] of Object.entries(panes)) {
        expect(m, `pane ${id}`).toEqual(
          { saveVisible: true, tabBarVisible: true, bodyScrolls: false, hClip: false });
      }
    } finally { await h.close(); }
  });

  // Settings used to take getFocusedWindow() as its PARENT. Opening it while the
  // colour panel was in front made it a child of that panel, so closing the panel
  // destroyed the Settings window — and any unsaved edits with it.
  test('closing the colour panel does not take the Settings window with it', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await clickMenu(h.app, 'Adjust Video Color…');
      await expect.poll(async () => (await windowsInfo(h.app)).some(w => w.url.includes('color.html')),
        { timeout: 15000 }).toBe(true);
      // Focus the panel, then open Settings from it.
      await h.app.evaluate(({ BrowserWindow }) => {
        const c = BrowserWindow.getAllWindows().find(w => (w.webContents.getURL() || '').includes('color.html'));
        if (c) c.focus();
      });
      await openSettings(h.app);

      expect(await h.app.evaluate(({ BrowserWindow }) => {
        const s = BrowserWindow.getAllWindows().find(w => (w.webContents.getURL() || '').includes('settings.html'));
        const p = s && s.getParentWindow();
        return p ? (p.webContents.getURL() || '') : null;
      })).toBe(null);

      await h.app.evaluate(({ BrowserWindow }) => {
        const c = BrowserWindow.getAllWindows().find(w => (w.webContents.getURL() || '').includes('color.html'));
        if (c) c.close();
      });
      await expect.poll(async () => (await windowsInfo(h.app)).some(w => w.url.includes('color.html')),
        { timeout: 15000 }).toBe(false);

      // Settings must still be standing.
      expect((await windowsInfo(h.app)).some(w => w.url.includes('settings.html'))).toBe(true);
    } finally { await h.close(); }
  });
});

test.describe('hardening', () => {
  test('a remote page cannot read the server list or redirect the session', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));

      // The remote page shares the session view (and preload-remote), so without a
      // sender check it could enumerate every configured host.
      const leaked = await evalInView(h.app, '127.0.0.1', 'window.kvmAPI.getConfig().then(c => c.servers.length)');
      expect(leaked).toBe(0);

      await evalInView(h.app, '127.0.0.1', 'window.kvmAPI.connect("http://example.invalid/pwned")');
      await new Promise(r => setTimeout(r, 1000));
      const urls = await sessionUrls(h.app);
      expect(urls.some(u => u.includes('example.invalid'))).toBe(false);
    } finally { await h.close(); }
  });

  // The session view used to run with webSecurity:false, which let the remote KVM
  // page — or anyone MITM-ing it over plain HTTP on the LAN — read any file on the
  // machine and any cross-origin response, then post both anywhere.
  test('the remote page cannot read local files', async () => {
    const secret = path.join(os.tmpdir(), `kvm-secret-${Date.now()}.txt`);
    fs.writeFileSync(secret, 'TOP_SECRET_VALUE');
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));

      const viaFetch = await evalInView(h.app, '127.0.0.1',
        `fetch(${JSON.stringify('file://' + secret)}).then(r => r.text()).then(t => 'READ:' + t).catch(() => 'BLOCKED')`);
      expect(viaFetch).toBe('BLOCKED');

      const viaXhr = await evalInView(h.app, '127.0.0.1', `new Promise(res => {
        try {
          const x = new XMLHttpRequest();
          x.open('GET', ${JSON.stringify('file://' + secret)});
          x.onload = () => res('READ:' + x.responseText);
          x.onerror = () => res('BLOCKED');
          x.send();
        } catch (e) { res('BLOCKED'); }
      })`);
      expect(viaXhr).toBe('BLOCKED');
    } finally { await h.close(); fs.rmSync(secret, { force: true }); }
  });

  test('the remote page cannot read cross-origin responses', async () => {
    const other = await startFakeKvm();
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));

      const res = await evalInView(h.app, `:${kvm.port}`,
        `fetch('${other.url}/').then(r => r.text()).then(() => 'READ').catch(() => 'BLOCKED')`);
      expect(res).toBe('BLOCKED');
    } finally { await h.close(); await other.close(); }
  });

  // A redirect used to carry the session — preload and all — onto any site on the
  // internet. Navigation is confined to the device the session is connected to.
  test('the remote page cannot navigate the session off the device', async () => {
    const elsewhere = await startFakeKvm();
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));

      // Same loopback address, but a different HOSTNAME — i.e. a different device.
      await evalInView(h.app, `:${kvm.port}`,
        `(location.href = 'http://localhost:${elsewhere.port}/hijack', 'go')`);
      await new Promise(r => setTimeout(r, 1500));

      const urls = await sessionUrls(h.app);
      expect(urls.some(u => u.includes('localhost'))).toBe(false);
      expect(urls.some(u => u.includes(`127.0.0.1:${kvm.port}`))).toBe(true);
    } finally { await h.close(); await elsewhere.close(); }
  });

  test('the remote page cannot open popup windows', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));

      const before = (await windowsInfo(h.app)).length;
      await evalInView(h.app, '127.0.0.1', `(window.open('http://localhost:1/popup', '_blank'), 'ok')`);
      await new Promise(r => setTimeout(r, 1500));
      expect((await windowsInfo(h.app)).length).toBe(before);
    } finally { await h.close(); }
  });

  // Overrides are injected as `selector { css }`, so an unbalanced brace would let
  // one row restyle the whole remote page (and pull in a remote url()).
  test('a CSS override cannot break out of its own rule', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await openSettings(h.app);
      await evalInWindow(h.app, 'settings.html', `window.kvmAPI.saveConfig({ cssOverrides: [
        { selector: '#x', css: 'color: red } body { background: url("http://evil.test/leak")', enabled: true, scope: 'all' }
      ] })`);

      const row = (h.readConfig().cssOverrides || [])[0];
      expect(row.css).not.toContain('}');
      expect(row.css).not.toContain('{');
    } finally { await h.close(); }
  });

  // Defence in depth, not a fixed bug: `scope` indexes video.servers, and today a
  // '__proto__' scope is inert (it retargets that object's prototype, creates no own
  // key, and does not survive JSON). Pin that down so it stays harmless.
  test('a video layer cannot be saved under a prototype-polluting scope', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a' }] });
    try {
      await openSettings(h.app);
      await evalInWindow(h.app, 'settings.html',
        `window.kvmAPI.saveVideoWB({ params: { r: 9, g: 1, b: 1, brightness: 1, contrast: 1, saturate: 1, sharpen: 0 }, scope: '__proto__' })`);

      const cfg = h.readConfig();
      expect(Object.keys(cfg.video.servers || {})).not.toContain('__proto__');
      const polluted = await evalInWindow(h.app, 'settings.html', `({}).r === undefined ? 'clean' : 'polluted'`);
      expect(polluted).toBe('clean');
    } finally { await h.close(); }
  });

  test('a blocked hotkey releases the matching menu accelerator', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a' }],
      blockedHotkeys: [{ key: 'm', meta: true, description: 'Minimize', enabled: true }]
    });
    try {
      // Cmd+M was claimed by the Window menu, so it minimised instead of reaching
      // the remote no matter what the Blocked Hotkeys tab said.
      await expect.poll(() => menuAccelerator(h.app, 'Minimize'), { timeout: 15000 }).toBe(null);
      expect(await menuAccelerator(h.app, 'Reload Session')).toBe('Cmd+R');
    } finally { await h.close(); }
  });

  test('a server name with quotes does not break the tab strip markup', async () => {
    const h = await launchApp({
      servers: [{ id: 'a', name: 'Office "A" <b>', host: kvm.url }],
      openSessions: [{ serverId: 'a' }],
      tabs: { position: 'right', overlay: true, showStrip: true, size: 76, items: [{ id: 'i1', serverId: 'a' }] }
    });
    try {
      await expect.poll(
        () => evalInView(h.app, 'tabbar.html', 'document.querySelectorAll(".tab").length'),
        { timeout: 15000 }
      ).toBe(1);

      const title = await evalInView(h.app, 'tabbar.html', 'document.querySelector(".tab").getAttribute("title")');
      expect(title).toBe('Office "A" <b>');
    } finally { await h.close(); }
  });
});
