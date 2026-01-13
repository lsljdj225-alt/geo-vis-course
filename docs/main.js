/**
 * main.js
 * - DEM 三维曲面
 * - SEGY 2D：变密度/变面积（带坐标轴标注和正半波填充）
 * - SEGY 3D：体渲染
 * - 统一调色盘
 */

const API = `https://geo-vis-backend.onrender.com/api`;

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
let segyInfo = null;

// DEM
let demActor = null;
let demMapper = null;
let scalarBarActor = null;

// Volume
let volumeActor = null;
let volumeMapper = null;
let volumeScalarRange = null;

// SEGY 2D
let segy2DActor = null;
let segy2DMapper = null;
let segy2DWiggleActors = [];
let segy2DFillActors = [];  // 变面积填充
let cubeAxesActor = null;   // 坐标轴

// ======================= 工具：清除各类显示 =======================
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

function removeCubeAxes() {
  if (cubeAxesActor) {
    renderer.removeActor(cubeAxesActor);
    cubeAxesActor = null;
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

  removeCubeAxes();
}

function clearAllDisplays() {
  removeVolumeIfAny();
  removeDEMIfAny();
  removeSegy2DActors();
  renderWindow.render();
}

// ======================= 获取 SEGY 信息 =======================
async function fetchSegyInfo() {
  try {
    const res = await fetch(`${API}/segy/info`);
    if (!res.ok) throw new Error(await res.text());
    segyInfo = await res.json();
    console.log("SEGY info:", segyInfo);
  } catch (e) {
    console.warn("Fetch segy info failed:", e.message);
  }
}
fetchSegyInfo();

// ======================= 创建坐标轴标注 =======================
function createCubeAxes(bounds, xTitle, yTitle, zTitle) {
  // 检查是否有CubeAxesActor
  const CubeAxes = vtk.Rendering.Core.vtkCubeAxesActor;
  if (!CubeAxes) {
    console.warn("vtkCubeAxesActor not available");
    return null;
  }

  const actor = CubeAxes.newInstance();
  actor.setDataBounds(bounds);
  actor.setCamera(renderer.getActiveCamera());

  // 设置轴标签
  actor.setXAxisLabel(xTitle || "X");
  actor.setYAxisLabel(yTitle || "Y");
  actor.setZAxisLabel(zTitle || "Z");

  // 设置颜色
  actor.setAxisLabels([xTitle || "X", yTitle || "Y", zTitle || "Z"]);

  return actor;
}

// ======================= 创建2D文字标注（备用方案） =======================
function create2DAnnotations(startTrace, traceCount, sampleCount, dtMs) {
  const canvas = document.getElementById("annotationCanvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  ctx.font = "12px sans-serif";

  // 绘制道号标注（X轴）
  const ticksX = 5;
  for (let i = 0; i <= ticksX; i++) {
    const t = i / ticksX;
    const x = 50 + t * (w - 80);
    const traceNum = startTrace + Math.round(t * (traceCount - 1));
    ctx.fillText(String(traceNum), x - 10, h - 10);
  }
  ctx.fillText("道号", w / 2, h - 25);

  // 绘制时间标注（Y轴）
  const ticksY = 5;
  for (let i = 0; i <= ticksY; i++) {
    const t = i / ticksY;
    const y = 30 + t * (h - 60);
    const timeMs = Math.round(t * sampleCount * dtMs);
    ctx.fillText(timeMs + " ms", 5, y + 4);
  }
  ctx.save();
  ctx.translate(15, h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("时间 (ms)", 0, 0);
  ctx.restore();
}

// ======================= 色标 =======================
function ensureScalarBar(lut) {
  const SBA = vtk.Rendering.Annotation && vtk.Rendering.Annotation.vtkScalarBarActor;
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

// ======================= 调色盘编辑器 =======================
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
  const toHex = (x) => {
    const v = clamp(Math.round(x * 255), 0, 255).toString(16).padStart(2, "0");
    return v;
  };
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
  const n = w;
  for (let i = 0; i < n; i++) {
    const x01 = i / (n - 1);
    const c = sampleColorAt(x01);
    cmapCtx.fillStyle = c;
    cmapCtx.fillRect(i, 10, 1, colorH - 20);
  }

  cmapCtx.strokeStyle = "#000";
  cmapCtx.strokeRect(0.5, 10.5, w - 1, colorH - 21);

  // 绘制透明度区域背景
  cmapCtx.fillStyle = "#f6f6f6";
  cmapCtx.fillRect(0, alphaY0, w, alphaH);

  // 网格线
  cmapCtx.strokeStyle = "#ddd";
  cmapCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yy = alphaY0 + (i / 4) * alphaH;
    cmapCtx.beginPath();
    cmapCtx.moveTo(0, yy);
    cmapCtx.lineTo(w, yy);
    cmapCtx.stroke();
  }
  cmapCtx.strokeStyle = "#000";
  cmapCtx.strokeRect(0.5, alphaY0 + 0.5, w - 1, alphaH - 1);

  // 绘制透明度曲线
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

  // 绘制控制点
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

  // 标签
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
    const d2 = (mx - px) * (mx - px) + (my - py) * (my - py);
    if (d2 <= 8 * 8) return i;
  }

  const baseY = colorH - 10;
  for (let i = 0; i < cmap.points.length; i++) {
    const p = cmap.points[i];
    const px = p.x * (w - 1);
    const d2 = (mx - px) * (mx - px) + (my - baseY) * (my - baseY);
    if (d2 <= 10 * 10) return i;
  }
  return -1;
}

function canvasPosToX01(mx) {
  const w = cmapCanvas.width;
  return clamp(mx / (w - 1), 0, 1);
}

function canvasPosToAlpha01(my) {
  const h = cmapCanvas.height;
  const colorH = Math.floor(h * 0.55);
  const alphaY0 = colorH + 10;
  const alphaH = h - alphaY0 - 10;
  const t = clamp((my - alphaY0) / (alphaH - 1), 0, 1);
  return clamp(1 - t, 0, 1);
}

function addPointAt(x01) {
  if (cmap.points.length >= MAX_POINTS) {
    alert(`最多 ${MAX_POINTS} 个控制点。`);
    return;
  }
  sortPoints();
  const color = sampleColorAt(x01);
  const a = sampleAlphaAt(x01);
  cmap.points.push({ x: x01, color, a });
  sortPoints();
  let idx = 0;
  for (let i = 0; i < cmap.points.length; i++) {
    if (Math.abs(cmap.points[i].x - x01) < 1e-6) idx = i;
  }
  cmap.selected = idx;
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
  const a = clamp(p.a, 0, 1);
  document.getElementById("ptAlpha").value = String(Math.round(a * 100));
  document.getElementById("ptAlphaText").innerText = a.toFixed(2);
}

// 调色盘交互事件
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

  const x01 = canvasPosToX01(mx);
  cmap.points[idx].x = x01;

  const h = cmapCanvas.height;
  if (my > h * 0.55) {
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
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;

  const idx = findPointAtCanvasPos(mx, my);
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
  if (!p) return;
  p.color = e.target.value;
  renderCMapEditor();
});

