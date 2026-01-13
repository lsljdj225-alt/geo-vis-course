/**
 * main.js - 地学数据三维可视化系统
 * 功能：
 * - 本地文件读取（DEM.tif 和 SEGY）
 * - DEM 三维曲面可视化
 * - SEGY 2D：变密度/变面积
 * - SEGY 3D：体渲染
 * - 按钮互斥和 toggle 功能
 * - 性能优化
 */

// ======================= 全局状态管理 =======================
const AppState = {
  // 当前激活的可视化模式：null | 'dem' | 'density' | 'wiggle' | 'volume'
  currentMode: null,

  // 已加载的数据
  demData: null,      // { width, height, data, min, max }
  segyData: null,     // { traces: Float32Array[], sampleCount, traceCount, dt }

  // 文件信息
  demFileName: null,
  segyFileName: null,

  // 渲染相关标志
  isRendering: false,
  renderPending: false,
};

// ======================= vtk.js 初始化 =======================
const fullScreenRenderer = vtk.Rendering.Misc.vtkFullScreenRenderWindow.newInstance({
  rootContainer: document.getElementById("vtkContainer"),
  containerStyle: { height: "100%", width: "100%", position: "relative" },
});
const renderer = fullScreenRenderer.getRenderer();
const renderWindow = fullScreenRenderer.getRenderWindow();
const interactor = renderWindow.getInteractor();

// 设置背景色
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

// ======================= 渲染对象存储 =======================
let demActor = null;
let demMapper = null;
let scalarBarActor = null;
let volumeActor = null;
let volumeMapper = null;
let volumeScalarRange = null;
let segy2DActor = null;
let segy2DMapper = null;
let segy2DWiggleActors = [];
let segy2DFillActors = [];

// ======================= 性能优化：节流渲染 =======================
let renderTimeout = null;
function scheduleRender() {
  if (renderTimeout) return;
  renderTimeout = requestAnimationFrame(() => {
    renderTimeout = null;
    renderWindow.render();
  });
}

// ======================= UI 元素引用 =======================
const btnSelectDem = document.getElementById("btnSelectDem");
const btnSelectSegy = document.getElementById("btnSelectSegy");
const demFileInput = document.getElementById("demFileInput");
const segyFileInput = document.getElementById("segyFileInput");
const demFileNameSpan = document.getElementById("demFileName");
const segyFileNameSpan = document.getElementById("segyFileName");
const loadingOverlay = document.getElementById("loadingOverlay");
const currentModeDiv = document.getElementById("currentMode");
const axisInfoDiv = document.getElementById("axisInfo");

// 可视化按钮
const vizButtons = {
  dem: document.getElementById("btnDem"),
  density: document.getElementById("btnDensity"),
  wiggle: document.getElementById("btnWiggle"),
  volume: document.getElementById("btnVolume"),
};

// ======================= 工具函数 =======================
function showLoading(show = true) {
  loadingOverlay.classList.toggle("hidden", !show);
}

function updateStatus(text) {
  currentModeDiv.innerHTML = text;
}

