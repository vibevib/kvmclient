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
  - A server written by hand has no `id`, and ids are what every lookup keys on
    (tab buttons, per-server CSS scope, per-server video layers, session
    restore). With both sides `undefined`, `s.id === wanted` matched **every**
    server. `getServers()` backfills missing/duplicate ids on read — as
    `tabItems()` already did for tab buttons — and `getServerById()` refuses a
    falsy id rather than returning the first server that lacks one.
- **GUI:** Settings window via cmd+,
- **Defaults:** Bundled in app, auto-created on first launch

## Window Parenting

macOS keeps a child window above its parent, including over a full-screen
parent, and sinks it with the app when you switch away. That is why the colour
panel is a child of a session window rather than always-on-top — but it makes
`parent:` load-bearing, and getting it wrong is not cosmetic:

| Window | Parent | Why |
|---|---|---|
| Colour panel | the **active** session window, re-parented on focus | it adjusts whichever session is in front, so it has to follow the front one |
| Settings | **none** | a singleton editing global config. It was `getFocusedWindow()`, which made it a child of the colour panel when that panel was in front — and closing the panel then destroyed Settings along with any unsaved edits |

`getFocusedWindow()` is the recurring trap here: Settings and the colour panel
are windows *without* sessions, so anything that reaches for "the current
window" must use `activeTabbedWin()` / `getActiveServerRec()` instead.

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

## Tab Settings

Four settings are **one setting each for every tab**, stored on `tabs` in the
config: `openNewInTabs`, `showStrip`, `behavior` (`keep`/`suspend`) and
`position`. `tabs.items` is the list of predefined tabs — `{ id, serverId, label }`,
where `label` is the short name shown on the tab and blank means "show the
position instead".

Two of these used to live somewhere narrower, and the change is migrated once at
startup by `migrateTabSettings()`:

- `behavior` was on every item. The shared value becomes `suspend` only if
  **every** item asked for it, so a mixed config does not start suspending tabs
  that were not suspending before.
- Strip visibility was per window, persisted in each `openSessions` entry as
  `show`. It becomes `showStrip`, true if any window had the strip up.
- `enabled` and `showButtons` drove nothing and are dropped.

`migrateTabSettings()` must run **after** `safeId`/`asStr`, which are `const`
arrow functions — placing it earlier in the file puts those in the temporal dead
zone and the app fails to start at all.

`winTabEntries(win)` is the single source of tab order: every predefined item
first (each claiming a matching session, adopting an item-less one if needed),
then any remaining sessions in that window. That is what puts an ad-hoc tab after
the predefined ones. The strip, the Tabs menu and `Ctrl+Tab` all index into it, so
they can never disagree about what the tabs are.

`activateEntryInWin` trusts that resolution rather than re-adopting: when it
focuses a session for an item it stamps `session.itemId`, so a **second** tab for
the same server opens its own session instead of adopting the first one again.

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
