(() => {
  const USBDeviceCtor = globalThis.USBDevice;
  if (!USBDeviceCtor?.prototype?.transferOut || !USBDeviceCtor?.prototype?.transferIn) return;

  const originalTransferOut = USBDeviceCtor.prototype.transferOut;
  const originalTransferIn = USBDeviceCtor.prototype.transferIn;
  const COMMAND_ENDPOINT = 2;
  const SLAM_SET_6DOF_INTERRUPT_RATE = 0x1005;
  const pendingSyntheticResponse = new WeakSet();

  function asBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function appendLog(text) {
    const log = document.getElementById("log");
    if (!log) return;
    const current = log.textContent === "Ready." ? "" : log.textContent;
    log.textContent = `${current}${text}\n`;
    log.scrollTop = log.scrollHeight;
  }

  USBDeviceCtor.prototype.transferOut = function patchedTransferOut(endpointNumber, data) {
    if (endpointNumber === COMMAND_ENDPOINT) {
      const bytes = asBytes(data);
      if (bytes?.byteLength >= 6) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const messageId = view.getUint16(4, true);
        if (messageId === SLAM_SET_6DOF_INTERRUPT_RATE) {
          pendingSyntheticResponse.add(this);
          const line = "[FW0951] Skipping unsupported SLAM_SET_6DOF_INTERRUPT_RATE (0x1005); firmware default interrupt rate will be used.";
          console.info(line);
          appendLog(line);
          return Promise.resolve({ status: "ok", bytesWritten: bytes.byteLength });
        }
      }
    }
    return originalTransferOut.call(this, endpointNumber, data);
  };

  USBDeviceCtor.prototype.transferIn = function patchedTransferIn(endpointNumber, length) {
    if (endpointNumber === COMMAND_ENDPOINT && pendingSyntheticResponse.has(this)) {
      pendingSyntheticResponse.delete(this);
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setUint32(0, 8, true);
      view.setUint16(4, SLAM_SET_6DOF_INTERRUPT_RATE, true);
      view.setUint16(6, 0, true); // SUCCESS; command intentionally omitted for FW 0.2.0.951 compatibility.
      return Promise.resolve({ status: "ok", data: view });
    }
    return originalTransferIn.call(this, endpointNumber, length);
  };
})();
