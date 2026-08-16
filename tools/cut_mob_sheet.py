"""Cut the labelled mob poses out of the spritesheet*.png art into frame strips.

The source sheets lay their poses out freely on a magenta backdrop, in labelled
groups ("IDLE", "WALK (Forward)", ...). This keys out the backdrop, finds the
poses as connected blobs, throws away the label text and the decorative sparkle
by size, sorts what's left into the group layout below, normalises every pose
onto a common ground line and frame box, and writes src/game/mobSheetData.js.

    python3 tools/cut_mob_sheet.py        # needs numpy + Pillow

All sheets share one frame box (the largest pose across all of them wins), so
every strip has the same geometry and mobSprites can index them identically.
POSES is the layout contract: if a sheet doesn't match it, the run fails loudly
rather than quietly mislabelling a pose. FRAME_ORDER is what mobSprites.FRAMES
indexes into, so the two must be changed together.
"""
import base64
import io
import re
from pathlib import Path
from typing import NamedTuple

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'game' / 'mobSheetData.js'

# Character -> source art. The key is the skin name the game spawns.
#
# The art is big enough to live outside git, so most of these .png files are
# usually absent: a character whose source is missing keeps the strip cut on the
# last run (see previous_strips). Drop a sheet back in to re-cut just that one.
# Check what a file actually draws before pointing a character at it — earlier
# drops had the nurse in trunks.png and the granny in nurse.png.
#
# `bg` overrides the chroma-key colour for sheets drawn on a different magenta,
# and `erase` blanks hi-res (x0, y0, x1, y1) rectangles back to the backdrop
# before keying — that is how a title card the art generator stamped onto the
# sheet is kept out of the pose layout. Rectangles are in source pixels, so
# re-check them if the art is redrawn.
class Sheet(NamedTuple):
    path: Path
    bg: np.ndarray = None      # None -> BG
    erase: tuple = ()


SHEETS = {
    'zombie': Sheet(ROOT / 'spritesheet.png'),
    'ghoul': Sheet(ROOT / 'spritesheet2.png'),
    'nurse': Sheet(ROOT / 'nurse.png'),
    'granny': Sheet(ROOT / 'granny.png'),
    'firefighter': Sheet(ROOT / 'firefighter.png'),
    # Shirtless zombie in striped trunks; a flip-flop lies by the corpse and is
    # dropped as too small to be a pose.
    'bather': Sheet(ROOT / 'zomb1.png', bg=np.array([177, 1, 128], dtype=np.float32)),
    # Militia zombie. The sheet carries a "POLICEMAN ZOMBIE (POLAND 1993)" title
    # card between the IDLE and HURT groups — big enough to read as a pose, so it
    # is erased first. JPEG, hence the slightly noisier backdrop.
    'policeman': Sheet(
        ROOT / 'zomb2.jpeg',
        bg=np.array([177, 0, 130], dtype=np.float32),
        erase=((1000, 0, 1780, 500),),
    ),
}

# NPC-only character sheets: a single band of two idle poses on the same
# magenta backdrop — no walk/attack/death art, because NPCs only ever play
# idle (see game/NPC.js). The two idles fill every frame of the strip so it
# indexes exactly like a mob's, and NPC_ONLY_SHEETS tells the game to never
# hand these skins to a random mob spawn.
NPC_SHEETS = {
    'bolek': ROOT / 'examples' / 'bolek.png',
}
NPC_POSES = [[['idle0'], ['idle1']]]
NPC_FRAME_MAP = {
    'idle0': 'idle0', 'idle1': 'idle1',
    'walk0': 'idle0', 'walk1': 'idle1',
    'attack0': 'idle0', 'attack1': 'idle1',
    'hurt0': 'idle0', 'hurt1': 'idle1',
    'dying0': 'idle0', 'dying1': 'idle1', 'dead': 'idle0',
}

BG = np.array([193, 0, 143], dtype=np.float32)  # the sheets' chroma-key magenta
NPC_BG = np.array([254, 1, 252], dtype=np.float32)  # the NPC sheets' brighter magenta

# Group layout: poses grouped into three horizontal bands, each band split into
# a left and a right group, each group read left to right.
POSES = [
    [['idle0', 'idle1'], ['hurt0', 'hurt1']],
    [['walk0', 'walk1'], ['attack0', 'attack1']],
    [['dying0', 'dying1'], ['dead']],
]

# The packed strip. `mirror` reuses one pose flipped for the opposite stride.
FRAME_ORDER = [
    ('idle0', False), ('idle1', False),
    ('walk0', False), ('walk1', False), ('walk1', True),
    ('attack0', False), ('attack1', False),
    ('hurt0', False), ('hurt1', False),
    ('dying0', False), ('dying1', False), ('dead', False),
]

