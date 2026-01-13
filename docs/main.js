/**
 * main.js
 * 纯前端版本 - 直接读取本地文件
 * 功能：DEM曲面、SEGY变密度/变面积/体渲染
 */

// ======================= vtk.js 初始化 =======================
const fullScreenRenderer = vtk.Rendering.Misc.vtkFullScreenRenderWindow.newInstance({
  rootContainer: document.getElementById("vtkContainer"),
  containerStyle: { height: "100%", width: "100%", position: "relative" },
});
const renderer = fullScreenRenderer.getRenderer();
const renderWindow = fullScreenRenderer.getRenderWindow();
const interactor = renderWindow.getInteractor();

renderer.setBackground(0.18, 0.2, 0.25);

// 方向轴
const axes = vtk.Rendering.Core.vtkAxesActor.newInstance();
const axesWidget = vtk.Interaction.Widgets.vtkOrientationMarkerWidget.newInstance({
  actor: axes,
  interactor,
});
axesWidget.setEnabled(true);
axesWidget.setViewportCorner(
  vtk.Interaction.Widgets.vtkOrientationMarkerWidget.Corners.BOTTOM_LEFT
);
axesWidget.setViewportSize(0.15);

// ======================= 全局状态 =======================
// 存储用户选择的文件数据
let demFileData = null;      // DEM 文件的 ArrayBuffer
let segyFileData = null;     // SEGY 文件的 ArrayBuffer
let segyInfo = null;         // SEGY 基本信息

// 当前激活的可视化类型：'dem' | 'density' | 'wiggle' | 'volume' | null
let activeVisualization = null;

// DEM 相关
let demActor = null;
let demMapper = null;
let scalarBarActor = null;

// Volume 相关
let volumeActor = null;
let volumeMapper = null;
let volumeScalarRange = null;

// SEGY 2D 相关
let segy2DActor = null;
let segy2DMapper = null;
let segy2DWiggleActors = [];
let segy2DFillActors = [];

// ======================= 文件读取 =======================
document.getElementById("demFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    demFileData = await file.arrayBuffer();
    document.getElementById("demFileName").textContent = file.name;
    document.getElementById("btnDem").disabled = false;
    console.log("DEM file loaded:", file.name, demFileData.byteLength, "bytes");
  } catch (err) {
    alert("读取DEM文件失败: " + err.message);
  }
});

document.getElementById("segyFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    segyFileData = await file.arrayBuffer();
    document.getElementById("segyFileName").textContent = file.name;

    // 解析 SEGY 基本信息
    segyInfo = parseSegyInfo(segyFileData);
    console.log("SEGY file loaded:", file.name, segyFileData.byteLength, "bytes");
    console.log("SEGY info:", segyInfo);

    // 启用 SEGY 相关按钮
    document.getElementById("btnDensity").disabled = false;
    document.getElementById("btnWiggle").disabled = false;
    document.getElementById("btnVolume").disabled = false;
  } catch (err) {
    alert("读取SEGY文件失败: " + err.message);
  }
});

// ======================= SEGY 解析 =======================
function parseSegyInfo(buffer) {
  const view = new DataView(buffer);

  // SEGY 文件头在 3200-3600 字节（二进制头）
  // 采样间隔在 3216-3218 (2字节, big-endian)
  // 每道采样点数在 3220-3222 (2字节, big-endian)
  const dtMicroseconds = view.getInt16(3216, false); // big-endian
  const sampleCount = view.getInt16(3220, false);

  // 计算道数：(文件总长 - 3600) / (240 + sampleCount * 4)
  const traceLength = 240 + sampleCount * 4;
  const traceCount = Math.floor((buffer.byteLength - 3600) / traceLength);

  return {
    dtMicroseconds: dtMicroseconds > 0 ? dtMicroseconds : 1000,
    sampleCount: sampleCount > 0 ? sampleCount : 128,
    traceCount: traceCount > 0 ? traceCount : 0,
  };
}

function getSegyTraces(buffer, startTrace, count) {
  if (!segyInfo) return null;

  const { sampleCount, traceCount } = segyInfo;
  const traceLength = 240 + sampleCount * 4;

  const actualStart = Math.max(0, Math.min(startTrace, traceCount - 1));
  const actualCount = Math.min(count, traceCount - actualStart);

  const data = new Float32Array(actualCount * sampleCount);

  for (let i = 0; i < actualCount; i++) {
    const traceOffset = 3600 + (actualStart + i) * traceLength + 240;
    const view = new DataView(buffer, traceOffset, sampleCount * 4);

    for (let j = 0; j < sampleCount; j++) {
      // IBM 浮点转 IEEE（简化版，假设是 IEEE float）
      data[i * sampleCount + j] = view.getFloat32(j * 4, false);
    }
  }

  return {
    data,
    traceCount: actualCount,
    sampleCount,
  };
}

