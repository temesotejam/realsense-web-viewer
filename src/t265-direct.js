(() => {
  const NativeWebSocket = window.WebSocket;
  const DIRECT_URL = "webusb-t265://runtime";
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
    DEV_GET_POSE: 0x0015,
    DEV_SET_LOW_POWER_MODE: 0x0025,
    SLAM_6DOF_CONTROL: 0x1006,
  });

  const selected = { device: null };
  let activeDirectSocket = null;

  function hex(value, width = 4) {
    return Number(value ?? 0).toString(16).toUpperCase().padStart(width, "0");
  }

  function isRuntime(device) {
    return RUNTIME_FILTERS.some((f) => device.vendorId === f.vendorId && device.productId === f.productId);
  }

  function setDirectHint(text) {
    const hint = document.getElementById("t265WebusbHint");
    if (hint) hint.textContent = text;
  }

  function setTransportLabel(text) {
    const el = document.getElementById("transportValue");
    if (el) el.textContent = text;
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

  function readUint64(view, offset) {
    if (typeof view.getBigUint64 === "function") return view.getBigUint64(offset, true);
    return (BigInt(view.getUint32(offset + 4, true)) << 32n) | BigInt(view.getUint32(offset, true));
  }

  class T265DirectSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = T265DirectSocket.CONNECTING;
      this.protocol = "";
      this.extensions = "";
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;

      this.device = selected.device;
      selected.device = null;
      this.interfaceNumber = null;
      this.endpoints = null;
      this.streaming = false;
      this.frame = 0;
      this.rateStart = 0;
      this.rateFrame = 0;
      this.poseRate = 0;
      this.lastViewerEmit = 0;

      queueMicrotask(() => this.start().catch((error) => this.fail(error)));
    }

    send() {
      // The main viewer sends viewer_hello after open. The in-browser transport
      // already owns the USB session, so no response is required here.
    }

    async close() {
      if (this.readyState === T265DirectSocket.CLOSED || this.readyState === T265DirectSocket.CLOSING) return;
      this.readyState = T265DirectSocket.CLOSING;
      await this.stopUsb();
      this.readyState = T265DirectSocket.CLOSED;
      setDirectHint("T265 WebUSB stopped.");
      setTransportLabel("WEBUSB");
      this.onclose?.({ code: 1000, reason: "T265 WebUSB closed", wasClean: true });
    }

    emitMessage(message) {
      if (this.readyState !== T265DirectSocket.OPEN) return;
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    async start() {
      if (!this.device || !isRuntime(this.device)) {
        throw new Error("No authorized 8087:0B37/0AF3 T265 runtime was supplied.");
      }
      await this.claimRuntime();
      const info = await this.configureTracking();

      this.streaming = true;
      this.frame = 0;
      this.rateStart = 0;
      this.rateFrame = 0;
      this.poseRate = 0;
      this.lastViewerEmit = 0;

      this.readInterrupts();
      await Promise.resolve();
      await this.bulkRequest(MSG.DEV_START);

      this.readyState = T265DirectSocket.OPEN;
      globalThis.dispatchEvent(new CustomEvent("realsense-t265-status", { detail: { active: true, firmware: info.firmware, transport: "webusb" } }));
      setTransportLabel("WEBUSB");
      setDirectHint(`T265 direct WebUSB started · FW ${info.firmware} · waiting for pose…`);
      this.onopen?.({ type: "open" });
      this.emitMessage({
        type: "device",
        model: "Intel(R) RealSense(TM) Tracking Camera T265",
        firmware: info.firmware,
        transport: "webusb",
      });
    }

    async claimRuntime() {
      const device = this.device;
      if (!device.opened) await device.open();
      if (!device.configuration) {
        const configurationValue = device.configurations?.[0]?.configurationValue || 1;
        await device.selectConfiguration(configurationValue);
      }

      for (const intf of Array.from(device.configuration?.interfaces || [])) {
        for (const alt of Array.from(intf.alternates || [])) {
          if (alt.interfaceClass !== 0xff) continue;
          const eps = Array.from(alt.endpoints || []);
          const msgOut = eps.find((ep) => ep.direction === "out" && ep.type === "bulk" && ep.endpointNumber === 2);
          const msgIn = eps.find((ep) => ep.direction === "in" && ep.type === "bulk" && ep.endpointNumber === 2);
          const poseIn = eps.find((ep) => ep.direction === "in" && ep.type === "interrupt" && ep.endpointNumber === 3);
          if (!msgOut || !msgIn || !poseIn) continue;

          if (!intf.claimed) await device.claimInterface(intf.interfaceNumber);
          if (intf.alternate?.alternateSetting !== alt.alternateSetting) {
            await device.selectAlternateInterface(intf.interfaceNumber, alt.alternateSetting);
          }
          this.interfaceNumber = intf.interfaceNumber;
          this.endpoints = { msgOut, msgIn, poseIn };
          setDirectHint(`8087:${hex(device.productId)} claimed · Bulk #2 · Interrupt #3`);
          return;
        }
      }
      throw new Error("T265 runtime endpoints (#2 Bulk IN/OUT and #3 Interrupt IN) were not found.");
    }

    async bulkRequest(messageId, payload = null, maxResponse = 1024) {
      if (!this.device || !this.endpoints) throw new Error("T265 runtime is not ready.");
      const request = makeRequest(messageId, payload?.length || 0);
      if (payload?.write) payload.write(request.view, 6);

      const out = await this.device.transferOut(this.endpoints.msgOut.endpointNumber, request.bytes);
      if (out.status !== "ok") throw new Error(`TM2 0x${hex(messageId, 4)} OUT=${out.status}`);
      if (Number.isFinite(out.bytesWritten) && out.bytesWritten !== request.bytes.byteLength) {
        throw new Error(`TM2 0x${hex(messageId, 4)} short write ${out.bytesWritten}/${request.bytes.byteLength}`);
      }

      const input = await this.device.transferIn(this.endpoints.msgIn.endpointNumber, maxResponse);
      if (input.status !== "ok" || !input.data || input.data.byteLength < 8) {
        throw new Error(`TM2 0x${hex(messageId, 4)} invalid response`);
      }
      const view = input.data;
      const declared = view.getUint32(0, true);
      const responseId = view.getUint16(4, true);
      const status = view.getUint16(6, true);
      if (responseId !== messageId) throw new Error(`TM2 response mismatch 0x${hex(responseId, 4)}`);
      if (declared > view.byteLength) throw new Error(`TM2 truncated response ${view.byteLength}/${declared}`);
      if (status !== 0) throw new Error(`TM2 0x${hex(messageId, 4)} status=0x${hex(status, 4)}`);
      return view;
    }

    parseDeviceInfo(view) {
      return {
        firmware: `${view.getUint8(13)}.${view.getUint8(14)}.${view.getUint8(15)}.${view.getUint32(16, true)}`,
      };
    }

    parseSupportedStreams(view) {
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

    selectTrackingStreams(streams) {
      const selectedStreams = streams.filter((s) =>
        (s.sensorType === 3 && (s.sensorIndex === 0 || s.sensorIndex === 1) && s.fps === 30) ||
        (s.sensorType === 4 && s.sensorIndex === 0 && s.fps === 200) ||
        (s.sensorType === 5 && s.sensorIndex === 0 && s.fps === 62)
      );
      const valid = selectedStreams.length === 4 &&
        selectedStreams.some((s) => s.sensorType === 3 && s.sensorIndex === 0) &&
        selectedStreams.some((s) => s.sensorType === 3 && s.sensorIndex === 1) &&
        selectedStreams.some((s) => s.sensorType === 4 && s.fps === 200) &&
        selectedStreams.some((s) => s.sensorType === 5 && s.fps === 62);
      if (!valid) throw new Error("Could not resolve the T265 librealsense tracking profile set.");
      return selectedStreams;
    }

    rawStreamsPayload(streams) {
      return fixedPayload(2 + streams.length * 12, (view, offset) => {
        view.setUint16(offset, streams.length, true);
        streams.forEach((s, i) => {
          const o = offset + 2 + i * 12;
          view.setUint8(o, s.sensorId);
          view.setUint8(o + 1, s.reserved || 0);
          view.setUint16(o + 2, s.width, true);
          view.setUint16(o + 4, s.height, true);
          view.setUint8(o + 6, s.pixelFormat);
          view.setUint8(o + 7, 0);
          view.setUint16(o + 8, s.stride, true);
          view.setUint16(o + 10, s.fps, true);
        });
      });
    }

    async configureTracking() {
      await this.bulkRequest(MSG.DEV_SET_LOW_POWER_MODE, fixedPayload(2, (view, o) => {
        view.setUint8(o, 0);
        view.setUint8(o + 1, 0);
      }));
      const info = this.parseDeviceInfo(await this.bulkRequest(MSG.DEV_GET_DEVICE_INFO));
      const streams = this.parseSupportedStreams(await this.bulkRequest(MSG.DEV_GET_SUPPORTED_RAW_STREAMS));
      await this.bulkRequest(MSG.DEV_RAW_STREAMS_CONTROL, this.rawStreamsPayload(this.selectTrackingStreams(streams)));

      // FW 0.2.0.951 reports UNKNOWN_MESSAGE_ID for SLAM_SET_6DOF_INTERRUPT_RATE.
      // The verified working path leaves the firmware default interrupt rate in place.
      await this.bulkRequest(MSG.SLAM_6DOF_CONTROL, fixedPayload(2, (view, o) => {
        view.setUint8(o, 1);
        view.setUint8(o + 1, 0x06);
      }));
      return info;
    }

    parsePose(view) {
      const declared = view.getUint32(0, true);
      if (declared < 104 || view.byteLength < 104) throw new Error(`Unexpected pose packet ${declared}/${view.byteLength} B`);
      const f = [];
      for (let i = 0; i < 19; i++) f.push(view.getFloat32(8 + i * 4, true));
      return {
        type: "pose",
        position: { x: f[0], y: f[1], z: f[2] },
        quaternion: { x: f[3], y: f[4], z: f[5], w: f[6] },
        velocity: { x: f[7], y: f[8], z: f[9] },
        angular_velocity: { x: f[10], y: f[11], z: f[12] },
        acceleration: { x: f[13], y: f[14], z: f[15] },
        angular_acceleration: { x: f[16], y: f[17], z: f[18] },
        device_timestamp_ns: readUint64(view, 84).toString(),
        tracker_confidence: view.getUint32(92, true),
        mapper_confidence: view.getUint32(96, true) & 0x3,
        tracker_state: view.getUint32(100, true),
        packet_length: declared,
        raw_frame: this.frame,
        raw_pose_hz: this.poseRate,
      };
    }

    updateRate(now) {
      if (!this.rateStart) {
        this.rateStart = now;
        this.rateFrame = this.frame;
        return;
      }
      const dt = now - this.rateStart;
      if (dt < 1000) return;
      this.poseRate = (this.frame - this.rateFrame) * 1000 / dt;
      this.rateStart = now;
      this.rateFrame = this.frame;
      setDirectHint(`T265 WebUSB · raw pose ${this.poseRate.toFixed(1)} Hz · viewer feed ~60 Hz`);
      setTransportLabel("WEBUSB");
    }

    async readInterrupts() {
      const device = this.device;
      const endpoint = this.endpoints.poseIn.endpointNumber;
      while (this.streaming && device === this.device) {
        try {
          const result = await device.transferIn(endpoint, 1024);
          if (!this.streaming || device !== this.device) break;
          if (result.status !== "ok" || !result.data || result.data.byteLength < 6) continue;
          if (result.data.getUint16(4, true) !== MSG.DEV_GET_POSE) continue;

          this.frame++;
          const now = performance.now();
          this.updateRate(now);
          const pose = this.parsePose(result.data);
          globalThis.dispatchEvent(new CustomEvent("realsense-t265-pose", { detail: pose }));
          if (!this.lastViewerEmit || now - this.lastViewerEmit >= 15) {
            this.lastViewerEmit = now;
            this.emitMessage(pose);
          }
        } catch (error) {
          if (this.streaming) this.fail(error);
          break;
        }
      }
    }

    async stopUsb() {
      if (this.device && this.streaming) {
        try { await this.bulkRequest(MSG.DEV_STOP); } catch (_) {}
      }
      this.streaming = false;
      globalThis.dispatchEvent(new CustomEvent("realsense-t265-status", { detail: { active: false } }));
      const device = this.device;
      const interfaceNumber = this.interfaceNumber;
      this.device = null;
      this.endpoints = null;
      this.interfaceNumber = null;
      if (device) {
        try { if (device.opened && interfaceNumber != null) await device.releaseInterface(interfaceNumber); } catch (_) {}
        try { if (device.opened) await device.close(); } catch (_) {}
      }
    }

    fail(error) {
      console.error("T265 direct WebUSB failed", error);
      this.streaming = false;
      globalThis.dispatchEvent(new CustomEvent("realsense-t265-status", { detail: { active: false, error: error?.message || String(error) } }));
      this.readyState = T265DirectSocket.CLOSED;
      setDirectHint(`T265 WebUSB error: ${error?.message || error}`);
      setTransportLabel("WEBUSB ERROR");
      this.onerror?.({ type: "error", error });
      this.onclose?.({ code: 1011, reason: error?.message || String(error), wasClean: false });
      this.stopUsb().catch(() => {});
    }
  }

  function PatchedWebSocket(url, protocols) {
    if (String(url) === DIRECT_URL) return new T265DirectSocket(String(url));
    return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
  }

  PatchedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = NativeWebSocket.OPEN;
  PatchedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  window.WebSocket = PatchedWebSocket;

  function connectDevice(device) {
    if (!device || !isRuntime(device)) throw new Error("T265 runtime device is not available.");
    if (activeDirectSocket && activeDirectSocket.readyState !== T265DirectSocket.CLOSED) {
      return activeDirectSocket;
    }
    selected.device = device;
    activeDirectSocket = new T265DirectSocket(DIRECT_URL);
    activeDirectSocket.onclose = () => { if (activeDirectSocket?.readyState === T265DirectSocket.CLOSED) activeDirectSocket = null; };
    return activeDirectSocket;
  }

  async function connectPermitted() {
    if (!("usb" in navigator)) throw new Error("WebUSB unavailable.");
    let device = globalThis.RealSenseT265Boot?.resolvePermittedDevice
      ? await globalThis.RealSenseT265Boot.resolvePermittedDevice()
      : (await navigator.usb.getDevices()).find(isRuntime);
    if (!device) return null;
    return connectDevice(device);
  }

  async function connectInteractive() {
    if (!("usb" in navigator)) throw new Error("WebUSB unavailable.");
    const device = globalThis.RealSenseT265Boot?.requestInteractiveDevice
      ? await globalThis.RealSenseT265Boot.requestInteractiveDevice()
      : await navigator.usb.requestDevice({ filters: RUNTIME_FILTERS });
    if (!device) return null;
    return connectDevice(device);
  }

  async function disconnect() {
    if (!activeDirectSocket) return;
    const s = activeDirectSocket;
    activeDirectSocket = null;
    await s.close();
  }

  globalThis.RealSenseT265Direct = Object.freeze({
    connectDevice,
    connectPermitted,
    connectInteractive,
    disconnect,
    get socket() { return activeDirectSocket; },
  });

  async function chooseAndConnect() {
    if (!("usb" in navigator)) {
      setDirectHint("WebUSB unavailable. Use desktop Chrome/Edge over HTTPS.");
      return;
    }
    try {
      setDirectHint("Choose the 8087:0B37 T265 runtime device…");
      const device = globalThis.RealSenseT265Boot?.requestInteractiveDevice
        ? await globalThis.RealSenseT265Boot.requestInteractiveDevice()
        : await navigator.usb.requestDevice({ filters: RUNTIME_FILTERS });
      if (!device || !isRuntime(device)) return;

      // Keep the original Viewer path when its controls are present.
      const bridgeUrl = document.getElementById("bridgeUrl");
      const connectBridge = document.getElementById("connectBridge");
      if (bridgeUrl && connectBridge) {
        selected.device = device;
        document.querySelector('.mode-button[data-mode="live"]')?.click();
        bridgeUrl.value = DIRECT_URL;
        connectBridge.click();
      } else {
        connectDevice(device);
      }
    } catch (error) {
      if (error?.name === "NotFoundError") {
        setDirectHint("No runtime T265 selected. If the device is 03E7:2150, use Boot Lab first.");
        return;
      }
      setDirectHint(`T265 WebUSB error: ${error?.message || error}`);
    }
  }

  document.getElementById("connectT265Webusb")?.addEventListener("click", chooseAndConnect);
  document.getElementById("openT265Boot")?.addEventListener("click", () => {
    window.location.href = "./t265-webusb.html";
  });

  if ("usb" in navigator) {
    setDirectHint("Direct T265 WebUSB ready. Runtime device: 8087:0B37. Use Boot Lab only for 03E7:2150.");
  } else {
    const button = document.getElementById("connectT265Webusb");
    if (button) button.disabled = true;
    setDirectHint("WebUSB unavailable. Use desktop Chrome/Edge over HTTPS.");
  }
})();