F = 8              # hi-res -> logical downscale
PAD_X = PAD_Y = 8  # hi-res padding kept clear inside the frame box
# Vertical gap that separates two pose bands. Roomy on purpose: within the last
# band a standing collapse pose starts ~200px above the corpse lying beside it,
# while one band starts ~470px below the one above it.
BAND_GAP = 300
MIN_POSE_H = 120   # taller than any label; shorter than the flattest corpse
MIN_POSE_AREA = 30000


def label_blobs(keep, min_area=1):
    """Connected components of a boolean mask -> list of (cells, area)."""
    from collections import deque
    h, w = keep.shape
    seen = np.zeros_like(keep)
    out = []
    for sy in range(h):
        for sx in range(w):
            if not keep[sy, sx] or seen[sy, sx]:
                continue
            q, cells = deque([(sy, sx)]), []
            seen[sy, sx] = True
            while q:
                cy, cx = q.popleft()
                cells.append((cy, cx))
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < h and 0 <= nx < w and keep[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(cells) >= min_area:
                out.append(cells)
    return out


def despeckle(keep, min_area):
    """Drop islands too small to be part of a pose (stray bits of label text)."""
    out = np.zeros_like(keep)
    for cells in label_blobs(keep, min_area):
        for cy, cx in cells:
            out[cy, cx] = True
    return out


def key_out(path, bg=BG, erase=()):
    """Chroma-key a sheet -> (rgb, alpha), with the backdrop un-mixed from edges.

    Anything inside an `erase` rectangle is painted out with the backdrop first,
    so it never reaches pose finding.
    """
    src = np.array(Image.open(path).convert('RGB')).astype(np.float32)
    for x0, y0, x1, y1 in erase:
        src[y0:y1, x0:x1] = bg
    dist = np.abs(src - bg).sum(axis=2)
    alpha = np.clip((dist - 70.0) / 90.0, 0.0, 1.0)
    a3 = alpha[:, :, None]
    rgb = np.clip(np.where(a3 > 0.02, (src - (1.0 - a3) * bg) / np.maximum(a3, 0.02), 0.0), 0, 255)
    return rgb, alpha


def find_poses(alpha, layout=POSES):
    """Locate the pose blobs and name them by the `layout` groups. -> {name: box}."""
    S = 4
    h, w = alpha.shape
    hh, ww = h // S, w // S
    small = (alpha[:hh * S, :ww * S] > 0.5).reshape(hh, S, ww, S).max(axis=(1, 3))

    # A pose is one big connected mass; every label glyph and the decorative
    # sparkle fall well under both thresholds. Nothing is merged first, so a
    # label a pose nearly touches — the ghoul's hair under "(Forward)" — can't
    # ride along into the frame.
    boxes = []
    for cells in label_blobs(small):
        ys = [c[0] for c in cells]
        xs = [c[1] for c in cells]
        box = (min(xs) * S, min(ys) * S, (max(xs) + 1) * S, (max(ys) + 1) * S)
        if box[3] - box[1] >= MIN_POSE_H and len(cells) * S * S >= MIN_POSE_AREA:
            boxes.append(drop_label_rows(alpha, box))

    bands = []
    for box in sorted(boxes, key=lambda b: b[1]):
        if bands and box[1] - bands[-1][-1][1] < BAND_GAP:
            bands[-1].append(box)
        else:
            bands.append([box])

    if len(bands) != len(layout):
        raise SystemExit(f'expected {len(layout)} pose bands, found {len(bands)}')

    named = {}
    for band, groups in zip(bands, layout):
        mid = alpha.shape[1] / 2
        left = sorted([b for b in band if b[0] < mid], key=lambda b: b[0])
        right = sorted([b for b in band if b[0] >= mid], key=lambda b: b[0])
        for found, expected in zip((left, right), groups):
            if len(found) != len(expected):
                raise SystemExit(f'expected poses {expected}, found {len(found)} blobs')
            named.update(zip(expected, found))
    return named


def drop_label_rows(alpha, box):
    """Clip a label off the top of a pose box.

    Pose finding runs on a 4x-pooled mask, which closes the few-pixel gap
    between a label and the art right under it (the firefighter's helmet sits
    5px below "WALK (Forward)", the nurse's cap touches "WALK" outright), so a
    box can start at the text.

    A label gives itself away by its shape: it is a wide band in the top
    quarter of the box with a much narrower head under it. A real head is the
    other way round — it only ever widens as it runs down into the shoulders.
    """
    x0, y0, x1, y1 = box
    rows = (alpha[y0:y1, x0:x1] > 0.5).sum(axis=1)
    n = len(rows)

    band = 0
    for k in range(1, int(n * 0.25) + 1):
        band = max(band, rows[k - 1])
        # Only a band as wide as the pose's widest row can be a label; a head
        # is a fraction of the shoulders below it, so it never qualifies.
        if band < max(25, 0.55 * rows.max()):
            continue
        if rows[k] <= 0.45 * band and rows[k:k + 12].max() <= 0.6 * band:
            return (x0, y0 + k, x1, y1)
    return box


def cut(rgb, alpha, box):
    """Tight-cropped (rgb, alpha) for one pose, plus its alignment anchor x."""
    x0, y0, x1, y1 = box
    a = alpha[y0:y1, x0:x1]
    c = rgb[y0:y1, x0:x1]
    solid = despeckle(a > 0.5, min_area=400)
    a = np.where(solid, a, 0.0)
    ys, xs = np.nonzero(solid)
    a = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    c = c[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    solid = solid[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

    h, w = a.shape
    if h > w * 0.9:
        # Standing pose: anchor on the head/torso mass so the body stays put
        # across the cycle while the legs swing.
        anchor = float(np.nonzero(solid[: max(1, int(h * 0.45))])[1].mean())
    else:
        anchor = w / 2.0
    return c, a, anchor


def rescale_pose(pose, factor):
    """Scale a cut pose (rgb, alpha, anchor) by `factor`, LANCZOS-filtered."""
    c, a, anchor = pose
    h, w = a.shape
    size = (max(1, round(w * factor)), max(1, round(h * factor)))
    rgb = np.asarray(Image.fromarray(np.clip(c, 0, 255).astype(np.uint8)).resize(size, Image.LANCZOS), np.float32)
    alpha = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize(size, Image.LANCZOS), np.float32) / 255.0
    return rgb, np.clip(alpha, 0.0, 1.0), anchor * factor


def stand_target_px(mob_poses, any_carried):
    """Hi-res standing height NPC art is scaled to match: the tallest mob in the
    run, cut now or carried from the last one.

    A carried strip has no poses to measure, so it stands in with the last run's
    SHEET_STAND_ROWS — otherwise re-cutting one short sheet while the rest carry
    would quietly resize every NPC.
    """
    heights = [a.shape[0] for sheet in mob_poses for _, a, _ in sheet.values()]
    if any_carried:
        heights.append(int(re.search(r'SHEET_STAND_ROWS = (\d+)', OUT.read_text()).group(1)) * F)
    return max(heights)


def strip_for(poses, frame_w, frame_h):
    """Pack one sheet's poses into a logical-resolution RGBA strip."""
    hw, hh = frame_w * F, frame_h * F
    strip = np.zeros((frame_h, frame_w * len(FRAME_ORDER), 4), np.uint8)

    for i, (name, mirror) in enumerate(FRAME_ORDER):
        c, a, anchor = poses[name]
        if mirror:
            c, a = c[:, ::-1], a[:, ::-1]
            anchor = a.shape[1] - anchor

        fc = np.zeros((hh, hw, 3), np.float32)
        fa = np.zeros((hh, hw), np.float32)
        h, w = a.shape
        # Feet on the baseline, anchor on the frame centre line.
        dy = max(0, min(hh - h, hh - PAD_Y - h))
        dx = max(0, min(hw - w, int(round(hw / 2.0 - anchor))))
        fc[dy:dy + h, dx:dx + w] = c
        fa[dy:dy + h, dx:dx + w] = a

        # Alpha-weighted box filter down to logical resolution, then a hard
        # alpha cut so the result stays crisp under the renderer's nearest filter.
        tiles = fa.reshape(frame_h, F, frame_w, F)
        cover = tiles.mean(axis=(1, 3))
        num = (fc * fa[:, :, None]).reshape(frame_h, F, frame_w, F, 3).sum(axis=(1, 3))
        den = np.maximum(tiles.sum(axis=(1, 3)), 1e-3)
        keep = despeckle(cover >= 0.45, min_area=10)

        px = np.zeros((frame_h, frame_w, 4), np.uint8)
        px[:, :, :3] = np.clip(num / den[:, :, None], 0, 255).astype(np.uint8)
        px[:, :, 3] = np.where(keep, 255, 0)
        px[~keep] = 0
        strip[:, i * frame_w:(i + 1) * frame_w] = px
    return strip


def unspill_outline(strip):
    """Take the backdrop back out of the black outline.

    The art is drawn on magenta and its outline pixels are blended with it,
    which the distance-based key cannot undo: a half-black/half-magenta pixel
    is far enough from the backdrop to read as fully opaque, so it survives as
    dark purple and rings every sprite.

    Spill shows up as a magenta cast — red and blue lifted above green — on a
    dark pixel, so those are flattened onto their own darkest channel: the
    outline keeps how dark it was and comes out neutral. Only pixels touching
    transparency are considered, and only dark ones, so purple *art* is left
    alone: the ghoul's shirt and the granny's pale skin both stay put.
    """
    rgb = strip[:, :, :3].astype(np.int16)
    opaque = strip[:, :, 3] > 0
    pad = np.pad(opaque, 1)
    edge = opaque & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])

    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    cast = (r > g + 6) & (b > g + 2) & (rgb.max(axis=2) < 95)
    flat = rgb.min(axis=2)[:, :, None].repeat(3, axis=2)
    strip[:, :, :3] = np.where((edge & cast)[:, :, None], flat, rgb).astype(np.uint8)
    return strip