// ======================= 清除显示 =======================
function removeVolumeIfAny() {
  if (!volumeActor) return;
  if (renderer.removeVolume) renderer.removeVolume(volumeActor);
  else renderer.removeViewProp(volumeActor);
  volumeActor = null;
  volumeMapper = null;
  volumeScalarRange = null;
}

function removeDEMIfAny() {
  if (!demActor) return;
  renderer.removeActor(demActor);
  demActor = null;
  demMapper = null;

  if (scalarBarActor) {
    renderer.removeActor2D(scalarBarActor);
    scalarBarActor = null;
  }
}

function removeSegy2DActors() {
  if (segy2DActor) {
    renderer.removeActor(segy2DActor);
    segy2DActor = null;
    segy2DMapper = null;
  }
  for (const actor of segy2DWiggleActors) {
    renderer.removeActor(actor);
  }
  segy2DWiggleActors = [];

  for (const actor of segy2DFillActors) {
    renderer.removeActor(actor);
  }
  segy2DFillActors = [];
}

function clearAllDisplays() {
  removeVolumeIfAny();
  removeDEMIfAny();
  removeSegy2DActors();
  renderWindow.render();
}

// ======================= 按钮状态管理 =======================
function updateButtonStates() {
  const buttons = {
    dem: document.getElementById("btnDem"),
    density: document.getElementById("btnDensity"),
    wiggle: document.getElementById("btnWiggle"),
    volume: document.getElementById("btnVolume"),
  };

  // 移除所有 active 类
  Object.values(buttons).forEach(btn => btn.classList.remove("active"));

  // 给当前激活的按钮添加 active 类
  if (activeVisualization && buttons[activeVisualization]) {
    buttons[activeVisualization].classList.add("active");
  }
}

function updateAxisInfo(content) {
  const infoDiv = document.getElementById("axisInfo");
  if (infoDiv) {
    infoDiv.innerHTML = content;
  }
}

// ======================= 可视化切换逻辑 =======================
function toggleVisualization(type, showFunction) {
  // 如果点击的是当前激活的类型，则清除
  if (activeVisualization === type) {
    clearAllDisplays();
    activeVisualization = null;
    updateButtonStates();
    updateAxisInfo('<div style="text-align:center; color:#9ca3af;">已清除显示</div>');
    return;
  }

  // 否则清除当前显示，切换到新类型
  clearAllDisplays();
  activeVisualization = type;
  updateButtonStates();
  showFunction();
}

// ======================= 调色盘 =======================
const MAX_POINTS = 10;

const cmap = {
  points: [
    { x: 0.00, color: "#3b4cc0", a: 0.00 },
    { x: 0.50, color: "#dddddd", a: 0.05 },
    { x: 1.00, color: "#b40426", a: 0.25 },
  ],
  selected: 1,
  dragging: false,
  dragIndex: -1,
};

const cmapCanvas = document.getElementById("cmapCanvas");
const cmapCtx = cmapCanvas.getContext("2d");

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function hexToRgb01(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function rgb01ToHex(r, g, b) {
  const toHex = (x) => clamp(Math.round(x * 255), 0, 255).toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpColor(c1, c2, t) {
  const [r1, g1, b1] = hexToRgb01(c1);
  const [r2, g2, b2] = hexToRgb01(c2);
  return rgb01ToHex(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t));
}

function sortPoints() {
  cmap.points.sort((p, q) => p.x - q.x);
  cmap.selected = clamp(cmap.selected, 0, cmap.points.length - 1);
}

function getSelectedPoint() {
  return cmap.points[cmap.selected] || null;
}

function sampleColorAt(x) {
  const pts = cmap.points;
  if (x <= pts[0].x) return pts[0].color;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].color;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x + 1e-12);
      return lerpColor(a.color, b.color, t);
    }
  }
  return pts[pts.length - 1].color;
}

function sampleAlphaAt(x) {
  const pts = cmap.points;
  if (x <= pts[0].x) return pts[0].a;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].a;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x + 1e-12);
      return lerp(a.a, b.a, t);
    }
  }
  return pts[pts.length - 1].a;
}

