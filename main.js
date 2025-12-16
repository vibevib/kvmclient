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

// Initialize store with defaults
const store = new Store({
  name: 'config',
  defaults: {
    host: 'http://192.168.8.222',
    cssOverrides: [
      { selector: '.un-collapse-triangle-collapsed', css: 'opacity: 0.01 !important', enabled: true },
      { selector: '.kvm-video-info', css: 'display: none !important', enabled: true },
      { selector: '#stream-canvas', css: 'filter: contrast(1.1) brightness(1.2)', enabled: true },
      { selector: '.kvm-page', css: 'height: 100% !important', enabled: true }
    ],
    blockedHotkeys: [
      { key: 'w', meta: true, description: 'Close tab', enabled: true },
      { key: 'q', meta: true, description: 'Quit app', enabled: true },
      { key: 't', meta: true, description: 'New tab', enabled: true },
      { key: 'n', meta: true, description: 'New window', enabled: true },
      { key: 'h', meta: true, description: 'Hide app', enabled: true },
      { key: 'm', meta: true, description: 'Minimize', enabled: true },
      { key: 'Tab', meta: true, description: 'App switcher', enabled: true }
    ]
  }
});

let mainWindow = null;
let browserView = null;
let settingsWindow = null;
let connectionError = null;

// Build CSS string from overrides
function buildCSS() {
  const overrides = store.get('cssOverrides') || [];
  return overrides
    .filter(o => o.enabled)
    .map(o => `${o.selector} { ${o.css} }`)
    .join(' ');
}

// Check if hotkey should be blocked
function isHotkeyBlocked(input) {
  const hotkeys = store.get('blockedHotkeys') || [];
  return hotkeys.some(h =>
    h.enabled &&
    h.key.toLowerCase() === input.key.toLowerCase() &&
    h.meta === input.meta
  );
}

// Show connect page on error
function showConnectPage(error) {
  connectionError = error;
  if (browserView) {
    browserView.webContents.loadFile('connect.html');
  }
}

// Try to connect to remote host
function connectToHost(host) {
  connectionError = null;
  if (host && host.trim()) {
    store.set('host', host);
    if (browserView) {
      browserView.webContents.loadURL(host);
    }
  } else {
    showConnectPage('No host configured');
  }
}

// Create app menu
function createMenu() {
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
      label: 'View',
      submenu: [
        {
          label: 'Reload Session',
          accelerator: 'Cmd+R',
          click: () => {
            if (browserView) {
              browserView.webContents.loadURL(store.get('host'));
            }
          }
        },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: 'Alt+Cmd+I', role: 'toggleDevTools' }
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

// Create the main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'icons', '512x512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Create BrowserView for remote session
  browserView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-remote.js'),
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: true,
      webSecurity: false
    }
  });

  mainWindow.setBrowserView(browserView);

  // Set BrowserView to fill the window
  const updateBounds = () => {
    const bounds = mainWindow.getContentBounds();
    browserView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  };
  updateBounds();
  mainWindow.on('resize', updateBounds);

  // Load the remote URL or show connect page
  const host = store.get('host');
  if (host && host.trim()) {
    browserView.webContents.loadURL(host);
  } else {
    showConnectPage('No host configured');
  }

  // Inject custom CSS when page loads
  browserView.webContents.on('did-finish-load', () => {
    const css = buildCSS();
    if (css) {
      browserView.webContents.insertCSS(css);
    }
  });

  // Also inject on navigation within the same session
  browserView.webContents.on('did-navigate-in-page', () => {
    const css = buildCSS();
    if (css) {
      browserView.webContents.insertCSS(css);
    }
  });

  // Handle connection failures
  browserView.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    // Ignore aborted loads (user navigated away)
    if (errorCode === -3) return;
    // Ignore if we're loading the connect page
    if (validatedURL.includes('connect.html')) return;

    const errorMsg = `Could not connect to ${validatedURL}\n${errorDescription} (${errorCode})`;
    showConnectPage(errorMsg);
  });

  // Handle HTTP errors (404, 500, etc.)
  browserView.webContents.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    // Only check main frame navigation, not sub-resources
    if (details.resourceType !== 'mainFrame') return;
    // Ignore local files
    if (details.url.startsWith('file://')) return;

    const statusCode = details.statusCode;
    if (statusCode >= 400) {
      const errorMsg = `HTTP Error ${statusCode} from ${details.url}`;
      showConnectPage(errorMsg);
    }
  });

  // CRITICAL: Intercept keyboard events before they trigger native actions
  browserView.webContents.on('before-input-event', (event, input) => {
    // cmd+` (backtick) - quit the app (always works)
    if (input.meta && input.key === '`') {
      app.isQuitting = true;
      app.quit();
      return;
    }

    // cmd+, - open settings (always works)
    if (input.meta && input.key === ',') {
      event.preventDefault();
      openSettings();
      return;
    }

    // Check if this hotkey should be blocked from native handling
    if (isHotkeyBlocked(input)) {
      // Don't prevent default - let it pass to the webview
    }
  });

  // Prevent the window from closing on cmd+w
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
    }
  });

  // Focus the BrowserView
  browserView.webContents.focus();
}

// Settings window
function openSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 700,
    height: 600,
    title: `${APP_NAME} Settings`,
    parent: mainWindow,
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

// IPC handlers
ipcMain.handle('get-config', () => {
  return {
    host: store.get('host'),
    cssOverrides: store.get('cssOverrides'),
    blockedHotkeys: store.get('blockedHotkeys')
  };
});

ipcMain.handle('save-config', (event, newConfig) => {
  const oldHost = store.get('host');

  if (newConfig.host !== undefined) store.set('host', newConfig.host);
  if (newConfig.cssOverrides !== undefined) store.set('cssOverrides', newConfig.cssOverrides);
  if (newConfig.blockedHotkeys !== undefined) store.set('blockedHotkeys', newConfig.blockedHotkeys);

  // Reload CSS in the browser view
  if (browserView) {
    const css = buildCSS();
    if (css) {
      browserView.webContents.insertCSS(css);
    }
  }

  // Reconnect if host changed
  if (newConfig.host !== undefined && newConfig.host !== oldHost) {
    connectToHost(newConfig.host);
  }

  return true;
});

ipcMain.handle('reload-session', () => {
  const host = store.get('host');
  if (host && host.trim()) {
    connectToHost(host);
  } else {
    showConnectPage('No host configured');
  }
});

ipcMain.handle('get-connection-error', () => {
  return connectionError;
});

ipcMain.handle('get-app-name', () => {
  return APP_NAME;
});

ipcMain.handle('connect', (event, host) => {
  connectToHost(host);
});

// Prevent default quit behavior
app.on('before-quit', () => {
  app.isQuitting = true;
});

// macOS: Prevent cmd+q from quitting immediately
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

  createMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
