#!/usr/bin/env python3
"""Build data/zoey.json from the images in photos/zoey/.

Usage (from the repo root):

    python scripts/build_zoey.py

Drop photos anywhere under photos/zoey/. Subdirectories become albums
("puppy-days" -> "Puppy Days"); files directly in photos/zoey/ land in the
default "Photos" album. Supported: .jpg/.jpeg/.png/.webp/.gif — HEIC is
skipped with a warning because browsers can't display it (export iPhone
photos as JPEG).

For every image the script records the path, pixel dimensions (EXIF
orientation respected, so portrait shots keep their aspect), the EXIF
DateTimeOriginal when present, and a caption. Captions come from an optional
captions.txt in the same directory (lines of "filename: caption text",
'#' comments allowed); otherwise a camera-ish filename (IMG_1234, DSC_...,
PXL_..., timestamps) gets no caption and anything else is prettified
("zoey_first_snow.jpg" -> "Zoey first snow").

Stdlib only, like the other builders in this directory. The output is
committed — rerun after adding photos and commit both. zoey.html renders
the result; the two share the manifest shape, change them together.
"""

import json
import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PHOTO_DIR = ROOT / 'photos' / 'zoey'
OUT = ROOT / 'data' / 'zoey.json'

EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
SKIP_EXTS = {'.heic', '.heif'}
BIG_WARN = 1_200_000  # bytes; nudge toward web-sized exports
DEFAULT_ALBUM = ('', 'Photos')

CAMERA_NAME = re.compile(
    r'^(img|dsc|dscn|dscf|pxl|mvimg|gopr|p\d{7}|\d{8}[_-]\d{6}|screenshot)[\w-]*$',
    re.IGNORECASE)


# ---------------------------------------------------------------- dimensions