function renderCMapEditor() {
  const w = cmapCanvas.width;
  const h = cmapCanvas.height;
  const colorH = Math.floor(h * 0.55);
  const alphaY0 = colorH + 10;
  const alphaH = h - alphaY0 - 10;

  cmapCtx.clearRect(0, 0, w, h);

  // 绘制颜色条
  for (let i = 0; i < w; i++) {
    const x01 = i / (w - 1);
    cmapCtx.fillStyle = sampleColorAt(x01);
    cmapCtx.fillRect(i, 10, 1, colorH - 20);
  }
  cmapCtx.strokeStyle = "#000";
  cmapCtx.strokeRect(0.5, 10.5, w - 1, colorH - 21);

  // 透明度区域
  cmapCtx.fillStyle = "#f6f6f6";
  cmapCtx.fillRect(0, alphaY0, w, alphaH);

  cmapCtx.strokeStyle = "#ddd";
  for (let i = 0; i <= 4; i++) {
    const yy = alphaY0 + (i / 4) * alphaH;
    cmapCtx.beginPath();
    cmapCtx.moveTo(0, yy);
    cmapCtx.lineTo(w, yy);
    cmapCtx.stroke();
  }
  cmapCtx.strokeStyle = "#000";
  cmapCtx.strokeRect(0.5, alphaY0 + 0.5, w - 1, alphaH - 1);

  // 透明度曲线
  sortPoints();
  cmapCtx.strokeStyle = "#222";
  cmapCtx.lineWidth = 2;
  cmapCtx.beginPath();
  for (let i = 0; i < cmap.points.length; i++) {
    const p = cmap.points[i];
    const px = p.x * (w - 1);
    const py = alphaY0 + (1 - p.a) * (alphaH - 1);
    if (i === 0) cmapCtx.moveTo(px, py);
    else cmapCtx.lineTo(px, py);
  }
  cmapCtx.stroke();

  // 控制点
  for (let i = 0; i < cmap.points.length; i++) {
    const p = cmap.points[i];
    const px = p.x * (w - 1);

    // 颜色条上的三角形
    const baseY = colorH - 5;
    cmapCtx.fillStyle = p.color;
    cmapCtx.beginPath();
    cmapCtx.moveTo(px, baseY);
    cmapCtx.lineTo(px - 7, baseY - 12);
    cmapCtx.lineTo(px + 7, baseY - 12);
    cmapCtx.closePath();
    cmapCtx.fill();
    cmapCtx.strokeStyle = (i === cmap.selected) ? "#ff0000" : "#000";
    cmapCtx.stroke();

    // 透明度区的圆点
    const py = alphaY0 + (1 - p.a) * (alphaH - 1);
    cmapCtx.fillStyle = p.color;
    cmapCtx.beginPath();
    cmapCtx.arc(px, py, 6, 0, Math.PI * 2);
    cmapCtx.fill();
    cmapCtx.strokeStyle = (i === cmap.selected) ? "#ff0000" : "#000";
    cmapCtx.stroke();
  }

  cmapCtx.fillStyle = "#000";
  cmapCtx.font = "12px sans-serif";
  cmapCtx.fillText("颜色", 6, 18);
  cmapCtx.fillText("透明度", 6, alphaY0 + 14);

  syncSelectedUI();
}

function findPointAtCanvasPos(mx, my) {
  const w = cmapCanvas.width;
  const h = cmapCanvas.height;
  const colorH = Math.floor(h * 0.55);
  const alphaY0 = colorH + 10;
  const alphaH = h - alphaY0 - 10;

  for (let i = 0; i < cmap.points.length; i++) {
    const p = cmap.points[i];
    const px = p.x * (w - 1);
    const py = alphaY0 + (1 - p.a) * (alphaH - 1);
    if ((mx - px) ** 2 + (my - py) ** 2 <= 64) return i;
  }

  const baseY = colorH - 10;
  for (let i = 0; i < cmap.points.length; i++) {
    const p = cmap.points[i];
    const px = p.x * (w - 1);
    if ((mx - px) ** 2 + (my - baseY) ** 2 <= 100) return i;
  }
  return -1;
}

function canvasPosToX01(mx) {
  return clamp(mx / (cmapCanvas.width - 1), 0, 1);
}

function canvasPosToAlpha01(my) {
  const h = cmapCanvas.height;
  const colorH = Math.floor(h * 0.55);
  const alphaY0 = colorH + 10;
  const alphaH = h - alphaY0 - 10;
  return clamp(1 - (my - alphaY0) / (alphaH - 1), 0, 1);
}

function addPointAt(x01) {
  if (cmap.points.length >= MAX_POINTS) {
    alert(`最多 ${MAX_POINTS} 个控制点。`);
    return;
  }
  cmap.points.push({ x: x01, color: sampleColorAt(x01), a: sampleAlphaAt(x01) });
  sortPoints();
  cmap.selected = cmap.points.findIndex(p => Math.abs(p.x - x01) < 1e-6);
  renderCMapEditor();
}

