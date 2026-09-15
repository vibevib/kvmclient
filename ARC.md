# KVM Architecture

## Overview
KVM - macOS Electron app that displays remote browser session at 192.168.1.100, intercepts system hotkeys, and supports custom CSS injection.

## Tech Stack
- **Electron** (v44+)
- **Node.js** (v20+)

## Core Components

### 1. Main Process (`main.js`)
- Create frameless BrowserWindow
- Register `before-input-event` handler to intercept hotkeys
- Load config from `~/Library/Application Support/KVM/config.json`
- Block app quit except on cmd+`

### 2. WebContentsView
- Loads `http://192.168.1.100`
- Receives all keyboard events naturally
- CSS injected via `webContents.insertCSS()` on `did-finish-load`

### 3. Config (electron-store)
Location: `~/Library/Application Support/KVM/config.json` (macOS)
```json
{
  "host": "http://192.168.1.100",
  "customCSS": ".un-collapse-triangle-collapsed{opacity:0.01 !important} ..."
}
```

## Hotkey Handling

```
┌─────────────────┐
│ Keyboard Input  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ before-input-event      │
│ (intercept ALL keys)    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ cmd+` ?                 │──Yes──► app.quit()
└────────┬────────────────┘
         │ No
         ▼
┌─────────────────────────┐
│ Pass to webContents     │
│ (remote session)        │
└─────────────────────────┘
```

**Blocked from native handling:** cmd+w, cmd+q, cmd+t, cmd+n, cmd+h

## File Structure
```
kvm/
├── package.json
├── main.js           # Main process
├── preload.js        # Bridge for settings UI
├── settings.html     # Settings window
├── assets/
│   └── icon.icns     # App icon
└── config/
    └── default.json  # Default config
```

## CSS Injection Flow
1. App starts → load config
2. WebContentsView loads remote URL
3. `did-finish-load` event fires
4. `webContents.insertCSS(config.customCSS)`

## Settings Access
- **Quick:** Edit `~/Library/Application Support/KVM/config.json` directly (macOS)
  - Hand-edited config is read defensively. A malformed `blockedHotkeys` row used
    to throw inside `createMenu()`, leaving the app on Electron's **default** menu
    for the rest of the session — no Connections or Tabs, and a `Cmd+Q` bound to
    Quit instead of passing through to the remote. Bad rows are now skipped, and
    `createMenu()` falls back to a minimal menu rather than none.
- **GUI:** Settings window via cmd+,
- **Defaults:** Bundled in app, auto-created on first launch

## Build
```bash
npm init -y
npm install electron --save-dev
npx electron .
```

## Package for macOS
```bash
npm install electron-builder --save-dev
npx electron-builder --mac
```

## Security Model

The remote KVM UI is **untrusted content**. It is served over plain HTTP on the
LAN, so anyone on that network can rewrite it in transit — the app is built so
that a hostile page in a session view cannot reach the host machine.

The invariants, all covered by tests in `tests/e2e.spec.js` (`hardening`):

| Invariant | Where |
|---|---|
| `webSecurity` and `contextIsolation` on, `nodeIntegration` off, `sandbox` on for every renderer | `createSession`, `openServerWindow`, `openSettings`, `openColorAdjust`, `setStripShown` |
| A session may only navigate within the device it is connected to, or to a local page | `sessionAllowsUrl` / `guardSessionNavigation` |
| Popups and `<webview>` are denied outright | `guardSessionNavigation` |
| Privileged IPC is reachable only from the local pages we ship | `isTrustedSender` / `isLocalPageUrl` |
| Certificate errors are waived only for a **private-network** host the user configured | `certificate-error` handler, `isPrivateHostname` + `knownHostnames` |
| Only pointer-lock, fullscreen and clipboard permissions are granted | `ALLOWED_PERMISSIONS` |
| Config from Settings is coerced to shape before it is stored or injected | `sanitizeServers` / `sanitizeOverrides` / `sanitizeHotkeys` / `sanitizeTabs` |
| Local pages carry a strict CSP (`default-src 'none'`) | `<meta>` in each `.html` |

Two rules are load-bearing and easy to undo by accident:

- **Never set `webSecurity: false`.** It lets the remote page read any local file
  (`fetch('file:///…')`) and any cross-origin response, and post both anywhere.
- **Never use the `ignore-certificate-errors` switch, or `callback(true)`
  unconditionally in `certificate-error`.** Both disable TLS validation for every
  host the app talks to, not just the KVM on the LAN.
