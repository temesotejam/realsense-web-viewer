const $ = (id) => document.getElementById(id);

const canvas = $("viewerCanvas");
const ctx = canvas.getContext("2d", { alpha: false });

const ui = {
  badge: $("connectionBadge"),
  model: $("deviceModel"),
  status: $("deviceStatus"),
  fps: $("fpsValue"),
  t265Controls: $("t265Controls"),
  d400Controls: $("d400Controls"),
  liveControls: $("liveControls"),
  posX: $("posX"),
  posY: $("posY"),
  posZ: $("posZ"),
  roll: $("rollValue"),
  pitch: $("pitchValue"),
  yaw: $("yawValue"),
  velocity: $("velocityValue"),
  confidence: $("confidenceValue"),
  viewerTitle: $("viewerTitle"),
  viewerSubtitle: $("viewerSubtitle"),
  overlay: $("overlayText"),
  statusMode: $("statusMode"),
  frames: $("frameCount"),
  transport: $("transportValue"),
  pause: $("pauseButton"),
  bridgeUrl: $("bridgeUrl"),
  connectBridge: $("connectBridge"),
  bridgeHint: $("bridgeHint"),
  depthRange: $("depthRange"),
  depthRangeLabel: $("depthRangeLabel"),
  probeX: $("probeX"),
  probeY: $("probeY"),
  probeDepth: $("probeDepth"),
};

const state = {
  mode: "t265",
  paused: false,
  frameCount: 0,
  lastFrameTime: performance.now(),
  fps: 60,
  demoStart: performance.now(),
  trajectory: [],
  origin: { x: 0, y: 0, z: 0 },
  pose: {
    x: 0, y: 0, z: 0,
    roll: 0, pitch: 0, yaw: 0,
    vx: 0, vy: 0, vz: 0,
    confidence: 3,
  },
  view: { yaw: -0.65, pitch: 0.42, zoom: 1.0 },
  drag: null,
  depthRangeM: 4,
  depthFrame: null,
  probe: null,
  socket: null,
  liveStream: null,
};

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function confidenceName(value) {
  return ["FAILED", "LOW", "MEDIUM", "HIGH"][Math.max(0, Math.min(3, Number(value) || 0))];
}

function setBadge(text, kind = "demo") {
  ui.badge.textContent = text;
  ui.badge.className = `badge badge-${kind}`;
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  ui.t265Controls.hidden = mode !== "t265";
  ui.d400Controls.hidden = mode !== "d400";
  ui.liveControls.hidden = mode !== "live";
  state.probe = null;

  if (mode === "t265") {
    closeSocket();
    setBadge("DEMO", "demo");
    ui.model.textContent = "T265 demo";
    ui.status.textContent = "Simulated";
    ui.viewerTitle.textContent = "T265 · 6DoF trajectory";
    ui.viewerSubtitle.textContent = "drag to orbit · wheel to zoom";
    ui.overlay.textContent = "Simulated tracking stream";
    ui.statusMode.textContent = "T265 DEMO";
    ui.transport.textContent = "INTERNAL";
    state.liveStream = null;
  } else if (mode === "d400") {
    closeSocket();
    setBadge("DEMO", "demo");
    ui.model.textContent = "D435/D455 demo";
    ui.status.textContent = "Simulated";
    ui.viewerTitle.textContent = "D400 · Depth colorizer";
    ui.viewerSubtitle.textContent = "move pointer to probe distance";
    ui.overlay.textContent = "Synthetic 16-bit depth frame";
    ui.statusMode.textContent = "D400 DEMO";
    ui.transport.textContent = "INTERNAL";
    state.liveStream = null;
  } else {
    setBadge("OFFLINE", "error");
    ui.model.textContent = "Waiting for bridge";
    ui.status.textContent = "Disconnected";
    ui.viewerTitle.textContent = "Live bridge";
    ui.viewerSubtitle.textContent = "pose and depth protocol ready";
    ui.overlay.textContent = "Connect a local librealsense bridge";
    ui.statusMode.textContent = "LIVE";
    ui.transport.textContent = "WEBSOCKET";
  }
}