function deleteSelectedPoint() {
  if (cmap.points.length <= 2) {
    alert("至少保留 2 个控制点。");
    return;
  }
  cmap.points.splice(cmap.selected, 1);
  cmap.selected = clamp(cmap.selected, 0, cmap.points.length - 1);
  renderCMapEditor();
}

function syncSelectedUI() {
  const p = getSelectedPoint();
  if (!p) return;
  document.getElementById("ptColor").value = p.color;
  document.getElementById("ptAlpha").value = String(Math.round(p.a * 100));
  document.getElementById("ptAlphaText").innerText = p.a.toFixed(2);
}

// 调色盘交互
cmapCanvas.addEventListener("mousedown", (ev) => {
  const rect = cmapCanvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const idx = findPointAtCanvasPos(mx, my);
  if (idx >= 0) {
    cmap.selected = idx;
    cmap.dragging = true;
    cmap.dragIndex = idx;
    renderCMapEditor();
    return;
  }
  addPointAt(canvasPosToX01(mx));
});

window.addEventListener("mousemove", (ev) => {
  if (!cmap.dragging) return;
  const rect = cmapCanvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const idx = cmap.dragIndex;
  if (idx < 0 || idx >= cmap.points.length) return;
  cmap.points[idx].x = canvasPosToX01(mx);
  if (my > cmapCanvas.height * 0.55) {
    cmap.points[idx].a = canvasPosToAlpha01(my);
  }
  sortPoints();
  renderCMapEditor();
});

window.addEventListener("mouseup", () => {
  cmap.dragging = false;
  cmap.dragIndex = -1;
});

cmapCanvas.addEventListener("dblclick", (ev) => {
  const rect = cmapCanvas.getBoundingClientRect();
  const idx = findPointAtCanvasPos(ev.clientX - rect.left, ev.clientY - rect.top);
  if (idx < 0) return;
  cmap.selected = idx;
  syncSelectedUI();
  const picker = document.getElementById("hiddenColorPicker");
  picker.value = cmap.points[idx].color;
  picker.oninput = () => {
    cmap.points[cmap.selected].color = picker.value;
    renderCMapEditor();
  };
  picker.click();
});

document.getElementById("ptColor").addEventListener("input", (e) => {
  const p = getSelectedPoint();
  if (p) { p.color = e.target.value; renderCMapEditor(); }
});

document.getElementById("ptAlpha").addEventListener("input", (e) => {
  const p = getSelectedPoint();
  if (p) {
    p.a = clamp(Number(e.target.value) / 100, 0, 1);
    document.getElementById("ptAlphaText").innerText = p.a.toFixed(2);
    renderCMapEditor();
  }
});

document.getElementById("btnAddPoint").onclick = () => addPointAt(0.5);
document.getElementById("btnDeletePoint").onclick = deleteSelectedPoint;

// ======================= 构建 VTK 颜色函数 =======================
function buildVTKCTF(range) {
  const [sMin, sMax] = range;
  const s = (t) => sMin + t * (sMax - sMin);
  sortPoints();
  const ctf = vtk.Rendering.Core.vtkColorTransferFunction.newInstance();
  for (const p of cmap.points) {
    const [r, g, b] = hexToRgb01(p.color);
    ctf.addRGBPoint(s(p.x), r, g, b);
  }
  return ctf;
}

function buildVTKOpacity(range) {
  const [sMin, sMax] = range;
  const s = (t) => sMin + t * (sMax - sMin);
  sortPoints();
  const ofun = vtk.Common.DataModel.vtkPiecewiseFunction.newInstance();
  for (const p of cmap.points) {
    ofun.addPoint(s(p.x), clamp(p.a, 0, 1));
  }
  return ofun;
}

function ensureScalarBar(lut) {
  const SBA = vtk.Rendering.Annotation?.vtkScalarBarActor;
  if (!SBA || !lut) return;
  if (!scalarBarActor) {
    scalarBarActor = SBA.newInstance();
    scalarBarActor.setAxisLabel("数值");
    scalarBarActor.setDrawNanAnnotation(false);
    scalarBarActor.setPosition(0.80, 0.05);
    scalarBarActor.setMaximumWidthInPixels(120);
    scalarBarActor.setMaximumHeightInPixels(300);
    renderer.addActor2D(scalarBarActor);
  }
  scalarBarActor.setScalarsToColors(lut);
}

function applyCMapToDEM() {
  if (!demMapper) return;
  const range = demMapper.getScalarRange();
  const ctf = buildVTKCTF(range);
  demMapper.setLookupTable(ctf);
  demMapper.setUseLookupTableScalarRange(true);
  ensureScalarBar(ctf);
}

function applyCMapToSegy2D() {
  if (!segy2DMapper) return;
  const range = segy2DMapper.getScalarRange();
  const ctf = buildVTKCTF(range);
  segy2DMapper.setLookupTable(ctf);
  segy2DMapper.setUseLookupTableScalarRange(true);
}

