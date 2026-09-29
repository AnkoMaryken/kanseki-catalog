# -*- coding: utf-8 -*-
"""
生成桌面版应用图标（「漢」字标）。

设计（与程序内图标、静态站 favicon 风格一致，但用主品牌「漢」而非账号品牌的「J」）：
  · 黑底 #101012（V0.8 起由藏青改为黑，与侧栏底色同一色值）
  · 圆角方块（大图标圆角比例约 22%，小图标略收，避免糊边）
  · 白色衬线「漢」字居中（华文中宋 STZhongsong → 宋体 SimSun 兜底）

输出（覆盖 Tauri 所需全套）：
  tauri/icons/32x32.png
  tauri/icons/128x128.png
  tauri/icons/128x128@2x.png   (256)
  tauri/icons/icon.png         (512)
  tauri/icons/icon.ico         (16/24/32/48/64/128/256 多尺寸)

用法：
  python make_icon.py
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, '..', 'tauri', 'icons')
ICON_DIR = os.path.normpath(ICON_DIR)

BG = (16, 16, 18, 255)       # #101012 黑（原藏青 #2b3a67，V0.8 改）
FG = (255, 255, 255, 255)    # 白

# 衬线字体候选（Windows 自带；用第一个存在的）
FONT_CANDIDATES = [
    r'C:\Windows\Fonts\STZHONGS.TTF',   # 华文中宋（最接近静态站 Noto Serif SC 的气质）
    r'C:\Windows\Fonts\simsun.ttc',     # 宋体
    r'C:\Windows\Fonts\simkai.ttf',     # 楷体
    r'C:\Windows\Fonts\msyh.ttc',       # 微软雅黑（兜底，非衬线）
]

# 各尺寸下圆角半径占边长比例（小图标略小，防止像素化后圆角发糊）
def radius_ratio(size):
    if size <= 32:
        return 0.20
    if size <= 64:
        return 0.22
    return 0.24


def pick_font():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def make_icon(size, font_path):
    """渲染单张尺寸的图标（4x 超采样后缩小，得到平滑边缘）。"""
    SS = 4
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底
    r = int(S * radius_ratio(size))
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BG)

    # 字：字号取 68% 边长（汉字视觉重心比拉丁字偏下，需略小并上移）
    font_size = int(S * 0.68)
    try:
        font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
    except Exception:
        font = ImageFont.load_default()

    ch = '漢'
    # 用 anchor='mm' 精确居中，再手工上移 1.5%（汉字下缘留白多于上缘）
    cx, cy = S / 2, S / 2 - S * 0.015
    d.text((cx, cy), ch, font=font, fill=FG, anchor='mm')

    return img.resize((size, size), Image.LANCZOS)


def main():
    font_path = pick_font()
    print('[icon] 使用字体:', font_path or '(内置位图字体，效果差)')

    targets = [
        (32, '32x32.png'),
        (128, '128x128.png'),
        (256, '128x128@2x.png'),
        (512, 'icon.png'),
    ]
    imgs = {}
    for size, name in targets:
        im = make_icon(size, font_path)
        out = os.path.join(ICON_DIR, name)
        im.save(out)
        imgs[size] = im
        print(f'[icon] {name:18s} {size}x{size}  {os.path.getsize(out):>7d} B')

    # ICO：多尺寸打包（Windows 会按显示场景自动挑最合适的）
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_base = make_icon(256, font_path)
    ico_path = os.path.join(ICON_DIR, 'icon.ico')
    ico_base.save(ico_path, format='ICO',
                  sizes=[(s, s) for s in ico_sizes])
    print(f'[icon] {"icon.ico":18s} {ico_sizes}  {os.path.getsize(ico_path):>7d} B')

    print('[icon] 完成 →', ICON_DIR)


if __name__ == '__main__':
    main()
