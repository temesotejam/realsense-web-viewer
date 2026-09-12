const RUNTIME_FILTERS = [
  { vendorId: 0x8087, productId: 0x0b37 },
  { vendorId: 0x8087, productId: 0x0af3 },
];

const MSG = Object.freeze({
  DEV_GET_DEVICE_INFO: 0x0001,
  DEV_GET_TIME: 0x0002,
  DEV_GET_SUPPORTED_RAW_STREAMS: 0x0004,
  DEV_RAW_STREAMS_CONTROL: 0x0005,
  DEV_START: 0x0012,
  DEV_STOP: 0x0013,
  DEV_STATUS: 0x0014,
  DEV_GET_POSE: 0x0015,
  DEV_TIMEOUT_CONFIGURATION: 0x001e,
  DEV_SET_LOW_POWER_MODE: 0x0025,
  DEV_ERROR: 0x8000,
  SLAM_SET_6DOF_INTERRUPT_RATE: 0x1005,
  SLAM_6DOF_CONTROL: 0x1006,
  SLAM_ERROR: 0x9000,
});

const STATUS = Object.freeze({
  0x0000: "SUCCESS",
  0x0001: "UNKNOWN_MESSAGE_ID",
  0x0002: "INVALID_REQUEST_LEN",
  0x0003: "INVALID_PARAMETER",
  0x0004: "INTERNAL_ERROR",
  0x0005: "UNSUPPORTED",
  0x0007: "MORE_DATA_AVAILABLE",
  0x0008: "DEVICE_BUSY",
  0x0009: "TIMEOUT",
  0x000c: "DEVICE_STOPPED",
  0x0010: "TEMPERATURE_WARNING",
  0x0011: "TEMPERATURE_STOP",
  0x0015: "DEVICE_RESET",
});

const SENSOR_NAMES = Object.freeze({
  0: "Color",
  1: "Depth",
  2: "IR",
  3: "Fisheye",
  4: "Gyro",
  5: "Accelerometer",
  6: "Controller",
  7: "Rssi",
  8: "Velocimeter",
  9: "Stereo",
  10: "Pose",
});

const $ = (id) => document.getElementById(id);
const ui = {
  apiStatus: $("apiStatus"),
  authorizeRuntime: $("authorizeRuntime"),
  usePermittedRuntime: $("usePermittedRuntime"),
  closeRuntime: $("closeRuntime"),
  probeRuntime: $("probeRuntime"),
  startPose: $("startPose"),
  stopPose: $("stopPose"),
  copyLog: $("copyLog"),
  clearLog: $("clearLog"),
  runtimeDevice: $("runtimeDevice"),
  runtimeInterface: $("runtimeInterface"),
  commandEndpoints: $("commandEndpoints"),
  poseEndpoint: $("poseEndpoint"),
  firmwareVersion: $("firmwareVersion"),
  deviceTime: $("deviceTime"),
  rawStreams: $("rawStreams"),
  poseFrames: $("poseFrames"),
  poseRate: $("poseRate"),
  posePacketLength: $("posePacketLength"),
  poseConfidence: $("poseConfidence"),
  poseX: $("poseX"),
  poseY: $("poseY"),
  poseZ: $("poseZ"),
  poseRoll: $("poseRoll"),
  posePitch: $("posePitch"),
  poseYaw: $("poseYaw"),
  poseSpeed: $("poseSpeed"),
  poseTimestamp: $("poseTimestamp"),
  poseTrackerState: $("poseTrackerState"),
  log: $("log"),
};

const state = {
  device: null,
  interfaceNumber: null,
  endpoints: null,
  rawStreams: [],
  probed: false,
  poseReading: false,
  interruptTask: null,
  poseFrames: 0,
  firstPoseAt: 0,
  lastRateAt: 0,
  lastRateFrames: 0,
  report: "",
};

function hex(value, width = 4) {
  return Number(value ?? 0).toString(16).toUpperCase().padStart(width, "0");
}

function stamp() {
  return new Date().toISOString();
}