def png_size(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    w, h = struct.unpack('>II', data[16:24])
    return w, h


def gif_size(data):
    if data[:6] not in (b'GIF87a', b'GIF89a'):
        return None
    w, h = struct.unpack('<HH', data[6:10])
    return w, h


def webp_size(data):
    if data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        return None
    fmt = data[12:16]
    if fmt == b'VP8X':
        w = int.from_bytes(data[24:27], 'little') + 1
        h = int.from_bytes(data[27:30], 'little') + 1
        return w, h
    if fmt == b'VP8 ':
        w, h = struct.unpack('<HH', data[26:30])
        return w & 0x3FFF, h & 0x3FFF
    if fmt == b'VP8L':
        bits = int.from_bytes(data[21:25], 'little')
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


def jpeg_size(data):
    """Width/height from the first SOF marker."""
    if data[:2] != b'\xff\xd8':
        return None
    i = 2
    n = len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seglen = struct.unpack('>H', data[i + 2:i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack('>HH', data[i + 5:i + 9])
            return w, h
        i += 2 + seglen
    return None


# ---------------------------------------------------------------------- EXIF

def exif_fields(data):
    """(DateTimeOriginal, orientation) from a JPEG's APP1 Exif block.

    Either may be None. Best-effort: any parse hiccup returns what was
    found so far — a malformed EXIF block must never sink the build.
    """
    date = None
    orient = None
    try:
        i, n = 2, len(data)
        tiff = None
        while i + 4 <= n:
            if data[i] != 0xFF:
                break
            marker = data[i + 1]
            if marker == 0xDA:  # start of scan — no APP1 coming
                break
            seglen = struct.unpack('>H', data[i + 2:i + 4])[0]
            if marker == 0xE1 and data[i + 4:i + 10] == b'Exif\x00\x00':
                tiff = data[i + 10:i + 2 + seglen]
                break
            i += 2 + seglen
        if not tiff or len(tiff) < 8:
            return None, None
        endian = '<' if tiff[:2] == b'II' else '>'
        u16 = lambda o: struct.unpack(endian + 'H', tiff[o:o + 2])[0]
        u32 = lambda o: struct.unpack(endian + 'I', tiff[o:o + 4])[0]

        def read_ifd(off):
            entries = {}
            count = u16(off)
            for k in range(count):
                e = off + 2 + 12 * k
                entries[u16(e)] = e
            return entries

        ifd0 = read_ifd(u32(4))
        if 0x0112 in ifd0:  # Orientation, SHORT in the value slot
            orient = u16(ifd0[0x0112] + 8)
        exif_ptr = ifd0.get(0x8769)
        date_entry = None
        if exif_ptr is not None:
            exif_ifd = read_ifd(u32(exif_ptr + 8))
            date_entry = exif_ifd.get(0x9003)  # DateTimeOriginal
        if date_entry is None:
            date_entry = ifd0.get(0x0132)  # file DateTime fallback
        if date_entry is not None:
            raw = tiff[u32(date_entry + 8):u32(date_entry + 8) + 19]
            txt = raw.decode('ascii', 'replace')
            dt = datetime.strptime(txt, '%Y:%m:%d %H:%M:%S')
            date = dt.strftime('%Y-%m-%d')
    except Exception:
        pass
    return date, orient


# ------------------------------------------------------------------ captions

def load_captions(dirpath):
    caps = {}
    f = dirpath / 'captions.txt'
    if not f.exists():
        return caps
    for line in f.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or ':' not in line:
            continue
        name, cap = line.split(':', 1)
        caps[name.strip().lower()] = cap.strip()
    return caps


def auto_caption(stem):
    if CAMERA_NAME.match(stem):
        return None
    words = re.sub(r'[_-]+', ' ', stem).strip()
    words = re.sub(r'\s+\d+$', '', words)  # trailing "... 2" counters
    return (words[:1].upper() + words[1:]) if words else None


def album_title(dirname):
    return re.sub(r'[_-]+', ' ', dirname).strip().title()


# --------------------------------------------------------------------- build

def main():
    if not PHOTO_DIR.exists():
        PHOTO_DIR.mkdir(parents=True)
    albums = {}
    warnings = []

    for path in sorted(PHOTO_DIR.rglob('*')):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext in SKIP_EXTS:
            warnings.append(f'skipped (browsers cannot show HEIC — export as JPEG): {path.relative_to(ROOT)}')
            continue
        if ext not in EXTS:
            continue
        data = path.read_bytes()
        size = jpeg_size(data) or png_size(data) or gif_size(data) or webp_size(data)
        if not size:
            warnings.append(f'skipped (could not read image header): {path.relative_to(ROOT)}')
            continue
        w, h = size
        date, orient = exif_fields(data) if ext in ('.jpg', '.jpeg') else (None, None)
        if orient in (5, 6, 7, 8):  # EXIF says rotate 90° — browser will
            w, h = h, w
        if len(data) > BIG_WARN:
            warnings.append(f'large file ({len(data) // 1024} KB) — consider a ~2000px web export: {path.relative_to(ROOT)}')

        rel = path.relative_to(PHOTO_DIR)
        if len(rel.parts) > 1:
            aid = rel.parts[0]
            title = album_title(aid)
        else:
            aid, title = DEFAULT_ALBUM
        caps = load_captions(path.parent)
        cap = caps.get(path.name.lower()) or auto_caption(path.stem)

        photo = {'src': str(path.relative_to(ROOT)).replace('\\', '/'), 'w': w, 'h': h}
        if date:
            photo['d'] = date
        if cap:
            photo['c'] = cap
        albums.setdefault(aid, {'id': aid, 'title': title, 'photos': []})
        albums[aid]['photos'].append(photo)

    # Newest first inside each album when dates exist; name-sorted otherwise.
    for a in albums.values():
        a['photos'].sort(key=lambda p: (p.get('d') or '', p['src']), reverse=True)

    out = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'count': sum(len(a['photos']) for a in albums.values()),
        'albums': sorted(albums.values(), key=lambda a: a['id']),
    }
    OUT.write_text(json.dumps(out, separators=(',', ':')) + '\n', encoding='utf-8')

    for wmsg in warnings:
        print('warning:', wmsg, file=sys.stderr)
    print(f'wrote {OUT.relative_to(ROOT)}: {out["count"]} photos in {len(out["albums"])} album(s)')


if __name__ == '__main__':
    main()
