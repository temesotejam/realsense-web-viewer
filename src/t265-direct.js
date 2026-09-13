const RUNTIME_FILTERS = [
  { vendorId: 0x8087, productId: 0x0b37 },
  { vendorId: 0x8087, productId: 0x0af3 },
];

const MSG = Object.freeze({
  DEV_GET_DEVICE_INFO: 0x0001,
  DEV_GET_SUPPORTED_RAW_STREAMS: 0x0004,
  DEV_RAW_STREAMS_CONTROL: 0x0005,
  DEV_START: 0x0012,
  DEV_STOP: 0x0013,
  DEV_STATUS: 0x0014,
  DEV_GET_POSE: 0x0015,
  DEV_SET_LOW_POWER_MODE: 0x0025,
  DEV_ERROR: 0x8000,
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
  0x0008: "DEVICE_BUSY",
  0x0009: "TIMEOUT",
  0x000c: "DEVICE_STOPPED",
});

const connectButton = document.getElementById("connectT265Webusb");
const stopButton = document.getElementById("stopT265Webusb");
const hint = document.getElementById("t265WebusbHint");

const direct = {
  device: null,
  interfaceNumber: null,
  endpoints: null,
  streaming: false,
  readTask: null,
  frame: 0,
  rateWindowStart: 0,
  rateWindowFrame: 0,
  poseRate: 0,
};

function emitState(state, extra = {}) {
  window.dispatchEvent(new CustomEvent("realsense:t265-state", {
    detail: { state, ...extra },
  }));
}

function emitPose(pose) {
  window.dispatchEvent(new CustomEvent("realsense:t265-pose", { detail: pose }));
}

function setHint(text) {
  if (hint) hint.textContent = text;
}

function setButtons() {
  if (connectButton) {
    connectButton.disabled = direct.streaming;
    connectButton.textContent = direct.streaming ? "T265 streaming" : "Connect T265 WebUSB";
  }
  if (stopButton) stopButton.disabled = !direct.streaming;
}

function hex(value, width = 4) {
  return Number(value ?? 0).toString(16).toUpperCase().padStart(width, "0");
}

function deviceId(device) {
  return `${hex(device.vendorId)}:${hex(device.productId)}`;
}

function isRuntime(device) {
  return RUNTIME_FILTERS.some((filter) => device.vendorId === filter.vendorId && device.productId === filter.productId);
}

async function ensureOpen(device) {
  if (!device.opened) await device.open();
  if (!device.configuration) {
    const configurationValue = device.configurations?.[0]?.configurationValue || 1;
    await device.selectConfiguration(configurationValue);
  }
}

function findTransport(device) {
  for (const intf of Array.from(device.configuration?.interfaces || [])) {
    for (const alt of Array.from(intf.alternates || [])) {
      if (alt.interfaceClass !== 0xff) continue;
      const eps = Array.from(alt.endpoints || []);
      const msgOut = eps.find((ep) => ep.direction === "out" && ep.type === "bulk" && ep.endpointNumber === 2);
      const msgIn = eps.find((ep) => ep.direction === "in" && ep.type === "bulk" && ep.endpointNumber === 2);
      const poseIn = eps.find((ep) => ep.direction === "in" && ep.type === "interrupt" && ep.endpointNumber === 3);
      if (msgOut && msgIn && poseIn) return { intf, alt, msgOut, msgIn, poseIn };
    }
  }
  throw new Error("T265 command Bulk #2 and Interrupt IN #3 endpoints were not found.");
}

async function claimRuntime(device) {
  await ensureOpen(device);
  const transport = findTransport(device);
  if (!transport.intf.claimed) await device.claimInterface(transport.intf.interfaceNumber);
  if (transport.intf.alternate?.alternateSetting !== transport.alt.alternateSetting) {
    await device.selectAlternateInterface(transport.intf.interfaceNumber, transport.alt.alternateSetting);
  }
  direct.device = device;
  direct.interfaceNumber = transport.intf.interfaceNumber;
  direct.endpoints = transport;
  return transport;
}