def encode(strip):
    """Quantise (alpha stays a hard mask) and encode as a base64 PNG."""
    quantised = Image.fromarray(strip[:, :, :3]).quantize(colors=40, method=Image.MEDIANCUT)
    out = np.dstack([np.array(quantised.convert('RGB')), strip[:, :, 3]])
    out[strip[:, :, 3] == 0] = 0
    buf = io.BytesIO()
    Image.fromarray(out).save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def previous_strips():
    """Strips already in the generated module, as {name: (frame_w, strip)}.

    The source art is huge and lives outside git, so a sheet whose .png is no
    longer on disk is carried over from the last run instead of being dropped.
    """
    if not OUT.exists():
        return {}
    text = OUT.read_text()
    fw = int(re.search(r'SHEET_FRAME_W = (\d+)', text).group(1))
    body = text.split('const B64 = {')[1].split('\n};')[0]
    out = {}
    for name, block in re.findall(r'(\w+): \[(.*?)\]\.join', body, re.S):
        b64 = ''.join(re.findall(r"'([^']*)'", block))
        img = Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGBA')
        out[name] = (fw, np.array(img))
    return out


def repack(old_w, strip, frame_w, frame_h):
    """Move an already-cut strip into a bigger frame box, ground line intact."""
    old_h = strip.shape[0]
    if old_w > frame_w or old_h > frame_h:
        raise SystemExit('frame box shrank; restore every source .png and re-cut')
    out = np.zeros((frame_h, frame_w * len(FRAME_ORDER), 4), np.uint8)
    dx, dy = (frame_w - old_w) // 2, frame_h - old_h
    for i in range(len(FRAME_ORDER)):
        frame = strip[:, i * old_w:(i + 1) * old_w]
        out[dy:, i * frame_w + dx:i * frame_w + dx + old_w] = frame
    return out


