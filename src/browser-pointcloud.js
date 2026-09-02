const $ = (id) => document.getElementById(id);

const pointCloudState = {
  sourceStream: null,
  sourceTrack: null,
  video: null,
  renderer: null,
  frameCallbackId: null,
  activeView: "depth",
  yaw: -0.35,
  pitch: -0.16,
  zoom: 1.0,
  drag: null,
  label: "",
  settings: null,
  getUserMediaWrapped: false,
};

installPointCloudStyles();
installPointCloudCaptureHook();
installPointCloudUiWhenReady();

function installPointCloudStyles() {
  const style = document.createElement("style");
  style.textContent = `
    #browserPointCloudCanvas {
      position: absolute;
      inset: 0;
      display: none;
      width: 100%;
      height: 100%;
      background: #05080b;
      cursor: grab;
      z-index: 1;
      touch-action: none;
    }
    #browserPointCloudCanvas:active { cursor: grabbing; }
    .browser-pointcloud-block {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .pc-toggle {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      padding: 3px;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: #080c11;
      margin-bottom: 9px;
    }
    .pc-toggle button {
      border: 0;
      border-radius: 6px;
      padding: 8px 6px;
      background: transparent;
      color: var(--muted);
      font-size: 0.75rem;
      font-weight: 750;
      cursor: pointer;
    }
    .pc-toggle button.active {
      background: #16212c;
      color: var(--accent);
    }
    .pc-range-row { margin-top: 9px; }
    .pc-value { float: right; color: #dbe8f5; font-variant-numeric: tabular-nums; }
    .pc-calibration {
      margin-top: 9px;
      padding-top: 8px;
      border-top: 1px dashed rgba(129,144,161,.2);
    }
    .pc-calibration summary {
      cursor: pointer;
      color: var(--muted);
      font-size: .72rem;
      user-select: none;
    }
    .pc-intrinsics-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-top: 8px;
    }
    .pc-intrinsics-grid label { font-size: .65rem; color: var(--muted); }
    .pc-intrinsics-grid input {
      width: 100%;
      margin-top: 3px;
      padding: 6px;
      color: #dbe8f5;
      background: #080d12;
      border: 1px solid var(--border);
      border-radius: 6px;
      font: .68rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .pc-state {
      margin: 7px 0 0;
      min-height: 1.2em;
      color: var(--muted);
      font-size: .68rem;
      line-height: 1.45;
    }
    .pc-state.ok { color: var(--accent-2); }
    .pc-state.warn { color: var(--warning); }
    .pc-state.error { color: #ff8d8d; }
  `;
  document.head.appendChild(style);
}

function installPointCloudCaptureHook() {
  if (!navigator.mediaDevices?.getUserMedia || pointCloudState.getUserMediaWrapped) return;
  const mediaDevices = navigator.mediaDevices;
  const original = mediaDevices.getUserMedia.bind(mediaDevices);

  const wrapped = async (constraints) => {
    const stream = await original(constraints);
    queueMicrotask(() => maybeAttachDepthStream(stream));
    return stream;
  };

  try {
    mediaDevices.getUserMedia = wrapped;
    pointCloudState.getUserMediaWrapped = mediaDevices.getUserMedia === wrapped;
  } catch (_) {
    pointCloudState.getUserMediaWrapped = false;
  }
}

