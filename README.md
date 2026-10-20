# pi-rdp-computer-use

Computer use over **RDP** for [Pi](https://pi.dev): the agent sees a remote desktop as images and drives it with mouse and keyboard events.

Built for Wayland desktops, where X11 automation tools (`xdotool`), screen grabbers (`scrot`/`import`) and input injectors (`ydotool`, `uinput`) are unavailable or need root. This extension needs none of them: it speaks the RDP protocol directly.

## How it works

```
Pi extension (extensions/rdp.ts)
        │  newline-delimited JSON over stdio
        ▼
Python bridge (bridge/rdp_bridge.py)  ── aardwolf RDP client ──▶  RDP server
        │                                   ▲
        │  bitmap updates → PNG             │  fastpath input events
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
* An RDP server that accepts your credentials (Windows RDP, `xrdp`, GNOME Remote Desktop, ...)

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
| host | `RDP_HOST` | `host` |
| port | `RDP_PORT` | `port` (default `3389`) |
| username | `RDP_USERNAME` | `username` |
| password | `RDP_PASSWORD` | `password` |
| domain | `RDP_DOMAIN` | `domain` |
| geometry | – | `width`, `height` |
| screenshot cap | – | `maxScreenshotWidth` |
| python | `PI_RDP_PYTHON` | `python` |
| consent | – | `consent.actions`, `consent.screenshots`, `consent.timeoutMs` |

Config file: `~/.config/pi-rdp-computer-use/config.json`

```json
{
  "host": "192.168.1.20",
  "port": 3389,
  "username": "hakergeniusz",
  "width": 1920,
  "height": 1080
}
```

Prefer `RDP_PASSWORD` or a `chmod 600` config file over passing passwords in tool arguments: passwords appear in session transcripts. The extension never logs the password and strips it from tool details.

To avoid the on-demand `uv` install, point `PI_RDP_PYTHON` at an interpreter that already has `aardwolf` and `pillow`:

```bash
uv venv ~/.local/share/pi-rdp
uv pip install --python ~/.local/share/pi-rdp/bin/python aardwolf pillow
export PI_RDP_PYTHON=~/.local/share/pi-rdp/bin/python
```

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

Run `/rdp doctor` first: it reports the Python and `aardwolf` versions, the session type, and whether any local display is involved (never).

**`STATUS_LOGON_FAILURE` (0xc000006d) or `SEC_E_LOGON_DENIED`**
The server refused the credentials during NLA/CredSSP. Check the username and password first. If you run GNOME Remote Desktop, re-set the RDP credentials and restart the daemon:

```bash
grdctl rdp set-credentials <username> '<password>'   # positional, not via stdin
systemctl --user restart gnome-remote-desktop.service
```

Note that `grdctl rdp set-credentials <user> --password` with piped stdin can store a mangled value; the daemon then keeps rejecting a password that looks correct.

**Input is ignored though screenshots update**
The server is in view-only mode. GNOME Remote Desktop exposes this as:

```bash
grdctl rdp disable-view-only
```

**Server requires NLA**
Already handled: the bridge offers NTLM inside CredSSP. Kerberos-first clients (`xfreerdp3`) can fail on hosts whose `/etc/krb5.conf` has a default realm, which is why this bridge pins NTLM.

**Screenshot is blank right after connect**
The server has not painted yet. `rdp_screenshot` waits for the first frame (set `allow_blank` to skip that wait, or lower `first_frame_timeout`).

**Slow first call**
The first tool call pays for `uv`'s resolve/install of `aardwolf`. Set `PI_RDP_PYTHON` to a prepared virtualenv to remove that.

## Security

* Every input tool is consent-gated with a 3-minute auto-decline (see [Consent](#consent)).
* The session runs with your user's privileges and a live remote-control channel to the target desktop.
* Nothing is written to disk except screenshots you request through `/rdp shot`.
* The bridge talks only to the configured host and port; there is no telemetry.
* Treat the RDP password like any other secret: prefer the environment variable, and rotate it if it has been shared in plain text.

## License

MIT