function updateAxisInfo(text) {
  axisInfoDiv.innerHTML = text;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

// ======================= 清除各类显示 =======================
function removeVolumeIfAny() {
  if (!volumeActor) return;
  try {
    if (renderer.removeVolume) renderer.removeVolume(volumeActor);
    else renderer.removeViewProp(volumeActor);
  } catch (e) {
    console.warn("removeVolume error:", e);
  }
  volumeActor = null;
  volumeMapper = null;
  volumeScalarRange = null;
}

function removeDEMIfAny() {
  if (demActor) {
    renderer.removeActor(demActor);
    demActor = null;
    demMapper = null;
  }
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
  scheduleRender();
}

// ======================= 按钮状态管理 =======================
function updateButtonStates() {
  // DEM 按钮：只有加载了 DEM 数据才启用
  vizButtons.dem.disabled = !AppState.demData;

  // SEGY 相关按钮：只有加载了 SEGY 数据才启用
  vizButtons.density.disabled = !AppState.segyData;
  vizButtons.wiggle.disabled = !AppState.segyData;
  vizButtons.volume.disabled = !AppState.segyData;

  // 更新按钮激活状态
  Object.entries(vizButtons).forEach(([mode, btn]) => {
    btn.classList.toggle("active", AppState.currentMode === mode);
  });
}

function setCurrentMode(mode) {
  if (AppState.currentMode === mode) {
    // 再次点击同一按钮：清除显示
    clearAllDisplays();
    AppState.currentMode = null;
    updateStatus('<div style="text-align:center; color:#9ca3af;">已清除显示</div>');
    updateAxisInfo('<div style="text-align:center; color:#9ca3af;">暂无数据</div>');
  } else {
    // 点击不同按钮：切换模式
    clearAllDisplays();
    AppState.currentMode = mode;
  }
  updateButtonStates();
}

// ======================= 文件选择处理 =======================
btnSelectDem.addEventListener("click", () => demFileInput.click());
btnSelectSegy.addEventListener("click", () => segyFileInput.click());

demFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  showLoading(true);
  try {
    AppState.demData = await readDEMFile(file);
    AppState.demFileName = file.name;
    demFileNameSpan.textContent = file.name;
    demFileNameSpan.classList.add("loaded");
    updateStatus(`<strong>DEM文件已加载：</strong>${file.name}<br>尺寸: ${AppState.demData.width} × ${AppState.demData.height}`);
    console.log("DEM loaded:", AppState.demData);
  } catch (err) {
    console.error("读取DEM失败:", err);
    alert("读取DEM文件失败: " + err.message);
    AppState.demData = null;
    demFileNameSpan.textContent = "读取失败";
  } finally {
    showLoading(false);
    updateButtonStates();
  }
});

segyFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  showLoading(true);
  try {
    AppState.segyData = await readSEGYFile(file);
    AppState.segyFileName = file.name;
    segyFileNameSpan.textContent = file.name;
    segyFileNameSpan.classList.add("loaded");
    updateStatus(`<strong>SEGY文件已加载：</strong>${file.name}<br>道数: ${AppState.segyData.traceCount}, 采样点: ${AppState.segyData.sampleCount}`);
    console.log("SEGY loaded:", AppState.segyData);
  } catch (err) {
    console.error("读取SEGY失败:", err);
    alert("读取SEGY文件失败: " + err.message);
    AppState.segyData = null;
    segyFileNameSpan.textContent = "读取失败";
  } finally {
    showLoading(false);
    updateButtonStates();
  }
});

// ======================= DEM 文件读取 (使用 GeoTIFF.js) =======================
async function readDEMFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const data = await image.readRasters({ interleave: true });

  // 获取第一个波段
  let values;
  if (data instanceof Float32Array || data instanceof Float64Array || data instanceof Uint16Array || data instanceof Int16Array) {
    values = new Float32Array(data);
  } else if (Array.isArray(data) || data.length) {
    values = new Float32Array(data[0] || data);
  } else {
    values = new Float32Array(width * height);
  }

  // 处理无效值
  for (let i = 0; i < values.length; i++) {
    if (!isFinite(values[i]) || values[i] < -1e10 || values[i] > 1e10) {
      values[i] = 0;
    }
  }

  // 计算范围
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }

  return { width, height, data: values, min, max };
}

