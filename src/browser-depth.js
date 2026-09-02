const $ = (id) => document.getElementById(id);

const d400Controls = $("d400Controls");
const viewerCanvas = $("viewerCanvas");
const canvasShell = document.querySelector(".canvas-shell");

if (!d400Controls || !viewerCanvas || !canvasShell) {
  console.warn("Browser depth module: required viewer elements are missing.");
} else {
  installBrowserDepthStyles();
  installBrowserDepthControls();
  startBrowserDepthController();
}

function installBrowserDepthStyles() {
  const style = document.createElement("style");
  style.textContent = `
    #browserDepthCanvas {
      position: absolute;
      inset: 0;
      display: none;
      width: 100%;
      height: 100%;
      background: #05080b;
      cursor: crosshair;
      z-index: 1;
    }
    .canvas-overlay { z-index: 2; }
    .browser-depth-block {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .browser-depth-select,
    .browser-depth-number {
      width: 100%;
      color: #dbe8f5;
      background: #080d12;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px;
      font-size: 0.72rem;
    }
    .browser-depth-select { margin-bottom: 8px; }
    .browser-depth-number {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      margin-bottom: 4px;
    }
    .browser-depth-state {
      min-height: 1.2em;
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 0.7rem;
      line-height: 1.4;
    }
    .browser-depth-state.ok { color: var(--accent-2); }
    .browser-depth-state.error { color: #ff8d8d; }
    .diagnostic-links {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .diagnostic-links a {
      color: var(--accent);
      font-size: 0.68rem;
      text-decoration: none;
    }
  `;
  document.head.appendChild(style);
}

function installBrowserDepthControls() {
  const list = d400Controls.querySelector(".readout-list");
  if (list && !$("probeRawZ16")) {
    const row = document.createElement("div");
    row.innerHTML = '<dt>Raw Z16</dt><dd id="probeRawZ16">—</dd>';
    list.appendChild(row);
  }

  const block = document.createElement("div");
  block.className = "browser-depth-block";
  block.innerHTML = `
    <h2>Direct USB</h2>
    <label class="field-label" for="browserDepthDevice">Browser-visible RealSense Depth input</label>
    <select id="browserDepthDevice" class="browser-depth-select">
      <option value="">Refresh to find cameras</option>
    </select>
    <div class="button-row">
      <button id="browserDepthRefresh" class="secondary">Refresh USB</button>
      <button id="browserDepthStart" class="primary">Start Depth</button>
    </div>
    <label class="field-label" for="browserDepthScale" style="margin-top:10px">Depth scale (m / Z16 unit)</label>
    <input id="browserDepthScale" class="browser-depth-number" type="number" value="0.001" min="0.000001" max="0.1" step="0.000001" />
    <p id="browserDepthState" class="browser-depth-state">Chrome/Edge: UVC → WebGL R32F. Default scale 0.001 m/unit is provisional and editable.</p>
    <div class="diagnostic-links">
      <a href="./depth-float-probe.html">Z16 diagnostic</a>
      <a href="./uvc-scan.html">UVC scan</a>
      <a href="./webusb-probe.html">WebUSB probe</a>
    </div>
  `;
  d400Controls.appendChild(block);

  const liveCanvas = document.createElement("canvas");
  liveCanvas.id = "browserDepthCanvas";
  liveCanvas.setAttribute("aria-label", "Live RealSense depth colorizer");
  canvasShell.insertBefore(liveCanvas, $("canvasOverlay"));
}