document.getElementById("ptAlpha").addEventListener("input", (e) => {
  const p = getSelectedPoint();
  if (!p) return;
  p.a = clamp(Number(e.target.value) / 100, 0, 1);
  document.getElementById("ptAlphaText").innerText = p.a.toFixed(2);
  renderCMapEditor();
});

document.getElementById("btnAddPoint").onclick = () => {
  addPointAt(0.5);
};

document.getElementById("btnDeletePoint").onclick = deleteSelectedPoint;

// ======================= 构建 VTK 颜色/透明度函数 =======================
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
  if (name === "Grayscale") {
    cmap.points = [
      { x: 0.0, color: "#000000", a: 0.00 },
      { x: 1.0, color: "#ffffff", a: 0.25 },
    ];
  } else if (name === "Rainbow") {
    cmap.points = [
      { x: 0.0, color: "#0000ff", a: 0.00 },
      { x: 0.25, color: "#00ffff", a: 0.05 },
      { x: 0.5, color: "#00ff00", a: 0.10 },
      { x: 0.75, color: "#ffff00", a: 0.15 },
      { x: 1.0, color: "#ff0000", a: 0.25 },
    ];
  } else if (name === "Seismic") {
    cmap.points = [
      { x: 0.0, color: "#0000ff", a: 0.00 },
      { x: 0.5, color: "#ffffff", a: 0.05 },
      { x: 1.0, color: "#ff0000", a: 0.30 },
    ];
  } else if (name === "Terrain") {
    cmap.points = [
      { x: 0.0, color: "#006400", a: 0.00 },
      { x: 0.3, color: "#228b22", a: 0.05 },
      { x: 0.5, color: "#deb887", a: 0.10 },
      { x: 0.7, color: "#8b4513", a: 0.15 },
      { x: 1.0, color: "#ffffff", a: 0.25 },
    ];
  } else {
    // CoolToWarm 冷暖色
    cmap.points = [
      { x: 0.0, color: "#3b4cc0", a: 0.00 },
      { x: 0.5, color: "#dddddd", a: 0.05 },
      { x: 1.0, color: "#b40426", a: 0.25 },
    ];
  }
  cmap.selected = Math.min(1, cmap.points.length - 1);
  renderCMapEditor();
}

