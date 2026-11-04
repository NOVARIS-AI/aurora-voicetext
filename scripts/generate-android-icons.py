#!/usr/bin/env python3
"""Generate the AURORA VoiceText Android robot-head launcher icon."""
from pathlib import Path
import math, struct, zlib

ROOT = Path("android/app/src/main/res")
NAVY = (7, 13, 30)
NAVY2 = (20, 24, 52)
CYAN = (55, 229, 239)
VIOLET = (170, 130, 255)
WHITE = (225, 244, 255)

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
    for y in range(size):
        for x in range(size):
            t = min(1, max(0, (x+y)/(2*size)))
            col = (0,0,0,0) if foreground else (*blend(NAVY, NAVY2, t),255)
            k=(y*size+x)*4
            p[k:k+4]=bytes(col)

    def put(x,y,color):
        if 0 <= x < size and 0 <= y < size:
            k=(int(y)*size+int(x))*4
            p[k:k+4]=bytes((*color,255))
    def rounded_rect(x0,y0,x1,y1,r,color):
        for y in range(max(0,int(y0)),min(size,int(y1)+1)):
            for x in range(max(0,int(x0)),min(size,int(x1)+1)):
                qx=min(max(x,x0+r),x1-r); qy=min(max(y,y0+r),y1-r)
                if (x-qx)**2+(y-qy)**2 <= r*r: put(x,y,color)
    def line(x0,y0,x1,y1,width,color):
        steps=max(1,int(math.hypot(x1-x0,y1-y0)*1.5))
        for n in range(steps+1):
            t=n/steps; x=x0+(x1-x0)*t; y=y0+(y1-y0)*t
            for yy in range(int(y-width),int(y+width)+1):
                for xx in range(int(x-width),int(x+width)+1):
                    if (xx-x)**2+(yy-y)**2 <= width*width: put(xx,yy,color)
    def circle(cx,cy,r,color):
        for y in range(max(0,int(cy-r)),min(size,int(cy+r)+1)):
            for x in range(max(0,int(cx-r)),min(size,int(cx+r)+1)):
                if (x-cx)**2+(y-cy)**2 <= r*r: put(x,y,color)

    line(c, size*.20, c, size*.31, size*.018, CYAN)
    circle(c,size*.17,size*.045,VIOLET)
    rounded_rect(size*.13,size*.43,size*.27,size*.62,size*.055,VIOLET)
    rounded_rect(size*.73,size*.43,size*.87,size*.62,size*.055,CYAN)
    rounded_rect(size*.22,size*.29,size*.78,size*.77,size*.13,(27,39,72))
    rounded_rect(size*.255,size*.325,size*.745,size*.735,size*.105,(12,21,43))
    rounded_rect(size*.30,size*.42,size*.70,size*.64,size*.07,(22,47,73))
    circle(size*.405,size*.525,size*.043,CYAN)
    circle(size*.595,size*.525,size*.043,VIOLET)
    circle(size*.405,size*.525,size*.014,WHITE)
    circle(size*.595,size*.525,size*.014,WHITE)
    for i,h in enumerate([.035,.065,.09,.065,.035]):
        x=size*(.42+i*.04)
        rounded_rect(x-size*.009,size*.69-h/2,x+size*.009,size*.69+h/2,size*.009,blend(CYAN,VIOLET,i/4))
    circle(c,size*.365,size*.018,CYAN)
    return p

png(ROOT/"drawable-nodpi/ic_launcher_foreground.png",432,432,render(432,True))
for density, size in [("mdpi",48),("hdpi",72),("xhdpi",96),("xxhdpi",144),("xxxhdpi",192)]:
    png(ROOT/f"mipmap-{density}/ic_launcher.png",size,size,render(size))
    png(ROOT/f"mipmap-{density}/ic_launcher_round.png",size,size,render(size))
adaptive='''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/aurora_icon_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
'''
(ROOT/"mipmap-anydpi-v26").mkdir(parents=True,exist_ok=True)
(ROOT/"mipmap-anydpi-v26/ic_launcher.xml").write_text(adaptive,encoding="utf-8")
(ROOT/"mipmap-anydpi-v26/ic_launcher_round.xml").write_text(adaptive,encoding="utf-8")
(ROOT/"values").mkdir(parents=True,exist_ok=True)
(ROOT/"values/aurora_icon_colors.xml").write_text('''<?xml version="1.0" encoding="utf-8"?>
<resources><color name="aurora_icon_background">#080D1E</color></resources>
''',encoding="utf-8")
print("Generated AURORA VoiceText Android robot-head launcher icons.")