function startBrowserDepthController() {
  const ui = {
    device: $("browserDepthDevice"),
    refresh: $("browserDepthRefresh"),
    start: $("browserDepthStart"),
    scale: $("browserDepthScale"),
    state: $("browserDepthState"),
    liveCanvas: $("browserDepthCanvas"),
    range: $("depthRange"),
    rangeLabel: $("depthRangeLabel"),
    probeX: $("probeX"),
    probeY: $("probeY"),
    probeDepth: $("probeDepth"),
    probeRaw: $("probeRawZ16"),
    badge: $("connectionBadge"),
    model: $("deviceModel"),
    deviceStatus: $("deviceStatus"),
    viewerTitle: $("viewerTitle"),
    viewerSubtitle: $("viewerSubtitle"),
    overlay: $("overlayText"),
    statusMode: $("statusMode"),
    transport: $("transportValue"),
    pause: $("pauseButton"),
  };

  const direct = {
    active: false,
    stream: null,
    video: null,
    pipeline: null,
    frameCallbackId: null,
    fallbackTimer: null,
    label: "",
    probe: null,
    mediaFrameCount: 0,
    lastMediaTime: null,
    cameraFps: 0,
  };

  ui.refresh.addEventListener("click", () => refreshDepthDevices(ui));
  ui.start.addEventListener("click", async () => {
    if (direct.active) stopDirectDepth(direct, ui, true);
    else await startDirectDepth(direct, ui);
  });
  ui.scale.addEventListener("input", () => {
    const value = depthScale(ui);
    if (direct.pipeline) direct.pipeline.scaleM = value;
    if (direct.active) updateProbe(direct, ui);
  });
  ui.range.addEventListener("input", () => {
    if (direct.pipeline) direct.pipeline.maxRangeM = Number(ui.range.value) || 4;
  });

  ui.liveCanvas.addEventListener("pointermove", (event) => {
    if (!direct.active || !direct.pipeline) return;
    const rect = ui.liveCanvas.getBoundingClientRect();
    direct.probe = {
      x: Math.max(0, Math.min(0.999999, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(0.999999, (event.clientY - rect.top) / rect.height)),
    };
    updateProbe(direct, ui);
  });
  ui.liveCanvas.addEventListener("pointerleave", () => {
    direct.probe = null;
  });

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.mode !== "d400") {
        if (direct.active) stopDirectDepth(direct, ui, false);
      } else if (direct.active) {
        applyLiveUi(direct, ui);
      }
    });
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", async () => {
    if (!direct.active && !$("d400Controls")?.hidden) {
      await refreshDepthDevices(ui, false);
    }
  });

  window.addEventListener("beforeunload", () => stopDirectDepth(direct, ui, false));
}

async function ensureCameraPermission() {
  const existing = await navigator.mediaDevices.enumerateDevices();
  const labelsVisible = existing.some((d) => d.kind === "videoinput" && d.label);
  if (labelsVisible) return;
  const seed = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  seed.getTracks().forEach((track) => track.stop());
}

async function refreshDepthDevices(ui, announce = true) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setDirectState(ui, "MediaDevices/getUserMedia is not available in this browser.", "error");
    return [];
  }

  ui.refresh.disabled = true;
  if (announce) setDirectState(ui, "Requesting camera permission…");
  try {
    await ensureCameraPermission();
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === "videoinput" && /realsense/i.test(d.label) && /depth/i.test(d.label));

    const previous = ui.device.value;
    ui.device.innerHTML = "";
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label;
      option.dataset.label = device.label;
      ui.device.appendChild(option);
    }
    if (!devices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No RealSense Depth inputs found";
      ui.device.appendChild(option);
      setDirectState(ui, "No browser-visible RealSense Depth input found.", "error");
    } else {
      if (devices.some((d) => d.deviceId === previous)) ui.device.value = previous;
      setDirectState(ui, `${devices.length} RealSense Depth input${devices.length === 1 ? "" : "s"} found.`, "ok");
    }
    return devices;
  } catch (error) {
    setDirectState(ui, `Camera access failed: ${error.name}: ${error.message}`, "error");
    return [];
  } finally {
    ui.refresh.disabled = false;
  }
}

async function startDirectDepth(direct, ui) {
  ui.start.disabled = true;
  setDirectState(ui, "Opening RealSense Depth input…");
  try {
    if (!ui.device.value) await refreshDepthDevices(ui);
    if (!ui.device.value) throw new Error("No RealSense Depth input is selected.");

    const selected = ui.device.options[ui.device.selectedIndex];
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: ui.device.value },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await waitForVideo(video);
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const pipeline = createFloatDepthPipeline(ui.liveCanvas, video, settings.width || video.videoWidth, settings.height || video.videoHeight);
    pipeline.scaleM = depthScale(ui);
    pipeline.maxRangeM = Number(ui.range.value) || 4;

    direct.active = true;
    direct.stream = stream;
    direct.video = video;
    direct.pipeline = pipeline;
    direct.label = track.label || selected?.dataset.label || selected?.textContent || "RealSense Depth";
    direct.mediaFrameCount = 0;
    direct.cameraFps = 0;
    direct.lastMediaTime = null;

    ui.liveCanvas.style.display = "block";
    viewerCanvas.style.visibility = "hidden";
    applyLiveUi(direct, ui, settings);
    setDirectState(ui, `Direct Depth live: ${settings.width || video.videoWidth}×${settings.height || video.videoHeight} @ ${settings.frameRate || "?"} fps`, "ok");
    scheduleDepthFrames(direct, ui);
  } catch (error) {
    stopDirectDepth(direct, ui, false);
    setDirectState(ui, `Depth start failed: ${error.name || "Error"}: ${error.message}`, "error");
  } finally {
    ui.start.disabled = false;
  }
}

