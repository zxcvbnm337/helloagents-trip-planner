# -*- coding: utf-8 -*-
"""生成地图标记图标 assets/marker.png

背景：小程序 <map> 组件的 marker 需要 iconPath，缺少图标资源时部分机型
不会渲染标记点。这里用纯标准库（zlib + struct）手工写 PNG，避免为了一个
小图标引入 Pillow 依赖。

用法（在 miniprogram 目录下）：
    python tools/make-marker-icon.py
"""

import os
import struct
import zlib

SIZE = 72                   # 输出尺寸（正方形，单位像素）
SS = 3                      # 超采样倍数，用于抗锯齿
PIN = (36.0, 28.0, 20.0)    # 圆形主体：圆心 x、圆心 y、半径
BASE_Y = 42.0               # 三角尾巴起点 y
TIP_Y = 66.0                # 底部尖端 y
HALF_BASE = 14.0            # 三角尾巴底部半宽
HOLE = (36.0, 28.0, 8.0)    # 中间白色圆孔
BODY_COLOR = (102, 126, 234, 255)   # #667eea
HOLE_COLOR = (255, 255, 255, 255)


def in_pin(x, y):
    """点是否落在「圆 + 尾三角」组成的定位标内部"""
    cx, cy, radius = PIN
    if (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius:
        return True
    if BASE_Y <= y <= TIP_Y:
        ratio = (y - BASE_Y) / (TIP_Y - BASE_Y)
        half = HALF_BASE * (1.0 - ratio)
        if abs(x - cx) <= half:
            return True
    return False


def in_hole(x, y):
    cx, cy, radius = HOLE
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def render_rgba():
    """逐像素超采样，返回 RGBA 原始扫描线（每行前面带 filter byte 0）"""
    buffer = bytearray()
    total_samples = SS * SS

    for py in range(SIZE):
        buffer.append(0)  # PNG filter type: None
        for px in range(SIZE):
            acc_r = acc_g = acc_b = acc_a = 0
            for i in range(SS):
                for j in range(SS):
                    x = px + (i + 0.5) / SS
                    y = py + (j + 0.5) / SS
                    if in_hole(x, y):
                        r, g, b, a = HOLE_COLOR
                    elif in_pin(x, y):
                        r, g, b, a = BODY_COLOR
                    else:
                        continue
                    acc_r += r
                    acc_g += g
                    acc_b += b
                    acc_a += a
            buffer += bytes((
                acc_r // total_samples,
                acc_g // total_samples,
                acc_b // total_samples,
                acc_a // total_samples,
            ))

    return bytes(buffer)


def png_chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def main():
    raw = render_rgba()

    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(raw, 9))
    png += png_chunk(b"IEND", b"")

    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.normpath(os.path.join(here, "..", "assets", "marker.png"))
    os.makedirs(os.path.dirname(target), exist_ok=True)

    with open(target, "wb") as fp:
        fp.write(png)

    print("written: %s (%d bytes)" % (target, len(png)))


if __name__ == "__main__":
    main()