function applyCMapToVolume() {
  if (!volumeActor || !volumeScalarRange) return;
  const ctf = buildVTKCTF(volumeScalarRange);
  const ofun = buildVTKOpacity(volumeScalarRange);
  const prop = volumeActor.getProperty();
  prop.setRGBTransferFunction(0, ctf);
  prop.setScalarOpacity(0, ofun);
  prop.setInterpolationTypeToLinear();
  prop.setShade(true);
  prop.setAmbient(0.25);
  prop.setDiffuse(0.7);
  prop.setSpecular(0.15);
}

function applyCMapToAll() {
  applyCMapToDEM();
  applyCMapToSegy2D();
  applyCMapToVolume();
  renderWindow.render();
}

document.getElementById("btnApplyCMap").onclick = applyCMapToAll;

// ======================= 预设色表 =======================
function setPreset(name) {
  const presets = {
    Grayscale: [
      { x: 0.0, color: "#000000", a: 0.00 },
      { x: 1.0, color: "#ffffff", a: 0.25 },
    ],
    Rainbow: [
      { x: 0.0, color: "#0000ff", a: 0.00 },
      { x: 0.25, color: "#00ffff", a: 0.05 },
      { x: 0.5, color: "#00ff00", a: 0.10 },
      { x: 0.75, color: "#ffff00", a: 0.15 },
      { x: 1.0, color: "#ff0000", a: 0.25 },
    ],
    Seismic: [
      { x: 0.0, color: "#0000ff", a: 0.00 },
      { x: 0.5, color: "#ffffff", a: 0.05 },
      { x: 1.0, color: "#ff0000", a: 0.30 },
    ],
    Terrain: [
      { x: 0.0, color: "#006400", a: 0.00 },
      { x: 0.3, color: "#228b22", a: 0.05 },
      { x: 0.5, color: "#deb887", a: 0.10 },
      { x: 0.7, color: "#8b4513", a: 0.15 },
      { x: 1.0, color: "#ffffff", a: 0.25 },
    ],
    CoolToWarm: [
      { x: 0.0, color: "#3b4cc0", a: 0.00 },
      { x: 0.5, color: "#dddddd", a: 0.05 },
      { x: 1.0, color: "#b40426", a: 0.25 },
    ],
  };
  cmap.points = presets[name] || presets.CoolToWarm;
  cmap.selected = Math.min(1, cmap.points.length - 1);
  renderCMapEditor();
}

document.getElementById("btnApplyPreset").onclick = () => {
  setPreset(document.getElementById("lutPreset").value);
  applyCMapToAll();
};

renderCMapEditor();

// ======================= DEM 可视化 =======================
function showDEM() {
  if (!demFileData) {
    alert("请先选择DEM文件");
    return;
  }

  try {
    // 简单解析 TIFF (假设是单波段灰度图)
    const arr = new Uint8Array(demFileData);

    // 尝试找到图像数据（简化处理，实际 TIFF 解析更复杂）
    // 这里假设是 raw 数据或简单格式
    const width = 256;  // 假设宽度
    const height = Math.floor(arr.length / width);

    const z = new Float32Array(width * height);
    for (let i = 0; i < Math.min(arr.length, z.length); i++) {
      z[i] = arr[i];
    }

    // 归一化
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < z.length; i++) {
      if (z[i] < zmin) zmin = z[i];
      if (z[i] > zmax) zmax = z[i];
    }

    const points = new Float32Array(width * height * 3);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = j * width + i;
        points[idx * 3 + 0] = i / width - 0.5;
        points[idx * 3 + 1] = j / height - 0.5;
        points[idx * 3 + 2] = (z[idx] - zmin) / (zmax - zmin + 1) * 0.3;
      }
    }

    // 构建三角网格
    const nCells = (width - 1) * (height - 1) * 2;
    const polys = new Uint32Array(nCells * 4);
    let p = 0;
    for (let j = 0; j < height - 1; j++) {
      for (let i = 0; i < width - 1; i++) {
        const a = j * width + i;
        const b = j * width + i + 1;
        const c = (j + 1) * width + i;
        const d = (j + 1) * width + i + 1;
        polys[p++] = 3; polys[p++] = a; polys[p++] = b; polys[p++] = d;
        polys[p++] = 3; polys[p++] = a; polys[p++] = d; polys[p++] = c;
      }
    }

    const polydata = vtk.Common.DataModel.vtkPolyData.newInstance();
    polydata.getPoints().setData(points, 3);
    polydata.getPolys().setData(polys);
    polydata.getPointData().setScalars(
      vtk.Common.Core.vtkDataArray.newInstance({
        name: "elevation",
        values: z,
        numberOfComponents: 1,
      })
    );

    demMapper = vtk.Rendering.Core.vtkMapper.newInstance();
    demMapper.setInputData(polydata);
    demMapper.setScalarRange(zmin, zmax);

    demActor = vtk.Rendering.Core.vtkActor.newInstance();
    demActor.setMapper(demMapper);

    const prop = demActor.getProperty();
    prop.setInterpolationToPhong();
    prop.setAmbient(0.25);
    prop.setDiffuse(0.7);
    prop.setSpecular(0.15);

    renderer.addActor(demActor);
    applyCMapToDEM();

    renderer.resetCamera();
    renderWindow.render();

    updateAxisInfo(`
      <strong>DEM 地形数据：</strong><br>
      网格尺寸: ${width} × ${height}<br>
      高程范围: ${zmin.toFixed(2)} ~ ${zmax.toFixed(2)}
    `);

    console.log("DEM显示成功");
  } catch (e) {
    console.error("DEM显示失败:", e);
    alert("DEM显示失败: " + e.message);
  }
}