// ======================= SEGY 文件读取 (纯 JavaScript 解析) =======================
async function readSEGYFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const dataView = new DataView(arrayBuffer);

  // 读取文本头 (3200 bytes) - 跳过
  // 读取二进制头 (400 bytes)
  const binaryHeaderOffset = 3200;

  // 采样间隔 (bytes 16-17, big-endian)
  const dt = dataView.getInt16(binaryHeaderOffset + 16, false);

  // 每道采样数 (bytes 20-21, big-endian)
  const sampleCount = dataView.getInt16(binaryHeaderOffset + 20, false);

  // 数据格式 (bytes 24-25)
  const formatCode = dataView.getInt16(binaryHeaderOffset + 24, false);

  console.log(`SEGY: dt=${dt}μs, samples=${sampleCount}, format=${formatCode}`);

  // 计算道数
  const traceHeaderSize = 240;
  const bytesPerSample = formatCode === 1 ? 4 : (formatCode === 5 ? 4 : 4); // IBM/IEEE float
  const traceDataSize = sampleCount * bytesPerSample;
  const traceSize = traceHeaderSize + traceDataSize;
  const dataStart = 3600;
  const traceCount = Math.floor((arrayBuffer.byteLength - dataStart) / traceSize);

  console.log(`SEGY: ${traceCount} traces detected`);

  // 读取所有道数据
  const traces = [];
  for (let t = 0; t < traceCount; t++) {
    const traceOffset = dataStart + t * traceSize + traceHeaderSize;
    const traceData = new Float32Array(sampleCount);

    for (let s = 0; s < sampleCount; s++) {
      const sampleOffset = traceOffset + s * 4;
      if (formatCode === 1) {
        // IBM 浮点格式
        traceData[s] = ibmToIeee(dataView.getUint32(sampleOffset, false));
      } else {
        // IEEE 浮点格式 (大端)
        traceData[s] = dataView.getFloat32(sampleOffset, false);
      }
    }
    traces.push(traceData);
  }

  return {
    traces,
    traceCount,
    sampleCount,
    dt: dt, // 微秒
  };
}

// IBM 浮点到 IEEE 浮点转换
function ibmToIeee(ibm) {
  if (ibm === 0) return 0;

  const sign = (ibm >>> 31) & 1;
  const exponent = ((ibm >>> 24) & 0x7f) - 64;
  const fraction = (ibm & 0x00ffffff) / 16777216.0;

  if (fraction === 0) return 0;

  const value = fraction * Math.pow(16, exponent);
  return sign ? -value : value;
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

function hexToRgb01(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
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

  // 绘制透明度区域
  cmapCtx.fillStyle = "#f6f6f6";
  cmapCtx.fillRect(0, alphaY0, w, alphaH);

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
    const baseY = colorH - 5;

    // 颜色条上的三角形
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
  for (let i = 0; i < cmap.points.length; i++) {
    if (Math.abs(cmap.points[i].x - x01) < 1e-6) cmap.selected = i;
  }
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
  document.getElementById("ptAlpha").value = String(Math.round(clamp(p.a, 0, 1) * 100));
  document.getElementById("ptAlphaText").innerText = p.a.toFixed(2);
}

// 调色盘事件
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
  if (p) {
    p.color = e.target.value;
    renderCMapEditor();
  }
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

// ======================= 色标 =======================
function ensureScalarBar(lut) {
  const SBA = vtk.Rendering.Annotation?.vtkScalarBarActor;
  if (!SBA || !lut) return;
  if (!scalarBarActor) {
    scalarBarActor = SBA.newInstance();
    scalarBarActor.setAxisLabel("数值");
    scalarBarActor.setDrawNanAnnotation(false);
    renderer.addActor2D(scalarBarActor);
  }
  scalarBarActor.setScalarsToColors(lut);
}

// ======================= 应用调色盘 =======================
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
  scheduleRender();
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
  const name = document.getElementById("lutPreset").value;
  setPreset(name);
  applyCMapToAll();
};

renderCMapEditor();

