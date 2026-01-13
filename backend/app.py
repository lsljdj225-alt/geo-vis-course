from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from io import BytesIO
from PIL import Image
import traceback
import numpy as np
from flask import Response
from segy_service import get_volume_stack
from dem_service import read_dem_as_grid
from segy_service import (
    read_segy_basic_info, get_trace_gather,
    gather_to_density_image, gather_to_wiggle_polylines
)

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}}, expose_headers=[
    "X-Dimensions", "X-Spacing", "X-Range", "X-DType"
])
# app.py
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def pick_existing(*paths):
    for p in paths:
        if p and os.path.exists(p):
            return p
    return None

DEM_PATH = pick_existing(
    os.path.join(BASE_DIR, "data", "dem.tif"),
    os.path.join(BASE_DIR, "data", "dem.tiff"),
)

SEGY_PATH = pick_existing(
    os.path.join(BASE_DIR, "data", "seismic.sgy"),
    os.path.join(BASE_DIR, "data", "seismic.segy"),
)

print("DEM_PATH =", DEM_PATH)
print("SEGY_PATH =", SEGY_PATH)

print("DEM exists?", os.path.exists(DEM_PATH))
print("SEGY exists?", os.path.exists(SEGY_PATH))

@app.get("/api/dem")
def api_dem():
    decimate = int(request.args.get("decimate", 3))
    z_scale = float(request.args.get("zScale", 1.0))
    grid = read_dem_as_grid(DEM_PATH, decimate=decimate, z_scale=z_scale)
    return jsonify(grid)

@app.get("/api/segy/info")
def api_segy_info():
    if not SEGY_PATH:
        return jsonify({"error": "SEGY file not found in backend/data (seismic.sgy or seismic.segy)"}), 404
    return jsonify(read_segy_basic_info(SEGY_PATH))

@app.get("/api/segy/density")
def api_segy_density():
    if not SEGY_PATH:
        return Response("SEGY file not found\n", status=404, mimetype="text/plain")
    start = int(request.args.get("start", 0))
    count = int(request.args.get("count", 200))

    try:
        arr = get_trace_gather(SEGY_PATH, start, count)  # (traces, samples)

        # 基本校验：避免空数组/维度不对
        if arr is None or arr.size == 0:
            raise ValueError("Empty gather: check start/count or segy file.")
        if arr.ndim != 2:
            raise ValueError(f"Gather must be 2D, got shape={arr.shape}")

        img = gather_to_density_image(arr)  # uint8, shape (traces, samples) or (traces, samples)

        # 确保是 uint8 且二维
        img = np.asarray(img)
        if img.ndim != 2:
            raise ValueError(f"Density image must be 2D, got shape={img.shape}")
        if img.dtype != np.uint8:
            img = img.astype(np.uint8)

        # 转成PNG：让“时间/采样”为竖直方向显示更直观
        pil = Image.fromarray(img.T, mode="L")

        buf = BytesIO()
        pil.save(buf, format="PNG")
        buf.seek(0)
        return send_file(buf, mimetype="image/png")
    

    except Exception as e:
        
        print("ERROR in /api/segy/density:", repr(e))
        
        print(traceback.format_exc())
        
        return Response(
            
            f"/api/segy/density failed: {repr(e)}\n",
            
            status=500,
            
            mimetype="text/plain"
        
        )

@app.get("/api/segy/wiggle")
def api_segy_wiggle():
    if not SEGY_PATH:
        return Response("SEGY file not found\n", status=404, mimetype="text/plain")
    start = int(request.args.get("start", 0))
    count = int(request.args.get("count", 60))
    max_points = int(request.args.get("maxPoints", 600))

    try:
        arr = get_trace_gather(SEGY_PATH, start, count)
        if arr is None or arr.size == 0 or arr.ndim != 2:
            raise ValueError(f"Bad gather: shape={None if arr is None else arr.shape}")
        return jsonify(gather_to_wiggle_polylines(arr, scale=0.7, max_points=max_points))
    except Exception as e:
        print("ERROR in /api/segy/wiggle:", repr(e))
        print(traceback.format_exc())
        return jsonify({"error": str(e)[:400]}), 500
@app.get("/api/segy/volume")
def api_segy_volume():
    start = int(request.args.get("start", 0))
    count = int(request.args.get("count", 128))
    slices = int(request.args.get("slices", 32))
    stride = int(request.args.get("stride", 20))
    sample_decim = int(request.args.get("sampleDecim", 2))

    try:
        info = read_segy_basic_info(SEGY_PATH)
        dt_us = int(info.get("dtMicroseconds", 0))
        dt_ms = (dt_us / 1000.0) if dt_us > 0 else 1.0

        vol = get_volume_stack(SEGY_PATH, start, count, slices=slices, stride=stride, sample_decim=sample_decim)
        # 裁剪极值：体渲染更稳定
        clip = float(np.percentile(np.abs(vol), 99.0)) + 1e-6
        vol = np.clip(vol, -clip, clip).astype(np.float32)

        nz, ny, nx = vol.shape
        spacing = (1.0, float(dt_ms * sample_decim), 1.0)  # x:道距(假设1), y:时间(ms), z:层距(假设1)
        vmin, vmax = float(vol.min()), float(vol.max())

        raw = vol.tobytes(order="C")
        resp = Response(raw, mimetype="application/octet-stream")
        resp.headers["X-Dimensions"] = f"{nx},{ny},{nz}"
        resp.headers["X-Spacing"] = f"{spacing[0]},{spacing[1]},{spacing[2]}"
        resp.headers["X-Range"] = f"{vmin},{vmax}"
        resp.headers["X-DType"] = "float32"
        return resp

    except Exception as e:
        print("ERROR in /api/segy/volume:", repr(e))
        print(traceback.format_exc())
        return Response(f"/api/segy/volume failed: {repr(e)}\n", status=500, mimetype="text/plain")



if __name__ == "__main__":
    # 你本地运行：python app.py
    app.run(host="0.0.0.0", port=5000, debug=True)