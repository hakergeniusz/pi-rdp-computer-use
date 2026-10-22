"""pi-rdp-computer-use - VNC bridge.

Speaks RFB 3.8 straight to a VNC server (verified against gnome-remote-desktop)
and exposes the same newline-delimited JSON protocol as bridge/rdp_bridge.py, so
the extension can drive either transport with identical tools.

Only RAW and CopyRect encodings are negotiated: they are trivially correct, and
aardwolf's VNC client (RRE/ZRLE paths, button masks, wheel) is not. Input is
written directly as RFB PointerEvent/KeyEvent, which also gives working scroll
and correct button masks.

Protocol: one JSON object per line on stdin, one per line on stdout.
  {"id": 1, "cmd": "connect", "args": {...}}
  {"id": 1, "ok": true, "result": {...}}
"""

from __future__ import annotations

import asyncio
import json
import struct
import sys
import time
import traceback
from typing import Any

from PIL import Image

from imaging import crop_region, draw_cursor, draw_region_box, encode_image

SERVER_VERSION = "RFB 003.008"

ENC_RAW = 0
ENC_COPY_RECT = 1

MSG_FRAMEBUFFER_UPDATE = 0
MSG_SET_COLOUR_MAP = 1
MSG_BELL = 2
MSG_SERVER_CUT_TEXT = 3

# X11 keysyms. Printable ASCII is its own keysym; the rest are named.
KEYSYMS = {
    "backspace": 0xFF08,
    "tab": 0xFF09,
    "enter": 0xFF0D,
    "return": 0xFF0D,
    "escape": 0xFF1B,
    "esc": 0xFF1B,
    "insert": 0xFF63,
    "delete": 0xFFFF,
    "home": 0xFF50,
    "end": 0xFF57,
    "pageup": 0xFF55,
    "pagedown": 0xFF56,
    "left": 0xFF51,
    "up": 0xFF52,
    "right": 0xFF53,
    "down": 0xFF54,
    "space": 0x0020,
    "capslock": 0xFFE5,
    "shift": 0xFFE1,
    "ctrl": 0xFFE3,
    "control": 0xFFE3,
    "alt": 0xFFE9,
    "super": 0xFFEB,
    "meta": 0xFFEB,
    "win": 0xFFEB,
    "menu": 0xFF67,
    **{f"f{index}": 0xFFBE + index - 1 for index in range(1, 13)},
}

# X11 keysym for a unicode code point outside Latin-1.
UNICODE_KEYSYM_BASE = 0x01000000


def vnc_des_key(password: str) -> bytes:
    """RFB auth uses DES with the password bytes bit-reversed, padded to 8."""
    raw = (password[:8] + "\x00" * 8)[:8].encode("latin-1")
    return bytes(int(f"{byte:08b}"[::-1], 2) for byte in raw)


def des_encrypt(key: bytes, data: bytes) -> bytes:
    from Cryptodome.Cipher import DES

    return DES.new(key, DES.MODE_ECB).encrypt(data)


def keysym_for(char: str) -> int:
    code = ord(char)
    if 0x20 <= code <= 0x7E:
        return code
    if code < 0x100:
        return code
    return UNICODE_KEYSYM_BASE | code