function deviceId(device) {
  return `${hex(device.vendorId)}:${hex(device.productId)}`;
}

function isRuntime(device) {
  return RUNTIME_FILTERS.some((filter) => device.vendorId === filter.vendorId && device.productId === filter.productId);
}

function log(line = "") {
  state.report += `${line}\n`;
  ui.log.textContent = state.report;
  ui.log.scrollTop = ui.log.scrollHeight;
}

function resetLog() {
  state.report = "";
  ui.log.textContent = "Ready.";
}

function setStatus(kind, text) {
  ui.apiStatus.className = `status ${kind || ""}`;
  ui.apiStatus.innerHTML = `<span class="dot"></span><span>${text}</span>`;
}

function statusName(status) {
  return STATUS[status] || `0x${hex(status, 4)}`;
}

function messageName(id) {
  const entry = Object.entries(MSG).find(([, value]) => value === id);
  return entry?.[0] || `0x${hex(id, 4)}`;
}

function endpointText(endpoint) {
  return endpoint ? `${endpoint.direction} ${endpoint.type} #${endpoint.endpointNumber} packet=${endpoint.packetSize}` : "—";
}

function updateButtons() {
  const ready = Boolean(state.device && state.endpoints);
  ui.probeRuntime.disabled = !ready || state.poseReading;
  ui.startPose.disabled = !ready || state.poseReading;
  ui.stopPose.disabled = !state.poseReading;
  ui.closeRuntime.disabled = !ready || state.poseReading;
}

async function ensureOpen(device) {
  if (!device.opened) await device.open();
  if (!device.configuration) {
    const configurationValue = device.configurations?.[0]?.configurationValue || 1;
    await device.selectConfiguration(configurationValue);
  }
}

function findRuntimeTransport(device) {
  for (const intf of Array.from(device.configuration?.interfaces || [])) {
    for (const alt of Array.from(intf.alternates || [])) {
      if (alt.interfaceClass !== 0xff) continue;
      const endpoints = Array.from(alt.endpoints || []);
      const msgOut = endpoints.find((ep) => ep.direction === "out" && ep.type === "bulk" && ep.endpointNumber === 2);
      const msgIn = endpoints.find((ep) => ep.direction === "in" && ep.type === "bulk" && ep.endpointNumber === 2);
      const poseIn = endpoints.find((ep) => ep.direction === "in" && ep.type === "interrupt" && ep.endpointNumber === 3);
      const streamIn = endpoints.find((ep) => ep.direction === "in" && ep.type === "bulk" && ep.endpointNumber === 1);
      const streamOut = endpoints.find((ep) => ep.direction === "out" && ep.type === "bulk" && ep.endpointNumber === 1);
      if (msgOut && msgIn && poseIn) {
        return { intf, alt, msgOut, msgIn, poseIn, streamIn, streamOut };
      }
    }
  }
  throw new Error("Expected T265 runtime endpoints (#2 Bulk OUT/IN and #3 Interrupt IN) were not found.");
}

async function prepareRuntime(device) {
  if (state.device && state.device !== device) await closeRuntime();
  await ensureOpen(device);
  const transport = findRuntimeTransport(device);
  if (!transport.intf.claimed) await device.claimInterface(transport.intf.interfaceNumber);
  if (transport.intf.alternate?.alternateSetting !== transport.alt.alternateSetting) {
    await device.selectAlternateInterface(transport.intf.interfaceNumber, transport.alt.alternateSetting);
  }

  state.device = device;
  state.interfaceNumber = transport.intf.interfaceNumber;
  state.endpoints = transport;
  state.rawStreams = [];
  state.probed = false;

  ui.runtimeDevice.textContent = `${deviceId(device)} ${device.productName || "T265"}`;
  ui.runtimeInterface.textContent = `IF ${transport.intf.interfaceNumber} / alt ${transport.alt.alternateSetting} / class 0xFF`;
  ui.commandEndpoints.textContent = `OUT #${transport.msgOut.endpointNumber} / IN #${transport.msgIn.endpointNumber}`;
  ui.poseEndpoint.textContent = `Interrupt IN #${transport.poseIn.endpointNumber}`;
  setStatus("ok", "T265 runtime claimed");
  log(`[${stamp()}] Runtime claimed: ${deviceId(device)} ${device.productName || ""}`);
  log(`IF ${transport.intf.interfaceNumber} alt ${transport.alt.alternateSetting}`);
  log(`Command: ${endpointText(transport.msgOut)}, ${endpointText(transport.msgIn)}`);
  log(`Pose: ${endpointText(transport.poseIn)}`);
  if (transport.streamIn) log(`Stream: ${endpointText(transport.streamIn)}`);
  updateButtons();
}

