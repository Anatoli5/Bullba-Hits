# -*- coding: utf-8 -*-
"""The game's own gun sight for the replay viewer's shot view (20.11.2026, NOTEBOOK T4), read from the user's client.

The client's sight is Scaleform Flash (read 20.11.2026 in NA 2.4.1.1, `C:/Projects/WoT-Base/KNOWLEDGE-client.md`
'The battle sight'): the centre mark is a sprite of one bitmap a frame (arcadeCrosshair.swf / sniperCrosshair.swf,
`<swf>_fla.Crosshair_mark_<n>`), the gun marker's tag another (crosshairControls.swf `GunMarkerTagUI`, a frame of colour
variants each), both lossless bitmaps (DefineBitsLossless2: zlib, premultiplied ARGB); the dispersion circle itself is
vector shapes sized by ActionScript and is not taken here (the page draws its own ring). Which frame: the setting's type +
1 (`TYPES`, the defaults of AccountSettings 2.4.1.1 - the user asked for the game's default sight); that the type picks
the frame this way is a guess (the frame counts fit: 14 centre marks, 15 tags), not read from the ActionScript.

steps(pk, out): one SWF a step (read from the packages through map_raw.Packages, inflated, its tags walked); out['value']
= {format, types, arcade: {centre, tag}, sniper: {centre, tag}, basis} where each image is {w, h, x, y (its top-left
from the sprite's registration point = the aim point, px), rgba (base64, straight alpha)}, or out['error'] in words.
Nothing of the client is kept in the repository: the file is made in the user's CFG at run time. Pure: no game module;
the client's Python 2.7 and CPython 3.
"""
from __future__ import absolute_import, division
import base64
import struct
import zlib

FORMAT = 1
KEY = 'playback-sight:'
SWFS = (('controls', 'gui/flash/crosshairControls.swf'), ('arcade', 'gui/flash/arcadeCrosshair.swf'),
        ('sniper', 'gui/flash/sniperCrosshair.swf'))
# AccountSettings.pyc 2.4.1.1 DEFAULT_VALUES (dis with the client's Python 20.11.2026): arcade mixing 3, gunTag 9,
# centralTag 8, net 0; sniper all 0
TYPES = {'arcade': {'centralTag': 8, 'gunTag': 9}, 'sniper': {'centralTag': 0, 'gunTag': 0}}
TAG_SYMBOL = 'GunMarkerTagUI'
SHAPES = (2, 22, 32, 83)
BITMAPS = (20, 36)
KEPT = SHAPES + BITMAPS + (39,)


class Bits(object):
    def __init__(self, b, p): self.b, self.p, self.bit = b, p, 0

    def u(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.b[self.p] >> (7 - self.bit)) & 1)
            self.bit += 1
            if self.bit == 8: self.bit, self.p = 0, self.p + 1
        return v

    def s(self, n):
        v = self.u(n)
        return v - (1 << n) if n and v >> (n - 1) else v

    def align(self):
        if self.bit: self.bit, self.p = 0, self.p + 1


def rect(bb):
    n = bb.u(5)
    r = [bb.s(n) for _ in range(4)]
    bb.align()
    return r                                     # xmin, xmax, ymin, ymax (twips)


def matrix(bb):
    """(sx, sy, tx, ty) of a MATRIX record (rotation skipped), twips."""
    sx = sy = 1.0
    if bb.u(1): n = bb.u(5); sx, sy = bb.s(n) / 65536.0, bb.s(n) / 65536.0
    if bb.u(1): n = bb.u(5); bb.s(n); bb.s(n)
    n = bb.u(5); tx, ty = bb.s(n), bb.s(n)
    bb.align()
    return sx, sy, tx, ty


def body(data):
    sig = bytes(data[:3])
    if sig in (b'CWS', b'CFX'): b = bytearray(zlib.decompress(bytes(data[8:])))
    elif sig in (b'FWS', b'GFX'): b = bytearray(data[8:])
    else: raise ValueError('not a SWF (%r)' % sig)
    return b, (5 + 4 * (b[0] >> 3) + 7) // 8 + 4


def tags(b, p):
    while p + 2 <= len(b):
        h = struct.unpack_from('<H', b, p)[0]; p += 2
        code, ln = h >> 6, h & 63
        if ln == 63: ln = struct.unpack_from('<I', b, p)[0]; p += 4
        yield code, b[p:p + ln]
        p += ln
        if code == 0: break


def cstr(b, i):
    j = b.find(b'\x00', i)
    return bytes(b[i:j]).decode('latin-1'), j + 1


def read(data):
    """({character id: (tag code, bytes)} of shapes, bitmaps and sprites, {symbol class name: id})."""
    b, p = body(data)
    chars, syms = {}, {}
    for code, t in tags(b, p):
        if code in KEPT: chars[struct.unpack_from('<H', t, 0)[0]] = (code, t)
        elif code == 76:
            n, i = struct.unpack_from('<H', t, 0)[0], 2
            for _ in range(n):
                cid = struct.unpack_from('<H', t, i)[0]
                name, i = cstr(t, i + 2)
                syms[name] = cid
    return chars, syms