document.getElementById("btnApplyPreset").onclick = () => {
  const name = document.getElementById("lutPreset").value;
  setPreset(name);
  applyCMapToAll();
};

renderCMapEditor();

// ======================= DEM 曲面构建 =======================
function buildSurfacePolyData(grid) {
  const { width: w, height: h, x, y, z, zRange } = grid;

  let xmin = Infinity, xmax = -Infinity;
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i], yi = y[i];
    if (xi < xmin) xmin = xi;
    if (xi > xmax) xmax = xi;
    if (yi < ymin) ymin = yi;
    if (yi > ymax) ymax = yi;
  }
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const dx = (xmax - xmin) || 1;
  const dy = (ymax - ymin) || 1;

  const scaleXY = 1.0 / Math.max(dx, dy);

  const zmin = zRange ? zRange[0] : Math.min(...z);
  const zmax = zRange ? zRange[1] : Math.max(...z);
  const dz = (zmax - zmin) || 1;
  const scaleZ = 0.35 / dz;

  const points = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    points[i * 3 + 0] = (x[i] - cx) * scaleXY;
    points[i * 3 + 1] = (y[i] - cy) * scaleXY;
    points[i * 3 + 2] = (z[i] - zmin) * scaleZ;
  }

  const nCells = (w - 1) * (h - 1) * 2;
  const polys = new Uint32Array(nCells * 4);
  let p = 0;
  const id = (r, c) => r * w + c;

  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const a = id(r, c);
      const b = id(r, c + 1);
      const d = id(r + 1, c);
      const e = id(r + 1, c + 1);
      polys[p++] = 3; polys[p++] = a; polys[p++] = b; polys[p++] = e;
      polys[p++] = 3; polys[p++] = a; polys[p++] = e; polys[p++] = d;
    }
  }

  const polydata = vtk.Common.DataModel.vtkPolyData.newInstance();
  polydata.getPoints().setData(points, 3);
  polydata.getPolys().setData(polys, 1);

  polydata.getPointData().setScalars(vtk.Common.Core.vtkDataArray.newInstance({
    name: "elevation",
    values: new Float32Array(z),
    numberOfComponents: 1,
  }));

  return polydata;
}

function addNormalsIfPossible(polydata) {
  const NormalsClass =
    (vtk.Filters && vtk.Filters.Core && vtk.Filters.Core.vtkPolyDataNormals) ||
    (vtk.Filters && vtk.Filters.General && vtk.Filters.General.vtkPolyDataNormals);

  if (!NormalsClass) {
    console.warn("vtkPolyDataNormals not found, skip normals.");
    return polydata;
  }

  const normals = NormalsClass.newInstance({
    computePointNormals: true,
    computeCellNormals: false,
    splitting: false,
  });
  normals.setInputData(polydata);
  normals.update();
  return normals.getOutputData();
}

