const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  startFakeKvm, launchApp, windowsInfo, sessionUrls,
  evalInView, evalInWindow, clickMenu, menuAccelerator, webContentsCount
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
      openSessions: [{ serverId: 'a', show: false }]
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
      openSessions: [{ serverId: 'a', show: false }]
    });
    try {
      await expect.poll(() => sessionUrls(h.app), { timeout: 20000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('connect.html')]));
    } finally { await h.close(); }
  });

  test('closing a window tears down its session webContents', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a', show: false }, { serverId: 'b', show: false }]
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
    const first = await launchApp({ servers: servers(), openSessions: [{ serverId: 'b', show: false }] });
    let saved;
    try {
      await expect.poll(() => sessionUrls(first.app), { timeout: 15000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));
      saved = first.readConfig();
    } finally { await first.close(); }

    expect(saved.openSessions).toEqual([{ serverId: 'b', show: false }]);
  });
});

test.describe('tab strip', () => {
  test('two buttons for the same server are independent sessions', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a', show: true }],
      tabs: {
        position: 'right', overlay: true, showButtons: true, size: 76,
        items: [
          { id: 'i1', serverId: 'a', behavior: 'keep' },
          { id: 'i2', serverId: 'a', behavior: 'keep' }
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
      openSessions: [{ serverId: 'a', show: true }],
      tabs: {
        position: 'right', overlay: true, showButtons: true, size: 76,
        items: [
          { id: 'i1', serverId: 'a', behavior: 'keep' },
          { id: 'i2', serverId: 'b', behavior: 'keep' }
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

test.describe('settings + css', () => {
  test('rapid CSS toggles settle on the final state', async () => {
    const h = await launchApp({
      servers: servers(),
      openSessions: [{ serverId: 'a', show: false }],
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
      tabs: { position: 'right', overlay: true, showButtons: true, size: 76, items: [{ id: 'i1', serverId: 'b', behavior: 'keep' }] }
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

test.describe('video adjustments', () => {
  test('layers persist outside cssOverrides and survive a Settings save', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a', show: false }] });
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
      openSessions: [{ serverId: 'a', show: false }],
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
      openSessions: [{ serverId: 'a', show: false }],
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

test.describe('hardening', () => {
  test('a remote page cannot read the server list or redirect the session', async () => {
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a', show: false }] });
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
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a', show: false }] });
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
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a', show: false }] });
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
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a', show: false }] });
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
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a', show: false }] });
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
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a', show: false }] });
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
    const h = await launchApp({ servers: servers(), openSessions: [{ serverId: 'a', show: false }] });
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
      openSessions: [{ serverId: 'a', show: false }],
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
      openSessions: [{ serverId: 'a', show: true }],
      tabs: { position: 'right', overlay: true, showButtons: true, size: 76, items: [{ id: 'i1', serverId: 'a', behavior: 'keep' }] }
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