function installPointCloudUiWhenReady(attempt = 0) {
  const d400Controls = $("d400Controls");
  const shell = document.querySelector(".canvas-shell");
  const depthStart = $("browserDepthStart");
  if (!d400Controls || !shell || !depthStart) {
    if (attempt < 80) setTimeout(() => installPointCloudUiWhenReady(attempt + 1), 50);
    return;
  }
  if ($("browserPointCloudCanvas")) return;

  const block = document.createElement("div");
  block.className = "browser-pointcloud-block";
  block.innerHTML = `
    <h2>3D Point Cloud</h2>
    <div class="pc-toggle" role="group" aria-label="D400 live visualization">
      <button id="pcDepthView" class="active">Depth</button>
      <button id="pcCloudView">Point Cloud</button>
    </div>
    <div class="button-row">
      <button id="pcResetView" class="secondary">Reset view</button>
      <button id="pcAutoIntrinsics" class="secondary">Auto intrinsics</button>
    </div>
    <div class="pc-range-row">
      <label class="field-label" for="pcStep">Point spacing <span id="pcStepValue" class="pc-value">3 px</span></label>
      <input id="pcStep" type="range" min="1" max="8" step="1" value="3" />
    </div>
    <div class="pc-range-row">
      <label class="field-label" for="pcPointSize">Point size <span id="pcPointSizeValue" class="pc-value">2.0 px</span></label>
      <input id="pcPointSize" type="range" min="1" max="5" step="0.25" value="2" />
    </div>
    <details class="pc-calibration">
      <summary>Point-cloud intrinsics</summary>
      <div class="pc-intrinsics-grid">
        <label>fx<input id="pcFx" type="number" step="0.001" value="381.902" /></label>
        <label>fy<input id="pcFy" type="number" step="0.001" value="381.902" /></label>
        <label>ppx<input id="pcPpx" type="number" step="0.001" value="318.229" /></label>
        <label>ppy<input id="pcPpy" type="number" step="0.001" value="239.945" /></label>
      </div>
    </details>
    <p id="pcState" class="pc-state">Start Direct USB Depth, then choose Point Cloud.</p>
  `;
  d400Controls.appendChild(block);

  const canvas = document.createElement("canvas");
  canvas.id = "browserPointCloudCanvas";
  canvas.setAttribute("aria-label", "Live RealSense 3D point cloud");
  shell.insertBefore(canvas, $("canvasOverlay"));

  bindPointCloudUi();
  observeDepthLifecycle();
}

function bindPointCloudUi() {
  const depthButton = $("pcDepthView");
  const cloudButton = $("pcCloudView");
  const resetButton = $("pcResetView");
  const autoButton = $("pcAutoIntrinsics");
  const step = $("pcStep");
  const pointSize = $("pcPointSize");
  const canvas = $("browserPointCloudCanvas");

  depthButton.addEventListener("click", () => setVisualization("depth"));
  cloudButton.addEventListener("click", () => setVisualization("pointcloud"));
  resetButton.addEventListener("click", () => {
    pointCloudState.yaw = -0.35;
    pointCloudState.pitch = -0.16;
    pointCloudState.zoom = 1.0;
  });
  autoButton.addEventListener("click", () => applyAutomaticIntrinsics(true));

  step.addEventListener("input", () => {
    $("pcStepValue").textContent = `${step.value} px`;
    pointCloudState.renderer?.setStep(Number(step.value));
    updatePointCountState();
  });
  pointSize.addEventListener("input", () => {
    $("pcPointSizeValue").textContent = `${Number(pointSize.value).toFixed(2)} px`;
  });

  for (const id of ["pcFx", "pcFy", "pcPpx", "pcPpy"]) {
    $(id).addEventListener("input", () => {
      if (pointCloudState.activeView === "pointcloud") setPcState("Manual intrinsics active.", "warn");
    });
  }

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointCloudState.drag = {
      x: event.clientX,
      y: event.clientY,
      yaw: pointCloudState.yaw,
      pitch: pointCloudState.pitch,
    };
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointCloudState.drag) return;
    pointCloudState.yaw = pointCloudState.drag.yaw + (event.clientX - pointCloudState.drag.x) * 0.007;
    pointCloudState.pitch = clamp(
      pointCloudState.drag.pitch + (event.clientY - pointCloudState.drag.y) * 0.006,
      -1.45,
      1.45,
    );
  });
  canvas.addEventListener("pointerup", () => { pointCloudState.drag = null; });
  canvas.addEventListener("pointercancel", () => { pointCloudState.drag = null; });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    pointCloudState.zoom = clamp(pointCloudState.zoom * Math.exp(-event.deltaY * 0.001), 0.25, 5.0);
  }, { passive: false });

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.mode !== "d400") {
        $("browserPointCloudCanvas").style.display = "none";
      } else if (pointCloudState.activeView === "pointcloud" && pointCloudState.video) {
        showPointCloudCanvas();
      }
    });
  });
}

