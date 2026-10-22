"""Shared image helpers for the pi-rdp-computer-use bridges.

Both transports (RDP via aardwolf, VNC via raw RFB) capture a full framebuffer
and then hand it here for cropping, cursor highlighting and encoding. Keeping
this in one place guarantees that the two transports behave identically, and
that the model gets the same metadata (scale, region origin, cursor position)
no matter which one is in use.
"""

from __future__ import annotations

import base64
import io
from typing import Any

from PIL import Image, ImageDraw

#: Magenta is rare in desktop themes, so the marker never blends into the UI.
CURSOR_COLOR = (255, 0, 255)
#: Cyan marks the region of interest in a full-desktop capture.
REGION_COLOR = (0, 200, 255)


def crop_region(
    image: Image.Image, region: dict[str, Any] | None
) -> tuple[Image.Image, dict[str, Any] | None]:
    """Crop `image` to `region` ({x, y, width, height}), clipped to the image.

    Returns the cropped image plus the region that was actually used (the
    requested one may be clipped by the desktop edges). Without a region the
    image is returned untouched and the region is None.
    """
    if not region:
        return image, None

    x = int(region.get("x", 0))
    y = int(region.get("y", 0))
    width = int(region.get("width") or image.width)
    height = int(region.get("height") or image.height)
    if width <= 0 or height <= 0:
        raise ValueError(f"Region width/height must be positive (got {width}x{height})")
    if x >= image.width or y >= image.height or x + width <= 0 or y + height <= 0:
        raise ValueError(
            f"Region {x},{y} {width}x{height} lies outside the {image.width}x{image.height} desktop"
        )

    left = max(0, x)
    top = max(0, y)
    right = min(image.width, x + width)
    bottom = min(image.height, y + height)
    cropped = image.crop((left, top, right, bottom))
    return cropped, {"x": left, "y": top, "width": cropped.width, "height": cropped.height}


def draw_cursor(
    image: Image.Image,
    x: int | None,
    y: int | None,
    color: tuple[int, int, int] = CURSOR_COLOR,
    radius: int = 16,
    label: bool = True,
) -> Image.Image:
    """Draw a ring plus crosshair at (x, y) so the model can see the pointer.

    Coordinates are desktop pixels; the marker is clipped to the image, so a
    cursor outside a cropped region simply draws nothing.
    """
    if x is None or y is None:
        return image

    draw = ImageDraw.Draw(image)
    cx, cy = int(x), int(y)
    ring = max(6, int(radius))

    draw.ellipse((cx - ring, cy - ring, cx + ring, cy + ring), outline=color, width=2)
    draw.ellipse((cx - 2, cy - 2, cx + 2, cy + 2), fill=color)

    arm = ring + 10
    gap = ring + 4
    draw.line((cx - arm, cy, cx - gap, cy), fill=color, width=2)
    draw.line((cx + gap, cy, cx + arm, cy), fill=color, width=2)
    draw.line((cx, cy - arm, cx, cy - gap), fill=color, width=2)
    draw.line((cx, cy + gap, cx, cy + arm), fill=color, width=2)

    if label:
        text = f"{cx},{cy}"
        try:
            left, top, right, bottom = draw.textbbox((0, 0), text)
            draw.rectangle((cx + gap + 2, cy - gap - 2, cx + gap + 2 + right, cy - gap - 2 + bottom), fill=color)
            draw.text((cx + gap + 3, cy - gap - 1), text, fill=(0, 0, 0))
        except Exception:  # noqa: BLE001 - the marker is cosmetic, never fatal
            pass
    return image


def draw_region_box(
    image: Image.Image, region: dict[str, Any], color: tuple[int, int, int] = REGION_COLOR
) -> Image.Image:
    """Outline a region of interest on a full-desktop capture."""
    draw = ImageDraw.Draw(image)
    x, y = int(region["x"]), int(region["y"])
    w, h = int(region["width"]), int(region["height"])
    draw.rectangle((x, y, x + w - 1, y + h - 1), outline=color, width=2)
    return image


def encode_image(
    image: Image.Image,
    fmt: str = "png",
    quality: int = 85,
    max_width: int = 0,
    max_height: int = 0,
) -> dict[str, Any]:
    """Encode `image` and report the size, byte count and downscale factor.

    `scale` is the factor between the returned image and the pixels that were
    cropped, so the caller can convert image coordinates back to desktop
    coordinates (desktop_x = region.x + image_x * scale).
    """
    if image.mode != "RGB":
        image = image.convert("RGB")

    original_width, original_height = image.size
    target_width, target_height = original_width, original_height

    if max_width and original_width > max_width:
        ratio = max_width / float(original_width)
        target_width = max_width
        target_height = max(1, int(original_height * ratio))
    if max_height and target_height > max_height:
        ratio = max_height / float(target_height)
        target_height = max_height
        target_width = max(1, int(target_width * ratio))

    if (target_width, target_height) != (original_width, original_height):
        image = image.resize((target_width, target_height), Image.LANCZOS)

    scale = target_width / float(original_width) if original_width else 1.0
    fmt = (fmt or "png").lower()
    buffer = io.BytesIO()
    if fmt in {"jpg", "jpeg"}:
        image.save(buffer, format="JPEG", quality=max(20, min(95, int(quality))), optimize=True)
        mime_type = "image/jpeg"
    else:
        image.save(buffer, format="PNG", optimize=True)
        mime_type = "image/png"
    payload = buffer.getvalue()

    return {
        "image_base64": base64.b64encode(payload).decode("ascii"),
        "mime_type": mime_type,
        "bytes": len(payload),
        "width": target_width,
        "height": target_height,
        "scale": round(scale, 6),
    }
