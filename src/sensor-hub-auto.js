import { sensorHub } from "./realsense-sensor-api.js";

const $ = (id) => document.getElementById(id);
const state = {
  starting: false,
  depth: false,
  t265: false,
  lastError: "",
};

function setText(id, text, kind = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  if (kind) el.dataset.kind = kind;
}

async function waitForGlobal(name, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (globalThis[name]) return globalThis[name];
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${name} did not initialize.`);
}

async function startDepth() {
  const api = await waitForGlobal("RealSenseDepthDirect");
  if (api.active) {
    state.depth = true;
    return { ok: true, already: true };
  }
  await api.startAuto();
  state.depth = !!api.active;
  return { ok: state.depth, label: api.label || "" };
}

async function startT265() {
  const api = await waitForGlobal("RealSenseT265Direct");
  if (api.socket && api.socket.readyState !== WebSocket.CLOSED) {
    state.t265 = true;
    return { ok: true, already: true };
  }
  const socket = await api.connectPermitted();
  if (!socket) {
    state.t265 = false;
    return {
      ok: false,
      authorization_required: true,
      reason: "No previously authorized T265 was found. Authorize it once from the normal viewer or Boot Lab.",
    };
  }
  state.t265 = true;
  return { ok: true };
}

async function stopAll() {
  const depth = globalThis.RealSenseDepthDirect;
  const t265 = globalThis.RealSenseT265Direct;
  const results = await Promise.allSettled([
    depth?.stop?.(),
    t265?.disconnect?.(),
  ]);
  state.depth = false;
  state.t265 = false;
  setText("hubState", "STOPPED");
  return results;
}

async function startAll(requestId = null, options = {}) {
  if (state.starting) return;
  state.starting = true;
  setText("hubState", "STARTING");
  const wantDepth = options.depth !== false;
  const wantT265 = options.t265 !== false;
  const result = { depth: null, t265: null };
  try {
    const jobs = [];
    if (wantDepth) jobs.push(startDepth().then((r) => { result.depth = r; }));
    if (wantT265) jobs.push(startT265().then((r) => { result.t265 = r; }));
    await Promise.allSettled(jobs);

    const depthOk = !wantDepth || !!result.depth?.ok;
    const t265Ok = !wantT265 || !!result.t265?.ok;
    const authRequired = !!result.t265?.authorization_required;
    state.lastError = "";

    setText("depthState", depthOk ? "LIVE" : "WAITING");
    setText("t265State", t265Ok ? "LIVE" : authRequired ? "AUTH REQUIRED" : "WAITING");
    setText("hubState", depthOk && t265Ok ? "LIVE" : authRequired ? "PARTIAL · T265 AUTH REQUIRED" : "PARTIAL");

    sensorHub.publishControlResult("sensor_api_start_result", requestId, {
      ok: depthOk && t265Ok,
      depth: result.depth,
      t265: result.t265,
      authorization_required: authRequired,
    });
  } catch (error) {
    state.lastError = error?.message || String(error);
    setText("hubState", `ERROR · ${state.lastError}`);
    sensorHub.publishControlResult("sensor_api_start_result", requestId, {
      ok: false,
      error: state.lastError,
    });
  } finally {
    state.starting = false;
  }
}

globalThis.addEventListener("realsense-hub-command", async (event) => {
  const command = event.detail || {};
  try {
    if (command.type === "sensor_api_start") {
      await startAll(command.request_id, command.options || {});
    } else if (command.type === "sensor_api_stop") {
      await stopAll();
      sensorHub.publishControlResult("sensor_api_stop_result", command.request_id, { ok: true });
    } else if (command.type === "sensor_api_restart") {
      await stopAll();
      await new Promise((r) => setTimeout(r, 250));
      await startAll(command.request_id, command.options || {});
    }
  } catch (error) {
    sensorHub.publishControlResult("sensor_api_control_error", command.request_id, {
      ok: false,
      error: error?.message || String(error),
    });
  }
});

sensorHub.onStats((stats) => {
  const d = stats.d435 || {};
  const t = stats.t265 || {};
  if (d.active) setText("depthState", `LIVE · ${d.width || 0}×${d.height || 0} · ${Number(d.hz || 0).toFixed(1)} Hz`);
  if (t.active) setText("t265State", `LIVE · ${Number(t.hz || 0).toFixed(1)} Hz · conf ${t.confidence ?? 0}`);
  setText("clientCount", String(stats.clients || 0));
});

globalThis.RealSenseHeadlessHub = Object.freeze({
  start: startAll,
  stop: stopAll,
  restart: async (options = {}) => { await stopAll(); await new Promise((r) => setTimeout(r, 250)); return startAll(null, options); },
  get state() { return { ...state }; },
});

// Autostart is the normal API behavior.
queueMicrotask(() => startAll(null, { depth: true, t265: true }));

// Retry only missing permitted devices. This also handles USB reconnects.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (!state.starting && (!globalThis.RealSenseDepthDirect?.active || !globalThis.RealSenseT265Direct?.socket)) {
    startAll(null, { depth: true, t265: true });
  }
}, 3000);