async function getRuntimeFromGesture() {
  const permitted = (await navigator.usb.getDevices()).find(isRuntime);
  if (permitted) return permitted;
  return navigator.usb.requestDevice({ filters: RUNTIME_FILTERS });
}

function makeRequest(messageId, payloadLength = 0) {
  const bytes = new Uint8Array(6 + payloadLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength, true);
  view.setUint16(4, messageId, true);
  return { bytes, view };
}

function fixedPayload(length, write) {
  return { length, write };
}

function statusName(status) {
  return STATUS[status] || `0x${hex(status, 4)}`;
}

async function bulkRequest(messageId, payload = null, maxResponse = 1024) {
  if (!direct.device || !direct.endpoints) throw new Error("T265 runtime is not claimed.");
  const request = makeRequest(messageId, payload?.length || 0);
  if (payload?.write) payload.write(request.view, 6);

  const out = await direct.device.transferOut(direct.endpoints.msgOut.endpointNumber, request.bytes);
  if (out.status !== "ok") throw new Error(`TM2 0x${hex(messageId, 4)} transferOut=${out.status}`);
  if (Number.isFinite(out.bytesWritten) && out.bytesWritten !== request.bytes.byteLength) {
    throw new Error(`TM2 0x${hex(messageId, 4)} short write ${out.bytesWritten}/${request.bytes.byteLength}`);
  }

  const input = await direct.device.transferIn(direct.endpoints.msgIn.endpointNumber, maxResponse);
  if (input.status !== "ok" || !input.data || input.data.byteLength < 8) {
    throw new Error(`TM2 0x${hex(messageId, 4)} invalid response (${input.status})`);
  }
  const view = input.data;
  const declared = view.getUint32(0, true);
  const responseId = view.getUint16(4, true);
  const status = view.getUint16(6, true);
  if (responseId !== messageId) throw new Error(`TM2 response ID mismatch 0x${hex(responseId, 4)}`);
  if (declared > view.byteLength) throw new Error(`TM2 truncated response ${view.byteLength}/${declared}`);
  if (status !== 0) throw new Error(`TM2 0x${hex(messageId, 4)} ${statusName(status)}`);
  return view;
}

function parseDeviceInfo(view) {
  return {
    firmware: `${view.getUint8(13)}.${view.getUint8(14)}.${view.getUint8(15)}.${view.getUint32(16, true)}`,
  };
}

function parseSupportedRawStreams(view) {
  const count = view.getUint16(8, true);
  const streams = [];
  for (let i = 0; i < count; i++) {
    const o = 12 + i * 12;
    if (o + 12 > view.byteLength) break;
    const sensorId = view.getUint8(o);
    streams.push({
      sensorId,
      sensorType: sensorId & 0x1f,
      sensorIndex: (sensorId >> 5) & 0x07,
      reserved: view.getUint8(o + 1),
      width: view.getUint16(o + 2, true),
      height: view.getUint16(o + 4, true),
      pixelFormat: view.getUint8(o + 6),
      stride: view.getUint16(o + 8, true),
      fps: view.getUint16(o + 10, true),
    });
  }
  return streams;
}

function selectTrackingProfiles(streams) {
  const selected = streams.filter((s) =>
    (s.sensorType === 3 && (s.sensorIndex === 0 || s.sensorIndex === 1) && s.fps === 30) ||
    (s.sensorType === 4 && s.sensorIndex === 0 && s.fps === 200) ||
    (s.sensorType === 5 && s.sensorIndex === 0 && s.fps === 62)
  );
  const valid = selected.length === 4 &&
    selected.some((s) => s.sensorType === 3 && s.sensorIndex === 0) &&
    selected.some((s) => s.sensorType === 3 && s.sensorIndex === 1) &&
    selected.some((s) => s.sensorType === 4 && s.fps === 200) &&
    selected.some((s) => s.sensorType === 5 && s.fps === 62);
  if (!valid) throw new Error("T265 librealsense tracking profile set could not be resolved.");
  return selected;
}