function updatePoseReadouts(pose) {
  const x = pose.x - state.origin.x;
  const y = pose.y - state.origin.y;
  const z = pose.z - state.origin.z;
  ui.posX.textContent = `${x.toFixed(3)} m`;
  ui.posY.textContent = `${y.toFixed(3)} m`;
  ui.posZ.textContent = `${z.toFixed(3)} m`;
  ui.roll.textContent = `${(pose.roll * 180 / Math.PI).toFixed(1)}°`;
  ui.pitch.textContent = `${(pose.pitch * 180 / Math.PI).toFixed(1)}°`;
  ui.yaw.textContent = `${(pose.yaw * 180 / Math.PI).toFixed(1)}°`;
  const speed = Math.hypot(pose.vx || 0, pose.vy || 0, pose.vz || 0);
  ui.velocity.textContent = `${speed.toFixed(3)} m/s`;
  ui.confidence.textContent = confidenceName(pose.confidence);
}

function demoPose(timeSec) {
  const w = 0.36;
  const x = 1.15 * Math.sin(w * timeSec);
  const y = 0.18 * Math.sin(w * 1.8 * timeSec + 0.5);
  const z = 0.82 * Math.cos(w * timeSec) + 0.25 * Math.sin(w * 0.45 * timeSec);
  const vx = 1.15 * w * Math.cos(w * timeSec);
  const vy = 0.18 * w * 1.8 * Math.cos(w * 1.8 * timeSec + 0.5);
  const vz = -0.82 * w * Math.sin(w * timeSec) + 0.25 * w * 0.45 * Math.cos(w * 0.45 * timeSec);
  const yaw = Math.atan2(vx, Math.max(1e-6, vz));
  const pitch = 0.10 * Math.sin(timeSec * 0.7);
  const roll = 0.16 * Math.sin(timeSec * 0.95);
  return { x, y, z, vx, vy, vz, roll, pitch, yaw, confidence: 3 };
}

function appendTrajectory(pose) {
  const p = {
    x: pose.x - state.origin.x,
    y: pose.y - state.origin.y,
    z: pose.z - state.origin.z,
  };
  const last = state.trajectory[state.trajectory.length - 1];
  if (!last || Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) > 0.006) {
    state.trajectory.push(p);
    if (state.trajectory.length > 3000) state.trajectory.shift();
  }
}

function rotateView(point) {
  const { yaw, pitch, zoom } = state.view;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  const x1 = point.x * cy - point.z * sy;
  const z1 = point.x * sy + point.z * cy;
  const y1 = point.y;

  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;
  return { x: x1 * zoom, y: y2 * zoom, z: z2 * zoom };
}

function project(point) {
  const p = rotateView({ x: point.x, y: -point.y, z: point.z });
  const w = canvas.width;
  const h = canvas.height;
  const cameraDistance = 5.2;
  const denom = Math.max(1.1, cameraDistance + p.z);
  const scale = Math.min(w, h) * 0.62 / denom;
  return {
    x: w * 0.5 + p.x * scale,
    y: h * 0.54 - p.y * scale,
    depth: denom,
  };
}

function line3d(a, b, color, width = 1, alpha = 1) {
  const pa = project(a);
  const pb = project(b);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pa.x, pa.y);
  ctx.lineTo(pb.x, pb.y);
  ctx.stroke();
  ctx.restore();
}