async function authorizeRuntime() {
  const device = await navigator.usb.requestDevice({ filters: RUNTIME_FILTERS });
  await prepareRuntime(device);
}

async function usePermittedRuntime() {
  const devices = await navigator.usb.getDevices();
  const device = devices.find(isRuntime);
  if (!device) throw new Error("No previously permitted 8087:0B37/0AF3 T265 runtime was found.");
  await prepareRuntime(device);
}

function makeRequest(messageId, payloadLength = 0) {
  const bytes = new Uint8Array(6 + payloadLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength, true);
  view.setUint16(4, messageId, true);
  return { bytes, view };
}

async function bulkRequest(messageId, payloadWriter = null, maxResponse = 1024) {
  if (!state.device || !state.endpoints) throw new Error("Runtime is not connected.");
  const payloadLength = payloadWriter?.length ?? 0;
  const request = makeRequest(messageId, payloadLength);
  if (payloadWriter?.write) payloadWriter.write(request.view, 6);

  const out = await state.device.transferOut(state.endpoints.msgOut.endpointNumber, request.bytes);
  if (out.status !== "ok") throw new Error(`${messageName(messageId)} transferOut returned ${out.status}.`);
  if (Number.isFinite(out.bytesWritten) && out.bytesWritten !== request.bytes.byteLength) {
    throw new Error(`${messageName(messageId)} short write ${out.bytesWritten}/${request.bytes.byteLength}.`);
  }

  const input = await state.device.transferIn(state.endpoints.msgIn.endpointNumber, maxResponse);
  if (input.status !== "ok" || !input.data) throw new Error(`${messageName(messageId)} transferIn returned ${input.status}.`);
  const view = input.data;
  if (view.byteLength < 8) throw new Error(`${messageName(messageId)} response is only ${view.byteLength} bytes.`);

  const declaredLength = view.getUint32(0, true);
  const responseId = view.getUint16(4, true);
  const status = view.getUint16(6, true);
  log(`${messageName(messageId)} -> ${messageName(responseId)} len=${declaredLength} status=${statusName(status)}`);
  if (responseId !== messageId) throw new Error(`Response ID mismatch: sent ${messageName(messageId)}, got ${messageName(responseId)}.`);
  if (declaredLength > view.byteLength) throw new Error(`${messageName(messageId)} truncated response ${view.byteLength}/${declaredLength}.`);
  if (status !== 0) throw new Error(`${messageName(messageId)} returned ${statusName(status)}.`);
  return view;
}

function fixedPayload(length, writer) {
  return { length, write: writer };
}

function parseDeviceInfo(view) {
  if (view.byteLength < 20) return { firmware: "response too short" };
  const major = view.getUint8(13);
  const minor = view.getUint8(14);
  const patch = view.getUint8(15);
  const build = view.getUint32(16, true);
  return { firmware: `${major}.${minor}.${patch}.${build}` };
}

function readUint64(view, offset) {
  if (typeof view.getBigUint64 === "function") return view.getBigUint64(offset, true);
  const lo = BigInt(view.getUint32(offset, true));
  const hi = BigInt(view.getUint32(offset + 4, true));
  return (hi << 32n) | lo;
}