// ======================= SEGY 变密度 =======================
function showDensity() {
  if (!segyFileData || !segyInfo) {
    alert("请先选择SEGY文件");
    return;
  }

  const start = parseInt(document.getElementById("segyStart").value, 10) || 0;
  const count = parseInt(document.getElementById("segyCount").value, 10) || 200;

  try {
    const result = getSegyTraces(segyFileData, start, count);
    if (!result) throw new Error("无法读取道数据");

    const { data, traceCount, sampleCount } = result;

    // 归一化
    let dmin = Infinity, dmax = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (isFinite(data[i])) {
        if (data[i] < dmin) dmin = data[i];
        if (data[i] > dmax) dmax = data[i];
      }
    }

    const normalized = new Float32Array(data.length);
    const range = dmax - dmin || 1;
    for (let i = 0; i < data.length; i++) {
      normalized[i] = (data[i] - dmin) / range;
    }

    // 构建网格
    const points = new Float32Array(traceCount * sampleCount * 3);
    for (let t = 0; t < traceCount; t++) {
      for (let s = 0; s < sampleCount; s++) {
        const idx = t * sampleCount + s;
        points[idx * 3 + 0] = t / traceCount;
        points[idx * 3 + 1] = 1 - s / sampleCount;
        points[idx * 3 + 2] = 0;
      }
    }

    const nCells = (traceCount - 1) * (sampleCount - 1) * 2;
    const polys = new Uint32Array(nCells * 4);
    let p = 0;
    for (let t = 0; t < traceCount - 1; t++) {
      for (let s = 0; s < sampleCount - 1; s++) {
        const a = t * sampleCount + s;
        const b = t * sampleCount + s + 1;
        const c = (t + 1) * sampleCount + s;
        const d = (t + 1) * sampleCount + s + 1;
        polys[p++] = 3; polys[p++] = a; polys[p++] = c; polys[p++] = d;
        polys[p++] = 3; polys[p++] = a; polys[p++] = d; polys[p++] = b;
      }
    }

    const polydata = vtk.Common.DataModel.vtkPolyData.newInstance();
    polydata.getPoints().setData(points, 3);
    polydata.getPolys().setData(polys);
    polydata.getPointData().setScalars(
      vtk.Common.Core.vtkDataArray.newInstance({
        name: "amplitude",
        values: normalized,
        numberOfComponents: 1,
      })
    );

    segy2DMapper = vtk.Rendering.Core.vtkMapper.newInstance();
    segy2DMapper.setInputData(polydata);
    segy2DMapper.setScalarRange(0, 1);

    segy2DActor = vtk.Rendering.Core.vtkActor.newInstance();
    segy2DActor.setMapper(segy2DMapper);

    renderer.addActor(segy2DActor);
    applyCMapToSegy2D();

    setCameraPreset("front");

    const dtMs = segyInfo.dtMicroseconds / 1000;
    updateAxisInfo(`
      <strong>变密度显示：</strong><br>
      道号范围: ${start} - ${start + traceCount - 1}<br>
      时间范围: 0 - ${(sampleCount * dtMs).toFixed(1)} ms<br>
      采样点数: ${sampleCount}
    `);

    console.log("变密度显示成功:", { traceCount, sampleCount });
  } catch (e) {
    console.error("变密度显示失败:", e);
    alert("变密度显示失败: " + e.message);
  }
}