function drawGrid() {
  ctx.fillStyle = "#05080b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const extent = 2.5;
  const step = 0.25;
  for (let v = -extent; v <= extent + 1e-6; v += step) {
    const major = Math.abs(v % 1) < 1e-4;
    line3d({ x: -extent, y: 0.65, z: v }, { x: extent, y: 0.65, z: v }, major ? "#1b2c36" : "#101a21", major ? 1.5 : 1);
    line3d({ x: v, y: 0.65, z: -extent }, { x: v, y: 0.65, z: extent }, major ? "#1b2c36" : "#101a21", major ? 1.5 : 1);
  }

  line3d({ x: 0, y: 0.65, z: 0 }, { x: 0.65, y: 0.65, z: 0 }, "#ff6b6b", 2.3);
  line3d({ x: 0, y: 0.65, z: 0 }, { x: 0, y: 0.00, z: 0 }, "#7ee787", 2.3);
  line3d({ x: 0, y: 0.65, z: 0 }, { x: 0, y: 0.65, z: 0.65 }, "#62a8ff", 2.3);

  drawAxisLabel("X", { x: 0.72, y: 0.65, z: 0 }, "#ff8d8d");
  drawAxisLabel("Y", { x: 0, y: -0.08, z: 0 }, "#9ef0aa");
  drawAxisLabel("Z", { x: 0, y: 0.65, z: 0.72 }, "#87bdff");
}

function drawAxisLabel(text, point, color) {
  const p = project(point);
  ctx.fillStyle = color;
  ctx.font = `${Math.max(11, canvas.width / 90)}px ui-monospace, monospace`;
  ctx.fillText(text, p.x, p.y);
}

function eulerBasis(roll, pitch, yaw) {
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const rotate = (v) => ({
    x: v.x * (cy * cr + sy * sp * sr) + v.y * (-cy * sr + sy * sp * cr) + v.z * (sy * cp),
    y: v.x * (cp * sr) + v.y * (cp * cr) + v.z * (-sp),
    z: v.x * (-sy * cr + cy * sp * sr) + v.y * (sy * sr + cy * sp * cr) + v.z * (cy * cp),
  });
  return {
    right: rotate({ x: 1, y: 0, z: 0 }),
    down: rotate({ x: 0, y: 1, z: 0 }),
    forward: rotate({ x: 0, y: 0, z: 1 }),
  };
}

function plus(a, b, scale = 1) {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

function drawCamera(pose) {
  const center = {
    x: pose.x - state.origin.x,
    y: pose.y - state.origin.y,
    z: pose.z - state.origin.z,
  };
  const basis = eulerBasis(pose.roll, pose.pitch, pose.yaw);
  const tip = plus(center, basis.forward, 0.28);
  const rear = plus(center, basis.forward, -0.10);
  const l = plus(rear, basis.right, -0.14);
  const r = plus(rear, basis.right, 0.14);
  const lt = plus(l, basis.down, -0.07);
  const lb = plus(l, basis.down, 0.07);
  const rt = plus(r, basis.down, -0.07);
  const rb = plus(r, basis.down, 0.07);

  const color = "#53d6ff";
  [lt, lb, rt, rb].forEach((corner) => line3d(corner, tip, color, 2));
  line3d(lt, rt, color, 2);
  line3d(rt, rb, color, 2);
  line3d(rb, lb, color, 2);
  line3d(lb, lt, color, 2);
  line3d(center, plus(center, basis.right, 0.30), "#ff6b6b", 2);
  line3d(center, plus(center, basis.down, 0.30), "#7ee787", 2);
  line3d(center, plus(center, basis.forward, 0.38), "#62a8ff", 2);

  const p = project(center);
  ctx.fillStyle = "#dff8ff";
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(3, canvas.width / 260), 0, Math.PI * 2);
  ctx.fill();
}