// ======================= DEM 曲面构建 =======================
function buildDEMSurface() {
  const { width: w, height: h, data: z, min: zmin, max: zmax } = AppState.demData;

  // 降采样以提高性能
  const decimate = Math.max(1, Math.floor(Math.max(w, h) / 300));
  const w2 = Math.floor(w / decimate);
  const h2 = Math.floor(h / decimate);

  // 归一化
  const scaleXY = 1.0 / Math.max(w2, h2);
  const dz = (zmax - zmin) || 1;
  const scaleZ = 0.35 / dz;

  const points = new Float32Array(w2 * h2 * 3);
  const scalars = new Float32Array(w2 * h2);

  for (let j = 0; j < h2; j++) {
    for (let i = 0; i < w2; i++) {
      const srcI = Math.min(i * decimate, w - 1);
      const srcJ = Math.min(j * decimate, h - 1);
      const srcIdx = srcJ * w + srcI;
      const dstIdx = j * w2 + i;

      const zVal = z[srcIdx];
      points[dstIdx * 3 + 0] = (i - w2 / 2) * scaleXY;
      points[dstIdx * 3 + 1] = (j - h2 / 2) * scaleXY;
      points[dstIdx * 3 + 2] = (zVal - zmin) * scaleZ;
      scalars[dstIdx] = zVal;
    }
  }

  // 构建三角形
  const nCells = (w2 - 1) * (h2 - 1) * 2;
  const polys = new Uint32Array(nCells * 4);
  let p = 0;

  for (let j = 0; j < h2 - 1; j++) {
    for (let i = 0; i < w2 - 1; i++) {
      const a = j * w2 + i;
      const b = j * w2 + i + 1;
      const c = (j + 1) * w2 + i;
      const d = (j + 1) * w2 + i + 1;
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
      values: scalars,
      numberOfComponents: 1,
    })
  );

  return { polydata, w2, h2, zmin, zmax };
}

// ======================= 加载 DEM =======================
async function loadDEM() {
  if (!AppState.demData) return;

  showLoading(true);

  // 使用 setTimeout 让 UI 有机会更新
  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    const { polydata, w2, h2, zmin, zmax } = buildDEMSurface();

    demMapper = vtk.Rendering.Core.vtkMapper.newInstance();
    demMapper.setInputData(polydata);
    demMapper.setScalarModeToUsePointData();
    demMapper.setColorModeToMapScalars();
    demMapper.setScalarRange(zmin, zmax);

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
    scheduleRender();

    updateStatus(`<strong>当前模式：</strong>DEM 三维曲面<br>文件：${AppState.demFileName}`);
    updateAxisInfo(`
      <strong>DEM 地形数据：</strong><br>
      原始尺寸: ${AppState.demData.width} × ${AppState.demData.height}<br>
      显示网格: ${w2} × ${h2}<br>
      高程范围: ${zmin.toFixed(2)} ~ ${zmax.toFixed(2)}
    `);

  } catch (e) {
    console.error("loadDEM failed:", e);
    alert("加载DEM失败：" + e.message);
  } finally {
    showLoading(false);
  }
}