// ======================= SEGY 变面积 =======================
function showWiggle() {
  if (!segyFileData || !segyInfo) {
    alert("请先选择SEGY文件");
    return;
  }

  const start = parseInt(document.getElementById("segyStart").value, 10) || 0;
  let count = parseInt(document.getElementById("segyCount").value, 10) || 60;
  count = Math.min(count, 80); // 限制道数避免卡顿

  try {
    const result = getSegyTraces(segyFileData, start, count);
    if (!result) throw new Error("无法读取道数据");

    const { data, traceCount, sampleCount } = result;

    // 归一化
    let maxAbs = 0;
    for (let i = 0; i < data.length; i++) {
      if (isFinite(data[i]) && Math.abs(data[i]) > maxAbs) {
        maxAbs = Math.abs(data[i]);
      }
    }
    maxAbs = maxAbs || 1;

    const scale = 0.7;

    // 添加白色背景
    const bgPoints = new Float32Array([0, 0, -0.001, 1, 0, -0.001, 1, 1, -0.001, 0, 1, -0.001]);
    const bgPolys = new Uint32Array([4, 0, 1, 2, 3]);
    const bgPolydata = vtk.Common.DataModel.vtkPolyData.newInstance();
    bgPolydata.getPoints().setData(bgPoints, 3);
    bgPolydata.getPolys().setData(bgPolys);
    const bgMapper = vtk.Rendering.Core.vtkMapper.newInstance();
    bgMapper.setInputData(bgPolydata);
    const bgActor = vtk.Rendering.Core.vtkActor.newInstance();
    bgActor.setMapper(bgMapper);
    bgActor.getProperty().setColor(1, 1, 1);
    segy2DFillActors.push(bgActor);
    renderer.addActor(bgActor);

    // 为每条道创建折线和填充
    for (let t = 0; t < traceCount; t++) {
      const baseX = t / traceCount;
      const linePoints = [];
      const fillPoints = [];
      const fillPolys = [];

      for (let s = 0; s < sampleCount; s++) {
        const amp = data[t * sampleCount + s] / maxAbs * scale / traceCount;
        const x = baseX + amp;
        const y = 1 - s / sampleCount;

        linePoints.push(x, y, 0.001);

        // 正半波填充
        if (amp > 0 && s > 0) {
          const prevAmp = data[t * sampleCount + s - 1] / maxAbs * scale / traceCount;
          const prevX = baseX + prevAmp;
          const prevY = 1 - (s - 1) / sampleCount;

          const idx = fillPoints.length / 3;
          fillPoints.push(baseX, prevY, 0);
          fillPoints.push(Math.max(prevX, baseX), prevY, 0);
          fillPoints.push(Math.max(x, baseX), y, 0);
          fillPoints.push(baseX, y, 0);
          fillPolys.push(4, idx, idx + 1, idx + 2, idx + 3);
        }
      }

      // 创建折线
      if (linePoints.length > 0) {
        const lp = vtk.Common.DataModel.vtkPolyData.newInstance();
        lp.getPoints().setData(new Float32Array(linePoints), 3);
        const lines = new Uint32Array(linePoints.length / 3 + 1);
        lines[0] = linePoints.length / 3;
        for (let i = 0; i < linePoints.length / 3; i++) lines[i + 1] = i;
        lp.getLines().setData(lines);

        const lm = vtk.Rendering.Core.vtkMapper.newInstance();
        lm.setInputData(lp);
        const la = vtk.Rendering.Core.vtkActor.newInstance();
        la.setMapper(lm);
        la.getProperty().setColor(0, 0, 0);
        la.getProperty().setLineWidth(1);
        segy2DWiggleActors.push(la);
        renderer.addActor(la);
      }

      // 创建填充
      if (fillPoints.length > 0) {
        const fp = vtk.Common.DataModel.vtkPolyData.newInstance();
        fp.getPoints().setData(new Float32Array(fillPoints), 3);
        fp.getPolys().setData(new Uint32Array(fillPolys));

        const fm = vtk.Rendering.Core.vtkMapper.newInstance();
        fm.setInputData(fp);
        const fa = vtk.Rendering.Core.vtkActor.newInstance();
        fa.setMapper(fm);
        fa.getProperty().setColor(0, 0, 0);
        segy2DFillActors.push(fa);
        renderer.addActor(fa);
      }
    }

    setCameraPreset("front");

    const dtMs = segyInfo.dtMicroseconds / 1000;
    updateAxisInfo(`
      <strong>变面积显示：</strong><br>
      道号范围: ${start} - ${start + traceCount - 1}<br>
      时间范围: 0 - ${(sampleCount * dtMs).toFixed(1)} ms<br>
      采样点数: ${sampleCount}
    `);

    console.log("变面积显示成功:", { traceCount, sampleCount });
  } catch (e) {
    console.error("变面积显示失败:", e);
    alert("变面积显示失败: " + e.message);
  }
}

