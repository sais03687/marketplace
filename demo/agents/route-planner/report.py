"""The pictures and the working notebook Route Planner attaches.

Everything is drawn in the road network's own x/y metres on top of the grey street
background build.sh drew, so the routes sit on the streets they follow.

Drawn with Pillow alone, not matplotlib. Memory on the standard tier (512 MB) is
the reason: SUMO's session does not give its memory back when it closes (measured
2026-10-16: 400 MB still held afterwards), which leaves about 110 MB for drawing.
matplotlib cost 66 MB for the map and 57 MB more for the replay and went over;
Pillow drawing onto the pre-drawn background needs a fraction of that.
"""
import base64
import io
import json

import roads

COLOURS = [(37, 99, 235), (234, 88, 12), (22, 163, 74), (147, 51, 234), (219, 39, 119), (8, 145, 178),
           (202, 138, 4), (75, 85, 99), (220, 38, 38), (101, 163, 13)]
SIZE = 640


def _font(size):
    from PIL import ImageFont
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _canvas(xs, ys, size=SIZE):
    """The street background cropped to the routes, and a function from x/y metres to pixels."""
    from PIL import Image

    pad = max(max(xs) - min(xs), max(ys) - min(ys)) * 0.08 + 300
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    half = max(max(xs) - min(xs), max(ys) - min(ys)) / 2 + pad
    a = roads.area() or {}
    extent = a.get("xy_extent")
    try:
        bg = Image.open(roads.BACKGROUND).convert("RGB") if extent else None
    except OSError:
        bg = None
    if bg is None:
        img = Image.new("RGB", (size, size), "white")
        s = size / (2 * half)
        return img, (lambda x, y: ((x - (cx - half)) * s, ((cy + half) - y) * s)), s
    W, H = bg.size
    xmin, xmax, ymin, ymax = extent
    sx, sy = W / (xmax - xmin), H / (ymax - ymin)
    left, top = (cx - half - xmin) * sx, (ymax - (cy + half)) * sy
    w, h = 2 * half * sx, 2 * half * sy
    crop = Image.new("RGB", (int(w), int(h)), "white")
    crop.paste(bg, (int(-left), int(-top)))
    bg.close()
    img = crop.resize((size, size), Image.LANCZOS)
    s = size / (2 * half)
    return img, (lambda x, y: ((x - (cx - half)) * s, ((cy + half) - y) * s)), s


def _soft(colour, amount=0.6):
    return tuple(int(c + (255 - c) * amount) for c in colour)


def _draw_panel(panel, xs, ys, faint=False):
    """A finished map of one plan. Returns (image, pixel function, metres-to-pixels)."""
    from PIL import ImageDraw

    img, px, scale = _canvas(xs, ys)
    d = ImageDraw.Draw(img)
    for k, v in enumerate(panel["vans"]):
        colour = COLOURS[k % len(COLOURS)]
        line_colour = _soft(colour, 0.55) if faint else colour
        d.line([px(x, y) for x, y in v["line"]], fill=line_colour, width=3 if faint else 4, joint="curve")
        for x, y in v["stops"]:
            cx, cy = px(x, y)
            d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=colour, outline="white", width=2)
    dx, dy = px(*panel["depot"])
    d.rectangle([dx - 7, dy - 7, dx + 7, dy + 7], fill="black")
    small = _font(11)
    for name, x, y in panel["labels"]:
        lx, ly = px(x, y)
        text = name[:30]
        box = d.textbbox((lx + 7, ly - 15), text, font=small)
        d.rectangle([box[0] - 2, box[1] - 1, box[2] + 2, box[3] + 1], fill=(255, 255, 255))
        d.text((lx + 7, ly - 15), text, fill=(30, 30, 30), font=small)
    # 1 km scale bar, bottom left.
    x0, y0 = 16, SIZE - 22
    d.line([(x0, y0), (x0 + 1000 * scale, y0)], fill="black", width=3)
    d.text((x0, y0 - 16), "1 km", fill="black", font=small)
    # Legend, top right.
    lines = [(COLOURS[k % len(COLOURS)], v["label"]) for k, v in enumerate(panel["vans"])] + [((0, 0, 0), "Depot")]
    widest = max(d.textlength(t, font=small) for _, t in lines)
    lx0 = SIZE - widest - 46
    d.rectangle([lx0 - 6, 8, SIZE - 8, 14 + 17 * len(lines)], fill=(255, 255, 255), outline=(200, 200, 200))
    for i, (colour, text) in enumerate(lines):
        yy = 18 + 17 * i
        d.line([(lx0, yy), (lx0 + 22, yy)], fill=colour, width=4)
        d.text((lx0 + 28, yy - 7), text, fill=(30, 30, 30), font=small)
    return img, px, scale


def _bounds(panels):
    xs = [p[0] for panel in panels for v in panel["vans"] for p in v["line"]] + [panels[0]["depot"][0]]
    ys = [p[1] for panel in panels for v in panel["vans"] for p in v["line"]] + [panels[0]["depot"][1]]
    return xs, ys