carried = previous_strips()
cut_sheets, reused = {}, {}
for name, sheet in SHEETS.items():
    path = sheet.path
    if path.exists():
        rgb, alpha = key_out(path, BG if sheet.bg is None else sheet.bg, sheet.erase)
        boxes = find_poses(alpha)
        cut_sheets[name] = {pose: cut(rgb, alpha, box) for pose, box in boxes.items()}
        print(f'{name}: {len(boxes)} poses from {path.name}')
    elif name in carried:
        reused[name] = carried[name]
        print(f'{name}: {path.name} is missing — carrying the strip from the last run')
    else:
        raise SystemExit(f'{name}: no {path.name} and nothing to carry over')

# NPC sheets: cut the two idles, scale them to the mob sheets' standing height
# (the source art is drawn at a different resolution), and fill the whole
# 12-frame order from them.
npc_target = stand_target_px(list(cut_sheets.values()), bool(reused))
for name, path in NPC_SHEETS.items():
    if path.exists():
        rgb, alpha = key_out(path, NPC_BG)
        idles = {pose: cut(rgb, alpha, box) for pose, box in find_poses(alpha, NPC_POSES).items()}
        factor = npc_target / max(a.shape[0] for _, a, _ in idles.values())
        idles = {pose: rescale_pose(p, factor) for pose, p in idles.items()}
        cut_sheets[name] = {frame: idles[src] for frame, src in NPC_FRAME_MAP.items()}
        print(f'{name}: 2 idle poses from {path.name}, scaled x{factor:.3f}')
    elif name in carried:
        reused[name] = carried[name]
        print(f'{name}: {path.name} is missing — carrying the strip from the last run')
    else:
        raise SystemExit(f'{name}: no {path.name} and nothing to carry over')

