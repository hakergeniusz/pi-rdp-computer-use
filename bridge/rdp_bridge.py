#!/usr/bin/env python3
"""Headless RDP bridge for the pi-rdp-computer-use extension.

Speaks newline-delimited JSON on stdin/stdout so a language model driven agent
can observe and control a remote desktop without a local display server, X11 or
uinput. Framebuffer frames arrive as RDP bitmap updates; input is sent back over
the RDP wire.

Protocol
  request : {"id": 1, "cmd": "screenshot", "args": {...}}
  response: {"id": 1, "ok": true, "result": {...}}
            {"id": 1, "ok": false, "error": "message"}

Diagnostics go to stderr, never to stdout, so stdout stays a clean channel.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import sys
import time
import traceback
from typing import Any

# A canvas larger than any expected remote desktop. The bridge tracks which
# area the server actually painted, so oversized frames from servers that
# ignore the requested geometry (GNOME Remote Desktop does) never fail and
# never crop the capture.
CANVAS_W = int(os.environ.get("RDP_CANVAS_WIDTH", "5120"))
CANVAS_H = int(os.environ.get("RDP_CANVAS_HEIGHT", "2880"))

# PC set 1 scancodes for the keys that cannot be expressed as Unicode text.
SCANCODES: dict[str, tuple[int, bool]] = {
    "escape": (0x01, False), "esc": (0x01, False),
    "backspace": (0x0E, False), "tab": (0x0F, False),
    "enter": (0x1C, False), "return": (0x1C, False),
    "ctrl": (0x1D, False), "control": (0x1D, False),
    "shift": (0x2A, False), "alt": (0x38, False),
    "space": (0x39, False), "capslock": (0x3A, False),
    "f1": (0x3B, False), "f2": (0x3C, False), "f3": (0x3D, False),
    "f4": (0x3E, False), "f5": (0x3F, False), "f6": (0x40, False),
    "f7": (0x41, False), "f8": (0x42, False), "f9": (0x43, False),
    "f10": (0x44, False), "f11": (0x57, False), "f12": (0x58, False),
    "home": (0x47, True), "end": (0x4F, True), "pageup": (0x49, True),
    "pagedown": (0x51, True), "insert": (0x52, True), "delete": (0x53, True),
    "left": (0x4B, True), "right": (0x4D, True), "up": (0x48, True),
    "down": (0x50, True), "super": (0x5B, True), "win": (0x5B, True),
    "menu": (0x5D, True), "printscreen": (0x37, True),
}

# Modifier names accepted by the `key` command.
MODIFIERS: dict[str, str] = {
    "ctrl": "ctrl", "control": "ctrl", "shift": "shift",
    "alt": "alt", "super": "super", "win": "super",
}


class TrackingBuffer:
    """Stands in for aardwolf's fixed-size PIL buffer.

    Records the extent of every pasted rectangle so `screenshot` can crop to the
    region the server really painted, and never raises when a frame is larger
    than the canvas we announced.
    """

    def __init__(self) -> None:
        from PIL import Image

        self._image = Image.new("RGBA", (CANVAS_W, CANVAS_H), (24, 24, 24, 255))
        self.max_x = 0
        self.max_y = 0
        self.frames = 0
        self.iosettings_width = 1920
        self.iosettings_height = 1080

    def paste(self, image, box=None, *args, **kwargs):  # noqa: ANN001 - aardwolf calls this
        if box is not None and len(box) == 4:
            self.max_x = max(self.max_x, int(box[2]))
            self.max_y = max(self.max_y, int(box[3]))
            self.frames += 1
        return self._image.paste(image, box, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        # deepcopy(), save(), tobytes(), size, ... all delegate to PIL.
        return getattr(self._image, name)

    def __deepcopy__(self, memo):  # PIL images must not be shared across threads
        from copy import deepcopy

        clone = TrackingBuffer.__new__(TrackingBuffer)
        clone._image = deepcopy(self._image, memo)
        clone.max_x = self.max_x
        clone.max_y = self.max_y
        clone.frames = self.frames
        clone.iosettings_width = self.iosettings_width
        clone.iosettings_height = self.iosettings_height
        return clone

    def cropped(self):
        width = self.max_x or self.iosettings_width
        height = self.max_y or self.iosettings_height
        width = max(1, min(width, CANVAS_W))
        height = max(1, min(height, CANVAS_H))
        return self._image.crop((0, 0, width, height))


class RdpSession:
    """Owns one aardwolf connection and serialises access to it."""

    def __init__(self) -> None:
        self.conn = None
        self.buffer: TrackingBuffer | None = None
        self.lock = asyncio.Lock()
        self.info: dict[str, Any] = {}
        self.connected_at: float | None = None
        self.last_error: str | None = None

    # -- lifecycle ---------------------------------------------------------
    async def connect(self, args: dict[str, Any]) -> dict[str, Any]:
        from aardwolf.commons.iosettings import RDPIOSettings
        from aardwolf.commons.queuedata.constants import VIDEO_FORMAT
        from aardwolf.commons.target import RDPTarget
        from aardwolf.connection import RDPConnection
        from asyauth.common.constants import asyauthProtocol, asyauthSecret
        from asyauth.common.credentials import UniCredential

        await self.close()

        host = args["host"]
        port = int(args.get("port") or 3389)
        password = args.get("password") or ""
        domain = args.get("domain")
        width = int(args.get("width") or 1920)
        height = int(args.get("height") or 1080)

        credential = UniCredential(
            username=args["username"],
            secret=password,
            domain=domain,
            stype=asyauthSecret.PASSWORD,
            protocol=asyauthProtocol.NTLM,
        )

        settings = RDPIOSettings()
        settings.channels = []
        settings.video_width = width
        settings.video_height = height
        settings.video_bpp_min = 32
        settings.video_bpp_max = 32
        settings.video_out_format = VIDEO_FORMAT.PIL
        settings.clipboard_use_pyperclip = False

        conn = RDPConnection(RDPTarget(ip=host, port=port, hostname=host), credential, settings)
        started = time.monotonic()
        ok, err = await asyncio.wait_for(
            conn.connect(auth_only=bool(args.get("auth_only"))), timeout=float(args.get("timeout") or 30)
        )
        if err is not None:
            try:
                await asyncio.wait_for(conn.terminate(), timeout=5)
            except Exception:  # noqa: BLE001 - best effort cleanup
                pass
            raise ConnectionError(_explain_auth_error(err))

        self.conn = conn
        # Swap in the oversized tracking canvas (aardwolf rebuilds it on connect).
        buffer = TrackingBuffer()
        buffer.iosettings_width = width
        buffer.iosettings_height = height
        try:
            conn._RDPConnection__desktop_buffer = buffer  # noqa: SLF001 - no public API
        except Exception:  # noqa: BLE001 - name mangling changed upstream
            pass
        self.buffer = buffer
        self.connected_at = time.time()
        self.info = {
            "host": host,
            "port": port,
            "username": args["username"],
            "domain": domain,
            "requested_width": width,
            "requested_height": height,
            "auth_only": bool(args.get("auth_only")),
        }
        self.last_error = None

        if not args.get("auth_only"):
            await self._wait_for_frame(float(args.get("first_frame_timeout") or 15))

        return {
            **self.info,
            "connected": True,
            "connect_seconds": round(time.monotonic() - started, 2),
            "frame_ready": self.has_frame(),
        }

    async def _wait_for_frame(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.has_frame():
                return
            await asyncio.sleep(0.1)

    def has_frame(self) -> bool:
        return bool(self.buffer is not None and self.buffer.max_x and self.buffer.max_y)

    async def close(self) -> None:
        conn = self.conn
        self.conn = None
        self.buffer = None
        self.connected_at = None
        if conn is None:
            return
        try:
            await asyncio.wait_for(conn.terminate(), timeout=8)
        except Exception:  # noqa: BLE001 - teardown is best effort
            pass

    def require(self):
        if self.conn is None:
            raise RuntimeError("Not connected. Call rdp_connect first.")
        return self.conn

    # -- observation -------------------------------------------------------
    async def screenshot(self, args: dict[str, Any]) -> dict[str, Any]:
        conn = self.require()
        if not args.get("allow_blank") and not self.has_frame():
            await self._wait_for_frame(float(args.get("timeout") or 5))
        image = conn.get_desktop_buffer()
        if isinstance(image, tuple):
            raise RuntimeError(f"Framebuffer unavailable: {image[1]}")
        assert self.buffer is not None
        image = self.buffer.cropped() if args.get("crop", True) else image
        if image.mode != "RGB":
            image = image.convert("RGB")
        max_width = int(args.get("max_width") or 0)
        if max_width and image.width > max_width:
            ratio = max_width / float(image.width)
            image = image.resize((max_width, max(1, int(image.height * ratio))))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        payload = buffer.getvalue()
        return {
            "png_base64": base64.b64encode(payload).decode("ascii"),
            "width": image.width,
            "height": image.height,
            "bytes": len(payload),
            "frame_ready": self.has_frame(),
        }

    # -- input -------------------------------------------------------------
    async def click(self, args: dict[str, Any]) -> dict[str, Any]:
        conn = self.require()
        from aardwolf.commons.queuedata.constants import MOUSEBUTTON

        button = _button(args.get("button", "left"))
        x = int(args["x"])
        y = int(args["y"])
        clicks = max(1, int(args.get("clicks") or 1))
        delay = float(args.get("interval") or 0.08)
        await _call(conn.send_mouse(MOUSEBUTTON.MOUSEBUTTON_HOVER, x, y, False))
        for index in range(clicks):
            await _call(conn.send_mouse(button, x, y, True))
            await asyncio.sleep(0.02)
            await _call(conn.send_mouse(button, x, y, False))
            if index + 1 < clicks:
                await asyncio.sleep(delay)
        return {"clicked": {"x": x, "y": y, "button": args.get("button", "left"), "clicks": clicks}}

    async def move(self, args: dict[str, Any]) -> dict[str, Any]:
        conn = self.require()
        from aardwolf.commons.queuedata.constants import MOUSEBUTTON

        x = int(args["x"])
        y = int(args["y"])
        await _call(conn.send_mouse(MOUSEBUTTON.MOUSEBUTTON_HOVER, x, y, False))
        return {"moved_to": {"x": x, "y": y}}

    async def drag(self, args: dict[str, Any]) -> dict[str, Any]:
        conn = self.require()
        from aardwolf.commons.queuedata.constants import MOUSEBUTTON

        button = _button(args.get("button", "left"))
        x1, y1 = int(args["x1"]), int(args["y1"])
        x2, y2 = int(args["x2"]), int(args["y2"])
        steps = max(1, int(args.get("steps") or 12))
        await _call(conn.send_mouse(MOUSEBUTTON.MOUSEBUTTON_HOVER, x1, y1, False))
        await _call(conn.send_mouse(button, x1, y1, True))
        for step in range(1, steps + 1):
            x = int(x1 + (x2 - x1) * step / steps)
            y = int(y1 + (y2 - y1) * step / steps)
            await _call(conn.send_mouse(MOUSEBUTTON.MOUSEBUTTON_HOVER, x, y, False))
            await asyncio.sleep(0.02)
        await _call(conn.send_mouse(button, x2, y2, False))
        return {"dragged": {"from": [x1, y1], "to": [x2, y2], "button": args.get("button", "left")}}

    async def scroll(self, args: dict[str, Any]) -> dict[str, Any]:
        conn = self.require()
        from aardwolf.commons.queuedata.constants import MOUSEBUTTON

        direction = str(args.get("direction", "down")).lower()
        wheel = (
            MOUSEBUTTON.MOUSEBUTTON_WHEEL_UP
            if direction in {"up", "in"}
            else MOUSEBUTTON.MOUSEBUTTON_WHEEL_DOWN
        )
        x = int(args.get("x", self.buffer.max_x // 2 if self.buffer else 0))
        y = int(args.get("y", self.buffer.max_y // 2 if self.buffer else 0))
        amount = max(1, int(args.get("amount") or 3))
        await _call(conn.send_mouse(MOUSEBUTTON.MOUSEBUTTON_HOVER, x, y, False))
        for _ in range(amount):
            await _call(conn.send_mouse(wheel, x, y, True))
            await _call(conn.send_mouse(wheel, x, y, False))
            await asyncio.sleep(0.02)
        return {"scrolled": {"direction": direction, "amount": amount, "at": [x, y]}}

    async def type_text(self, args: dict[str, Any]) -> dict[str, Any]:
        conn = self.require()
        text = str(args["text"])
        interval = float(args.get("interval") or 0.01)
        for char in text:
            code = ord(char)
            if char == "\n":
                await self._press_scancode("enter")
                continue
            if char == "\t":
                await self._press_scancode("tab")
                continue
            await _call(conn.send_key_char(code, True))
            await _call(conn.send_key_char(code, False))
            if interval:
                await asyncio.sleep(interval)
        return {"typed_characters": len(text)}

    async def _press_scancode(self, name: str) -> None:
        conn = self.require()
        scancode, extended = SCANCODES[name]
        await _call(conn.send_key_scancode(scancode, True, extended))
        await asyncio.sleep(0.01)
        await _call(conn.send_key_scancode(scancode, False, extended))

    async def key(self, args: dict[str, Any]) -> dict[str, Any]:
        conn = self.require()
        spec = str(args["key"]).strip()
        action = str(args.get("action", "press")).lower()
        parts = [part for part in spec.replace("-", "+").split("+") if part] or [spec]
        modifiers = [MODIFIERS.get(part.lower(), part.lower()) for part in parts[:-1]]
        target = parts[-1].lower()

        if target in SCANCODES:
            scancode, extended = SCANCODES[target]
        elif len(target) == 1:
            # Single character: send as a Unicode key event.
            code = ord(target)
            if action in {"down", "press"}:
                await _call(conn.send_key_char(code, True))
            if action in {"up", "press"}:
                await _call(conn.send_key_char(code, False))
            return {"key": spec}
        else:
            raise ValueError(f"Unknown key: {spec!r}")

        pressed: list[str] = []
        try:
            for modifier in modifiers:
                if modifier not in SCANCODES:
                    raise ValueError(f"Unknown modifier: {modifier!r}")
                mcode, mex = SCANCODES[modifier]
                await _call(conn.send_key_scancode(mcode, True, mex))
                pressed.append(modifier)
                await asyncio.sleep(0.01)
            if action in {"down", "press"}:
                await _call(conn.send_key_scancode(scancode, True, extended))
            if action in {"up", "press"}:
                await _call(conn.send_key_scancode(scancode, False, extended))
        finally:
            for modifier in reversed(pressed):
                mcode, mex = SCANCODES[modifier]
                await _call(conn.send_key_scancode(mcode, False, mex))
                await asyncio.sleep(0.01)
        return {"key": spec, "modifiers": modifiers}

    # -- status ------------------------------------------------------------
    async def status(self) -> dict[str, Any]:
        return {
            "connected": self.conn is not None,
            **self.info,
            "frame_ready": self.has_frame(),
            "desktop": (
                {"width": self.buffer.max_x, "height": self.buffer.max_y}
                if self.has_frame()
                else None
            ),
            "uptime_seconds": (
                round(time.time() - self.connected_at, 1) if self.connected_at else None
            ),
            "last_error": self.last_error,
        }

    def doctor(self) -> dict[str, Any]:
        """Environment facts useful when a connection is refused."""
        import shutil

        try:
            import aardwolf  # noqa: F401

            aardwolf_ok = True
        except Exception as exc:  # noqa: BLE001 - report, do not raise
            aardwolf_ok = f"import failed: {exc}"
        return {
            "python": sys.version.split()[0],
            "aardwolf": aardwolf_ok,
            "xdg_session_type": os.environ.get("XDG_SESSION_TYPE"),
            "xdg_current_desktop": os.environ.get("XDG_CURRENT_DESKTOP"),
            "freerdp_client": shutil.which("xfreerdp3") or shutil.which("xfreerdp"),
            "display_needed": False,
            "notes": [
                "The bridge speaks RDP directly; no X11, Wayland screencast or uinput access is required.",
                "Servers enforcing NLA must accept the credentials; gnome-remote-desktop needs "
                "'Remote Control' enabled (view-only off) before input is honoured.",
            ],
        }


def _button(name: str):
    from aardwolf.commons.queuedata.constants import MOUSEBUTTON

    mapping = {
        "left": MOUSEBUTTON.MOUSEBUTTON_LEFT,
        "right": MOUSEBUTTON.MOUSEBUTTON_RIGHT,
        "middle": MOUSEBUTTON.MOUSEBUTTON_MIDDLE,
    }
    key = str(name).lower()
    if key not in mapping:
        raise ValueError(f"Unknown mouse button: {name!r}")
    return mapping[key]


async def _call(awaitable) -> None:
    """aardwolf returns (result, error); surface the error."""
    result, error = await awaitable
    if error is not None:
        raise RuntimeError(str(error))
    return result


def _explain_auth_error(error: Exception) -> str:
    text = str(error)
    hints = []
    if "0xc000006d" in text or "LOGON_FAILURE" in text.upper():
        hints.append(
            "The server rejected the credentials (STATUS_LOGON_FAILURE). Verify the "
            "username/password, and for gnome-remote-desktop confirm the RDP credentials "
            "in Settings > System > Remote Desktop."
        )
    if "0x8009030c" in text or "LOGON_DENIED" in text.upper():
        hints.append("NLA authentication failed (SEC_E_LOGON_DENIED).")
    if "HYBRID_REQUIRED" in text.upper():
        hints.append("The server requires NLA; this bridge already negotiates NLA.")
    return text + (" | " + " ".join(hints) if hints else "")


COMMANDS = {
    "connect": "connect",
    "disconnect": "close",
    "status": "status",
    "screenshot": "screenshot",
    "click": "click",
    "move": "move",
    "drag": "drag",
    "scroll": "scroll",
    "type": "type_text",
    "key": "key",
}


async def dispatch(session: RdpSession, command: str, args: dict[str, Any]) -> Any:
    if command == "ping":
        return {"pong": True}
    if command == "doctor":
        return session.doctor()
    method_name = COMMANDS.get(command)
    if method_name is None:
        raise ValueError(f"Unknown command: {command!r}")
    async with session.lock:
        if command == "status":
            return await session.status()
        if command == "disconnect":
            await session.close()
            return {"connected": False}
        method = getattr(session, method_name)
        if command in {"screenshot", "click", "move", "drag", "scroll", "type", "key"}:
            session.require()
        return await method(args)


async def main() -> int:
    session = RdpSession()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        request_id = None
        command = "?"
        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            command = str(payload.get("cmd", ""))
            args = payload.get("args") or {}
            result = await dispatch(session, command, args)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as error:  # noqa: BLE001 - every failure is reported to the caller
            print(f"[bridge] {command} failed: {error}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            response = {"id": request_id, "ok": False, "error": str(error)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    await session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