// ======================= SEGY 变密度显示 =======================
async function showDensity() {
  if (!AppState.segyData) return;

  const start = parseInt(document.getElementById("segyStart").value, 10) || 0;
  let count = parseInt(document.getElementById("segyCount").value, 10) || 200;
  count = Math.min(count, AppState.segyData.traceCount - start);

  if (count <= 0) {
    alert("无效的道范围");
    return;
  }

  showLoading(true);
  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    const { traces, sampleCount } = AppState.segyData;

    // 提取数据子集
    const data = new Float32Array(count * sampleCount);
    let dmin = Infinity, dmax = -Infinity;

    for (let t = 0; t < count; t++) {
      const trace = traces[start + t];
      for (let s = 0; s < sampleCount; s++) {
        const val = trace[s];
        data[t * sampleCount + s] = val;
        if (val < dmin) dmin = val;
        if (val > dmax) dmax = val;
      }
    }

    // 归一化
    const clip = Math.max(Math.abs(dmin), Math.abs(dmax)) + 1e-6;

    // 降采样
    const decim = Math.max(1, Math.floor(Math.max(count, sampleCount) / 400));
    const W2 = Math.floor(count / decim);
    const H2 = Math.floor(sampleCount / decim);

    const points = new Float32Array(W2 * H2 * 3);
    const scalars = new Float32Array(W2 * H2);

    for (let j = 0; j < H2; j++) {
      for (let i = 0; i < W2; i++) {
        const srcI = i * decim;
        const srcJ = j * decim;
        const dstIdx = j * W2 + i;

        points[dstIdx * 3 + 0] = i / (W2 - 1);
        points[dstIdx * 3 + 1] = 1 - j / (H2 - 1);
        points[dstIdx * 3 + 2] = 0;

        const val = data[srcI * sampleCount + srcJ];
        scalars[dstIdx] = (val + clip) / (2 * clip);
      }
    }

    // 构建网格
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
        name: "amplitude",
        values: scalars,
        numberOfComponents: 1,
      })
    );

    segy2DMapper = vtk.Rendering.Core.vtkMapper.newInstance();
    segy2DMapper.setInputData(polydata);
    segy2DMapper.setScalarRange(0, 1);

    const ctf = buildVTKCTF([0, 1]);
    segy2DMapper.setLookupTable(ctf);

    segy2DActor = vtk.Rendering.Core.vtkActor.newInstance();
    segy2DActor.setMapper(segy2DMapper);
    renderer.addActor(segy2DActor);

    // 添加边框
    addBorder();

    setCameraPreset("front");

    const dtMs = AppState.segyData.dt / 1000;
    updateStatus(`<strong>当前模式：</strong>变密度显示<br>文件：${AppState.segyFileName}`);
    updateAxisInfo(`
      <strong>变密度显示：</strong><br>
      道范围: ${start} - ${start + count - 1}<br>
      采样点: ${sampleCount}<br>
      时间范围: 0 - ${(sampleCount * dtMs).toFixed(1)} ms
    `);

  } catch (e) {
    console.error("showDensity failed:", e);
    alert("变密度显示失败：" + e.message);
  } finally {
    showLoading(false);
  }
}