class VncSession:
    """One RFB connection with a persistent canvas."""

    def __init__(self) -> None:
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self.canvas: Image.Image | None = None
        self.width = 0
        self.height = 0
        self.bypp = 4
        self.server_name = ""
        self.version = ""
        self.info: dict[str, Any] = {}
        self.connected_at: float | None = None
        self.last_error: str | None = None
        self.frame_seq = 0
        self.rects_seen = 0
        self.encoding_error: str | None = None
        # Last pointer position we sent, in desktop pixels. Used to mark the
        # cursor in screenshots, because RFB never reports the pointer back.
        self.pointer_x: int | None = None
        self.pointer_y: int | None = None
        # Last clipboard text the server pushed (ServerCutText).
        self.clipboard: str | None = None

    # -- lifecycle ---------------------------------------------------------
    async def connect(self, args: dict[str, Any]) -> dict[str, Any]:
        await self.close()

        host = args["host"]
        port = int(args.get("port") or 5900)
        password = str(args.get("password") or "")
        timeout = float(args.get("timeout") or 30)
        started = time.monotonic()

        try:
            self.reader, self.writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=timeout
            )
            await asyncio.wait_for(self._handshake(password), timeout=timeout)
        except Exception as error:  # noqa: BLE001 - surfaced to the model
            await self.close()
            raise ConnectionError(_explain(error)) from error

        self.connected_at = time.time()
        self.task = asyncio.create_task(self._read_loop())
        self.info = {"host": host, "port": port, "protocol": "vnc", "server_name": self.server_name}

        frame_ready = False
        if not args.get("auth_only"):
            await self.request_update(full=True)
            frame_ready = await self.wait_for_frame(
                float(args.get("first_frame_timeout") or 15), after=0
            )
            await self.settle()

        return {
            **self.info,
            "connected": True,
            "rfbserver": self.version,
            "desktop": {"width": self.width, "height": self.height},
            "connect_seconds": round(time.monotonic() - started, 2),
            "frame_ready": frame_ready,
        }

    async def _handshake(self, password: str) -> None:
        assert self.reader is not None and self.writer is not None
        # Send our version first: servers either greet immediately or wait for
        # the client's version, and this order works with both.
        self.writer.write(SERVER_VERSION.encode("ascii") + b"\n")
        await self.writer.drain()
        self.version = (await self.reader.readexactly(12)).decode("latin-1").strip()

        count = (await self.reader.readexactly(1))[0]
        if count == 0:
            size = struct.unpack("!I", await self.reader.readexactly(4))[0]
            reason = (await self.reader.readexactly(size)).decode("latin-1", "replace")
            raise ConnectionError(f"Server refused the connection: {reason}")
        types = list(await self.reader.readexactly(count))

        if 2 in types:
            self.writer.write(bytes([2]))
            await self.writer.drain()
            challenge = await self.reader.readexactly(16)
            self.writer.write(des_encrypt(vnc_des_key(password), challenge))
            await self.writer.drain()
            status = struct.unpack("!I", await self.reader.readexactly(4))[0]
            if status != 0:
                size = struct.unpack("!I", await self.reader.readexactly(4))[0]
                reason = (await self.reader.readexactly(size)).decode("latin-1", "replace")
                raise ConnectionError(f"VNC authentication failed: {reason or 'wrong password'}")
        elif 1 in types:  # no authentication
            self.writer.write(bytes([1]))
            await self.writer.drain()
            # RFB 3.8 sends a SecurityResult even for the "None" security type.
            status = struct.unpack("!I", await self.reader.readexactly(4))[0]
            if status != 0:
                size = struct.unpack("!I", await self.reader.readexactly(4))[0]
                reason = (await self.reader.readexactly(size)).decode("latin-1", "replace")
                raise ConnectionError(f"Server refused the connection: {reason}")
        else:
            raise ConnectionError(
                f"Server offers unsupported security types {types}; "
                "this bridge supports VNC password auth and 'none'."
            )

        self.writer.write(bytes([1]))  # shared session
        await self.writer.drain()
        self.width, self.height = struct.unpack("!HH", await self.reader.readexactly(4))
        pixfmt = await self.reader.readexactly(16)
        bpp, depth, _big, _true, rmax, gmax, bmax, rshift, gshift, bshift = struct.unpack(
            "!BBBBHHHBBB", pixfmt[:13]
        )
        name_len = struct.unpack("!I", await self.reader.readexactly(4))[0]
        self.server_name = (await self.reader.readexactly(name_len)).decode("latin-1", "replace")

        # Ask for a fixed, easy-to-decode format regardless of the server default.
        await self._send(b"\x00\x00\x00\x00" + struct.pack("!BBBBHHHBBB3x", 32, 24, 0, 1, 255, 255, 255, 0, 8, 16))
        self.bypp = 4
        self.canvas = Image.new("RGB", (self.width, self.height), (0, 0, 0))
        await self._set_encodings([ENC_RAW, ENC_COPY_RECT])

    async def _send(self, payload: bytes) -> None:
        assert self.writer is not None
        self.writer.write(payload)
        await self.writer.drain()

    async def _set_encodings(self, encodings: list[int]) -> None:
        body = b"".join(struct.pack("!i", value) for value in encodings)
        await self._send(struct.pack("!BxH", 2, len(encodings)) + body)

    async def request_update(self, full: bool = False, x: int = 0, y: int = 0) -> None:
        width = self.width - x
        height = self.height - y
        await self._send(struct.pack("!BBHHHH", 3, 0 if full else 1, x, y, width, height))

    async def wait_for_frame(self, timeout: float, after: int | None = None) -> bool:
        threshold = self.frame_seq if after is None else after
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.frame_seq > threshold:
                return True
            await asyncio.sleep(0.05)
        return False

    async def settle(self, quiet: float = 0.25, timeout: float = 1.5) -> None:
        """Wait until no new frame arrived for `quiet` seconds.

        Servers send the initial paint as several updates; capturing right after
        the first one yields a half-drawn screen.
        """
        deadline = time.monotonic() + timeout
        last = self.frame_seq
        quiet_until = time.monotonic() + quiet
        while time.monotonic() < deadline:
            if self.frame_seq != last:
                last = self.frame_seq
                quiet_until = time.monotonic() + quiet
            if time.monotonic() >= quiet_until:
                return
            await asyncio.sleep(0.05)

    async def close(self) -> None:
        task, self.task = self.task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        writer, self.writer = self.writer, None
        self.reader = None
        self.canvas = None
        self.connected_at = None
        if writer is not None:
            try:
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), timeout=3)
            except Exception:  # noqa: BLE001 - teardown is best effort
                pass

    def require(self) -> None:
        if self.writer is None or self.canvas is None:
            raise RuntimeError("Not connected. Call rdp_connect first.")

    # -- framebuffer -------------------------------------------------------
    async def _read_loop(self) -> None:
        assert self.reader is not None
        try:
            while True:
                message = (await self.reader.readexactly(1))[0]
                if message == MSG_FRAMEBUFFER_UPDATE:
                    await self._handle_update()
                elif message == MSG_SET_COLOUR_MAP:
                    await self.reader.readexactly(1)
                    first, count = struct.unpack("!HH", await self.reader.readexactly(4))
                    await self.reader.readexactly(6 * count)
                elif message == MSG_BELL:
                    continue
                elif message == MSG_SERVER_CUT_TEXT:
                    await self.reader.readexactly(3)
                    size = struct.unpack("!I", await self.reader.readexactly(4))[0]
                    raw = await self.reader.readexactly(size)
                    self.clipboard = raw.decode("latin-1", "replace")
                else:
                    raise RuntimeError(f"Unexpected server message type {message}")
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - keep the error for status
            self.last_error = f"framebuffer reader stopped: {error}"
            print(f"[bridge] {self.last_error}", file=sys.stderr)

    async def _handle_update(self) -> None:
        assert self.reader is not None and self.canvas is not None
        await self.reader.readexactly(1)
        count = struct.unpack("!H", await self.reader.readexactly(2))[0]
        for _ in range(count):
            x, y, width, height, encoding = struct.unpack("!HHHHi", await self.reader.readexactly(12))
            if encoding == ENC_RAW:
                payload = await self.reader.readexactly(width * height * self.bypp)
                tile = Image.frombytes("RGB", (width, height), payload, "raw", "BGRX")
                self.canvas.paste(tile, (x, y))
            elif encoding == ENC_COPY_RECT:
                src_x, src_y = struct.unpack("!HH", await self.reader.readexactly(4))
                patch = self.canvas.crop((src_x, src_y, src_x + width, src_y + height))
                self.canvas.paste(patch, (x, y))
            else:
                self.encoding_error = (
                    f"server sent unsupported encoding {encoding}; "
                    "reconnect if the screen stops updating"
                )
                raise RuntimeError(self.encoding_error)
            self.rects_seen += 1
        self.frame_seq += 1

    # -- observation -------------------------------------------------------
    async def screenshot(self, args: dict[str, Any]) -> dict[str, Any]:
        self.require()
        assert self.canvas is not None
        timeout = float(args.get("timeout") or 6)
        if args.get("refresh", True):
            before = self.frame_seq
            # Incremental requests carry only the changed rectangles; a full
            # refresh is 30+ MB on a 4K desktop, so it is opt-in.
            await self.request_update(full=bool(args.get("full_refresh")))
            await self.wait_for_frame(timeout, after=before)
            await self.settle()

        desktop = {"width": self.canvas.width, "height": self.canvas.height}
        image = self.canvas.copy()

        mark = args.get("mark_region")
        if mark:
            draw_region_box(image, {
                "x": int(mark.get("x", 0)),
                "y": int(mark.get("y", 0)),
                "width": int(mark.get("width", 0)),
                "height": int(mark.get("height", 0)),
            })

        cropped, region = crop_region(image, args.get("region"))

        cursor_x = args.get("cursor_x")
        cursor_y = args.get("cursor_y")
        if cursor_x is None:
            cursor_x = self.pointer_x
        if cursor_y is None:
            cursor_y = self.pointer_y
        cursor_visible = False
        if args.get("highlight_cursor", True) and cursor_x is not None and cursor_y is not None:
            # The marker lives in desktop space; shift it into region space.
            local_x = int(cursor_x) - (region["x"] if region else 0)
            local_y = int(cursor_y) - (region["y"] if region else 0)
            if 0 <= local_x < cropped.width and 0 <= local_y < cropped.height:
                draw_cursor(cropped, local_x, local_y)
                cursor_visible = True

        encoded = encode_image(
            cropped,
            fmt=str(args.get("format") or "png"),
            quality=int(args.get("quality") or 85),
            max_width=int(args.get("max_width") or 0),
            max_height=int(args.get("max_height") or 0),
        )

        return {
            **encoded,
            "desktop": desktop,
            "region": region,
            "cursor": {"x": cursor_x, "y": cursor_y, "visible": cursor_visible},
            "frames": self.frame_seq,
            "frame_ready": True,
        }

    # -- input -------------------------------------------------------------
    async def _pointer(self, mask: int, x: int, y: int) -> None:
        await self._send(struct.pack("!BBHH", 5, mask, int(x), int(y)))
        self.pointer_x, self.pointer_y = int(x), int(y)

    async def click(self, args: dict[str, Any]) -> dict[str, Any]:
        self.require()
        mask = _button_mask(args.get("button", "left"))
        x, y = int(args["x"]), int(args["y"])
        clicks = max(1, int(args.get("clicks") or 1))
        interval = float(args.get("interval") or 0.08)
        await self._pointer(0, x, y)
        for index in range(clicks):
            await self._pointer(mask, x, y)
            await asyncio.sleep(0.03)
            await self._pointer(0, x, y)
            if index + 1 < clicks:
                await asyncio.sleep(interval)
        return {"clicked": {"x": x, "y": y, "button": args.get("button", "left"), "clicks": clicks}}

    async def move(self, args: dict[str, Any]) -> dict[str, Any]:
        self.require()
        x, y = int(args["x"]), int(args["y"])
        await self._pointer(0, x, y)
        return {"moved_to": {"x": x, "y": y}}

    async def button(self, args: dict[str, Any]) -> dict[str, Any]:
        """Press or release a mouse button and hold it (for drags)."""
        self.require()
        name = str(args.get("button", "left")).lower()
        action = str(args.get("action", "down")).lower()
        mask = _button_mask(name)
        x = int(args.get("x", self.pointer_x or 0))
        y = int(args.get("y", self.pointer_y or 0))
        await self._pointer(0, x, y)
        await self._pointer(mask if action in {"down", "press"} else 0, x, y)
        return {"button": name, "action": action, "at": [x, y]}

    async def drag(self, args: dict[str, Any]) -> dict[str, Any]:
        self.require()
        mask = _button_mask(args.get("button", "left"))
        x1, y1 = int(args["x1"]), int(args["y1"])
        x2, y2 = int(args["x2"]), int(args["y2"])
        steps = max(1, int(args.get("steps") or 12))
        await self._pointer(0, x1, y1)
        await self._pointer(mask, x1, y1)
        for step in range(1, steps + 1):
            await self._pointer(mask, int(x1 + (x2 - x1) * step / steps), int(y1 + (y2 - y1) * step / steps))
            await asyncio.sleep(0.02)
        await self._pointer(0, x2, y2)
        return {"dragged": {"from": [x1, y1], "to": [x2, y2], "button": args.get("button", "left")}}

    async def scroll(self, args: dict[str, Any]) -> dict[str, Any]:
        self.require()
        direction = str(args.get("direction", "down")).lower()
        masks = {"up": 8, "down": 16, "left": 32, "right": 64, "in": 8, "out": 16}
        if direction not in masks:
            raise ValueError(f"Unknown scroll direction: {direction!r}")
        mask = masks[direction]
        x = int(args.get("x", self.pointer_x if self.pointer_x is not None else self.width // 2))
        y = int(args.get("y", self.pointer_y if self.pointer_y is not None else self.height // 2))
        amount = max(1, int(args.get("amount") or 3))
        await self._pointer(0, x, y)
        for _ in range(amount):
            await self._pointer(mask, x, y)
            await asyncio.sleep(0.01)
            await self._pointer(0, x, y)
            await asyncio.sleep(0.01)
        return {"scrolled": {"direction": direction, "amount": amount, "at": [x, y]}}

    async def _key(self, keysym: int, pressed: bool) -> None:
        await self._send(struct.pack("!BBxxI", 4, int(pressed), keysym))

    async def type_text(self, args: dict[str, Any]) -> dict[str, Any]:
        self.require()
        text = str(args["text"])
        interval = float(args.get("interval") or 0.01)
        for char in text:
            if char == "\n":
                await self._tap(KEYSYMS["enter"])
            elif char == "\t":
                await self._tap(KEYSYMS["tab"])
            else:
                await self._tap(keysym_for(char))
            if interval:
                await asyncio.sleep(interval)
        return {"typed_characters": len(text)}

    async def _tap(self, keysym: int) -> None:
        await self._key(keysym, True)
        await asyncio.sleep(0.01)
        await self._key(keysym, False)

    async def key(self, args: dict[str, Any]) -> dict[str, Any]:
        self.require()
        spec = str(args["key"]).strip()
        action = str(args.get("action", "press")).lower()
        parts = [part for part in spec.replace("-", "+").split("+") if part] or [spec]
        target = parts[-1].lower()

        if target in KEYSYMS:
            keysym = KEYSYMS[target]
        elif len(target) == 1:
            keysym = keysym_for(target)
        else:
            raise ValueError(f"Unknown key: {spec!r}")

        pressed: list[int] = []
        try:
            for name in parts[:-1]:
                modifier = name.lower()
                if modifier not in KEYSYMS:
                    raise ValueError(f"Unknown modifier: {name!r}")
                code = KEYSYMS[modifier]
                await self._key(code, True)
                pressed.append(code)
                await asyncio.sleep(0.01)
            if action in {"down", "press"}:
                await self._key(keysym, True)
            if action in {"up", "press"}:
                await self._key(keysym, False)
        finally:
            for code in reversed(pressed):
                await self._key(code, False)
                await asyncio.sleep(0.01)
        return {"key": spec, "modifiers": parts[:-1]}

    # -- status ------------------------------------------------------------
    async def status(self) -> dict[str, Any]:
        return {
            "connected": self.writer is not None,
            **self.info,
            "desktop": {"width": self.width, "height": self.height} if self.width else None,
            "frame_ready": self.canvas is not None,
            "frames": self.frame_seq,
            "rects": self.rects_seen,
            "pointer": {"x": self.pointer_x, "y": self.pointer_y},
            "clipboard_length": len(self.clipboard) if self.clipboard else 0,
            "uptime_seconds": round(time.time() - self.connected_at, 1) if self.connected_at else None,
            "last_error": self.last_error,
        }

    async def clipboard_text(self, args: dict[str, Any]) -> dict[str, Any]:
        """Return the last clipboard text the server pushed to us."""
        return {"text": self.clipboard, "length": len(self.clipboard or "")}

    def doctor(self) -> dict[str, Any]:
        try:
            import PIL  # noqa: F401

            pillow_ok = True
        except Exception as exc:  # noqa: BLE001 - report, never raise
            pillow_ok = f"import failed: {exc}"
        try:
            import Cryptodome  # noqa: F401

            pycryptodome_ok = True
        except Exception as exc:  # noqa: BLE001
            pycryptodome_ok = f"import failed: {exc}"
        return {
            "protocol": "vnc",
            "python": sys.version.split()[0],
            "pillow": pillow_ok,
            "pycryptodomex": pycryptodome_ok,
            "encodings": ["raw", "copyrect"],
            "display_needed": False,
            "notes": [
                "The bridge speaks RFB 3.8 directly; no X11, Wayland screencast or uinput access is required.",
                "gnome-remote-desktop needs 'gsettings set org.gnome.desktop.remote-desktop.vnc "
                "auth-method password' - the default 'prompt' waits for a dialog on the desktop "
                "and the client sees no server banner at all.",
                "VNC passwords are truncated to 8 characters by the protocol.",
            ],
        }


def _button_mask(name: str) -> int:
    mapping = {"left": 1, "middle": 2, "right": 4}
    key = str(name).lower()
    if key not in mapping:
        raise ValueError(f"Unknown mouse button: {name!r}")
    return mapping[key]


def _explain(error: Exception) -> str:
    text = str(error)
    hints = []
    if "authentication failed" in text.lower() or "wrong password" in text.lower():
        hints.append(
            "Verify the VNC password (max 8 characters, set with 'grdctl vnc set-password'), "
            "and that auth-method is set to password rather than prompt."
        )
    if "connection refused" in text.lower():
        hints.append("No VNC server is listening; enable it with 'grdctl vnc enable'.")
    if "timed out" in text.lower() or isinstance(error, asyncio.TimeoutError):
        hints.append(
            "The server accepted the TCP connection but never sent an RFB banner - "
            "gnome-remote-desktop does this when auth-method is 'prompt'."
        )
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
    "button": "button",
    "clipboard": "clipboard_text",
}


async def dispatch(session: VncSession, command: str, args: dict[str, Any]) -> Any:
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
        if command in {"screenshot", "click", "move", "drag", "scroll", "type", "key", "button", "clipboard"}:
            session.require()
        return await getattr(session, method_name)(args)


async def main() -> int:
    session = VncSession()
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
