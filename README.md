# leKVM

> **Warning:** This is fully vibecoded shitty code.

A macOS desktop wrapper around the [GL.iNet hardware KVM](https://www.gl-inet.com/) web UI, aiming to improve the UX. It blocks host hotkeys (so `Cmd+W` doesn't close the window while you're controlling the remote), hides excessive controls, corrects the video's color, and lets you juggle several KVMs at once.

## Features

- **Multiple servers** — save any number of KVM hosts and open them from the **Connections** menu, each in its own window.
- **Splash / connection picker** — on launch it reopens the windows you had open; if none, a splash screen lists your saved servers to pick from (or connect to an ad-hoc URL).
- **Session tabs** — one window, several sessions, switched from an edge-docked strip. Opening a server adds a tab by default; a tab can show a short name of your choosing, or just its position.
- **Live video adjustments** — a floating panel (⌥⌘C) with **white balance** (per-channel R/G/B), **brightness / contrast / saturation**, and **sharpen**, in two layers: a **Global** layer for all servers and a **This server** layer for the current tab. Changes preview live and **save automatically**.
- **White point picker** — the video is too blue? Let the app find the whitest-looking area and neutralise it, or click something that should be white. One step, undoable.
- **CSS overrides** — inject arbitrary CSS into the remote UI, scoped **globally or per-server**, applied instantly.
- **Hotkey blocking** — configurable list of macOS shortcuts that get passed through to the remote instead of acting on the host.
- **Camera / microphone passthrough** — optional, off by default: hand the remote
  machine your camera and mic as a virtual webcam and headset.
- **Persistent settings** and auto-reconnect / connection-error handling.

## Getting Started

Requires **Node 20+**. The app runs on Electron 44.

```bash
npm install
npm start          # run in development
npm run build      # build an unsigned macOS .dmg
```

`npm run build` outputs to `dist/` (e.g. `dist/leKVM-1.0.0-arm64.dmg` and `dist/mac-arm64/leKVM.app`). The build is **unsigned**, so on first launch macOS Gatekeeper will warn — right-click the app → **Open** once, or **System Settings → Privacy & Security → Open Anyway**.

To regenerate the app icons after changing `assets/icon.svg`:

```bash
node generate-icons.js
```

That writes the PNG ladder, `icon.icns` and `icon.ico` from the one SVG. The
`.icns` step needs `iconutil`, so it only runs on macOS; everything else works
anywhere.

## Appearance

**Settings → General → Theme**: Auto (the default, follows macOS), Dark or
Light. It applies to the app's own windows, not to the KVM's web UI.

## First run

With no servers configured, the app opens a setup screen: a name and an address,
`＋ Add more` for another, and three switches (use tabs, enable mic, enable
camera). Everything it sets can be changed afterwards in **Settings**.

Tabs can be closed from **Tabs → Close Tab** or by right-clicking a tab on the
strip. Closing a tab removes its row as well as its session, so it does not come
back on the next render. **Disconnect Tab**, in the same two places, drops the
connection and keeps the tab — click it again to reconnect.

**Reserved tabs** (Settings → Tabs) are slots kept on the strip for a server
whether or not it is open, with a short name and an order you can drag.

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

Configure them in **Settings → Tabs**. The first four settings are **one setting
each, shared by every tab** — not something you set per tab:

| Setting | Default | What it does |
|---|---|---|
| Open new servers in tabs | **on** | A server opens as a tab on the window you are using. Off: each one gets its own window. |
| Show the tab strip | **on** | The strip is visible on every window. |
| Suspend tabs in the background | **off** | Off, every tab keeps streaming. On, a backgrounded tab drops its stream to save bandwidth and reconnects when you switch back. |
| Strip location | right | Which edge the strip sits on, whether it floats **over the content** (in the letterbox bars) or takes its **own space**, and how thick it is. |

Below those is the list of **tabs**: a server, its URL (read-only), and an
optional **short name**. Drag the ≡ handle to reorder — that order is the order
they appear in the strip. A tab with no name shows its position instead, so an
unnamed strip reads `1 2 3`.

A server you open later is a tab too; it just has no saved slot, so it is added
**after** the predefined ones rather than shuffling them.

`Ctrl+Tab` / `Ctrl+Shift+Tab` cycle through them. Switching keeps every session
loaded and simply restacks them, so tabs swap instantly.

## Video Adjustments

Open with **View → Adjust Video Color…** (⌥⌘C). Two sections:

- **Global** — applies to every server (the base look).
- **This server** — applies only to the current tab; it stacks on top of the global layer (gains and tone multiply, sharpen adds). `1.000` = no change (`Sharpen 0` = off).

The panel is a child window of the session it was opened from, so it stays above that session (full-screen included) without floating over your other apps.

White balance is a real per-channel gain (SVG `feComponentTransfer`), sharpen is an SVG `feConvolveMatrix` unsharp kernel — both applied to the detected video element. Every change previews live on the active tab and saves automatically (no Save button).

## White Point

Rather than hunting for the right Red/Green/Blue by hand, point the app at
something that ought to be white and let it work them out.

- **View → Auto White Balance** (⌥⌘W) scans the picture for the area that most
  looks like it should be white and neutralises it.
- **View → Pick White Point…** (⇧⌥⌘W) puts a crosshair over the session; click
  something white and it averages **5×5 pixels** there.
- **View → Undo White Balance** puts back exactly what it replaced.

Both are also buttons in the ⌥⌘C panel, with an **Apply to** choice of *this
server* or *global*. Afterwards the sliders hold the computed numbers, so you can
nudge them or ignore them and set your own.

It samples the **raw** stream — what the KVM sent, before any correction — so the
gains come out absolute rather than relative to whatever is already applied. If a
patch that should be white reads `rgb(200, 205, 255)`, its mean is 220 and the
gains are `220/200`, `220/205`, `220/255`: blue down, red up.

Two things it will tell you rather than hide:

- **That area is blown out.** Once a channel hits 255 the excess is simply gone,
  so the correction is a floor, not a measurement. Auto prefers an area it *can*
  measure even when a brighter one is available — but a screen that is genuinely
  too blue often has blue pegged everywhere, so it falls back to a clipped area
  and says so rather than refusing.
- **It hit the slider limits.** The result is pinned to the range the panel
  offers, so a wild sample gives a compromise.

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
| `Alt + Cmd + W` | Auto white balance |
| `Shift + Alt + Cmd + W` | Pick white point |
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
- **Least-privilege permissions.** Pointer-lock, fullscreen and clipboard are
  granted; geolocation, USB/HID/serial and notifications are denied outright.
- **Camera and microphone are opt-in.** The KVM passes them to the remote
  machine as a virtual webcam and headset, so they *can* be granted — but they
  are off until you turn them on in **Settings → General**, and even then only
  for the device a session is pinned to. Our own local pages never get them, and
  neither does a suspended tab. Turning one on applies to every tab and window;
  macOS asks for its own permission at that moment.
- Local pages carry a strict CSP, and config coming back from Settings is
  coerced to shape before it is stored or injected.

These are enforced in `main.js` and covered by the `hardening` tests; `ARC.md`
documents where each one lives and which two are easiest to undo by accident.

The macOS build is **unsigned** — see *Getting Started* for the Gatekeeper prompt.

## Configuration

Settings are stored in `~/Library/Application Support/leKVM/config.json`.

## License

MIT