function rawStreamsPayload(streams) {
  return fixedPayload(2 + streams.length * 12, (view, offset) => {
    view.setUint16(offset, streams.length, true);
    streams.forEach((s, i) => {
      const o = offset + 2 + i * 12;
      view.setUint8(o, s.sensorId);
      view.setUint8(o + 1, s.reserved || 0);
      view.setUint16(o + 2, s.width, true);
      view.setUint16(o + 4, s.height, true);
      view.setUint8(o + 6, s.pixelFormat);
      view.setUint8(o + 7, 0); // Internal SLAM input only.
      view.setUint16(o + 8, s.stride, true);
      view.setUint16(o + 10, s.fps, true);
    });
  });
}

function readUint64(view, offset) {
  if (typeof view.getBigUint64 === "function") return view.getBigUint64(offset, true);
  return (BigInt(view.getUint32(offset + 4, true)) << 32n) | BigInt(view.getUint32(offset, true));
}

function quaternionToEuler(x, y, z, w) {
  const sinr = 2 * (w * x + y * z);
  const cosr = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr, cosr);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  return { roll, pitch, yaw: Math.atan2(siny, cosy) };
}

function parsePose(view) {
  const declared = view.getUint32(0, true);
  if (declared < 104 || view.byteLength < 104) throw new Error(`Unexpected T265 pose packet length ${declared}/${view.byteLength}`);
  const base = 8;
  const f = [];
  for (let i = 0; i < 19; i++) f.push(view.getFloat32(base + i * 4, true));
  const euler = quaternionToEuler(f[3], f[4], f[5], f[6]);
  return {
    x: f[0], y: f[1], z: f[2],
    qx: f[3], qy: f[4], qz: f[5], qw: f[6],
    vx: f[7], vy: f[8], vz: f[9],
    angularVelocity: { x: f[10], y: f[11], z: f[12] },
    acceleration: { x: f[13], y: f[14], z: f[15] },
    angularAcceleration: { x: f[16], y: f[17], z: f[18] },
    roll: euler.roll, pitch: euler.pitch, yaw: euler.yaw,
    deviceTimestampNs: readUint64(view, 84),
    confidence: view.getUint32(92, true),
    mapperConfidence: view.getUint32(96, true) & 0x3,
    trackerState: view.getUint32(100, true),
    packetLength: declared,
  };
}

function updateRate() {
  const now = performance.now();
  if (!direct.rateWindowStart) {
    direct.rateWindowStart = now;
    direct.rateWindowFrame = direct.frame;
    return;
  }
  const dt = now - direct.rateWindowStart;
  if (dt >= 1000) {
    direct.poseRate = (direct.frame - direct.rateWindowFrame) * 1000 / dt;
    direct.rateWindowStart = now;
    direct.rateWindowFrame = direct.frame;
    setHint(`Direct WebUSB pose · ${direct.poseRate.toFixed(1)} Hz · Interrupt IN #3`);
    emitState("streaming", { poseRate: direct.poseRate, frame: direct.frame });
  }
}

async function interruptLoop() {
  const device = direct.device;
  const endpoint = direct.endpoints.poseIn.endpointNumber;
  while (direct.streaming && device === direct.device) {
    try {
      const result = await device.transferIn(endpoint, 1024);
      if (!direct.streaming || device !== direct.device) break;
      if (result.status !== "ok" || !result.data || result.data.byteLength < 6) continue;
      const id = result.data.getUint16(4, true);
      if (id === MSG.DEV_GET_POSE) {
        const pose = parsePose(result.data);
        direct.frame++;
        updateRate();
        emitPose({ ...pose, frame: direct.frame, poseRate: direct.poseRate });
      }
    } catch (error) {
      if (direct.streaming) {
        direct.streaming = false;
        setButtons();
        setHint(`T265 interrupt error: ${error.message}`);
        emitState("error", { message: error.message });
      }
      break;
    }
  }
}

