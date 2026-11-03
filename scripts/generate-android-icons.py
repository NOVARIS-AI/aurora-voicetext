#!/usr/bin/env python3
"""Generate AURORA VoiceText Android launcher icons without external packages."""
from pathlib import Path
import math, struct, zlib

ROOT = Path("android/app/src/main/res")
BG1 = (7, 13, 30)
BG2 = (26, 17, 62)
CYAN = (55, 229, 239)
VIOLET = (170, 130, 255)

def blend(a, b, t):
    return tuple(round(a[i] * (1-t) + b[i] * t) for i in range(3))

def png(path, w, h, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y*w*4:(y+1)*w*4]) for y in range(h))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">2I5B", w, h, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)

def render(size, foreground=False):
    p = bytearray(size * size * 4)
    c = size / 2
    radius = size * (0.46 if foreground else 0.49)
    bars = [0.18,0.29,0.46,0.68,0.88,0.68,0.46,0.29,0.18]
    for y in range(size):
        for x in range(size):
            dx, dy = x-c, y-c
            if foreground:
                col = (0,0,0,0)
            else:
                t = min(1, max(0, (x+y)/(2*size)))
                col = (*blend(BG1, BG2, t), 255)
                # soft circular vignette
                shade = max(0, 1 - math.sqrt(dx*dx+dy*dy)/(size*0.9)) * 0.12
                col = tuple(int(v*(1-shade)) for v in col[:3]) + (255,)
            idx = (y*size+x)*4
            p[idx:idx+4] = bytes(col)
    # centered audio waveform: nine rounded vertical bars
    base_y = c
    bar_w = size*0.075
    gap = size*0.035
    total = len(bars)*bar_w + (len(bars)-1)*gap
    start_x = c-total/2
    for i, height in enumerate(bars):
        x0 = start_x+i*(bar_w+gap)
        hh = height*size*0.53
        y0, y1 = base_y-hh/2, base_y+hh/2
        for y in range(max(0,int(y0)), min(size,int(y1)+1)):
            for x in range(max(0,int(x0)), min(size,int(x0+bar_w)+1)):
                # rounded caps
                cx = min(max(x, x0+bar_w/2), x0+bar_w/2)
                cy = min(max(y, y0+bar_w/2), y1-bar_w/2) if y1-y0 > bar_w else (y0+y1)/2
                if (x-cx)**2+(y-cy)**2 <= (bar_w/2)**2:
                    t = i/(len(bars)-1)
                    color = blend(CYAN, VIOLET, t)
                    j=(y*size+x)*4
                    p[j:j+4]=bytes((*color,255))
    # small sparkle above-right of waveform
    sx, sy = int(size*.77), int(size*.27)
    for y in range(max(0,sy-size//32),min(size,sy+size//32+1)):
        for x in range(max(0,sx-size//32),min(size,sx+size//32+1)):
            if abs(x-sx)+abs(y-sy) < size*.045:
                j=(y*size+x)*4
                p[j:j+4]=bytes((*CYAN,255))
    return p

# Adaptive foreground is transparent; Android supplies the background color.
png(ROOT/"drawable-nodpi/ic_launcher_foreground.png", 432, 432, render(432, True))
for density, size in [("mdpi",48),("hdpi",72),("xhdpi",96),("xxhdpi",144),("xxxhdpi",192)]:
    png(ROOT/f"mipmap-{density}/ic_launcher.png", size, size, render(size))
    png(ROOT/f"mipmap-{density}/ic_launcher_round.png", size, size, render(size))
adaptive = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/aurora_icon_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
'''
(ROOT/"mipmap-anydpi-v26").mkdir(parents=True, exist_ok=True)
(ROOT/"mipmap-anydpi-v26/ic_launcher.xml").write_text(adaptive, encoding="utf-8")
(ROOT/"mipmap-anydpi-v26/ic_launcher_round.xml").write_text(adaptive, encoding="utf-8")
colors = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="aurora_icon_background">#080D1E</color>
</resources>
'''
(ROOT/"values").mkdir(parents=True, exist_ok=True)
(ROOT/"values/aurora_icon_colors.xml").write_text(colors, encoding="utf-8")
print("Generated AURORA VoiceText legacy and adaptive Android launcher icons.")