function parseSupportedRawStreams(view) {
  if (view.byteLength < 12) throw new Error("Supported-stream response is too short.");
  const count = view.getUint16(8, true);
  const entrySize = 12;
  const required = 12 + count * entrySize;
  if (view.byteLength < required) throw new Error(`Supported-stream response truncated: ${view.byteLength}/${required}.`);
  const streams = [];
  for (let i = 0; i < count; i++) {
    const o = 12 + i * entrySize;
    const sensorId = view.getUint8(o);
    streams.push({
      sensorId,
      sensorType: sensorId & 0x1f,
      sensorIndex: (sensorId >> 5) & 0x07,
      reserved: view.getUint8(o + 1),
      width: view.getUint16(o + 2, true),
      height: view.getUint16(o + 4, true),
      pixelFormat: view.getUint8(o + 6),
      outputMode: view.getUint8(o + 7),
      stride: view.getUint16(o + 8, true),
      fps: view.getUint16(o + 10, true),
    });
  }
  return streams;
}

function streamDescription(stream) {
  const name = SENSOR_NAMES[stream.sensorType] || `Sensor${stream.sensorType}`;
  const geometry = stream.width && stream.height ? ` ${stream.width}x${stream.height}` : "";
  return `${name}[${stream.sensorIndex}]${geometry} @${stream.fps}Hz fmt=${stream.pixelFormat}`;
}

async function probeRuntime() {
  ui.probeRuntime.disabled = true;
  log(`[${stamp()}] Runtime protocol probe starting…`);

  await bulkRequest(MSG.DEV_SET_LOW_POWER_MODE, fixedPayload(2, (view, o) => {
    view.setUint8(o, 0);
    view.setUint8(o + 1, 0);
  }));

  const info = await bulkRequest(MSG.DEV_GET_DEVICE_INFO);
  const deviceInfo = parseDeviceInfo(info);
  ui.firmwareVersion.textContent = deviceInfo.firmware;
  log(`Firmware: ${deviceInfo.firmware}`);

  const time = await bulkRequest(MSG.DEV_GET_TIME);
  if (time.byteLength >= 16) {
    const ns = readUint64(time, 8);
    ui.deviceTime.textContent = `${(Number(ns) / 1e9).toFixed(3)} s`;
    log(`Device time: ${ns} ns`);
  }

  const supported = await bulkRequest(MSG.DEV_GET_SUPPORTED_RAW_STREAMS);
  state.rawStreams = parseSupportedRawStreams(supported);
  state.probed = true;
  ui.rawStreams.textContent = String(state.rawStreams.length);
  for (const stream of state.rawStreams) log(`  stream ${streamDescription(stream)}`);

  log(`RESULT: TM2 command transport is working over Bulk OUT/IN #2 (${state.rawStreams.length} raw stream profile(s)).`);
  setStatus("ok", "TM2 runtime protocol ready");
  updateButtons();
}

function rawStreamsControlPayload(streams) {
  const entrySize = 12;
  return fixedPayload(2 + streams.length * entrySize, (view, offset) => {
    view.setUint16(offset, streams.length, true);
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      const o = offset + 2 + i * entrySize;
      view.setUint8(o, stream.sensorId);
      view.setUint8(o + 1, stream.reserved || 0);
      view.setUint16(o + 2, stream.width, true);
      view.setUint16(o + 4, stream.height, true);
      view.setUint8(o + 6, stream.pixelFormat);
      view.setUint8(o + 7, 0); // Keep raw sensors internal to the T265; do not stream images/IMU to host.
      view.setUint16(o + 8, stream.stride, true);
      view.setUint16(o + 10, stream.fps, true);
    }
  });
}