// ======================= 加载 DEM =======================
async function loadDEM() {
  try {
    clearAllDisplays();

    const res = await fetch(`${API}/dem?decimate=3&zScale=10`);
    if (!res.ok) throw new Error(`DEM API ${res.status}: ${await res.text()}`);
    const grid = await res.json();

    let polydata = buildSurfacePolyData(grid);
    polydata = addNormalsIfPossible(polydata);

    demMapper = vtk.Rendering.Core.vtkMapper.newInstance();
    demMapper.setInputData(polydata);
    demMapper.setScalarModeToUsePointData();
    demMapper.setColorModeToMapScalars();
    demMapper.setScalarRange(grid.zRange[0], grid.zRange[1]);

    demActor = vtk.Rendering.Core.vtkActor.newInstance();
    demActor.setMapper(demMapper);

    const prop = demActor.getProperty();
    prop.setInterpolationToPhong();
    prop.setAmbient(0.25);
    prop.setDiffuse(0.7);
    prop.setSpecular(0.15);
    prop.setSpecularPower(25);

    renderer.addActor(demActor);

    applyCMapToDEM();

    renderer.resetCamera();
    renderWindow.render();

    // 【新增】更新 DEM 坐标信息
    const infoDiv = document.getElementById("axisInfo");
    if (infoDiv) {
      infoDiv.innerHTML = `
        <strong>DEM 地形数据：</strong><br>
        网格尺寸: ${grid.width} × ${grid.height}<br>
        高程范围: ${grid.zRange[0].toFixed(2)} ~ ${grid.zRange[1].toFixed(2)}
      `;
    }

  } catch (e) {
    console.error("loadDEM failed:", e);
    alert("加载DEM失败：请打开F12查看 Console 报错。");
  }
}

// ======================= 相机预设 =======================
function setCameraPreset(name) {
  const cam = renderer.getActiveCamera();
  if (name === "top") {
    cam.setPosition(0, 0, 2);
    cam.setViewUp(0, 1, 0);
  } else if (name === "front") {
    cam.setPosition(0, -2, 0.5);
    cam.setViewUp(0, 0, 1);
  } else if (name === "side") {
    cam.setPosition(2, 0, 0.5);
    cam.setViewUp(0, 0, 1);
  } else {
    cam.setPosition(1.2, -1.6, 1.0);
    cam.setViewUp(0, 0, 1);
  }
  renderer.resetCamera();
  renderWindow.render();
}

// ======================= 添加边框和坐标标注线 =======================
function addAxisLines(startTrace, traceCount, sampleCount, dtMs) {
  // 创建边框
  const borderPoints = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
    0, 0, 0,
  ]);

  const borderLines = new Uint32Array([5, 0, 1, 2, 3, 4]);

  const borderPolydata = vtk.Common.DataModel.vtkPolyData.newInstance();
  borderPolydata.getPoints().setData(borderPoints, 3);
  borderPolydata.getLines().setData(borderLines);

  const borderMapper = vtk.Rendering.Core.vtkMapper.newInstance();
  borderMapper.setInputData(borderPolydata);

  const borderActor = vtk.Rendering.Core.vtkActor.newInstance();
  borderActor.setMapper(borderMapper);
  borderActor.getProperty().setColor(1, 1, 1);
  borderActor.getProperty().setLineWidth(2);

  segy2DWiggleActors.push(borderActor);
  renderer.addActor(borderActor);

  // 添加刻度线
  const tickPoints = [];
  const tickLines = [];
  let ptIdx = 0;

  // X轴刻度（道号）
  const numTicksX = 5;
  for (let i = 0; i <= numTicksX; i++) {
    const x = i / numTicksX;
    tickPoints.push(x, 0, 0);
    tickPoints.push(x, -0.03, 0);
    tickLines.push(2, ptIdx, ptIdx + 1);
    ptIdx += 2;
  }

  // Y轴刻度（时间）
  const numTicksY = 5;
  for (let i = 0; i <= numTicksY; i++) {
    const y = i / numTicksY;
    tickPoints.push(0, y, 0);
    tickPoints.push(-0.03, y, 0);
    tickLines.push(2, ptIdx, ptIdx + 1);
    ptIdx += 2;
  }

  const tickPolydata = vtk.Common.DataModel.vtkPolyData.newInstance();
  tickPolydata.getPoints().setData(new Float32Array(tickPoints), 3);
  tickPolydata.getLines().setData(new Uint32Array(tickLines));

  const tickMapper = vtk.Rendering.Core.vtkMapper.newInstance();
  tickMapper.setInputData(tickPolydata);

  const tickActor = vtk.Rendering.Core.vtkActor.newInstance();
  tickActor.setMapper(tickMapper);
  tickActor.getProperty().setColor(1, 1, 1);
  tickActor.getProperty().setLineWidth(1.5);

  segy2DWiggleActors.push(tickActor);
  renderer.addActor(tickActor);

  // 更新HTML标注信息
  updateAnnotationInfo(startTrace, traceCount, sampleCount, dtMs);
}

