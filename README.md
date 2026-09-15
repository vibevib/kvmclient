# KVM

> **Warning:** This is fully vibecoded shitty code.

A macOS desktop wrapper around the [GL.iNet hardware KVM](https://www.gl-inet.com/) web UI, aiming to improve the UX. It blocks host hotkeys (so `Cmd+W` doesn't close the window while you're controlling the remote), hides excessive controls, corrects the video's color, and lets you juggle several KVMs at once.

## Features

- **Multiple servers** — save any number of KVM hosts and open them from the **Connections** menu, each in its own window.
- **Splash / connection picker** — on launch it reopens the windows you had open; if none, a splash screen lists your saved servers to pick from (or connect to an ad-hoc URL).
- **Session tabs** — turn any window into a multi-session window with an edge-docked button strip (**Tabs → Show Session Tabs**). Click a button to connect/switch to that server *in the same window*; each tab can **keep** streaming in the background or **suspend** to save bandwidth.
- **Live video adjustments** — a floating panel (⌥⌘C) with **white balance** (per-channel R/G/B), **brightness / contrast / saturation**, and **sharpen**, in two layers: a **Global** layer for all servers and a **This server** layer for the current tab. Changes preview live and **save automatically**.
- **CSS overrides** — inject arbitrary CSS into the remote UI, scoped **globally or per-server**, applied instantly.
- **Hotkey blocking** — configurable list of macOS shortcuts that get passed through to the remote instead of acting on the host.
- **Persistent settings** and auto-reconnect / connection-error handling.

## Getting Started

Requires **Node 20+**. The app runs on Electron 44.

```bash
npm install
npm start          # run in development
npm run build      # build an unsigned macOS .dmg
```

`npm run build` outputs to `dist/` (e.g. `dist/KVM-1.0.0-arm64.dmg` and `dist/mac-arm64/KVM.app`). The build is **unsigned**, so on first launch macOS Gatekeeper will warn — right-click the app → **Open** once, or **System Settings → Privacy & Security → Open Anyway**.

To regenerate app icons after changing `assets/icon.png`:

```bash
node generate-icons.js
```

## Tests

End-to-end tests drive the real app with Playwright's Electron support — each one
launches the app against a throwaway profile and a fake KVM web server, so they
never touch your config or need real hardware.

```bash
npm test
```

They cover the splash/picker, session restore, tab-strip switching, live CSS
overrides, the video-adjustment layers, and the security boundary below — a
hostile remote page trying to read local files, read cross-origin responses,
redirect the session off the device, or open popups.

## Servers & Connections

Add servers in **Settings → General** (name + host; a bare IP like `192.168.1.100` gets `http://` added automatically). Open them from the **Connections** menu — each click opens a new window/instance.

## Session Tabs

Configure the shared session strip in **Settings → Tabs**: pick the button **position** (left/right/top/bottom), whether it floats **over the content** (transparent, sits in the letterbox bars) or takes its **own space** (shrinks the video), its **size**, and the list of **session buttons** (a server + keep/suspend behavior).

Then, on any window, **Tabs → Show Session Tabs** toggles the strip. Switching keeps every session view loaded and simply restacks them, so tabs swap instantly. `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle sessions.

## Video Adjustments

Open with **View → Adjust Video Color…** (⌥⌘C). Two sections:

- **Global** — applies to every server (the base look).
- **This server** — applies only to the current tab; it stacks on top of the global layer (gains and tone multiply, sharpen adds). `1.000` = no change (`Sharpen 0` = off).

The panel is a child window of the session it was opened from, so it stays above that session (full-screen included) without floating over your other apps.

White balance is a real per-channel gain (SVG `feComponentTransfer`), sharpen is an SVG `feConvolveMatrix` unsharp kernel — both applied to the detected video element. Every change previews live on the active tab and saves automatically (no Save button).

## CSS Overrides

Add/edit rules in **Settings → CSS Overrides**. Each rule has a selector, CSS, and an **Apply to** scope (all servers or one). Defaults hide clutter and correct the stream; changes apply live.

Video adjustments are **not** stored here — they live under their own `video` key in the config, so saving the Settings pane can't clobber them. (Older configs that kept them as a `#video-wrapper` rule are migrated automatically on launch.)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd + ,` | Open settings |
| `Cmd + R` | Reload the active session |
| `Cmd + `` ` `` | Quit application |
| `Alt + Cmd + C` | Adjust video color |
| `Alt + Cmd + I` | Toggle DevTools (for the active session) |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | Next / previous session (tabbed window) |

## Blocked Hotkeys

These macOS shortcuts are passed through to the remote instead of acting on the host (editable in **Settings → Blocked Hotkeys**):

`Cmd + W`, `Cmd + Q`, `Cmd + T`, `Cmd + N`, `Cmd + H`, `Cmd + M`, `Cmd + Tab`

These work by the menu simply *not* claiming the shortcut, so the key falls
through to the remote session — which is why the app quits on `Cmd + \`` rather
than `Cmd + Q`.

## Security

The KVM web UI is served over plain **HTTP on your LAN**, so anyone on that
network can tamper with it in transit. The app therefore treats the remote page
as **untrusted** and confines it:

- **No local file or cross-origin access.** Renderers run with `webSecurity` and
  `contextIsolation` on, `nodeIntegration` off and `sandbox` on, so the remote
  page can't read files off your Mac or read responses from other hosts.
- **Navigation is pinned to the device.** A session can only navigate within the
  host it's connected to (or back to the local connect page); popups and
  `<webview>` are denied, so a redirect can't carry the session — and its
  privileges — onto an arbitrary site.
- **Privileged IPC is local-only.** The settings/connect/colour/tab pages can
  call it; the remote page shares a preload with the connect page but is rejected
  by an explicit sender check.
- **Certificates are only waived for your KVM.** A self-signed cert is accepted
  only from a **private-network address you configured** (RFC1918, loopback,
  link-local, CGNAT or `.local`). Certificates from anywhere else are validated
  normally.
- **Least-privilege permissions.** Only pointer-lock, fullscreen and clipboard
  are granted; camera, microphone, geolocation, USB/HID/serial and notifications
  are denied.
- Local pages carry a strict CSP, and config coming back from Settings is
  coerced to shape before it is stored or injected.

These are enforced in `main.js` and covered by the `hardening` tests; `ARC.md`
documents where each one lives and which two are easiest to undo by accident.

The macOS build is **unsigned** — see *Getting Started* for the Gatekeeper prompt.

## Configuration

Settings are stored in `~/Library/Application Support/KVM/config.json`.

## License

MIT