function observeDepthLifecycle() {
  const startButton = $("browserDepthStart");
  if (!startButton) return;
  const observer = new MutationObserver(() => {
    if (/^Start Depth$/i.test(startButton.textContent.trim())) {
      detachPointCloudSource();
      setVisualization("depth", false);
    }
  });
  observer.observe(startButton, { childList: true, characterData: true, subtree: true });
}

async function maybeAttachDepthStream(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return;
  const label = track.label || "";
  if (!/realsense/i.test(label) || !/depth/i.test(label)) return;

  detachPointCloudSource(false);

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none";
  video.srcObject = stream;
  document.body.appendChild(video);

  try {
    await waitForPointCloudVideo(video);
    await video.play();
    const settings = track.getSettings();
    const renderer = createPointCloudRenderer(
      $("browserPointCloudCanvas"),
      video,
      settings.width || video.videoWidth,
      settings.height || video.videoHeight,
    );

    pointCloudState.sourceStream = stream;
    pointCloudState.sourceTrack = track;
    pointCloudState.video = video;
    pointCloudState.renderer = renderer;
    pointCloudState.label = label;
    pointCloudState.settings = settings;
    renderer.setStep(Number($("pcStep")?.value || 3));
    applyAutomaticIntrinsics(false);
    schedulePointCloudFrames();
    updatePointCountState();

    track.addEventListener("ended", () => detachPointCloudSource(), { once: true });
    setPcState("Depth stream captured for 3D. Choose Point Cloud.", "ok");
  } catch (error) {
    video.srcObject = null;
    video.remove();
    setPcState(`Point-cloud source failed: ${error.message}`, "error");
  }
}

function detachPointCloudSource(resetMessage = true) {
  const state = pointCloudState;
  if (state.video && state.frameCallbackId != null && state.video.cancelVideoFrameCallback) {
    try { state.video.cancelVideoFrameCallback(state.frameCallbackId); } catch (_) {}
  }
  if (state.renderer) state.renderer.dispose();
  if (state.video) {
    state.video.srcObject = null;
    state.video.remove();
  }
  state.sourceStream = null;
  state.sourceTrack = null;
  state.video = null;
  state.renderer = null;
  state.frameCallbackId = null;
  state.label = "";
  state.settings = null;
  const canvas = $("browserPointCloudCanvas");
  if (canvas) canvas.style.display = "none";
  if (resetMessage && $("pcState")) setPcState("Start Direct USB Depth, then choose Point Cloud.");
}

function setVisualization(mode, updateUi = true) {
  pointCloudState.activeView = mode;
  const depthButton = $("pcDepthView");
  const cloudButton = $("pcCloudView");
  if (updateUi) {
    depthButton?.classList.toggle("active", mode === "depth");
    cloudButton?.classList.toggle("active", mode === "pointcloud");
  }

  if (mode === "pointcloud") {
    if (!pointCloudState.video || !pointCloudState.renderer) {
      if (updateUi) setPcState("Start Direct USB Depth first.", "warn");
      pointCloudState.activeView = "depth";
      depthButton?.classList.add("active");
      cloudButton?.classList.remove("active");
      return;
    }
    showPointCloudCanvas();
    setPcState("Live point cloud · drag to orbit · wheel to zoom.", "ok");
    $("viewerTitle").textContent = "D400 · Live 3D point cloud";
    $("viewerSubtitle").textContent = "depth-colored · drag to orbit · wheel to zoom";
    $("overlayText").textContent = "Browser-direct Z16 → 3D point cloud";
    $("transportValue").textContent = "UVC / R32F / 3D";
  } else {
    const pcCanvas = $("browserPointCloudCanvas");
    if (pcCanvas) pcCanvas.style.display = "none";
    const depthCanvas = $("browserDepthCanvas");
    if (depthCanvas && $("browserDepthStart")?.textContent.trim() === "Stop Depth") {
      depthCanvas.style.display = "block";
      $("viewerCanvas").style.visibility = "hidden";
      $("viewerTitle").textContent = "D400 · Browser live depth";
      $("viewerSubtitle").textContent = "UVC → WebGL R32F/Z16 · move pointer to probe";
      $("overlayText").textContent = `${pointCloudState.settings?.width || pointCloudState.video?.videoWidth || 640} × ${pointCloudState.settings?.height || pointCloudState.video?.videoHeight || 480} direct depth`;
      $("transportValue").textContent = "UVC / R32F";
      setPcState("Depth view active. Point cloud remains available.", "ok");
    }
  }
}