async function configurePose() {
  if (!state.probed) await probeRuntime();
  if (!state.rawStreams.length) throw new Error("T265 reported no supported raw streams; refusing to start 6DoF.");

  log(`[${stamp()}] Configuring pose-only tracking…`);
  await bulkRequest(MSG.DEV_RAW_STREAMS_CONTROL, rawStreamsControlPayload(state.rawStreams));

  await bulkRequest(MSG.SLAM_SET_6DOF_INTERRUPT_RATE, fixedPayload(1, (view, o) => {
    view.setUint8(o, 1); // One pose interrupt per fisheye update: nominally 30 Hz.
  }));

  await bulkRequest(MSG.SLAM_6DOF_CONTROL, fixedPayload(2, (view, o) => {
    view.setUint8(o, 1); // enable 6DoF
    view.setUint8(o + 1, 0x06); // mapping + relocalization, matching librealsense default mode
  }));
}

function confidenceName(value) {
  return ["FAILED", "LOW", "MEDIUM", "HIGH"][Math.max(0, Math.min(3, Number(value) || 0))];
}

function trackerStateName(value) {
  if (value === 0x0) return "Inactive";
  if (value === 0x3) return "Active 3DoF";
  if (value === 0x4) return "Active 6DoF";
  if (value === 0x7) return "Inertial 3DoF";
  return `0x${hex(value, 8)}`;
}

function quaternionToEuler(x, y, z, w) {
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);
  return { roll, pitch, yaw };
}

function parsePosePacket(view) {
  const declaredLength = view.getUint32(0, true);
  const available = Math.min(view.byteLength, declaredLength || view.byteLength);
  const base = 8; // 6-byte interrupt header + bIndex + reserved
  if (available < 72) throw new Error(`Pose packet too short: ${available} bytes.`);

  const floats = [];
  const floatCount = available >= 104 ? 19 : 16;
  for (let i = 0; i < floatCount; i++) floats.push(view.getFloat32(base + i * 4, true));

  const pose = {
    x: floats[0], y: floats[1], z: floats[2],
    qi: floats[3], qj: floats[4], qk: floats[5], qr: floats[6],
    vx: floats[7], vy: floats[8], vz: floats[9],
    vax: floats[10], vay: floats[11], vaz: floats[12],
    ax: floats[13], ay: floats[14], az: floats[15],
    aax: floatCount >= 19 ? floats[16] : NaN,
    aay: floatCount >= 19 ? floats[17] : NaN,
    aaz: floatCount >= 19 ? floats[18] : NaN,
  };

  const tail = base + floatCount * 4;
  if (available >= tail + 20) {
    pose.timestampNs = readUint64(view, tail);
    pose.trackerConfidence = view.getUint32(tail + 8, true);
    pose.mapperConfidence = view.getUint32(tail + 12, true);
    pose.trackerState = view.getUint32(tail + 16, true);
  } else {
    pose.timestampNs = 0n;
    pose.trackerConfidence = 0;
    pose.mapperConfidence = 0;
    pose.trackerState = 0;
  }
  pose.packetLength = declaredLength || view.byteLength;
  return pose;
}

function displayPose(pose) {
  const euler = quaternionToEuler(pose.qi, pose.qj, pose.qk, pose.qr);
  const deg = 180 / Math.PI;
  const speed = Math.hypot(pose.vx, pose.vy, pose.vz);
  ui.poseX.textContent = `${pose.x.toFixed(4)} m`;
  ui.poseY.textContent = `${pose.y.toFixed(4)} m`;
  ui.poseZ.textContent = `${pose.z.toFixed(4)} m`;
  ui.poseRoll.textContent = `${(euler.roll * deg).toFixed(2)}°`;
  ui.posePitch.textContent = `${(euler.pitch * deg).toFixed(2)}°`;
  ui.poseYaw.textContent = `${(euler.yaw * deg).toFixed(2)}°`;
  ui.poseSpeed.textContent = `${speed.toFixed(4)} m/s`;
  ui.poseTimestamp.textContent = pose.timestampNs ? `${(Number(pose.timestampNs) / 1e9).toFixed(3)} s` : "—";
  ui.poseTrackerState.textContent = trackerStateName(pose.trackerState);
  ui.posePacketLength.textContent = `${pose.packetLength} B`;
  ui.poseConfidence.textContent = `${confidenceName(pose.trackerConfidence)} / ${confidenceName(pose.mapperConfidence & 0x3)}`;
}