function drawTrajectory() {
  if (state.trajectory.length < 2) return;
  ctx.save();
  ctx.strokeStyle = "#9ff36b";
  ctx.lineWidth = Math.max(1.2, canvas.width / 700);
  ctx.beginPath();
  state.trajectory.forEach((point, index) => {
    const p = project(point);
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawT265() {
  drawGrid();
  drawTrajectory();
  drawCamera(state.pose);
}

function depthColor(depthM, maxM) {
  if (!Number.isFinite(depthM) || depthM <= 0 || depthM > maxM) return [5, 8, 11];
  const t = Math.max(0, Math.min(1, depthM / maxM));
  const stops = [
    [0.00, 32, 8, 76],
    [0.20, 39, 63, 181],
    [0.42, 18, 166, 197],
    [0.64, 68, 218, 116],
    [0.82, 237, 217, 72],
    [1.00, 244, 88, 48],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const u = (t - a[0]) / (b[0] - a[0]);
      return [
        Math.round(a[1] + (b[1] - a[1]) * u),
        Math.round(a[2] + (b[2] - a[2]) * u),
        Math.round(a[3] + (b[3] - a[3]) * u),
      ];
    }
  }
  return stops[stops.length - 1].slice(1);
}

function syntheticDepth(x, y, width, height, timeSec) {
  const nx = (x / width - 0.5) * 2;
  const ny = (y / height - 0.5) * 2;
  let depth = 2.3 + 0.65 * nx + 0.24 * Math.sin(ny * 5 + timeSec * 0.35);

  const cx1 = -0.32 + 0.08 * Math.sin(timeSec * 0.55);
  const cy1 = -0.08;
  const d1 = Math.hypot(nx - cx1, ny - cy1);
  if (d1 < 0.32) depth = Math.min(depth, 0.85 + d1 * 0.8);

  const cx2 = 0.38;
  const cy2 = 0.22 + 0.05 * Math.cos(timeSec * 0.4);
  const d2 = Math.hypot(nx - cx2, ny - cy2);
  if (d2 < 0.25) depth = Math.min(depth, 1.35 + d2 * 1.15);

  return Math.max(0.18, depth);
}

function renderDepthPixels(width, height, getter) {
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const maxM = state.depthRangeM;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const depthM = getter(x, y);
      const [r, g, b] = depthColor(depthM, maxM);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return image;
}

function drawDepth(timeSec) {
  const sampleW = Math.min(400, Math.max(160, Math.round(canvas.width / 3)));
  const sampleH = Math.max(120, Math.round(sampleW * 0.75));
  let getter;
  let sourceW = sampleW;
  let sourceH = sampleH;

  if (state.mode === "live" && state.depthFrame) {
    const frame = state.depthFrame;
    sourceW = frame.width;
    sourceH = frame.height;
    getter = (x, y) => {
      const sx = Math.min(frame.width - 1, Math.floor(x / sampleW * frame.width));
      const sy = Math.min(frame.height - 1, Math.floor(y / sampleH * frame.height));
      return frame.data[sy * frame.width + sx] * frame.scaleM;
    };
  } else {
    getter = (x, y) => syntheticDepth(x, y, sampleW, sampleH, timeSec);
  }

  const image = renderDepthPixels(sampleW, sampleH, getter);
  const temp = document.createElement("canvas");
  temp.width = sampleW;
  temp.height = sampleH;
  temp.getContext("2d").putImageData(image, 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(temp, 0, 0, canvas.width, canvas.height);

  if (state.probe) {
    const px = state.probe.x * canvas.width;
    const py = state.probe.y * canvas.height;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, 9 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - 15, py); ctx.lineTo(px + 15, py);
    ctx.moveTo(px, py - 15); ctx.lineTo(px, py + 15);
    ctx.stroke();

    let depthM;
    if (state.mode === "live" && state.depthFrame) {
      const frame = state.depthFrame;
      const sx = Math.min(frame.width - 1, Math.floor(state.probe.x * frame.width));
      const sy = Math.min(frame.height - 1, Math.floor(state.probe.y * frame.height));
      depthM = frame.data[sy * frame.width + sx] * frame.scaleM;
      ui.probeX.textContent = String(sx);
      ui.probeY.textContent = String(sy);
    } else {
      const sx = Math.min(sampleW - 1, Math.floor(state.probe.x * sampleW));
      const sy = Math.min(sampleH - 1, Math.floor(state.probe.y * sampleH));
      depthM = syntheticDepth(sx, sy, sampleW, sampleH, timeSec);
      ui.probeX.textContent = String(sx);
      ui.probeY.textContent = String(sy);
    }
    ui.probeDepth.textContent = Number.isFinite(depthM) && depthM > 0 ? `${depthM.toFixed(3)} m` : "invalid";
  }
}

function updateFps(now) {
  const dt = now - state.lastFrameTime;
  if (dt > 0) {
    const instantaneous = 1000 / dt;
    state.fps = state.fps * 0.92 + instantaneous * 0.08;
  }
  state.lastFrameTime = now;
  ui.fps.textContent = state.fps.toFixed(1);
}

function animationLoop(now) {
  resizeCanvas();
  updateFps(now);

  if (!state.paused) {
    if (state.mode === "t265") {
      const t = (now - state.demoStart) / 1000;
      state.pose = demoPose(t);
      appendTrajectory(state.pose);
      updatePoseReadouts(state.pose);
    }
    state.frameCount++;
    ui.frames.textContent = String(state.frameCount);
  }

  if (state.mode === "d400") {
    drawDepth((now - state.demoStart) / 1000);
  } else if (state.mode === "live" && state.liveStream === "depth") {
    drawDepth((now - state.demoStart) / 1000);
  } else {
    drawT265();
  }

  requestAnimationFrame(animationLoop);
}

function resetOrigin() {
  state.origin = { x: state.pose.x, y: state.pose.y, z: state.pose.z };
  state.trajectory = [];
}

function clearTrail() {
  state.trajectory = [];
}

function quaternionToEuler(qx, qy, qz, qw) {
  const sinr = 2 * (qw * qx + qy * qz);
  const cosr = 1 - 2 * (qx * qx + qy * qy);
  const roll = Math.atan2(sinr, cosr);

  const sinp = 2 * (qw * qy - qz * qx);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);

  const siny = 2 * (qw * qz + qx * qy);
  const cosy = 1 - 2 * (qy * qy + qz * qz);
  const yaw = Math.atan2(siny, cosy);
  return { roll, pitch, yaw };
}

function decodeDepthBase64(message) {
  const binary = atob(message.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const length = Math.min(message.width * message.height, Math.floor(bytes.length / 2));
  const values = new Uint16Array(length);
  for (let i = 0; i < length; i++) values[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  if (length !== message.width * message.height) throw new Error("Depth payload size does not match width × height");
  return {
    width: message.width,
    height: message.height,
    data: values,
    scaleM: Number(message.depth_scale_m ?? 0.001),
  };
}

function handleBridgeMessage(message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "hello" || message.type === "device") {
    ui.model.textContent = message.model || message.name || "RealSense";
    ui.status.textContent = "Streaming";
    return;
  }

  if (message.type === "pose") {
    const position = message.position || {};
    const velocity = message.velocity || {};
    let orientation = message.euler || {};
    if (message.quaternion) {
      const q = message.quaternion;
      orientation = quaternionToEuler(Number(q.x || 0), Number(q.y || 0), Number(q.z || 0), Number(q.w ?? 1));
    }
    state.pose = {
      x: Number(position.x || 0),
      y: Number(position.y || 0),
      z: Number(position.z || 0),
      vx: Number(velocity.x || 0),
      vy: Number(velocity.y || 0),
      vz: Number(velocity.z || 0),
      roll: Number(orientation.roll || 0),
      pitch: Number(orientation.pitch || 0),
      yaw: Number(orientation.yaw || 0),
      confidence: Number(message.tracker_confidence ?? message.confidence ?? 0),
    };
    state.liveStream = "pose";
    ui.t265Controls.hidden = false;
    ui.d400Controls.hidden = true;
    appendTrajectory(state.pose);
    updatePoseReadouts(state.pose);
    ui.viewerTitle.textContent = "Live · T265 pose";
    ui.overlay.textContent = "Live 6DoF tracking stream";
    ui.statusMode.textContent = "T265 LIVE";
    return;
  }

  if (message.type === "depth") {
    state.depthFrame = decodeDepthBase64(message);
    state.liveStream = "depth";
    ui.t265Controls.hidden = true;
    ui.d400Controls.hidden = false;
    ui.viewerTitle.textContent = "Live · D400 depth";
    ui.overlay.textContent = `${message.width} × ${message.height} depth stream`;
    ui.statusMode.textContent = "D400 LIVE";
  }
}

function closeSocket() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }
}