async function configureAndStart() {
  await bulkRequest(MSG.DEV_SET_LOW_POWER_MODE, fixedPayload(2, (view, o) => {
    view.setUint8(o, 0);
    view.setUint8(o + 1, 0);
  }));

  const info = parseDeviceInfo(await bulkRequest(MSG.DEV_GET_DEVICE_INFO));
  const streams = parseSupportedRawStreams(await bulkRequest(MSG.DEV_GET_SUPPORTED_RAW_STREAMS));
  const trackingStreams = selectTrackingProfiles(streams);
  await bulkRequest(MSG.DEV_RAW_STREAMS_CONTROL, rawStreamsPayload(trackingStreams));

  // FW 0.2.0.951 returns UNKNOWN_MESSAGE_ID for SLAM_SET_6DOF_INTERRUPT_RATE.
  // T265-compatible librealsense does not need to send it; use firmware default.
  await bulkRequest(MSG.SLAM_6DOF_CONTROL, fixedPayload(2, (view, o) => {
    view.setUint8(o, 1);
    view.setUint8(o + 1, 0x06); // mapping + relocalization
  }));

  direct.frame = 0;
  direct.poseRate = 0;
  direct.rateWindowStart = 0;
  direct.rateWindowFrame = 0;
  direct.streaming = true;
  setButtons();
  setHint(`Starting direct pose · firmware ${info.firmware}`);
  emitState("starting", { model: "Intel RealSense Tracking Camera T265", firmware: info.firmware });
  direct.readTask = interruptLoop();
  await Promise.resolve();
  await bulkRequest(MSG.DEV_START);
  emitState("streaming", { model: "Intel RealSense Tracking Camera T265", firmware: info.firmware, poseRate: 0, frame: 0 });
}

async function startDirect() {
  if (!("usb" in navigator)) throw new Error("WebUSB is unavailable. Use desktop Chrome/Edge over HTTPS.");
  if (direct.streaming) return;
  setHint("Looking for T265 runtime 8087:0B37…");
  const device = await getRuntimeFromGesture();
  const transport = await claimRuntime(device);
  setHint(`${deviceId(device)} claimed · Bulk #${transport.msgOut.endpointNumber} / Interrupt #${transport.poseIn.endpointNumber}`);
  emitState("connected", { model: device.productName || "Intel RealSense Tracking Camera T265" });
  await configureAndStart();
}

async function stopDirect({ close = false } = {}) {
  if (direct.device && direct.streaming) {
    try { await bulkRequest(MSG.DEV_STOP); } catch (_) {}
  }
  direct.streaming = false;
  setButtons();
  if (close && direct.device) {
    const device = direct.device;
    const interfaceNumber = direct.interfaceNumber;
    direct.device = null;
    direct.endpoints = null;
    direct.interfaceNumber = null;
    try { if (device.opened && interfaceNumber != null) await device.releaseInterface(interfaceNumber); } catch (_) {}
    try { if (device.opened) await device.close(); } catch (_) {}
  }
  setHint("T265 WebUSB stopped.");
  emitState("stopped");
}

function reportError(error) {
  if (error?.name === "NotFoundError") {
    setHint("No runtime T265 selected. If the camera is 03E7:2150, boot it first in Boot Lab.");
    return;
  }
  setHint(`T265 WebUSB error: ${error?.message || error}`);
  emitState("error", { message: error?.message || String(error) });
}

connectButton?.addEventListener("click", () => startDirect().catch(reportError));
stopButton?.addEventListener("click", () => stopDirect().catch(reportError));

if ("usb" in navigator) {
  navigator.usb.addEventListener("disconnect", (event) => {
    if (event.device !== direct.device) return;
    direct.streaming = false;
    direct.device = null;
    direct.endpoints = null;
    direct.interfaceNumber = null;
    setButtons();
    setHint("T265 runtime disconnected.");
    emitState("disconnected");
  });
  setHint("Direct T265 WebUSB is ready. Boot Lab is only needed when the device is 03E7:2150.");
} else {
  if (connectButton) connectButton.disabled = true;
  setHint("WebUSB unavailable. Use desktop Chrome/Edge over HTTPS.");
}

window.addEventListener("beforeunload", () => {
  if (direct.device?.opened) direct.device.close().catch(() => {});
});

setButtons();