function updatePoseRate() {
  const now = performance.now();
  if (!state.firstPoseAt) {
    state.firstPoseAt = now;
    state.lastRateAt = now;
    state.lastRateFrames = state.poseFrames;
    return;
  }
  const elapsed = now - state.lastRateAt;
  if (elapsed >= 1000) {
    const frames = state.poseFrames - state.lastRateFrames;
    ui.poseRate.textContent = `${(frames * 1000 / elapsed).toFixed(1)} Hz`;
    state.lastRateAt = now;
    state.lastRateFrames = state.poseFrames;
  }
}

async function interruptLoop() {
  const device = state.device;
  const endpoint = state.endpoints.poseIn.endpointNumber;
  let firstPoseLogged = false;
  while (state.poseReading && device === state.device) {
    try {
      const result = await device.transferIn(endpoint, 1024);
      if (!state.poseReading || device !== state.device) break;
      if (result.status !== "ok" || !result.data) {
        log(`Interrupt IN #${endpoint}: status=${result.status}`);
        continue;
      }
      const view = result.data;
      if (view.byteLength < 6) {
        log(`Interrupt IN #${endpoint}: short packet ${view.byteLength} B`);
        continue;
      }
      const declaredLength = view.getUint32(0, true);
      const id = view.getUint16(4, true);

      if (id === MSG.DEV_GET_POSE) {
        const pose = parsePosePacket(view);
        state.poseFrames++;
        ui.poseFrames.textContent = String(state.poseFrames);
        displayPose(pose);
        updatePoseRate();
        if (!firstPoseLogged) {
          firstPoseLogged = true;
          log(`[${stamp()}] FIRST POSE: packet=${pose.packetLength}B position=(${pose.x.toFixed(4)}, ${pose.y.toFixed(4)}, ${pose.z.toFixed(4)}) tracker=${confidenceName(pose.trackerConfidence)} state=${trackerStateName(pose.trackerState)}`);
          log("RESULT: live T265 6DoF pose packets are reaching JavaScript over Interrupt IN #3.");
          setStatus("ok", "LIVE T265 POSE");
        } else if (state.poseFrames % 300 === 0) {
          log(`Pose frame ${state.poseFrames}: ${ui.poseRate.textContent}, packet=${declaredLength}B, tracker=${confidenceName(pose.trackerConfidence)}`);
        }
      } else if (id === MSG.DEV_STATUS || id === MSG.DEV_ERROR || id === MSG.SLAM_ERROR) {
        const status = view.byteLength >= 8 ? view.getUint16(6, true) : 0xffff;
        log(`Interrupt ${messageName(id)} len=${declaredLength} status=${statusName(status)}`);
      } else {
        log(`Interrupt ${messageName(id)} len=${declaredLength} actual=${view.byteLength}`);
      }
    } catch (error) {
      if (state.poseReading) {
        log(`[${stamp()}] Interrupt read failed: ${error.name}: ${error.message}`);
        setStatus("bad", "Pose interrupt failed");
      }
      break;
    }
  }
}

async function startPose() {
  if (state.poseReading) return;
  ui.startPose.disabled = true;
  await configurePose();

  state.poseFrames = 0;
  state.firstPoseAt = 0;
  state.lastRateAt = 0;
  state.lastRateFrames = 0;
  ui.poseFrames.textContent = "0";
  ui.poseRate.textContent = "—";
  state.poseReading = true;
  updateButtons();

  log(`[${stamp()}] Arming Interrupt IN #${state.endpoints.poseIn.endpointNumber} before DEV_START…`);
  state.interruptTask = interruptLoop();
  await Promise.resolve();

  try {
    await bulkRequest(MSG.DEV_START);
    log("DEV_START accepted. Waiting for live 6DoF interrupt packets…");
    setStatus("warn", "Tracking started; waiting for pose");
  } catch (error) {
    state.poseReading = false;
    updateButtons();
    throw error;
  }
}