def frames(sprite):
    """[[(character id, tx, ty px)] placed in each frame] of a DefineSprite (PlaceObject2 with a character)."""
    out, cur = [], []
    for code, t in tags(sprite, 4):
        if code == 26 and t[0] & 2:
            cid, q, tx, ty = struct.unpack_from('<H', t, 3)[0], 5, 0.0, 0.0
            if t[0] & 4:
                bb = Bits(t, q); sx, sy, tx, ty = matrix(bb); tx, ty = tx / 20.0, ty / 20.0
            cur.append((cid, tx, ty))
        elif code == 1:
            out.append(cur); cur = []
    if cur: out.append(cur)
    return out


def shape_bitmap(code, t):
    """(bitmap id, (xmin, ymin, xmax, ymax) px) of a shape filled by one bitmap, else None."""
    bb = Bits(t, 2)
    r = rect(bb)
    if code == 83: rect(bb); bb.p += 1
    p = bb.p
    n = t[p]; p += 1
    if n == 0xff and code != 2: n = struct.unpack_from('<H', t, p)[0]; p += 2
    for _ in range(n):
        kind = t[p]; p += 1
        if 0x40 <= kind <= 0x43:
            bid = struct.unpack_from('<H', t, p)[0]
            if bid != 0xffff: return bid, (r[0] / 20.0, r[2] / 20.0, r[1] / 20.0, r[3] / 20.0)
            bb = Bits(t, p + 2); matrix(bb); p = bb.p           # 0xffff: a fill with no bitmap
            continue
        if kind == 0: p += 3 if code in (2, 22) else 4
        else: return None
    return None


def first_bitmap(chars, cid, dx=0.0, dy=0.0, depth=0):
    """(bitmap id, rect px from the registration point) of the first bitmap reached through the first frame."""
    if depth > 8 or cid not in chars: return None
    code, t = chars[cid]
    if code in SHAPES:
        got = shape_bitmap(code, t)
        if got is None: return None
        x0, y0, x1, y1 = got[1]
        return got[0], (x0 + dx, y0 + dy, x1 + dx, y1 + dy)
    if code == 39:
        fr = frames(t)
        for child, tx, ty in (fr[0] if fr else ()):
            got = first_bitmap(chars, child, dx + tx, dy + ty, depth + 1)
            if got: return got
    return None


def image(chars, bid, box):
    code, t = chars[bid]
    cid, fmt, w, h = struct.unpack_from('<HBHH', t, 0)
    if fmt != 5: raise ValueError('bitmap %d of format %d' % (cid, fmt))
    px = bytearray(zlib.decompress(bytes(t[7:])))
    out = bytearray(w * h * 4)
    for i in range(w * h):
        a, r, g, b = px[4 * i], px[4 * i + 1], px[4 * i + 2], px[4 * i + 3]
        if code == 36:
            if a: r, g, b = min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a)
        else: a = 255
        out[4 * i], out[4 * i + 1], out[4 * i + 2], out[4 * i + 3] = r, g, b, a
    x0, y0, x1, y1 = box
    return {'w': w, 'h': h, 'x': round(x0, 2), 'y': round(y0, 2), 'dw': round(x1 - x0, 2), 'dh': round(y1 - y0, 2),
            'rgba': base64.b64encode(bytes(out)).decode('ascii')}


def frame_image(chars, sprite_id, frame):
    """The image of frame `frame` (0-based) of a sprite: the first bitmap through what that frame places."""
    code, t = chars[sprite_id]
    fr = frames(t)
    if frame >= len(fr): raise ValueError('sprite %d has %d frames, not %d' % (sprite_id, len(fr), frame + 1))
    for child, tx, ty in fr[frame]:
        got = first_bitmap(chars, child, tx, ty)
        if got: return image(chars, got[0], got[1])
    raise ValueError('frame %d of sprite %d holds no bitmap' % (frame + 1, sprite_id))


def mark_symbol(syms, swf):
    for name in sorted(syms):
        if name.startswith(swf + '_fla.Crosshair_mark_'): return syms[name]
    raise ValueError('%s.swf has no centre mark' % swf)


def steps(pk, out):
    """Generator, one SWF a step; out['value'] or out['error'] ('<step>: <exception>')."""
    got, step = {}, 'start'
    try:
        for name, path in SWFS:
            step = 'reading ' + path
            pkg, entry = pk.find(path)
            if entry is None: raise ValueError('not in the packages')
            got[name] = read(pk.read(pkg, entry))
            yield
        step = 'the images'
        value = {'format': FORMAT, 'types': TYPES,
                 'basis': 'the client\'s own Flash sight, read at run time; type -> frame = type + 1 is a guess'}
        controls = got['controls']
        tag = controls[1].get(TAG_SYMBOL)
        if tag is None: raise ValueError('crosshairControls.swf has no ' + TAG_SYMBOL)
        for mode in ('arcade', 'sniper'):
            chars, syms = got[mode]
            value[mode] = {'centre': frame_image(chars, mark_symbol(syms, mode + 'Crosshair'), TYPES[mode]['centralTag']),
                           'tag': frame_image(controls[0], tag, TYPES[mode]['gunTag'])}
        out['value'] = value
        yield
    except Exception as e:
        out['error'] = '%s: %s: %s' % (step, type(e).__name__, e)