// ======================= SEGY 体渲染 =======================
function showVolume() {
  if (!segyFileData || !segyInfo) {
    alert("请先选择SEGY文件");
    return;
  }

  const start = parseInt(document.getElementById("segyStart").value, 10) || 0;
  const count = parseInt(document.getElementById("segyCount").value, 10) || 128;
  const slices = 32;
  const stride = 20;

  try {
    const { sampleCount, traceCount: totalTraces } = segyInfo;

    // 构建体数据
    const nx = Math.min(count, totalTraces - start);
    const ny = sampleCount;
    const nz = slices;

    const vol = new Float32Array(nx * ny * nz);

    for (let z = 0; z < nz; z++) {
      const sliceStart = start + z * stride;
      const result = getSegyTraces(segyFileData, sliceStart, nx);
      if (result) {
        for (let x = 0; x < result.traceCount; x++) {
          for (let y = 0; y < result.sampleCount; y++) {
            vol[z * nx * ny + y * nx + x] = result.data[x * result.sampleCount + y];
          }
        }
      }
    }

    // 归一化
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < vol.length; i++) {
      if (isFinite(vol[i])) {
        if (vol[i] < vmin) vmin = vol[i];
        if (vol[i] > vmax) vmax = vol[i];
      }
    }
    volumeScalarRange = [vmin, vmax];

    const imageData = vtk.Common.DataModel.vtkImageData.newInstance();
    imageData.setDimensions([nx, ny, nz]);
    imageData.setSpacing([1, 1, 1]);
    imageData.getPointData().setScalars(
      vtk.Common.Core.vtkDataArray.newInstance({
        name: "amplitude",
        values: vol,
        numberOfComponents: 1,
      })
    );

    volumeMapper = vtk.Rendering.Core.vtkVolumeMapper.newInstance();
    volumeMapper.setInputData(imageData);
    volumeMapper.setSampleDistance(0.7);

    volumeActor = vtk.Rendering.Core.vtkVolume.newInstance();
    volumeActor.setMapper(volumeMapper);

    applyCMapToVolume();

    if (renderer.addVolume) renderer.addVolume(volumeActor);
    else renderer.addViewProp(volumeActor);

    renderer.resetCamera();
    renderWindow.render();

    const dtMs = segyInfo.dtMicroseconds / 1000;
    updateAxisInfo(`
      <strong>体渲染显示：</strong><br>
      道号范围: ${start} - ${start + nx - 1}<br>
      时间范围: 0 - ${(ny * dtMs).toFixed(1)} ms<br>
      切片数: ${nz}<br>
      振幅范围: ${vmin.toFixed(2)} ~ ${vmax.toFixed(2)}
    `);

    console.log("体渲染显示成功:", { nx, ny, nz, vmin, vmax });
  } catch (e) {
    console.error("体渲染显示失败:", e);
    alert("体渲染显示失败: " + e.message);
  }
}

// ======================= 相机预设 =======================
function setCameraPreset(name) {
  const cam = renderer.getActiveCamera();
  switch (name) {
    case "top":
      cam.setPosition(0, 0, 2);
      cam.setViewUp(0, 1, 0);
      break;
    case "front":
      cam.setPosition(0.5, 0.5, 2);
      cam.setViewUp(0, 1, 0);
      break;
    case "side":
      cam.setPosition(2, 0.5, 0.5);
      cam.setViewUp(0, 1, 0);
      break;
    default: // iso
      cam.setPosition(1.2, -0.5, 1.5);
      cam.setViewUp(0, 1, 0);
  }
  cam.setFocalPoint(0.5, 0.5, 0);
  renderer.resetCamera();
  renderWindow.render();
}

// ======================= 按钮事件绑定 =======================
document.getElementById("btnDem").onclick = () => toggleVisualization("dem", showDEM);
document.getElementById("btnDensity").onclick = () => toggleVisualization("density", showDensity);
document.getElementById("btnWiggle").onclick = () => toggleVisualization("wiggle", showWiggle);
document.getElementById("btnVolume").onclick = () => toggleVisualization("volume", showVolume);

document.getElementById("btnViewIso").onclick = () => setCameraPreset("iso");
document.getElementById("btnViewTop").onclick = () => setCameraPreset("top");
document.getElementById("btnViewFront").onclick = () => setCameraPreset("front");
document.getElementById("btnViewSide").onclick = () => setCameraPreset("side");
document.getElementById("btnResetCam").onclick = () => {
  renderer.resetCamera();
  renderWindow.render();
};

// ======================= 初始化 =======================
renderer.getActiveCamera().setPosition(1.2, -0.5, 1.5);
renderer.getActiveCamera().setViewUp(0, 1, 0);
renderer.resetCamera();
renderWindow.render();