function showPointCloudCanvas() {
  const pcCanvas = $("browserPointCloudCanvas");
  const depthCanvas = $("browserDepthCanvas");
  if (depthCanvas) depthCanvas.style.display = "none";
  if (pcCanvas) pcCanvas.style.display = "block";
  const mainCanvas = $("viewerCanvas");
  if (mainCanvas) mainCanvas.style.visibility = "hidden";
}

function applyAutomaticIntrinsics(announce) {
  if (!pointCloudState.settings) return;
  const w = Number(pointCloudState.settings.width || pointCloudState.video?.videoWidth || 640);
  const h = Number(pointCloudState.settings.height || pointCloudState.video?.videoHeight || 480);
  const label = pointCloudState.label || "";
  let preset;
  let note;

  if (/430|435/i.test(label)) {
    const sx = w / 640;
    const sy = h / 480;
    preset = {
      fx: 381.902008056641 * sx,
      fy: 381.902008056641 * sy,
      ppx: 318.229400634766 * sx,
      ppy: 239.944534301758 * sy,
    };
    note = "D430/D435 legacy Intel web-demo intrinsics preset";
  } else if (/405/i.test(label)) {
    const hfov = 87 * Math.PI / 180;
    const vfov = 58 * Math.PI / 180;
    preset = {
      fx: (w * 0.5) / Math.tan(hfov * 0.5),
      fy: (h * 0.5) / Math.tan(vfov * 0.5),
      ppx: (w - 1) * 0.5,
      ppy: (h - 1) * 0.5,
    };
    note = "D405 nominal-FOV approximation (editable)";
  } else {
    const hfov = 75 * Math.PI / 180;
    const vfov = 62 * Math.PI / 180;
    preset = {
      fx: (w * 0.5) / Math.tan(hfov * 0.5),
      fy: (h * 0.5) / Math.tan(vfov * 0.5),
      ppx: (w - 1) * 0.5,
      ppy: (h - 1) * 0.5,
    };
    note = "generic wide-FOV approximation (editable)";
  }

  $("pcFx").value = preset.fx.toFixed(3);
  $("pcFy").value = preset.fy.toFixed(3);
  $("pcPpx").value = preset.ppx.toFixed(3);
  $("pcPpy").value = preset.ppy.toFixed(3);
  if (announce || pointCloudState.activeView === "pointcloud") setPcState(note, /405/i.test(label) ? "warn" : "ok");
}

function currentIntrinsics() {
  const fallbackW = pointCloudState.settings?.width || pointCloudState.video?.videoWidth || 640;
  const fallbackH = pointCloudState.settings?.height || pointCloudState.video?.videoHeight || 480;
  return {
    fx: positiveNumber($("pcFx")?.value, fallbackW * 0.6),
    fy: positiveNumber($("pcFy")?.value, fallbackH * 0.8),
    ppx: finiteNumber($("pcPpx")?.value, fallbackW * 0.5),
    ppy: finiteNumber($("pcPpy")?.value, fallbackH * 0.5),
  };
}