// ======================= 添加边框 =======================
function addBorder() {
  const borderPoints = new Float32Array([
    0, 0, 0.001,  1, 0, 0.001,  1, 1, 0.001,  0, 1, 0.001,  0, 0, 0.001
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
}

// ======================= SEGY 变面积显示 =======================
async function showWiggle() {
  if (!AppState.segyData) return;

  const start = parseInt(document.getElementById("segyStart").value, 10) || 0;
  let count = parseInt(document.getElementById("segyCount").value, 10) || 50;
  count = Math.min(count, 100, AppState.segyData.traceCount - start);

  if (count <= 0) {
    alert("无效的道范围");
    return;
  }

  showLoading(true);
  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    const { traces, sampleCount } = AppState.segyData;

    // 计算归一化因子
    let maxAbs = 0;
    for (let t = 0; t < count; t++) {
      const trace = traces[start + t];
      for (let s = 0; s < sampleCount; s++) {
        const v = Math.abs(trace[s]);
        if (v > maxAbs) maxAbs = v;
      }
    }
    maxAbs = maxAbs || 1;

    const scale = 0.7 / count;
    const step = Math.max(1, Math.floor(sampleCount / 500));

    // 白色背景
    const bgPoints = new Float32Array([0, 0, -0.002, 1, 0, -0.002, 1, 1, -0.002, 0, 1, -0.002]);
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

    // 绘制每条道
    for (let t = 0; t < count; t++) {
      const trace = traces[start + t];
      const baseX = (t + 0.5) / count;

      // 波形线
      const linePts = [];
      for (let s = 0; s < sampleCount; s += step) {
        const val = trace[s] / maxAbs;
        const x = baseX + val * scale;
        const y = 1 - s / sampleCount;
        linePts.push(x, y, 0.001);
      }

      const linePoints = new Float32Array(linePts);
      const nPts = linePts.length / 3;
      const lines = new Uint32Array(nPts + 1);
      lines[0] = nPts;
      for (let k = 0; k < nPts; k++) lines[k + 1] = k;

      const linePolydata = vtk.Common.DataModel.vtkPolyData.newInstance();
      linePolydata.getPoints().setData(linePoints, 3);
      linePolydata.getLines().setData(lines);

      const lineMapper = vtk.Rendering.Core.vtkMapper.newInstance();
      lineMapper.setInputData(linePolydata);

      const lineActor = vtk.Rendering.Core.vtkActor.newInstance();
      lineActor.setMapper(lineMapper);
      lineActor.getProperty().setColor(0, 0, 0);
      lineActor.getProperty().setLineWidth(1);

      segy2DWiggleActors.push(lineActor);
      renderer.addActor(lineActor);

      // 正半波填充
      const fillPts = [];
      const fillPolys = [];
      let fillIdx = 0;

      for (let s = 0; s < sampleCount - step; s += step) {
        const val0 = trace[s] / maxAbs;
        const val1 = trace[s + step] / maxAbs;

        if (val0 > 0 || val1 > 0) {
          const x0 = baseX + Math.max(0, val0) * scale;
          const x1 = baseX + Math.max(0, val1) * scale;
          const y0 = 1 - s / sampleCount;
          const y1 = 1 - (s + step) / sampleCount;

          fillPts.push(baseX, y0, 0);
          fillPts.push(x0, y0, 0);
          fillPts.push(x1, y1, 0);
          fillPts.push(baseX, y1, 0);

          fillPolys.push(4, fillIdx, fillIdx + 1, fillIdx + 2, fillIdx + 3);
          fillIdx += 4;
        }
      }

      if (fillPts.length > 0) {
        const fillPolydata = vtk.Common.DataModel.vtkPolyData.newInstance();
        fillPolydata.getPoints().setData(new Float32Array(fillPts), 3);
        fillPolydata.getPolys().setData(new Uint32Array(fillPolys));

        const fillMapper = vtk.Rendering.Core.vtkMapper.newInstance();
        fillMapper.setInputData(fillPolydata);

        const fillActor = vtk.Rendering.Core.vtkActor.newInstance();
        fillActor.setMapper(fillMapper);
        fillActor.getProperty().setColor(0, 0, 0);

        segy2DFillActors.push(fillActor);
        renderer.addActor(fillActor);
      }
    }

    addBorder();
    setCameraPreset("front");

    const dtMs = AppState.segyData.dt / 1000;
    updateStatus(`<strong>当前模式：</strong>变面积显示<br>文件：${AppState.segyFileName}`);
    updateAxisInfo(`
      <strong>变面积显示：</strong><br>
      道范围: ${start} - ${start + count - 1}<br>
      采样点: ${sampleCount}<br>
      时间范围: 0 - ${(sampleCount * dtMs).toFixed(1)} ms
    `);

  } catch (e) {
    console.error("showWiggle failed:", e);
    alert("变面积显示失败：" + e.message);
  } finally {
    showLoading(false);
  }
}

// ======================= SEGY 体渲染 =======================
async function showVolume() {
  if (!AppState.segyData) return;

  const start = parseInt(document.getElementById("segyStart").value, 10) || 0;
  let count = parseInt(document.getElementById("segyCount").value, 10) || 100;
  count = Math.min(count, AppState.segyData.traceCount - start);

  if (count <= 0) {
    alert("无效的道范围");
    return;
  }

  showLoading(true);
  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    const { traces, sampleCount } = AppState.segyData;

    // 构建 3D 体：使用多个切片
    const slices = 32;
    const stride = Math.max(1, Math.floor(count / slices));
    const sampleDecim = 2;

    const nx = Math.min(count, 128);
    const ny = Math.floor(sampleCount / sampleDecim);
    const nz = Math.min(slices, Math.floor(count / stride));

    const volume = new Float32Array(nx * ny * nz);
    let vmin = Infinity, vmax = -Infinity;

    for (let z = 0; z < nz; z++) {
      const traceStart = start + z * stride;
      for (let x = 0; x < nx; x++) {
        const traceIdx = Math.min(traceStart + x, AppState.segyData.traceCount - 1);
        const trace = traces[traceIdx];
        for (let y = 0; y < ny; y++) {
          const sampleIdx = y * sampleDecim;
          const val = trace[sampleIdx] || 0;
          const idx = z * nx * ny + y * nx + x;
          volume[idx] = val;
          if (val < vmin) vmin = val;
          if (val > vmax) vmax = val;
        }
      }
    }

    // 裁剪极值
    const clip = Math.max(Math.abs(vmin), Math.abs(vmax)) * 0.99 + 1e-6;
    for (let i = 0; i < volume.length; i++) {
      volume[i] = clamp(volume[i], -clip, clip);
    }
    vmin = -clip;
    vmax = clip;
    volumeScalarRange = [vmin, vmax];

    const imageData = vtk.Common.DataModel.vtkImageData.newInstance();
    imageData.setDimensions([nx, ny, nz]);
    imageData.setSpacing([1, 1, 1]);

    const scalars = vtk.Common.Core.vtkDataArray.newInstance({
      name: "amplitude",
      values: volume,
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
    scheduleRender();

    const dtMs = AppState.segyData.dt / 1000;
    updateStatus(`<strong>当前模式：</strong>体渲染<br>文件：${AppState.segyFileName}`);
    updateAxisInfo(`
      <strong>体渲染：</strong><br>
      体积尺寸: ${nx} × ${ny} × ${nz}<br>
      道范围: ${start} - ${start + count - 1}<br>
      振幅范围: ${vmin.toFixed(2)} ~ ${vmax.toFixed(2)}
    `);

  } catch (e) {
    console.error("showVolume failed:", e);
    alert("体渲染失败：" + e.message);
  } finally {
    showLoading(false);
  }
}

// ======================= 相机预设 =======================
function setCameraPreset(name) {
  const cam = renderer.getActiveCamera();
  switch (name) {
    case "top":
      cam.setPosition(0.5, 0.5, 3);
      cam.setViewUp(0, 1, 0);
      cam.setFocalPoint(0.5, 0.5, 0);
      break;
    case "front":
      cam.setPosition(0.5, -2, 0.5);
      cam.setViewUp(0, 0, 1);
      cam.setFocalPoint(0.5, 0.5, 0);
      break;
    case "side":
      cam.setPosition(3, 0.5, 0.5);
      cam.setViewUp(0, 0, 1);
      cam.setFocalPoint(0.5, 0.5, 0);
      break;
    default: // iso
      cam.setPosition(1.5, -1.5, 1.5);
      cam.setViewUp(0, 0, 1);
      cam.setFocalPoint(0.5, 0.5, 0);
  }
  renderer.resetCamera();
  scheduleRender();
}

// ======================= 可视化按钮事件 =======================
Object.entries(vizButtons).forEach(([mode, btn]) => {
  btn.addEventListener("click", async () => {
    const wasActive = AppState.currentMode === mode;
    setCurrentMode(mode);

    if (!wasActive && AppState.currentMode === mode) {
      switch (mode) {
        case "dem": await loadDEM(); break;
        case "density": await showDensity(); break;
        case "wiggle": await showWiggle(); break;
        case "volume": await showVolume(); break;
      }
    }
    updateButtonStates();
  });
});

// ======================= 视角按钮事件 =======================
document.getElementById("btnViewIso").onclick = () => setCameraPreset("iso");
document.getElementById("btnViewTop").onclick = () => setCameraPreset("top");
document.getElementById("btnViewFront").onclick = () => setCameraPreset("front");
document.getElementById("btnViewSide").onclick = () => setCameraPreset("side");
document.getElementById("btnResetCam").onclick = () => {
  renderer.resetCamera();
  scheduleRender();
};

// ======================= 初始化 =======================
renderer.getActiveCamera().setPosition(1.2, -1.6, 1.0);
renderer.getActiveCamera().setViewUp(0, 0, 1);
renderer.resetCamera();
scheduleRender();
updateButtonStates();

console.log("地学数据三维可视化系统已初始化");