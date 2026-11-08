# ポリマーケット記録のアイコンを作る (Pillow)。使い方: python3 icons/make-icons.py
# 青→緑のグラデーションに、白いカード・確率の棒グラフ・上向きの折れ線
from PIL import Image, ImageDraw
import os
D = os.path.dirname(os.path.abspath(__file__))
S = 2048  # 大きく描いてから縮める (なめらかにするため)

def grad(size):
    img = Image.new('RGB', (size, size))
    px = img.load()
    a, b = (59, 103, 217), (14, 170, 140)
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return img

def art(img, scale):
    d = ImageDraw.Draw(img)
    c = S / 2
    k = lambda v: c + (v - 1024) * scale   # 2048 の座標を縮めて中央に
    # カード
    d.rounded_rectangle([k(420), k(470), k(1628), k(1580)], radius=150 * scale, fill=(255, 255, 255))
    # 棒グラフ (確率)
    bars = [(560, 1240, (91, 140, 255)), (780, 1030, (91, 140, 255)), (1000, 1150, (91, 140, 255)), (1220, 860, (56, 217, 192))]
    for x, top, col in bars:
        d.rounded_rectangle([k(x), k(top), k(x + 150), k(1440)], radius=40 * scale, fill=col)
    # 折れ線
    pts = [(560, 1120), (850, 930), (1080, 1010), (1440, 640)]
    d.line([(k(x), k(y)) for x, y in pts], fill=(255, 122, 107), width=int(70 * scale), joint='curve')
    for x, y in pts:
        r = 50 * scale
        d.ellipse([k(x) - r, k(y) - r, k(x) + r, k(y) + r], fill=(255, 122, 107))
    r = 85 * scale
    d.ellipse([k(1440) - r, k(640) - r, k(1440) + r, k(640) + r], fill=(255, 255, 255), outline=(255, 122, 107), width=int(36 * scale))

base = grad(256).resize((S, S), Image.BICUBIC)
full = base.copy(); art(full, 1.0)
mask_v = base.copy(); art(mask_v, 0.78)

def rounded(img):
    m = Image.new('L', (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 112 / 512), fill=255)
    out = img.convert('RGBA'); out.putalpha(m); return out

any_icon = rounded(full)
for size in (192, 512):
    any_icon.resize((size, size), Image.LANCZOS).save(os.path.join(D, f'icon-{size}.png'))
    mask_v.resize((size, size), Image.LANCZOS).save(os.path.join(D, f'maskable-{size}.png'))
full.resize((180, 180), Image.LANCZOS).save(os.path.join(D, 'apple-touch-icon.png'))
print('ok')