async function stopPose() {
  if (!state.device) return;
  if (!state.poseReading) {
    updateButtons();
    return;
  }
  log(`[${stamp()}] Sending DEV_STOP…`);
  try {
    await bulkRequest(MSG.DEV_STOP);
    log("DEV_STOP accepted.");
  } finally {
    state.poseReading = false;
    setStatus("ok", "T265 runtime claimed");
    updateButtons();
  }
}

async function closeRuntime() {
  if (!state.device) return;
  if (state.poseReading) await stopPose();
  const device = state.device;
  const interfaceNumber = state.interfaceNumber;
  state.device = null;
  state.endpoints = null;
  state.interfaceNumber = null;
  state.rawStreams = [];
  state.probed = false;
  try {
    if (device.opened && interfaceNumber != null) await device.releaseInterface(interfaceNumber);
  } catch (_) {}
  try {
    if (device.opened) await device.close();
  } catch (_) {}
  ui.runtimeDevice.textContent = "—";
  ui.runtimeInterface.textContent = "—";
  ui.commandEndpoints.textContent = "—";
  ui.poseEndpoint.textContent = "—";
  setStatus("ok", "WebUSB available");
  log(`[${stamp()}] Runtime connection closed.`);
  updateButtons();
}

function reportError(context, error) {
  const message = `${context}: ${error?.name || "Error"}: ${error?.message || error}`;
  log(`[${stamp()}] ${message}`);
  setStatus("bad", context);
  updateButtons();
}

ui.authorizeRuntime.addEventListener("click", () => authorizeRuntime().catch((error) => {
  if (error?.name !== "NotFoundError") reportError("Runtime authorization failed", error);
}));
ui.usePermittedRuntime.addEventListener("click", () => usePermittedRuntime().catch((error) => reportError("Runtime lookup failed", error)));
ui.closeRuntime.addEventListener("click", () => closeRuntime().catch((error) => reportError("Runtime close failed", error)));
ui.probeRuntime.addEventListener("click", () => probeRuntime().catch((error) => reportError("Runtime probe failed", error)).finally(updateButtons));
ui.startPose.addEventListener("click", () => startPose().catch((error) => reportError("Pose start failed", error)));
ui.stopPose.addEventListener("click", () => stopPose().catch((error) => reportError("Pose stop failed", error)));
ui.copyLog.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.report || ui.log.textContent);
    ui.copyLog.textContent = "Copied";
  } catch (_) {
    ui.copyLog.textContent = "Copy failed";
  }
  setTimeout(() => { ui.copyLog.textContent = "Copy log"; }, 1000);
});
ui.clearLog.addEventListener("click", resetLog);

if ("usb" in navigator) {
  setStatus("ok", "WebUSB available");
  log(`[${stamp()}] WebUSB available. Secure context=${window.isSecureContext}`);
  navigator.usb.addEventListener("connect", (event) => {
    if (isRuntime(event.device)) log(`[${stamp()}] USB runtime connect: ${deviceId(event.device)} ${event.device.productName || ""}`);
  });
  navigator.usb.addEventListener("disconnect", (event) => {
    if (!isRuntime(event.device)) return;
    log(`[${stamp()}] USB runtime disconnect: ${deviceId(event.device)} ${event.device.productName || ""}`);
    if (event.device === state.device) {
      state.poseReading = false;
      state.device = null;
      state.endpoints = null;
      state.interfaceNumber = null;
      state.rawStreams = [];
      state.probed = false;
      setStatus("bad", "T265 disconnected");
      updateButtons();
    }
  });
  updateButtons();
} else {
  setStatus("bad", "WebUSB unavailable");
  for (const button of [ui.authorizeRuntime, ui.usePermittedRuntime, ui.closeRuntime, ui.probeRuntime, ui.startPose, ui.stopPose]) button.disabled = true;
  log("WebUSB is unavailable. Use a current desktop Chrome or Edge browser over HTTPS.");
}
