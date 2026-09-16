// e2e helpers: launch the real app against an isolated profile + a fake KVM server.
const { _electron: electron } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Stands in for the GL.iNet KVM web UI: a #video-wrapper with a canvas inside it.
// /bad-iframe additionally embeds a sub-frame that cannot load.
function startFakeKvm() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/404')) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><body>nope</body>');
      return;
    }
    const badIframe = req.url.startsWith('/bad-iframe')
      ? '<iframe id="dead" src="http://127.0.0.1:9/nothing-here"></iframe>'
      : '';
    // /novideo has no media element at all, for the "nothing to sample" path.
    if (req.url.startsWith('/novideo')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body style="margin:0;background:#111">'
            + '<div id="marker">kvm-ok</div><p>no stream here</p></body></html>');
      return;
    }
    // The stream is painted from the query, so a test can put a known colour in
    // front of the white-point sampler:
    //   /tint?r=&g=&b=   the whole frame is that colour
    //   /patch?r=&g=&b=  a dark frame with one light patch in it
    const paint = `
      var c=document.getElementById('stream-canvas'), x=c.getContext('2d');
      var q=new URLSearchParams(location.search), p=location.pathname;
      function col(dr,dg,db){
        return 'rgb('+(q.get('r')||dr)+','+(q.get('g')||dg)+','+(q.get('b')||db)+')';
      }
      if (p.indexOf('/decoy') === 0) {
        // Dark frame, a bright patch with blue pegged at 255, and thin light
        // text that IS measurable but is a terrible white reference. The text
        // must not win just for being unclipped.
        x.fillStyle='#0e0e12'; x.fillRect(0,0,c.width,c.height);
        x.fillStyle='rgb(200,206,255)'; x.fillRect(96,60,128,90);
        x.fillStyle='#6a7a9a'; x.font='16px monospace';
        x.fillText('this patch should be white', 20, 200);
      } else if (p.indexOf('/two') === 0) {
        // A blown-out white block AND a dimmer, unclipped one that is slightly
        // blue. The clipped block scores higher on brightness, so this tells
        // apart "prefers bright" from "prefers measurable".
        x.fillStyle='#101010'; x.fillRect(0,0,c.width,c.height);
        x.fillStyle='rgb(255,255,255)'; x.fillRect(20,20,60,60);
        x.fillStyle='rgb(190,195,230)'; x.fillRect(180,120,100,100);
      } else if (p.indexOf('/patch') === 0) {
        x.fillStyle='#101010'; x.fillRect(0,0,c.width,c.height);
        x.fillStyle=col(220,224,255); x.fillRect(40,40,80,80);
      } else if (p.indexOf('/tint') === 0) {
        x.fillStyle=col(255,255,255); x.fillRect(0,0,c.width,c.height);
      }
      document.getElementById('marker').dataset.painted = '1';
    `;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body style="margin:0;background:#111">
      <div id="video-wrapper"><canvas id="stream-canvas" width="320" height="240"></canvas></div>
      <div id="marker">kvm-ok</div>${badIframe}<script>${paint}<\/script></body></html>`);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

// Launch the app with a throwaway userData dir seeded with `config`.
async function launchApp(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvm-e2e-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  const app = await electron.launch({ args: [ROOT, `--user-data-dir=${dir}`], cwd: ROOT });
  return {
    app,
    dir,
    readConfig() {
      const p = path.join(dir, 'config.json');
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    },
    async close() {
      try { await app.close(); } catch (e) { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// --- main-process probes ----------------------------------------------------

// Every window with its child-view URLs (sessions + the tab strip).
// contentView.children holds plain views too, so keep only the ones with
// webContents — i.e. the WebContentsViews the app attached.
const windowsInfo = (app) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().map(w => ({
    id: w.id,
    title: w.getTitle(),
    url: w.webContents.getURL(),
    views: w.contentView.children.filter(v => v.webContents).map(v => v.webContents.getURL())
  })));

// Session views = everything that isn't the tab strip.
async function sessionUrls(app) {
  const wins = await windowsInfo(app);
  return wins
    .filter(w => !w.url.includes('settings.html') && !w.url.includes('color.html'))
    .flatMap(w => w.views.filter(u => !u.includes('tabbar.html')));
}

// Run JS inside the first child view whose URL matches `match`.
const evalInView = (app, match, js) => app.evaluate(({ BrowserWindow }, { match, js }) => {
  for (const w of BrowserWindow.getAllWindows()) {
    for (const v of w.contentView.children) {
      if (!v.webContents) continue;
      if ((v.webContents.getURL() || '').includes(match)) return v.webContents.executeJavaScript(js);
    }
  }
  return null;
}, { match, js });

// Run JS inside a top-level window whose URL matches `match` (settings/color).
const evalInWindow = (app, match, js) => app.evaluate(({ BrowserWindow }, { match, js }) => {
  const w = BrowserWindow.getAllWindows().find(w => (w.webContents.getURL() || '').includes(match));
  return w ? w.webContents.executeJavaScript(js) : null;
}, { match, js });

// Electron installs a DEFAULT menu before the app's own createMenu() runs, so wait
// for one of our labels before trusting a lookup.
const findMenuItem = (app, label) => app.evaluate(({ Menu }, label) => {
  const menu = Menu.getApplicationMenu();
  if (!menu) return null;
  for (const top of menu.items) {
    if (!top.submenu) continue;
    const hit = top.submenu.items.find(i => i.label === label);
    if (hit) return { accelerator: hit.accelerator || null };
  }
  return null;
}, label);

async function waitForMenuItem(app, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = await findMenuItem(app, label);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`menu item "${label}" never appeared`);
    await new Promise(r => setTimeout(r, 250));
  }
}

// Click an application-menu item by label (searches all submenus, one level deep).
async function clickMenu(app, label) {
  await waitForMenuItem(app, label);
  return app.evaluate(({ Menu }, label) => {
    const menu = Menu.getApplicationMenu();
    for (const top of menu.items) {
      if (!top.submenu) continue;
      const hit = top.submenu.items.find(i => i.label === label);
      if (hit) { hit.click(); return true; }
    }
    return false;
  }, label);
}

// Our menu's accelerator for `label` (waits past the default menu first).
async function menuAccelerator(app, label) {
  await waitForMenuItem(app, label);
  const hit = await findMenuItem(app, label);
  return hit ? hit.accelerator : undefined;
}

// Top-level application-menu labels — null if no menu is installed at all.
const menuTopLevel = (app) => app.evaluate(({ Menu }) => {
  const m = Menu.getApplicationMenu();
  return m ? m.items.map(i => i.label) : null;
});

// Every accelerator the application menu claims, roles included.
const menuAccelerators = (app) => app.evaluate(({ Menu }) => {
  const m = Menu.getApplicationMenu();
  if (!m) return null;
  const out = [];
  for (const top of m.items) {
    if (!top.submenu) continue;
    for (const i of top.submenu.items) if (i.accelerator) out.push(i.accelerator);
  }
  return out;
});

const webContentsCount = (app) => app.evaluate(({ webContents }) => webContents.getAllWebContents().length);

module.exports = {
  ROOT, startFakeKvm, launchApp,
  windowsInfo, sessionUrls, evalInView, evalInWindow,
  clickMenu, menuAccelerator, waitForMenuItem, webContentsCount,
  menuTopLevel, menuAccelerators
};
