(() => {
  const USBDeviceCtor = globalThis.USBDevice;
  if (!USBDeviceCtor?.prototype?.transferOut || !USBDeviceCtor?.prototype?.transferIn) return;

  const originalTransferOut = USBDeviceCtor.prototype.transferOut;
  const originalTransferIn = USBDeviceCtor.prototype.transferIn;
  const DEV_RAW_STREAMS_CONTROL = 0x0005;
  const SLAM_SET_6DOF_INTERRUPT_RATE = 0x1005;
  const COMMAND_ENDPOINT = 2;
  const ENTRY_SIZE = 12;
  const HEADER_SIZE = 8; // 6-byte request header + uint16 stream count
  const pendingSyntheticRateResponse = new WeakSet();

  function asBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function describe(entry) {
    const type = entry.sensorId & 0x1f;
    const index = (entry.sensorId >> 5) & 0x07;
    const names = { 3: "Fisheye", 4: "Gyro", 5: "Accelerometer" };
    return `${names[type] || `Sensor${type}`}[${index}] @${entry.fps}Hz`;
  }

  function selectLibrealsenseProfiles(bytes) {
    if (bytes.byteLength < HEADER_SIZE) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declaredLength = view.getUint32(0, true);
    const messageId = view.getUint16(4, true);
    if (messageId !== DEV_RAW_STREAMS_CONTROL) return null;

    const count = view.getUint16(6, true);
    if (declaredLength !== bytes.byteLength || bytes.byteLength !== HEADER_SIZE + count * ENTRY_SIZE) return null;

    const entries = [];
    for (let i = 0; i < count; i++) {
      const offset = HEADER_SIZE + i * ENTRY_SIZE;
      const sensorId = view.getUint8(offset);
      entries.push({
        offset,
        sensorId,
        type: sensorId & 0x1f,
        index: (sensorId >> 5) & 0x07,
        fps: view.getUint16(offset + 10, true),
      });
    }

    const selected = entries.filter((entry) =>
      (entry.type === 3 && (entry.index === 0 || entry.index === 1)) ||
      (entry.type === 4 && entry.index === 0 && entry.fps === 200) ||
      (entry.type === 5 && entry.index === 0 && entry.fps === 62)
    );

    const valid = selected.length === 4 &&
      selected.some((e) => e.type === 3 && e.index === 0) &&
      selected.some((e) => e.type === 3 && e.index === 1) &&
      selected.some((e) => e.type === 4 && e.index === 0 && e.fps === 200) &&
      selected.some((e) => e.type === 5 && e.index === 0 && e.fps === 62);
    if (!valid) return null;

    const fixed = new Uint8Array(HEADER_SIZE + selected.length * ENTRY_SIZE);
    const fixedView = new DataView(fixed.buffer);
    fixedView.setUint32(0, fixed.byteLength, true);
    fixedView.setUint16(4, DEV_RAW_STREAMS_CONTROL, true);
    fixedView.setUint16(6, selected.length, true);
    selected.forEach((entry, i) => {
      const target = HEADER_SIZE + i * ENTRY_SIZE;
      fixed.set(bytes.subarray(entry.offset, entry.offset + ENTRY_SIZE), target);
      fixed[target + 7] = 0; // Internal SLAM input only; do not export raw frames to the host.
    });

    return { fixed, count, selected };
  }

  function appendLog(text) {
    const log = document.getElementById("log");
    if (!log) return;
    const current = log.textContent === "Ready." ? "" : log.textContent;
    log.textContent = `${current}${text}\n`;
    log.scrollTop = log.scrollHeight;
  }

  USBDeviceCtor.prototype.transferOut = function patchedTransferOut(endpointNumber, data) {
    try {
      if (endpointNumber === COMMAND_ENDPOINT) {
        const bytes = asBytes(data);
        if (bytes?.byteLength >= 6) {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const messageId = view.getUint16(4, true);

          if (messageId === SLAM_SET_6DOF_INTERRUPT_RATE) {
            pendingSyntheticRateResponse.add(this);
            const line = "[FW0951] Skipping unsupported SLAM_SET_6DOF_INTERRUPT_RATE (0x1005); using firmware default interrupt rate.";
            console.info(line);
            appendLog(line);
            return Promise.resolve({ status: "ok", bytesWritten: bytes.byteLength });
          }
        }

        const result = bytes && selectLibrealsenseProfiles(bytes);
        if (result && result.count !== result.selected.length) {
          const logicalLength = bytes.byteLength;
          const summary = result.selected.map(describe).join(", ");
          const line = `[RAWFIX] DEV_RAW_STREAMS_CONTROL ${result.count} -> ${result.selected.length}: ${summary}; USB ${logicalLength} -> ${result.fixed.byteLength} B`;
          console.info(line);
          appendLog(line);
          return originalTransferOut.call(this, endpointNumber, result.fixed).then((transferResult) => {
            if (transferResult?.status === "ok" &&
                Number.isFinite(transferResult.bytesWritten) &&
                transferResult.bytesWritten === result.fixed.byteLength) {
              return { status: transferResult.status, bytesWritten: logicalLength };
            }
            return transferResult;
          });
        }
      }
    } catch (error) {
      console.warn("T265 compatibility patch failed; sending original packet.", error);
    }
    return originalTransferOut.call(this, endpointNumber, data);
  };

  USBDeviceCtor.prototype.transferIn = function patchedTransferIn(endpointNumber, length) {
    if (endpointNumber === COMMAND_ENDPOINT && pendingSyntheticRateResponse.has(this)) {
      pendingSyntheticRateResponse.delete(this);
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setUint32(0, 8, true);
      view.setUint16(4, SLAM_SET_6DOF_INTERRUPT_RATE, true);
      view.setUint16(6, 0, true); // SUCCESS: the command itself was intentionally omitted.
      return Promise.resolve({ status: "ok", data: view });
    }
    return originalTransferIn.call(this, endpointNumber, length);
  };
})();