function schedulePointCloudFrames() {
  const state = pointCloudState;
  if (!state.video || !state.renderer) return;

  const frame = () => {
    if (!state.video || !state.renderer) return;
    if (state.activeView === "pointcloud" && $("d400Controls") && !$("d400Controls").hidden) {
      try {
        const scaleM = positiveNumber($("browserDepthScale")?.value, 0.001);
        const maxRangeM = positiveNumber($("depthRange")?.value, 4);
        const intr = currentIntrinsics();
        state.renderer.render({
          scaleM,
          maxRangeM,
          intrinsics: intr,
          yaw: state.yaw,
          pitch: state.pitch,
          zoom: state.zoom,
          pointSize: positiveNumber($("pcPointSize")?.value, 2),
        });
      } catch (error) {
        setPcState(`Point-cloud frame error: ${error.message}`, "error");
      }
    }
    if (state.video?.requestVideoFrameCallback) {
      state.frameCallbackId = state.video.requestVideoFrameCallback(frame);
    } else {
      state.frameCallbackId = requestAnimationFrame(frame);
    }
  };

  if (state.video.requestVideoFrameCallback) state.frameCallbackId = state.video.requestVideoFrameCallback(frame);
  else state.frameCallbackId = requestAnimationFrame(frame);
}

function createPointCloudRenderer(canvas, video, sourceWidth, sourceHeight) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL2 is unavailable for point cloud rendering.");

  const vertexSource = `#version 300 es
    precision highp float;
    in vec2 aPixel;
    uniform sampler2D uDepth;
    uniform vec2 uSourceSize;
    uniform vec2 uFocal;
    uniform vec2 uPrincipal;
    uniform float uScaleM;
    uniform float uMaxRangeM;
    uniform float uYaw;
    uniform float uPitch;
    uniform float uZoom;
    uniform float uPointSize;
    uniform float uAspect;
    out float vDepthT;
    out float vValid;

    mat3 rotY(float a) {
      float c = cos(a), s = sin(a);
      return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c);
    }
    mat3 rotX(float a) {
      float c = cos(a), s = sin(a);
      return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c);
    }

    void main() {
      vec2 uv = (aPixel + vec2(0.5)) / uSourceSize;
      float normalized = texture(uDepth, uv).r;
      float z16 = floor(normalized * 65535.0 + 0.5);
      float z = z16 * uScaleM;
      bool valid = z16 > 0.5 && z > 0.0 && z <= uMaxRangeM;
      if (!valid) {
        gl_Position = vec4(2.0, 2.0, 1.0, 1.0);
        gl_PointSize = 0.0;
        vDepthT = 0.0;
        vValid = 0.0;
        return;
      }

      float x = (aPixel.x - uPrincipal.x) * z / uFocal.x;
      float y = -(aPixel.y - uPrincipal.y) * z / uFocal.y;
      float targetZ = uMaxRangeM * 0.45;
      vec3 p = vec3(x, y, z - targetZ);
      p = rotX(uPitch) * rotY(uYaw) * p;

      float cameraDistance = uMaxRangeM * 0.75 / max(uZoom, 0.05) + 0.15;
      float viewZ = max(0.08, cameraDistance + p.z);
      float perspective = 1.85 / viewZ;
      vec2 ndc = vec2((p.x * perspective) / max(uAspect, 0.2), p.y * perspective);
      float depth01 = clamp((viewZ - 0.05) / max(uMaxRangeM * 3.0, 0.2), 0.0, 1.0);
      gl_Position = vec4(ndc, depth01 * 2.0 - 1.0, 1.0);
      gl_PointSize = uPointSize;
      vDepthT = clamp(z / max(uMaxRangeM, 0.000001), 0.0, 1.0);
      vValid = 1.0;
    }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;
    in float vDepthT;
    in float vValid;
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
      if (vValid < 0.5) discard;
      vec2 d = gl_PointCoord * 2.0 - 1.0;
      if (dot(d, d) > 1.0) discard;
      outColor = vec4(palette(vDepthT), 0.96);
    }
  `;

  const program = makeProgram(gl, vertexSource, fragmentSource);
  const locations = {
    pixel: gl.getAttribLocation(program, "aPixel"),
    depth: gl.getUniformLocation(program, "uDepth"),
    sourceSize: gl.getUniformLocation(program, "uSourceSize"),
    focal: gl.getUniformLocation(program, "uFocal"),
    principal: gl.getUniformLocation(program, "uPrincipal"),
    scaleM: gl.getUniformLocation(program, "uScaleM"),
    maxRangeM: gl.getUniformLocation(program, "uMaxRangeM"),
    yaw: gl.getUniformLocation(program, "uYaw"),
    pitch: gl.getUniformLocation(program, "uPitch"),
    zoom: gl.getUniformLocation(program, "uZoom"),
    pointSize: gl.getUniformLocation(program, "uPointSize"),
    aspect: gl.getUniformLocation(program, "uAspect"),
  };

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const pointBuffer = gl.createBuffer();
  let pointCount = 0;
  let step = 3;

  function rebuildPoints(nextStep) {
    step = Math.max(1, Math.round(nextStep));
    const values = [];
    for (let y = 0; y < sourceHeight; y += step) {
      for (let x = 0; x < sourceWidth; x += step) values.push(x, y);
    }
    pointCount = values.length / 2;
    gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STATIC_DRAW);
  }
  rebuildPoints(step);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND);

  return {
    get pointCount() { return pointCount; },
    get step() { return step; },
    setStep(nextStep) { if (Math.round(nextStep) !== step) rebuildPoints(nextStep); },
    render(options) {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      drainGlErrors(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, gl.RED, gl.FLOAT, video);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`R32F point-cloud upload failed (0x${error.toString(16)}).`);

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.018, 0.027, 0.037, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
      gl.enableVertexAttribArray(locations.pixel);
      gl.vertexAttribPointer(locations.pixel, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(locations.depth, 0);
      gl.uniform2f(locations.sourceSize, sourceWidth, sourceHeight);
      gl.uniform2f(locations.focal, options.intrinsics.fx, options.intrinsics.fy);
      gl.uniform2f(locations.principal, options.intrinsics.ppx, options.intrinsics.ppy);
      gl.uniform1f(locations.scaleM, options.scaleM);
      gl.uniform1f(locations.maxRangeM, options.maxRangeM);
      gl.uniform1f(locations.yaw, options.yaw);
      gl.uniform1f(locations.pitch, options.pitch);
      gl.uniform1f(locations.zoom, options.zoom);
      gl.uniform1f(locations.pointSize, options.pointSize * dpr);
      gl.uniform1f(locations.aspect, canvas.width / Math.max(1, canvas.height));
      gl.drawArrays(gl.POINTS, 0, pointCount);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(pointBuffer);
      gl.deleteProgram(program);
    },
  };
}

function updatePointCountState() {
  if (!pointCloudState.renderer) return;
  const label = /405/i.test(pointCloudState.label)
    ? "D405 nominal intrinsics"
    : /430|435/i.test(pointCloudState.label)
      ? "D430/D435 preset"
      : "generic intrinsics";
  setPcState(`${pointCloudState.renderer.pointCount.toLocaleString()} points · ${label}`, /405/i.test(pointCloudState.label) ? "warn" : "ok");
}

function setPcState(text, kind = "") {
  const element = $("pcState");
  if (!element) return;
  element.textContent = text;
  element.className = `pc-state${kind ? ` ${kind}` : ""}`;
}

function waitForPointCloudVideo(video) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
    const timer = setTimeout(() => reject(new Error("Timed out waiting for point-cloud video frame.")), 6000);
    video.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
    video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Point-cloud video element error.")); }, { once: true });
  });
}

function makeProgram(gl, vertexSource, fragmentSource) {
  const vs = makeShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = makeShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown point-cloud program link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function makeShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown point-cloud shader compile error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function drainGlErrors(gl) {
  while (gl.getError() !== gl.NO_ERROR) {}
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
