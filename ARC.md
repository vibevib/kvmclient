# RC Architecture

## Overview
RC (Remote Control) - macOS Electron app that displays remote browser session at 192.168.8.222, intercepts system hotkeys, and supports custom CSS injection.

## Tech Stack
- **Electron** (v28+)
- **Node.js** (v20+)

## Core Components

### 1. Main Process (`main.js`)
- Create frameless BrowserWindow
- Register `before-input-event` handler to intercept hotkeys
- Load config from `~/.kvmclient/config.json`
- Block app quit except on cmd+`

### 2. BrowserView
- Loads `http://192.168.8.222`
- Receives all keyboard events naturally
- CSS injected via `webContents.insertCSS()` on `did-finish-load`

### 3. Config (electron-store)
Location: `~/Library/Application Support/RC/config.json` (macOS)
```json
{
  "host": "http://192.168.8.222",
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
rc/
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
2. BrowserView loads remote URL
3. `did-finish-load` event fires
4. `webContents.insertCSS(config.customCSS)`

## Settings Access
- **Quick:** Edit `~/Library/Application Support/RC/config.json` directly (macOS)
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