# One frame box for every sheet: the largest pose (plus padding, rounded to F)
# or the largest carried strip, whichever is bigger.
wide = max([a.shape[1] for s in cut_sheets.values() for _, a, _ in s.values()] or [0])
tall = max([a.shape[0] for s in cut_sheets.values() for _, a, _ in s.values()] or [0])
FRAME_W = max([-(-(wide + 2 * PAD_X) // F)] + [w for w, _ in reused.values()])
FRAME_H = max([-(-(tall + 2 * PAD_Y) // F)] + [s.shape[0] for _, s in reused.values()])

strips = {}
for name in list(SHEETS) + list(NPC_SHEETS):
    if name in cut_sheets:
        strips[name] = strip_for(cut_sheets[name], FRAME_W, FRAME_H)
    else:
        strips[name] = repack(*reused[name], FRAME_W, FRAME_H)
    strips[name] = unspill_outline(strips[name])

# Where a standing character actually sits inside the frame. The frame box has
# to fit the widest, tallest thing on any sheet — an outflung arm, a corpse
# lying down — so a figure on its feet never fills it. The renderer scales a
# sprite by these rather than by the frame, otherwise every mob comes out
# noticeably shorter than the height its type asks for.
STANDING = [i for i, (pose, _) in enumerate(FRAME_ORDER) if not pose.startswith(('dying', 'dead'))]
tops, feet = [], []
for strip in strips.values():
    for i in STANDING:
        rows = np.nonzero((strip[:, i * FRAME_W:(i + 1) * FRAME_W, 3] > 0).any(axis=1))[0]
        tops.append(int(rows.min()))
        feet.append(int(rows.max()) + 1)
STAND_ROWS = max(feet) - min(tops)   # the tallest character's full height
GROUND_ROW = max(feet)               # the row the feet stand on

entries = []
for name, strip in strips.items():
    png = encode(strip)
    b64 = base64.b64encode(png).decode()
    lines = ',\n'.join(f"    '{b64[i:i + 92]}'" for i in range(0, len(b64), 92))
    entries.append(f"  {name}: [\n{lines},\n  ].join('')")
    print(f'{name}: {FRAME_W}x{FRAME_H} x{len(FRAME_ORDER)} frames, {len(png)} B png')
print(f'standing art: {STAND_ROWS} rows tall, feet on row {GROUND_ROW} of {FRAME_H}')

OUT.write_text(f"""// mobSheetData.js — the mob sprite sheets, cut from the spritesheet*.png art.
//
// One {len(FRAME_ORDER)}-frame horizontal strip per character (idle, walk, attack, hurt,
// collapse, corpse), chroma-keyed off the source art's magenta backdrop,
// despilled, downsampled to logical pixel-art resolution and quantised to a
// 40-colour palette. Every strip shares one frame box, so they are all indexed
// the same way. They ship as base64 data URLs rather than loose .png files so
// the game keeps running straight from the filesystem with no asset fetch — the
// same reason the world bundles into a single html file.
//
// Generated by tools/cut_mob_sheet.py — edit that, not this.

/** Logical size of one frame in the strip (px). */
export const SHEET_FRAME_W = {FRAME_W};
export const SHEET_FRAME_H = {FRAME_H};
/** Frames packed into each strip, left to right. */
export const SHEET_FRAME_COUNT = {len(FRAME_ORDER)};

/**
 * Where a standing character sits in the frame, in frame rows: how tall the
 * tallest one is, and the row its feet rest on. The frame box also has to hold
 * outflung arms and a corpse lying down, so a figure on its feet covers only
 * part of it — scale a sprite by SHEET_STAND_ROWS, not by the frame height, or
 * every mob renders shorter than its type asks for.
 */
export const SHEET_STAND_ROWS = {STAND_ROWS};
export const SHEET_GROUND_ROW = {GROUND_ROW};

/** Character sheets that belong to NPCs only — random mob spawns skip them. */
export const NPC_ONLY_SHEETS = Object.freeze({list(NPC_SHEETS)!r});

const B64 = {{
{',\n'.join(entries)},
}};

/**
 * `data:` URL per character sheet — safe to use as an <img> src without
 * tainting the canvas the tinting reads back from.
 * @type {{Record<string, string>}}
 */
export const MOB_SHEET_URLS = Object.freeze(Object.fromEntries(
  Object.entries(B64).map(([name, b64]) => [name, 'data:image/png;base64,' + b64]),
));
""")
print('wrote', OUT)
