import numpy as np
import segyio

def read_segy_basic_info(segy_path: str):
    with segyio.open(segy_path, "r", ignore_geometry=True) as f:
        f.mmap()
        n_traces = f.tracecount
        n_samples = len(f.samples)
        try:
            dt_us = int(segyio.tools.dt(f))
        except Exception:
            dt_us = 0
    return {"traceCount": int(n_traces), "sampleCount": int(n_samples), "dtMicroseconds": int(dt_us)}

def get_trace_gather(segy_path: str, start_trace: int, count: int):
    """
    取一组相邻trace，形成 2D 剖面 (n_traces, n_samples)
    - 自动裁剪 start/count，避免越界
    - 至少返回 1 条 trace，否则抛异常
    """
    with segyio.open(segy_path, "r", ignore_geometry=True) as f:
        f.mmap()
        n_traces = f.tracecount
        n_samples = len(f.samples)

        start = max(0, min(int(start_trace), n_traces - 1))
        end = max(start + 1, min(start + int(count), n_traces))
        n = end - start

        data = np.empty((n, n_samples), dtype=np.float32)
        for k, i in enumerate(range(start, end)):
            data[k, :] = f.trace[i].astype(np.float32)

        return data



def normalize_for_display(arr: np.ndarray, p_low=2.0, p_high=98.0):
    """
    变密度显示用：百分位截断，避免极端值；输出0..1
    """
    a = np.asarray(arr, dtype=np.float32)
    a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)

    lo = float(np.percentile(a, p_low))
    hi = float(np.percentile(a, p_high))
    if hi - lo < 1e-6:
        # 数据几乎常数：避免除0，直接返回0.5灰
        return np.full_like(a, 0.5, dtype=np.float32)

    x = (a - lo) / (hi - lo)
    x = np.clip(x, 0.0, 1.0)
    return x

def gather_to_density_image(arr: np.ndarray):
    a = np.asarray(arr, dtype=np.float32)
    a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)

    # 用绝对值的百分位做对称裁剪
    clip = float(np.percentile(np.abs(a), 98.0)) + 1e-6
    x = np.clip(a / clip, -1.0, 1.0)

    # 映射到 0..255（-1->0, 0->127, 1->255）
    img = ((x + 1.0) * 127.5).astype(np.uint8)
    return img



def gather_to_wiggle_polylines(arr: np.ndarray, scale: float = 0.7, max_points: int = 600):
    """
    变面积（wiggle）显示：对纵向采样降采样，避免JSON过大导致失败。
    max_points: 每条trace最多传这么多个点
    """
    n_tr, n_s = arr.shape
    a = np.asarray(arr, dtype=np.float32)
    a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)

    # 归一化
    denom = float(np.max(np.abs(a)) + 1e-6)
    a = (a / denom) * float(scale)

    # 计算降采样步长
    step = max(1, int(np.ceil(n_s / max_points)))
    idx = np.arange(0, n_s, step, dtype=np.int32)

    polylines = []
    for i in range(n_tr):
        pts = []
        for j in idx:
            pts.append([float(i + a[i, j]), float(j)])
        polylines.append(pts)

    return {
        "traceCount": int(n_tr),
        "sampleCount": int(n_s),
        "step": int(step),
        "polylines": polylines,
    }

def get_volume_stack(segy_path: str, start: int, count: int,
                     slices: int = 32, stride: int = 20, sample_decim: int = 2):
    """
    兜底的 3D 体：把多个相邻 gather 按 start+k*stride 取出来，堆叠成 (nz, ny, nx)
    nx = trace(道)方向, ny = sample(时间采样)方向, nz = slice(堆叠层)方向
    """
    slices = max(1, int(slices))
    stride = max(1, int(stride))
    sample_decim = max(1, int(sample_decim))

    stacks = []
    for k in range(slices):
        g = get_trace_gather(segy_path, start + k * stride, count)  # (nx, n_samples)
        g = g[:, ::sample_decim]  # 时间降采样
        stacks.append(g.astype(np.float32))

    stack = np.stack(stacks, axis=0)          # (nz, nx, ny)
    vol = np.transpose(stack, (0, 2, 1))      # -> (nz, ny, nx) 让 x 最快变化，适配 vtkImageData
    vol = np.nan_to_num(vol, nan=0.0, posinf=0.0, neginf=0.0)
    return vol  # float32