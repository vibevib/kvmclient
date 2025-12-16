# KVM Client

> **Warning:** This is fully vibecoded shitty code.

A simple wrapper around [GL.iNet hardware KVM](https://www.gl-inet.com/) web UI aiming to improve the UX. It blocks host hotkeys (so that `Cmd+W` doesn't close your browser window on the host computer), hides excessive controls, and improves the contrast of the video stream.

## Features

- Connect to remote KVM hosts over HTTP/HTTPS
- Custom CSS injection for UI customization
- Hotkey blocking to prevent accidental window actions
- Auto-reconnect with connection error handling
- Persistent settings

## Getting Started

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build for macOS
npm run build
```

The build outputs a `.dmg` installer to `dist/`.

## Building from Source

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Generate app icons (if modifying `assets/icon.png`):
   ```bash
   node generate-icons.js
   ```
4. Build the app:
   ```bash
   npm run build
   ```
5. Find the installer at `dist/KVM Client-1.0.0.dmg`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd + ,` | Open settings |
| `Cmd + `` ` `` | Quit application |
| `Cmd + R` | Reload session |

## Blocked Hotkeys

These macOS shortcuts are blocked by default to prevent accidental window actions while controlling the remote machine:

| Shortcut | Default Action (Blocked) |
|----------|--------------------------|
| `Cmd + W` | Close tab |
| `Cmd + Q` | Quit app |
| `Cmd + T` | New tab |
| `Cmd + N` | New window |
| `Cmd + H` | Hide app |
| `Cmd + M` | Minimize |
| `Cmd + Tab` | App switcher |

## CSS Overrides

Default CSS rules adjust the video stream for better visibility:

- **Video contrast/brightness** - `filter: contrast(1.1) brightness(1.2)` on `#stream-canvas`
- **Hide video info overlay** - `.kvm-video-info`
- **Hide collapse triangles** - `.un-collapse-triangle-collapsed`
- **Full height layout** - `.kvm-page`

All overrides are editable in Settings > CSS Overrides.

## Configuration

Settings are stored in `~/Library/Application Support/kvmclient/config.json`.

## Customization

To change the app name, edit `productName` in `package.json`. The name is automatically reflected in menus, window titles, and the UI.

## License

MIT
