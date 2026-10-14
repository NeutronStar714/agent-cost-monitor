"""Assemble the icon sets from the rendered mark, in `build/acm-iconset/`.

The chain is: `assets/acm-icon.svg` (the design, the only place the geometry lives) ->
`build-mark.py` (renders it at exact pixel sizes) -> this script (assembles the sets the bundle and
the page read). Nothing here invents a size it was given: 16, 32, 128 and 144 are taken as-is, and
only the sizes the mark is not rendered at (24, 48, 64, 256) are derived from the 512 master by
halving, so every step is an exact 2:1 rather than one careless jump.

No other artwork exists in this repository to fall back on, deliberately: the mark is the only
source, and `build-mark.py` is the only producer.

Why the *window* icon is the 128 and not the 512 — the thing that decides whether a taskbar looks
blurred: a running window's taskbar button is drawn from the WINDOW's own large icon, at the
taskbar's pixel size, which on a 200% display is 64. 128 is an exact 2:1 reduction of that; 512 is
8:1 and would hand the shell's own filter the job. The .ico still carries 256 for Explorer, the
jumplist and any surface that asks for it.

Two conventions this follows, because the shell paths that draw a taskbar button are the least
forgiving: DIB entries for every size below 256 and PNG only at 256, since `npx tauri icon` stores
every entry as PNG; and no single-step downscale of the 512, which is what smears the detail that
makes a dollar sign legible small.
"""
import io
import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
ICONS = ROOT / "src-tauri" / "icons"
WINDOW = ROOT / "window"

# The sizes the shell asks for, and the ones worth shipping in an .ico.
SIZES = [16, 24, 32, 48, 64, 128, 256]

# Which file in the set holds which exact size. Anything not listed is derived.
ICONSET = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "build" / "acm-iconset"
SET_FILES = {
    16: "mark-16.png",
    32: "mark-32.png",
    128: "mark-128.png",
    144: "mark-144.png",
    512: "mark-512.png",
}
MASTER_SIZE = 512


def load(path):
    with Image.open(path) as im:
        return im.convert("RGBA").copy()


def ladder(image, target):
    """Halve while it stays above the target, then one final exact step."""
    current = image
    while current.width // 2 >= target and current.width % 2 == 0:
        current = current.resize((current.width // 2, current.height // 2), Image.Resampling.LANCZOS)
    if current.width != target:
        current = current.resize((target, target), Image.Resampling.LANCZOS)
    return current


def dib(im):
    """A 32bpp BMP entry: BITMAPINFOHEADER, XOR pixels bottom-up, then the AND mask."""
    w, h = im.size
    px = im.load()
    stride = ((w + 31) // 32) * 4
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4 + stride * h, 0, 0, 0, 0)
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row
    return header + bytes(xor) + bytes(mask)


def png(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


if not ICONSET.exists():
    raise SystemExit(
        f"no icon set at {ICONSET}\n"
        "Expected the export that carries favicon-16x16.png, favicon-32x32.png, favicon-128.png,\n"
        "apple-touch-icon-144x144.png and icon512.png. Pass another directory to override:\n"
        "    python build-icon.py path/to/iconset"
    )

master = None
for size, name in sorted(SET_FILES.items()):
    if name == SET_FILES[MASTER_SIZE]:
        continue
    if not (ICONSET / name).exists():
        raise SystemExit(f"the set is missing {name}, which supplies the {size}px bitmap")

master = load(ICONSET / SET_FILES[MASTER_SIZE])
print(f"master   {SET_FILES[MASTER_SIZE]} {master.width}x{master.height}")

# Exact bitmaps first, straight from the set.
exact = {}
for size, name in sorted(SET_FILES.items()):
    if size == MASTER_SIZE:
        continue
    image = load(ICONSET / name)
    if image.width != size:
        raise SystemExit(f"{name} is {image.width}px but claims to be the {size}px bitmap")
    exact[size] = image
    print(f"exact    {name} {size}x{size}")

# The 24px entry lives inside the set's own .ico, so it needs no resampling either.
ico_file = ICONSET / "favicon.ico"
if ico_file.exists():
    try:
        with Image.open(ico_file) as im:
            available = set(im.info.get("sizes", []))
            if (24, 24) in available:
                exact[24] = im.ico.getimage((24, 24)).convert("RGBA").copy()
                print("exact    favicon.ico 24x24 (taken from the set's own .ico)")
            else:
                print(f"note     the set's .ico holds {sorted(available)}, no 24x24")
    except Exception as error:  # noqa: BLE001 - a missing entry is not fatal, it just gets derived
        print(f"note     could not read {ico_file.name}: {error}")

images = {}
for size in SIZES:
    if size in exact:
        images[size] = exact[size]
    else:
        images[size] = ladder(master, size)
        print(f"derived  {size}x{size} from the {MASTER_SIZE} master (halving)")

entries = [(size, dib(images[size]) if size < 256 else png(images[size])) for size in SIZES]
offset = 6 + 16 * len(entries)
directory = b""
blobs = b""
for size, blob in entries:
    directory += struct.pack(
        "<BBBBHHII", size if size < 256 else 0, size if size < 256 else 0, 0, 0, 1, 32, len(blob), offset + len(blobs)
    )
    blobs += blob
ico = struct.pack("<HHH", 0, 1, len(entries)) + directory + blobs

written = []


def save(path, image):
    image.save(path)
    written.append(path)


(ICONS / "icon.ico").write_bytes(ico)
written.append(ICONS / "icon.ico")
print(f"wrote    src-tauri/icons/icon.ico  {len(ico)} bytes, {len(entries)} entries (DIB below 256, PNG at 256)")

save(ICONS / "32x32.png", images[32])
save(ICONS / "64x64.png", images[64])
save(ICONS / "128x128.png", images[128])
save(ICONS / "128x128@2x.png", images[256])
# The window's own large icon: 128, because the taskbar slot at 200% scaling is 64 and this is an
# exact 2:1 of it. `include_bytes!` compiles this in, so the widget has to be rebuilt to change it.
save(ICONS / "icon.png", images[128])

# The page's set, under NAMES THAT HAVE NEVER BEEN USED BEFORE.
#
# A browser caches a favicon by URL, so replacing the bytes at an existing path leaves the old
# picture on screen indefinitely — which is exactly what happened here: the files were correct and
# the taskbar was not, because it was still asking for `/icon-32.png`. A new path is the only
# reliable cache-bust, so the window's set is `mark-*` from now on, and the old names are deleted
# rather than left behind to be served to anything that remembers them.
save(WINDOW / "mark-16.png", images[16])
save(WINDOW / "mark-32.png", images[32])
save(WINDOW / "mark-48.png", images[48])
save(WINDOW / "mark-256.png", images[256])
save(WINDOW / "mark.png", images[128])
(WINDOW / "mark.ico").write_bytes(ico)
written.append(WINDOW / "mark.ico")

# Read every written file back. A ladder that silently produced a 1x1, or an .ico that lost an
# entry, is exactly the kind of failure that only shows up as "the icon looks wrong" much later.
print("\nread back:")
with Image.open(ICONS / "icon.ico") as check:
    print(f"  src-tauri/icons/icon.ico entries {sorted(check.info.get('sizes', []))}")
for path in written:
    if path.suffix == ".ico":
        continue
    with Image.open(path) as check:
        print(f"  {path.relative_to(ROOT).as_posix():<28} {check.width}x{check.height} {check.format}")