function connectBridge() {
  closeSocket();
  const url = ui.bridgeUrl.value.trim();
  if (!url) return;

  ui.connectBridge.disabled = true;
  ui.connectBridge.textContent = "Connecting…";
  ui.status.textContent = "Connecting";
  setBadge("CONNECTING", "demo");

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    ui.connectBridge.disabled = false;
    ui.connectBridge.textContent = "Connect";
    ui.status.textContent = "Invalid endpoint";
    ui.bridgeHint.textContent = error.message;
    setBadge("ERROR", "error");
    return;
  }

  state.socket = socket;
  socket.onopen = () => {
    ui.connectBridge.disabled = false;
    ui.connectBridge.textContent = "Disconnect";
    ui.status.textContent = "Connected";
    ui.bridgeHint.textContent = "Bridge connected. Waiting for device/pose/depth messages.";
    setBadge("LIVE", "live");
    socket.send(JSON.stringify({ type: "viewer_hello", protocol: 1, viewer: "realsense-web-viewer" }));
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    try {
      handleBridgeMessage(JSON.parse(event.data));
    } catch (error) {
      ui.bridgeHint.textContent = `Ignored invalid bridge message: ${error.message}`;
    }
  };

  socket.onerror = () => {
    ui.status.textContent = "Connection error";
    setBadge("ERROR", "error");
  };

  socket.onclose = () => {
    if (state.socket === socket) state.socket = null;
    ui.connectBridge.disabled = false;
    ui.connectBridge.textContent = "Connect";
    ui.status.textContent = "Disconnected";
    if (state.mode === "live") setBadge("OFFLINE", "error");
  };
}

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