function stopDirectDepth(direct, ui, restoreD400Demo) {
  if (direct.video && direct.frameCallbackId != null && direct.video.cancelVideoFrameCallback) {
    try { direct.video.cancelVideoFrameCallback(direct.frameCallbackId); } catch (_) {}
  }
  if (direct.fallbackTimer) clearTimeout(direct.fallbackTimer);
  if (direct.stream) direct.stream.getTracks().forEach((track) => track.stop());
  if (direct.video) direct.video.srcObject = null;
  if (direct.pipeline) direct.pipeline.dispose();

  direct.active = false;
  direct.stream = null;
  direct.video = null;
  direct.pipeline = null;
  direct.frameCallbackId = null;
  direct.fallbackTimer = null;
  direct.probe = null;

  ui.liveCanvas.style.display = "none";
  viewerCanvas.style.visibility = "visible";
  ui.start.textContent = "Start Depth";
  ui.pause.disabled = false;
  if (ui.pause.textContent === "Live") ui.pause.textContent = "Pause";
  ui.probeRaw.textContent = "—";

  if (restoreD400Demo && !$("d400Controls").hidden) restoreDemoUi(ui);
}

function applyLiveUi(direct, ui, settings = null) {
  ui.start.textContent = "Stop Depth";
  ui.badge.textContent = "USB LIVE";
  ui.badge.className = "badge badge-live";
  ui.model.textContent = compactModelName(direct.label);
  ui.deviceStatus.textContent = "Browser direct";
  ui.viewerTitle.textContent = "D400 · Browser live depth";
  ui.viewerSubtitle.textContent = "UVC → WebGL R32F/Z16 · move pointer to probe";
  ui.overlay.textContent = settings
    ? `${settings.width || direct.video?.videoWidth} × ${settings.height || direct.video?.videoHeight} direct depth`
    : "Direct browser Depth stream";
  ui.statusMode.textContent = "D400 USB LIVE";
  ui.transport.textContent = "UVC / R32F";
  ui.pause.disabled = true;
  ui.pause.textContent = "Live";
}

function restoreDemoUi(ui) {
  ui.badge.textContent = "DEMO";
  ui.badge.className = "badge badge-demo";
  ui.model.textContent = "D435/D455 demo";
  ui.deviceStatus.textContent = "Simulated";
  ui.viewerTitle.textContent = "D400 · Depth colorizer";
  ui.viewerSubtitle.textContent = "move pointer to probe distance";
  ui.overlay.textContent = "Synthetic 16-bit depth frame";
  ui.statusMode.textContent = "D400 DEMO";
  ui.transport.textContent = "INTERNAL";
  setDirectState(ui, "Direct USB stopped. Demo mode active.");
}

function scheduleDepthFrames(direct, ui) {
  if (!direct.active || !direct.video || !direct.pipeline) return;

  const process = (now, metadata = null) => {
    if (!direct.active || !direct.pipeline || !direct.video) return;
    try {
      direct.pipeline.scaleM = depthScale(ui);
      direct.pipeline.maxRangeM = Number(ui.range.value) || 4;
      direct.pipeline.renderFrame();
      direct.mediaFrameCount++;

      if (metadata?.mediaTime != null) {
        if (direct.lastMediaTime != null) {
          const dt = metadata.mediaTime - direct.lastMediaTime;
          if (dt > 0) {
            const inst = 1 / dt;
            direct.cameraFps = direct.cameraFps ? direct.cameraFps * 0.88 + inst * 0.12 : inst;
          }
        }
        direct.lastMediaTime = metadata.mediaTime;
      }

      if (direct.probe) updateProbe(direct, ui);
      if (direct.mediaFrameCount % 20 === 0 && direct.cameraFps > 0) {
        setDirectState(ui, `Streaming · camera ${direct.cameraFps.toFixed(1)} fps · scale ${depthScale(ui).toFixed(6)} m/unit`, "ok");
      }
    } catch (error) {
      setDirectState(ui, `Depth frame error: ${error.message}`, "error");
    }

    if (direct.video.requestVideoFrameCallback) {
      direct.frameCallbackId = direct.video.requestVideoFrameCallback(process);
    } else {
      direct.fallbackTimer = setTimeout(() => process(performance.now(), null), 33);
    }
  };

  if (direct.video.requestVideoFrameCallback) {
    direct.frameCallbackId = direct.video.requestVideoFrameCallback(process);
  } else {
    direct.fallbackTimer = setTimeout(() => process(performance.now(), null), 0);
  }
}

function updateProbe(direct, ui) {
  if (!direct.active || !direct.pipeline || !direct.probe) return;
  const x = Math.min(direct.pipeline.width - 1, Math.floor(direct.probe.x * direct.pipeline.width));
  const y = Math.min(direct.pipeline.height - 1, Math.floor(direct.probe.y * direct.pipeline.height));
  const normalized = direct.pipeline.readNormalizedDepth(x, y);
  const z16 = Math.max(0, Math.min(65535, Math.round(normalized * 65535)));
  const distanceM = z16 * depthScale(ui);

  ui.probeX.textContent = String(x);
  ui.probeY.textContent = String(y);
  ui.probeRaw.textContent = String(z16);
  ui.probeDepth.textContent = z16 > 0 ? `${distanceM.toFixed(3)} m` : "invalid";
}

