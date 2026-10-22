# pi-rdp-computer-use

Full desktop control for [Pi](https://pi.dev) over **RDP or VNC**: the agent sees a remote desktop as images and drives it with mouse and keyboard events.

Built for Wayland desktops, where X11 automation tools (`xdotool`), screen grabbers (`scrot`/`import`) and input injectors (`ydotool`, `uinput`) are unavailable or need root. This extension needs none of them: it speaks the remote desktop protocol directly.

Two transports, identical tools:

| Protocol | Bridge | Use when |
| --- | --- | --- |
| `rdp` (default) | `bridge/rdp_bridge.py` (aardwolf) | Windows, `xrdp`, any NLA-capable server |
| `vnc` | `bridge/vnc_bridge.py` (own RFB 3.8 client) | GNOME Remote Desktop, `x11vnc`, wayvnc, TigerVNC — and when RDP auth is broken server-side |

## How it works

```
Pi extension (extensions/rdp.ts)
        │  newline-delimited JSON over stdio
        ▼
Python bridge (bridge/*.py)  ── RDP (aardwolf) or RFB 3.8 ──▶  desktop server
        │                                   ▲
        │  bitmap updates → PNG             │  input events
        ▼                                   │
   model sees an image                 click / type / scroll / drag
```

* **No display required.** The bridge never opens a window, so it runs on headless machines and under Wayland alike.
* **Observation** is the remote framebuffer, decoded and returned to the model as a PNG (or JPEG, on request).
* **Input** is sent as RDP fastpath input events and RFB pointer/key events, so it works in any layout and needs no local input permissions.
* **Resilient geometry.** Servers that ignore the requested resolution (GNOME Remote Desktop shares the real screen size) are handled by a tracking canvas, so frames are never cropped or dropped.
* **Self-healing.** If the bridge or the server drops the session, the next tool call reconnects with the stored credentials.
* **Clean disconnects.** `rdp_disconnect` ends the bridge's read loop and closes the socket with a FIN, so the server tears the session down properly. Killing the bridge instead leaves a half-open session behind, and gnome-remote-desktop then refuses every new connection.

## Tools

The tools are registered with `deferred` exposure: Pi does not spend context on them until the agent looks for them. `tool_search` finds them by name and description, and the extension activates `tool_search` at session start when it is available.

| Tool | What it does |
| --- | --- |
| `rdp_connect` | Open a session (RDP or VNC) and report the desktop size. Falls back to the other transport if the first one fails. |
| `rdp_screenshot` | Capture the full desktop **or a region** of it, with the mouse cursor highlighted by a magenta crosshair. |
| `rdp_mouse` | Left, right or middle click at any desktop pixel, move, drag, press/release a held button, or scroll up/down/left/right. |
| `rdp_keyboard` | Type text (Unicode, layout independent) or press a named key or combination (`enter`, `tab`, `escape`, `f5`, `ctrl+c`, `alt+tab`). |
| `rdp_wait` | Wait until the screen changes, instead of sleeping blindly. |
| `rdp_disconnect` | Close the session and stop the bridge. |
| `rdp_status` | Session state, transport, geometry, pointer position, last error. |
| `rdp_clipboard` | Read the remote clipboard (VNC transport only). |

### Coordinates

Every coordinate is a **desktop pixel**: the origin is the top-left of the whole screen, and the size is the one reported by `rdp_connect` (`1920x1080` for a 1080p display, and larger on a multi-monitor desktop).

A screenshot reports the mapping back to desktop pixels, so the agent never has to guess:

```
Full desktop 1920x1080.
Image pixel (ix, iy) = desktop (ix/1, iy/1).
Mouse cursor at desktop (640, 360), marked with a magenta crosshair.
```

```
Region 800x400 of the 1920x1080 desktop, origin at desktop (0, 0).
Image pixel (ix, iy) = desktop (0 + ix/1, 0 + iy/1). Use those desktop coordinates for rdp_mouse.
```

If the capture was downscaled (`max_width`, `max_height`), the scale factor is included in the same formula. `rdp_mouse` also accepts `space: "image"`, which interprets the coordinates in the pixel space of the last screenshot instead of the desktop.

### Screenshot options

| Option | Effect |
| --- | --- |
| `region` | `{x, y, width, height}` — capture only that part of the screen. |
| `mark_region` | Outline an area on a full-desktop capture to show where to look. |
| `highlight_cursor` | Draw the magenta crosshair at the mouse cursor (default on). |
| `cursor_x`, `cursor_y` | Mark a known cursor position explicitly. |
| `max_width`, `max_height` | Downscale the image (the scale is reported back). |
| `format`, `quality` | `png` (default) or `jpeg`. |
| `ocr`, `ocr_lang` | Also return the text on screen, read with tesseract (`eng` by default). |
| `full_refresh` | Ask the server for the whole framebuffer instead of only what changed. |

### OCR

With `ocr: true` the capture is also read by tesseract and the text comes back with the image:

```
Text on screen (OCR):
Files   Home   Recent   Starred
```

A vision model reads the image anyway, but exact text (a version number, an error
message, a file name) is far more reliable when it is spelled out. The capture
is never cropped for OCR: a region uses a single block of text, a full screen
uses sparse text. Tesseract runs on the machine that runs Pi, not on the remote
desktop, so it works for any transport.

## Install

```bash
pi install git:github.com/hakergeniusz/pi-rdp-computer-use
```

Or load a checkout directly while developing:

```bash
pi --extension ~/Projects/pi-rdp-computer-use/extensions/rdp.ts
```

## Configure

Credentials are resolved in this order: tool parameter → environment variable → config file.

| Setting | Environment | Config file |
| --- | --- | --- |
| protocol | `PI_RDP_PROTOCOL` | `protocol` (`rdp` or `vnc`) |
| host | `RDP_HOST` | `host` |
| port | `RDP_PORT` | `port` (default `3389` RDP, `5900` VNC) |
| username | `RDP_USERNAME` | `username` (RDP only) |
| password | `RDP_PASSWORD` | `password` |
| domain | `RDP_DOMAIN` | `domain` |
| geometry | – | `width`, `height` |
| screenshot cap | – | `maxScreenshotWidth` |
| python | `PI_RDP_PYTHON` | `python` |
| consent | `PI_RDP_CONSENT` | `consent.mode`, `consent.screenshots`, `consent.timeoutMs` |

Config file: `~/.config/pi-rdp-computer-use/config.json`

```json
{
  "protocol": "vnc",
  "host": "127.0.0.1",
  "port": 5900,
  "password": "secret12",
  "consent": { "mode": "session", "timeoutMs": 180000 }
}
```

Prefer `RDP_PASSWORD` or a `chmod 600` config file over passing passwords in tool arguments: passwords appear in session transcripts. The extension never logs the password and strips it from tool details.

### Consent

`consent.mode` decides how often the agent has to ask before touching the desktop:

| Mode | Behaviour |
| --- | --- |
| `session` (default) | One confirmation when the session is opened, then free rein for that session. |
| `action` | A confirmation before every click, drag, scroll and keystroke. |
| `off` | Never ask. |

A prompt that nobody answers within `consent.timeoutMs` (default 3 minutes) counts as a refusal, so a forgotten dialog can never turn into unattended remote control. The legacy `consent.actions` boolean is still honoured: `false` means `off`, `true` means `action`.

## Command line

```bash
/rdp status                      # session state
/rdp doctor                      # environment facts
/rdp shot [path]                 # save a full screenshot
/rdp region x y w h [path]       # save a region screenshot
/rdp disconnect                  # close the session
```

## Troubleshooting

* **RDP connects but every click is ignored** — the server is in view-only mode:
  `grdctl rdp disable-view-only` (and `gsettings set org.gnome.desktop.remote-desktop.vnc view-only false` for VNC).
* **VNC connects but the banner never arrives** — the server waits for a desktop dialog:
  `gsettings set org.gnome.desktop.remote-desktop.vnc auth-method password`.
* **NLA rejects every client** — a known gnome-remote-desktop bug; the VNC transport is the workaround, and `rdp_connect` falls back to it automatically.
* **"Session creation inhibited"** — the server still holds a session from an earlier client that vanished without a clean disconnect. Restart the daemon with `systemctl --user restart gnome-remote-desktop.service`; if the message persists, log out and back in (the compositor keeps the session state).
* **The screen looks frozen** — the server only sends what changed; `full_refresh: true` asks for the whole framebuffer.

## License

MIT
