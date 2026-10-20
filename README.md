# pi-rdp-computer-use

Computer use over **RDP or VNC** for [Pi](https://pi.dev): the agent sees a remote desktop as images and drives it with mouse and keyboard events.

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
* **Observation** is the RDP framebuffer, decoded and returned to the model as a PNG.
* **Input** is sent as RDP fastpath input events (mouse + Unicode/scancode keyboard), so it works in any layout and needs no local input permissions.
* **Resilient geometry.** Servers that ignore the requested resolution (GNOME Remote Desktop shares the real screen size) are handled by a tracking canvas, so frames are never cropped or dropped.

## Requirements

* Pi with extension support
* `uv` (runs the Python bridge; dependencies are installed on demand)
* A desktop server that accepts your credentials: RDP (Windows, `xrdp`, GNOME Remote Desktop) or VNC (GNOME Remote Desktop, `x11vnc`, wayvnc, TigerVNC)

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
| consent | – | `consent.actions`, `consent.screenshots`, `consent.timeoutMs` |

Config file: `~/.config/pi-rdp-computer-use/config.json`

```json
{
  "protocol": "vnc",
  "host": "127.0.0.1",
  "port": 5900,
  "password": "••••••••",
  "consent": { "actions": true, "timeoutMs": 180000 }
}
```

Prefer `RDP_PASSWORD` or a `chmod 600` config file over passing passwords in tool arguments: passwords appear in session transcripts. The extension never logs the password and strips it from tool details.

To avoid the on-demand `uv` install, point `PI_RDP_PYTHON` at an interpreter that already has `aardwolf` and `pillow`:

```bash
uv venv ~/.local/share/pi-rdp
uv pip install --python ~/.local/share/pi-rdp/bin/python aardwolf pillow
export PI_RDP_PYTHON=~/.local/share/pi-rdp/bin/python
```

## VNC backend (GNOME Remote Desktop)

GNOME Remote Desktop's VNC backend is the reliable path on Wayland: it shares the
live session, and its password authentication has none of the NLA machinery that
RDP uses. Three settings decide whether it works at all:

```bash
# 1. password auth instead of the default desktop prompt
#    (with "prompt" the server sends no RFB banner and every client just times out)
gsettings set org.gnome.desktop.remote-desktop.vnc auth-method password

# 2. allow input, not just viewing (the default is view-only)
gsettings set org.gnome.desktop.remote-desktop.vnc view-only false

# 3. an 8-character password (RFB truncates to 8) and enable the backend
grdctl vnc set-password 'Secret12'
grdctl vnc enable
systemctl --user restart gnome-remote-desktop.service
```

Then point the extension at it:

```json
{ "protocol": "vnc", "host": "127.0.0.1", "port": 5900, "password": "Secret12" }
```

Notes:

* The VNC backend shares the **live, unlocked** session. If the screen is locked the agent sees the lock screen; it cannot unlock it.
* Screen contents can change under the agent while you work — expect frames to differ from what it saw a moment earlier.
* Disable it again with `grdctl vnc disable` and `gsettings set org.gnome.desktop.remote-desktop.vnc enable false`.

## Consent

Every tool that changes your desktop asks first, and the prompt **auto-declines after 3 minutes** of no answer — a forgotten dialog can never turn into unattended remote control.

| Tool | Asks by default |
| --- | --- |
| `rdp_connect`, `rdp_click`, `rdp_move`, `rdp_drag`, `rdp_scroll`, `rdp_type`, `rdp_key` | yes |
| `rdp_screenshot`, `rdp_status`, `rdp_disconnect` | no (read-only) |

On a decline or a timeout the tool sends nothing and returns `The user did not grant consent (declined or no answer within 3 minutes)` so the model knows control was withheld.

```json
{
  "consent": {
    "actions": true,
    "screenshots": false,
    "timeoutMs": 180000
  }
}
```

Set `consent.actions` to `false` only if you want the model to drive the desktop without prompts. Screenshots are not gated by default because they are non-destructive; set `consent.screenshots` to `true` to be asked before each capture.

## Tools

| Tool | Purpose |
| --- | --- |
| `rdp_connect` | Open a session, wait for the first frame |
| `rdp_screenshot` | Capture the desktop as an image |
| `rdp_click` | Click at `x`,`y` (`button`, `clicks`) |
| `rdp_move` | Hover the pointer at `x`,`y` |
| `rdp_drag` | Drag from `x1`,`y1` to `x2`,`y2` |
| `rdp_scroll` | Wheel `up`/`down` at a position |
| `rdp_type` | Type text via Unicode key events |
| `rdp_key` | Named keys and chords: `enter`, `f5`, `ctrl+c`, `alt+tab` |
| `rdp_status` | Connection state, geometry, uptime, last error |
| `rdp_disconnect` | Close the session |

Slash command: `/rdp status | doctor | shot [path] | disconnect`

A typical agent loop:

```
rdp_connect(host="192.168.1.20", username="me")
rdp_screenshot()                      # look at the screen
rdp_click(x=412, y=230)               # open a menu
rdp_screenshot()                      # verify the result
rdp_type(text="hello world")
rdp_key(key="ctrl+s")
```

## Troubleshooting

Run `/rdp doctor` first: it reports the Python and library versions, the protocol in use, the negotiated encodings, and whether any local display is involved (never).

**`STATUS_LOGON_FAILURE` (0xc000006d) or `SEC_E_LOGON_DENIED`**
The server refused the credentials during NLA/CredSSP. Check the username and password first. If you run GNOME Remote Desktop, re-set the RDP credentials and restart the daemon:

```bash
grdctl rdp set-credentials <username> '<password>'   # positional, not via stdin
systemctl --user restart gnome-remote-desktop.service
```

Note that `grdctl rdp set-credentials <user> --password` with piped stdin can store a mangled value; the daemon then keeps rejecting a password that looks correct.

**Input is ignored though screenshots update**
The server is in view-only mode. For RDP:

```bash
grdctl rdp disable-view-only
```

For VNC the same concept lives in dconf, and it is **on by default**:

```bash
gsettings set org.gnome.desktop.remote-desktop.vnc view-only false
```

**VNC: the connection hangs with no banner at all**
`auth-method` is still `prompt`, so the server waits for someone to approve a dialog on the desktop before speaking RFB. Set `auth-method password` (see [VNC backend](#vnc-backend-gnome-remote-desktop)).

**VNC: `VNC authentication failed`**
RFB only uses the first 8 characters of the password, and `grdctl vnc set-password` stores exactly what you give it. Keep client and server strings identical in those 8 characters, then restart the daemon.

**VNC: screen stops updating**
The bridge only negotiates RAW and CopyRect. If a server insists on another encoding it raises `unsupported encoding` in `/rdp status` (`last_error`); reconnect. aardwolf's own VNC client is not used because its RRE path raises, its pointer masks never set a button, and its wheel maps to button 0.

**Server requires NLA**
Already handled: the bridge offers NTLM inside CredSSP. Kerberos-first clients (`xfreerdp3`) can fail on hosts whose `/etc/krb5.conf` has a default realm, which is why this bridge pins NTLM.

**Screenshot is blank right after connect**
The server has not painted yet. `rdp_screenshot` waits for the first frame (set `allow_blank` to skip that wait, or lower `first_frame_timeout`).

**Slow first call**
The first tool call pays for `uv`'s resolve/install of the bridge dependencies (`aardwolf`+`pillow` for RDP, `pillow`+`pycryptodomex` for VNC). Set `PI_RDP_PYTHON` to a prepared virtualenv to remove that.

**The agent's keystrokes land in whatever is focused on the real desktop**
That is the point of computer use, but it also means a stray `escape` or `ctrl+w` hits your own windows (including the terminal running Pi). Keep the consent prompt enabled and only approve actions you want on that screen.

## Security

* Every input tool is consent-gated with a 3-minute auto-decline (see [Consent](#consent)).
* The session runs with your user's privileges and a live remote-control channel to the target desktop.
* Nothing is written to disk except screenshots you request through `/rdp shot`.
* The bridge talks only to the configured host and port; there is no telemetry.
* Treat the desktop password like any other secret: prefer the environment variable or a `chmod 600` config, and rotate it if it has been shared in plain text.
* VNC password authentication is DES-based, limited to 8 characters, and sends the challenge/response **without TLS**. Only enable the VNC backend on a host/network you trust; for RDP the bridge keeps NLA (with TLS inside CredSSP).

## License

MIT