function depthScale(ui) {
  const value = Number(ui.scale.value);
  return Number.isFinite(value) && value > 0 ? value : 0.001;
}

function setDirectState(ui, text, kind = "") {
  ui.state.textContent = text;
  ui.state.className = `browser-depth-state${kind ? ` ${kind}` : ""}`;
}

function compactModelName(label) {
  const match = label.match(/Intel\(R\) RealSense\(TM\) (.+?) Depth \(/i);
  if (match) return match[1].replace(/with RGB Module/i, "").trim();
  if (/430/i.test(label)) return "RealSense 430 / D435";
  if (/405/i.test(label)) return "RealSense D405";
  return "RealSense Depth";
}

function waitForVideo(video) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
    const timer = setTimeout(() => reject(new Error("Timed out waiting for a Depth frame.")), 6000);
    video.addEventListener("loadeddata", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    video.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("The Depth video element reported an error."));
    }, { once: true });
  });
}

function createFloatDepthPipeline(canvas, video, width, height) {
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL2 is unavailable.");
  if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float is unavailable.");

  const vertexSource = `#version 300 es
    in vec2 aPosition;
    out vec2 vUv;
    void main() {
      gl_Position = vec4(aPosition.x * 2.0 - 1.0, 1.0 - aPosition.y * 2.0, 0.0, 1.0);
      vUv = aPosition;
    }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;
    uniform sampler2D uDepth;
    uniform float uScaleM;
    uniform float uMaxRangeM;
    in vec2 vUv;
    out vec4 outColor;

    vec3 palette(float t) {
      t = clamp(t, 0.0, 1.0);
      if (t < 0.20) return mix(vec3(0.125,0.031,0.298), vec3(0.153,0.247,0.710), t / 0.20);
      if (t < 0.42) return mix(vec3(0.153,0.247,0.710), vec3(0.071,0.651,0.773), (t - 0.20) / 0.22);
      if (t < 0.64) return mix(vec3(0.071,0.651,0.773), vec3(0.267,0.855,0.455), (t - 0.42) / 0.22);
      if (t < 0.82) return mix(vec3(0.267,0.855,0.455), vec3(0.929,0.851,0.282), (t - 0.64) / 0.18);
      return mix(vec3(0.929,0.851,0.282), vec3(0.957,0.345,0.188), (t - 0.82) / 0.18);
    }

    void main() {
      float normalized = texture(uDepth, vUv).r;
      float z16 = floor(normalized * 65535.0 + 0.5);
      float depthM = z16 * uScaleM;
      if (z16 < 0.5 || depthM <= 0.0 || depthM > uMaxRangeM) {
        outColor = vec4(0.020, 0.031, 0.043, 1.0);
        return;
      }
      float t = depthM / max(uMaxRangeM, 0.000001);
      outColor = vec4(palette(t), 1.0);
    }
  `;

  const program = createProgram(gl, vertexSource, fragmentSource);
  const positionLocation = gl.getAttribLocation(program, "aPosition");
  const scaleLocation = gl.getUniformLocation(program, "uScaleM");
  const maxRangeLocation = gl.getUniformLocation(program, "uMaxRangeM");
  const depthLocation = gl.getUniformLocation(program, "uDepth");

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0, 1, 0, 1, 1,
    0, 0, 1, 1, 0, 1,
  ]), gl.STATIC_DRAW);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  const onePixel = new Float32Array(1);

  const pipeline = {
    gl,
    width: canvas.width,
    height: canvas.height,
    scaleM: 0.001,
    maxRangeM: 4,

    renderFrame() {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      clearGlErrors(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, gl.RED, gl.FLOAT, video);
      const uploadError = gl.getError();
      if (uploadError !== gl.NO_ERROR) throw new Error(`R32F video upload failed (WebGL error 0x${uploadError.toString(16)}).`);

      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error("R32F depth framebuffer is incomplete.");
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(depthLocation, 0);
      gl.uniform1f(scaleLocation, pipeline.scaleM);
      gl.uniform1f(maxRangeLocation, pipeline.maxRangeM);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    readNormalizedDepth(x, y) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      clearGlErrors(gl);
      gl.readPixels(x, y, 1, 1, gl.RED, gl.FLOAT, onePixel);
      const error = gl.getError();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (error !== gl.NO_ERROR) return 0;
      return onePixel[0];
    },

    dispose() {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };

  return pipeline;
}

function clearGlErrors(gl) {
  while (gl.getError() !== gl.NO_ERROR) {}
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown WebGL link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown WebGL shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}