$("resetOrigin").addEventListener("click", resetOrigin);
$("clearTrail").addEventListener("click", clearTrail);
ui.pause.addEventListener("click", () => {
  state.paused = !state.paused;
  ui.pause.textContent = state.paused ? "Resume" : "Pause";
});
ui.depthRange.addEventListener("input", () => {
  state.depthRangeM = Number(ui.depthRange.value);
  ui.depthRangeLabel.textContent = `${state.depthRangeM.toFixed(1)} m`;
});
ui.connectBridge.addEventListener("click", () => {
  if (state.socket) closeSocket();
  else connectBridge();
});

canvas.addEventListener("pointerdown", (event) => {
  if (state.mode === "d400" || (state.mode === "live" && state.liveStream === "depth")) return;
  canvas.setPointerCapture(event.pointerId);
  state.drag = { x: event.clientX, y: event.clientY, yaw: state.view.yaw, pitch: state.view.pitch };
});
canvas.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const nx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));

  if (state.mode === "d400" || (state.mode === "live" && state.liveStream === "depth")) {
    state.probe = { x: nx, y: ny };
    return;
  }

  if (state.drag) {
    state.view.yaw = state.drag.yaw + (event.clientX - state.drag.x) * 0.007;
    state.view.pitch = Math.max(-1.35, Math.min(1.35, state.drag.pitch + (event.clientY - state.drag.y) * 0.006));
  }
});
canvas.addEventListener("pointerup", () => { state.drag = null; });
canvas.addEventListener("pointercancel", () => { state.drag = null; });
canvas.addEventListener("wheel", (event) => {
  if (state.mode === "d400" || (state.mode === "live" && state.liveStream === "depth")) return;
  event.preventDefault();
  state.view.zoom = Math.max(0.35, Math.min(3.2, state.view.zoom * Math.exp(-event.deltaY * 0.001)));
}, { passive: false });

window.addEventListener("beforeunload", closeSocket);
window.addEventListener("resize", resizeCanvas);

setMode("t265");
requestAnimationFrame(animationLoop);
