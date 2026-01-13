import numpy as np
from PIL import Image

import numpy as np
from PIL import Image

def read_dem_as_grid(dem_path: str, decimate: int = 2, z_scale: float = 1.0):
    """
    兜底方案：把DEM当普通图片读取。
    增强：对 z 做归一化/截断，避免溢出导致 inf。
    """
    img = Image.open(dem_path)
    arr = np.array(img)

    # RGB/RGBA 取单通道
    if arr.ndim == 3:
        arr = arr[..., 0]

    # 降采样
    z = arr[::decimate, ::decimate].astype(np.float64)  # 用 float64 更稳
    h, w = z.shape

    # 处理异常值：把 NaN/Inf 去掉
    z = np.nan_to_num(z, nan=0.0, posinf=0.0, neginf=0.0)

    # 用分位数做截断，避免极端值把范围拉爆（常见于DEM或无效值）
    lo = float(np.percentile(z, 2))
    hi = float(np.percentile(z, 98))
    if hi - lo < 1e-12:
        lo = float(z.min())
        hi = float(z.max() + 1e-6)

    z = np.clip(z, lo, hi)

    # 归一化到 0..1，再乘 z_scale
    z01 = (z - lo) / (hi - lo)
    z = (z01 * float(z_scale)).astype(np.float32)

    xs = np.arange(w, dtype=np.float32)
    ys = np.arange(h, dtype=np.float32)
    x, y = np.meshgrid(xs, ys)

    return {
        "width": int(w),
        "height": int(h),
        "x": x.reshape(-1).tolist(),
        "y": y.reshape(-1).tolist(),
        "z": z.reshape(-1).tolist(),
        "zRange": [float(z.min()), float(z.max())],
    }