function updateAnnotationInfo(startTrace, traceCount, sampleCount, dtMs, extraInfo = null) {
  const infoDiv = document.getElementById("axisInfo");
  if (!infoDiv) return;

  const endTrace = startTrace + traceCount - 1;
  const maxTime = Math.round(sampleCount * dtMs);

  let html = `
    <strong>坐标信息：</strong><br>
    X轴（道号）: ${startTrace} - ${endTrace}<br>
    Y轴（时间）: 0 - ${maxTime} ms<br>
    采样点数: ${sampleCount}
  `;

  // 如果有额外信息（如体渲染的切片数）
  if (extraInfo) {
    html += `<br>${extraInfo}`;
  }

  infoDiv.innerHTML = html;
}

// ======================= SEGY 2D 变密度 =======================
async function showDensity3D() {
  const start = parseInt(document.getElementById("segyStart").value, 10);
  const count = parseInt(document.getElementById("segyCount").value, 10);

  try {
    clearAllDisplays();

    const url = `${API}/segy/density?start=${start}&count=${count}&_t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Density API ${res.status}: ${await res.text()}`);
    const blob = await res.blob();

    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, img.width, img.height);

    const W = img.width;
    const H = img.height;

    const decim = Math.max(1, Math.floor(Math.max(W, H) / 300));
    const W2 = Math.floor(W / decim);
    const H2 = Math.floor(H / decim);

    const points = new Float32Array(W2 * H2 * 3);
    const scalars = new Float32Array(W2 * H2);

    for (let j = 0; j < H2; j++) {
      for (let i = 0; i < W2; i++) {
        const srcI = i * decim;
        const srcJ = j * decim;
        const srcIdx = srcJ * W + srcI;
        const dstIdx = j * W2 + i;

        points[dstIdx * 3 + 0] = i / (W2 - 1);
        points[dstIdx * 3 + 1] = (H2 - 1 - j) / (H2 - 1);
        points[dstIdx * 3 + 2] = 0;

        scalars[dstIdx] = imgData.data[srcIdx * 4] / 255.0;
      }
    }

    const nCells = (W2 - 1) * (H2 - 1) * 2;
    const polys = new Uint32Array(nCells * 4);
    let p = 0;
    for (let j = 0; j < H2 - 1; j++) {
      for (let i = 0; i < W2 - 1; i++) {
        const a = j * W2 + i;
        const b = j * W2 + i + 1;
        const c = (j + 1) * W2 + i;
        const d = (j + 1) * W2 + i + 1;
        polys[p++] = 3; polys[p++] = a; polys[p++] = b; polys[p++] = d;
        polys[p++] = 3; polys[p++] = a; polys[p++] = d; polys[p++] = c;
      }
    }

    const polydata = vtk.Common.DataModel.vtkPolyData.newInstance();
    polydata.getPoints().setData(points, 3);
    polydata.getPolys().setData(polys);
    polydata.getPointData().setScalars(
      vtk.Common.Core.vtkDataArray.newInstance({
        name: "density",
        values: scalars,
        numberOfComponents: 1,
      })
    );

    segy2DMapper = vtk.Rendering.Core.vtkMapper.newInstance();
    segy2DMapper.setInputData(polydata);
    segy2DMapper.setScalarRange(0, 1);

    const ctf = buildVTKCTF([0, 1]);
    segy2DMapper.setLookupTable(ctf);

    const actor = vtk.Rendering.Core.vtkActor.newInstance();
    actor.setMapper(segy2DMapper);

    segy2DActor = actor;
    renderer.addActor(segy2DActor);

    // 添加坐标轴
    const dtMs = segyInfo?.dtMicroseconds ? segyInfo.dtMicroseconds / 1000.0 : 1.0;
    const sampleCount = segyInfo?.sampleCount ?? H;
    addAxisLines(start, count, sampleCount, dtMs);

    setCameraPreset("front");
    console.log("变密度显示成功:", { W, H, W2, H2 });

  } catch (e) {
    console.error("showDensity3D failed:", e);
    alert("变密度3D显示失败：" + e.message);
  }
}
// ======================= SEGY 2D 变面积（带填充） =======================
async function showWiggle3D() {
  // 在 try 外读取，确保每次调用都获取最新值
  const start = parseInt(document.getElementById("segyStart").value, 10);
  let count = parseInt(document.getElementById("segyCount").value, 10);
  count = Math.min(Math.max(count, 1), 100);

  console.log("变面积请求参数:", { start, count }); // 调试用

  try {
    clearAllDisplays();

    const url = `${API}/segy/wiggle?start=${start}&count=${count}&maxPoints=800&_t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wiggle API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const { traceCount, sampleCount, polylines } = data;

    for (let i = 0; i < polylines.length; i++) {
      const pts = polylines[i];
      const nPts = pts.length;
      const baseX = i / traceCount;

      const linePoints = new Float32Array(nPts * 3);
      const lines = new Uint32Array(nPts + 1);
      lines[0] = nPts;

      for (let k = 0; k < nPts; k++) {
        const x = pts[k][0] / traceCount;
        const y = 1.0 - pts[k][1] / sampleCount;
        linePoints[k * 3 + 0] = x;
        linePoints[k * 3 + 1] = y;
        linePoints[k * 3 + 2] = 0.001;
        lines[k + 1] = k;
      }

      const linePolydata = vtk.Common.DataModel.vtkPolyData.newInstance();
      linePolydata.getPoints().setData(linePoints, 3);
      linePolydata.getLines().setData(lines);

      const lineMapper = vtk.Rendering.Core.vtkMapper.newInstance();
      lineMapper.setInputData(linePolydata);

      const lineActor = vtk.Rendering.Core.vtkActor.newInstance();
      lineActor.setMapper(lineMapper);
      lineActor.getProperty().setColor(0, 0, 0);
      lineActor.getProperty().setLineWidth(1.2);

      segy2DWiggleActors.push(lineActor);
      renderer.addActor(lineActor);

      const fillTriangles = [];
      const fillPointsList = [];
      let fillPtIdx = 0;

      for (let k = 0; k < nPts - 1; k++) {
        const x0 = pts[k][0] / traceCount;
        const x1 = pts[k + 1][0] / traceCount;
        const y0 = 1.0 - pts[k][1] / sampleCount;
        const y1 = 1.0 - pts[k + 1][1] / sampleCount;

        const pos0 = x0 > baseX + 0.001;
        const pos1 = x1 > baseX + 0.001;

        if (pos0 || pos1) {
          fillPointsList.push(baseX, y0, 0);
          fillPointsList.push(Math.max(x0, baseX), y0, 0);
          fillPointsList.push(Math.max(x1, baseX), y1, 0);
          fillTriangles.push(3, fillPtIdx, fillPtIdx + 1, fillPtIdx + 2);
          fillPtIdx += 3;

          fillPointsList.push(baseX, y0, 0);
          fillPointsList.push(Math.max(x1, baseX), y1, 0);
          fillPointsList.push(baseX, y1, 0);
          fillTriangles.push(3, fillPtIdx, fillPtIdx + 1, fillPtIdx + 2);
          fillPtIdx += 3;
        }
      }

      if (fillPointsList.length > 0) {
        const fillPolydata = vtk.Common.DataModel.vtkPolyData.newInstance();
        fillPolydata.getPoints().setData(new Float32Array(fillPointsList), 3);
        fillPolydata.getPolys().setData(new Uint32Array(fillTriangles));

        const fillMapper = vtk.Rendering.Core.vtkMapper.newInstance();
        fillMapper.setInputData(fillPolydata);

        const fillActor = vtk.Rendering.Core.vtkActor.newInstance();
        fillActor.setMapper(fillMapper);
        fillActor.getProperty().setColor(0, 0, 0);

        segy2DFillActors.push(fillActor);
        renderer.addActor(fillActor);
      }
    }

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

    const dtMs = segyInfo?.dtMicroseconds ? segyInfo.dtMicroseconds / 1000.0 : 1.0;
    addAxisLines(start, traceCount, sampleCount, dtMs);

    setCameraPreset("front");
    console.log("变面积显示成功:", { traceCount, sampleCount });

  } catch (e) {
    console.error("showWiggle3D failed:", e);
    alert("变面积3D显示失败：" + e.message);
  }
}
// ======================= SEGY 3D 体渲染 =======================
async function loadSeismicVolume() {
  const start = parseInt(document.getElementById("segyStart").value, 10);
  const count = parseInt(document.getElementById("segyCount").value, 10);
  const slices = 32;      // 切片数
  const stride = 20;      // 切片间隔
  const sampleDecim = 2;  // 采样降采样

  console.log("体渲染请求参数:", { start, count });

  try {
    clearAllDisplays();

    const url = `${API}/segy/volume?start=${start}&count=${count}&slices=${slices}&stride=${stride}&sampleDecim=${sampleDecim}&_t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Volume API ${res.status}: ${await res.text()}`);

    const dims = res.headers.get("X-Dimensions");
    const spacing = res.headers.get("X-Spacing");
    const range = res.headers.get("X-Range");
    if (!dims || !spacing || !range) {
      throw new Error("缺少响应头：检查后端 CORS expose_headers。");
    }

    const [nx, ny, nz] = dims.split(",").map(Number);
    const [sx, sy, sz] = spacing.split(",").map(Number);
    const [vmin, vmax] = range.split(",").map(Number);
    volumeScalarRange = [vmin, vmax];

    const ab = await res.arrayBuffer();
    const values = new Float32Array(ab);

    const imageData = vtk.Common.DataModel.vtkImageData.newInstance();
    imageData.setDimensions([nx, ny, nz]);
    imageData.setSpacing([sx, sy, sz]);

    const scalars = vtk.Common.Core.vtkDataArray.newInstance({
      name: "amp",
      values,
      numberOfComponents: 1,
    });
    imageData.getPointData().setScalars(scalars);

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

    // 【新增】更新坐标信息
    const dtMs = segyInfo?.dtMicroseconds ? segyInfo.dtMicroseconds / 1000.0 : 1.0;
    const actualSampleCount = ny * sampleDecim; // 还原实际采样点数
    const extraInfo = `Z轴（切片）: ${nz} 层<br>振幅范围: ${vmin.toFixed(2)} ~ ${vmax.toFixed(2)}`;
    updateAnnotationInfo(start, nx, actualSampleCount, dtMs, extraInfo);

    console.log("体渲染加载成功:", { nx, ny, nz, vmin, vmax });

  } catch (e) {
    console.error("loadSeismicVolume failed:", e);
    alert("体渲染失败：请打开F12看 Console 报错。");
  }
}
// ======================= 按钮事件绑定 =======================
document.getElementById("btnDem").onclick = loadDEM;
document.getElementById("btnDensity").onclick = showDensity3D;
document.getElementById("btnWiggle").onclick = showWiggle3D;
document.getElementById("btnVolume").onclick = loadSeismicVolume;

document.getElementById("btnViewIso").onclick = () => setCameraPreset("iso");
document.getElementById("btnViewTop").onclick = () => setCameraPreset("top");
document.getElementById("btnViewFront").onclick = () => setCameraPreset("front");
document.getElementById("btnViewSide").onclick = () => setCameraPreset("side");
document.getElementById("btnResetCam").onclick = () => {
  renderer.resetCamera();
  renderWindow.render();
};

// ======================= 初始化场景 =======================
renderer.getActiveCamera().setPosition(1.2, -1.6, 1.0);
renderer.getActiveCamera().setViewUp(0, 0, 1);
renderer.resetCamera();
renderWindow.render();