def _titled(img, title):
    from PIL import Image, ImageDraw
    out = Image.new("RGB", (img.width, img.height + 30), "white")
    out.paste(img, (0, 30))
    ImageDraw.Draw(out).text((10, 7), title, fill=(20, 20, 20), font=_font(15))
    return out


def static_map(panels) -> bytes:
    """One map per plan, side by side. Each panel: {"title", "depot": (x, y),
    "labels": [(name, x, y)], "vans": [{"van", "line": [(x, y)], "stops": [(x, y)], "label"}]}."""
    from PIL import Image

    xs, ys = _bounds(panels)
    tiles = [_titled(_draw_panel(p, xs, ys)[0], p["title"]) for p in panels]
    out = Image.new("RGB", (sum(t.width for t in tiles) + 10 * (len(tiles) - 1), tiles[0].height), "white")
    x = 0
    for t in tiles:
        out.paste(t, (x, 0))
        x += t.width + 10
    buf = io.BytesIO()
    out.quantize(colors=255, method=Image.Quantize.MEDIANCUT).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def replay_gif(panel, traces, start_label, frames: int = 60, frame_ms: int = 120) -> bytes:
    """The vans driving their simulated routes, from SUMO's position trace.

    `traces` is {van: [(seconds, x, y), ...]} sampled every few seconds of simulated
    time; `start_label(seconds)` turns a time into the clock shown on each frame.
    """
    from PIL import Image, ImageDraw

    xs, ys = _bounds([panel])
    base, px, _ = _draw_panel(panel, xs, ys, faint=True)
    base = _titled(base, panel["title"])
    end = max(t[-1][0] for t in traces.values() if t)
    colour_of = {v["van"]: COLOURS[k % len(COLOURS)] for k, v in enumerate(panel["vans"])}
    big = _font(15)

    def where(trace, t):
        last = trace[0]
        for p in trace:
            if p[0] > t:
                break
            last = p
        return last[1], last[2]

    palette = base.quantize(colors=200, method=Image.Quantize.MEDIANCUT)
    images = []
    for f in range(frames):
        t = end * f / (frames - 1)
        frame = base.copy()
        d = ImageDraw.Draw(frame)
        for van, trace in traces.items():
            if not trace:
                continue
            cx, cy = px(*where(trace, t))
            cy += 30   # the title bar above the map
            d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=colour_of.get(van, (0, 0, 0)), outline="black", width=2)
        clock = start_label(t)
        w = d.textlength(clock, font=big)
        d.rectangle([frame.width - w - 18, 2, frame.width - 4, 27], fill="white")
        d.text((frame.width - w - 11, 6), clock, fill=(20, 20, 20), font=big)
        images.append(frame.quantize(palette=palette, dither=Image.Dither.NONE))
    buf = io.BytesIO()
    images[0].save(buf, format="GIF", save_all=True, append_images=images[1:], duration=frame_ms, loop=0,
                   optimize=True)
    return buf.getvalue()


def notebook(title: str, summary_md: str, data: dict, map_png: bytes | None) -> bytes:
    """A Jupyter notebook of the work: what was asked, what was computed, and the map.

    The data cell holds every number the reply is built from, and the last cell
    redraws a plain version of the routes from it (with matplotlib, on the reader's
    machine), so the working can be checked or reused without AgentStore. The map is
    stored as the cell's output, so it shows without running anything.
    """
    def md(text):
        return {"cell_type": "markdown", "metadata": {}, "source": text}

    def code(src, outputs=None):
        return {"cell_type": "code", "metadata": {}, "execution_count": None, "source": src,
                "outputs": outputs or []}

    data_src = "import json\n\nwork = json.loads(" + json.dumps(json.dumps(data, indent=1)) + ")\nlist(work)"
    redraw = (
        "import matplotlib.pyplot as plt\n\n"
        "fig, ax = plt.subplots(figsize=(7, 6))\n"
        "for plan in work['plans']:\n"
        "    for van in plan['vans']:\n"
        "        xs = [p[0] for p in van['line']]; ys = [p[1] for p in van['line']]\n"
        "        ax.plot(xs, ys, label=f\"{plan['name']} - van {van['van']}\")\n"
        "ax.set_aspect('equal'); ax.legend(fontsize=7); ax.set_title('Routes (network x/y metres)')\n"
        "plt.show()\n"
    )
    outputs = []
    if map_png:
        outputs = [{"output_type": "display_data", "metadata": {},
                    "data": {"image/png": base64.b64encode(map_png).decode("ascii"), "text/plain": ["<map>"]}}]
    nb = {
        "cells": [
            md(f"# {title}\n\n{summary_md}"),
            md("## Everything that was computed\n\nThe request as read, the street each stop was matched to, "
               "the driving-time table, each plan's stop order and its simulated timeline, fuel and CO2."),
            code(data_src),
            md("## The map from the reply"),
            code("# The map attached to the email, as produced by the agent.", outputs),
            md("## Redraw the routes from the data above"),
            code(redraw),
        ],
        "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
                     "language_info": {"name": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    return json.dumps(nb, indent=1).encode("utf-8")
