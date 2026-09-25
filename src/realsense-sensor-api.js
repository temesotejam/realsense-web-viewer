export const REALSENSE_SENSOR_CHANNEL = "realsense-sensor-api-v1";
const API_VERSION = 1;

class RealSenseSensorHub {
  constructor() {
    this.channel = "BroadcastChannel" in globalThis ? new BroadcastChannel(REALSENSE_SENSOR_CHANNEL) : null;
    this.startedAt = performance.now();
    this.poseSeq = 0;
    this.depthSeq = 0;
    this.clients = new Set();
    this.listeners = new Set();
    this.stats = {
      apiVersion: API_VERSION,
      channel: REALSENSE_SENSOR_CHANNEL,
      t265: { active: false, frames: 0, hz: 0, confidence: 0, lastHostMs: 0 },
      d435: { active: false, frames: 0, hz: 0, width: 0, height: 0, scaleM: 0.001, lastHostMs: 0 },
      clients: 0,
    };
    this.poseRate = { t: 0, n: 0, hz: 0 };
    this.depthRate = { t: 0, n: 0, hz: 0 };
    this.channel?.addEventListener("message", (e) => this.onMessage(e.data));
    globalThis.addEventListener("realsense-t265-pose", (e) => this.publishPose(e.detail));
    globalThis.addEventListener("realsense-t265-status", (e) => this.setT265Status(e.detail));
    globalThis.addEventListener("realsense-depth-frame", (e) => this.publishDepth(e.detail));
    globalThis.addEventListener("realsense-depth-status", (e) => this.setDepthStatus(e.detail));
    globalThis.realsenseSensorHub = this;
  }

  now() { return performance.now(); }

  updateRate(bucket) {
    const now = this.now();
    if (!bucket.t) { bucket.t = now; bucket.n = 0; return bucket.hz; }
    bucket.n++;
    const dt = now - bucket.t;
    if (dt >= 1000) {
      bucket.hz = bucket.n * 1000 / dt;
      bucket.t = now;
      bucket.n = 0;
    }
    return bucket.hz;
  }

  emitStats() {
    this.stats.clients = this.clients.size;
    const copy = structuredClone(this.stats);
    this.listeners.forEach((fn) => { try { fn(copy); } catch (_) {} });
  }

  onStats(fn) {
    this.listeners.add(fn);
    fn(structuredClone(this.stats));
    return () => this.listeners.delete(fn);
  }

  post(message) {
    this.channel?.postMessage({ protocol: API_VERSION, source: "realsense-web-viewer", ...message });
  }

  onMessage(message) {
    if (!message || message.protocol !== API_VERSION) return;
    if (message.type === "sensor_api_hello") {
      if (message.client_id) this.clients.add(message.client_id);
      this.post({ type: "sensor_api_status", request_id: message.request_id || null, status: structuredClone(this.stats) });
      this.emitStats();
    } else if (message.type === "sensor_api_goodbye") {
      if (message.client_id) this.clients.delete(message.client_id);
      this.emitStats();
    } else if (message.type === "sensor_api_status_request") {
      this.post({ type: "sensor_api_status", request_id: message.request_id || null, status: structuredClone(this.stats) });
    }
  }

  publishPose(pose) {
    if (!pose) return;
    const host = this.now();
    const hz = this.updateRate(this.poseRate);
    this.stats.t265 = {
      active: true,
      frames: ++this.poseSeq,
      hz,
      confidence: Number(pose.tracker_confidence ?? 0),
      lastHostMs: host,
    };
    this.post({
      type: "t265_pose",
      seq: this.poseSeq,
      host_timestamp_ms: host,
      device_timestamp_ns: pose.device_timestamp_ns ?? null,
      raw_frame: pose.raw_frame ?? null,
      raw_pose_hz: Number(pose.raw_pose_hz ?? hz),
      position: pose.position,
      quaternion: pose.quaternion,
      velocity: pose.velocity,
      angular_velocity: pose.angular_velocity,
      acceleration: pose.acceleration,
      angular_acceleration: pose.angular_acceleration,
      tracker_confidence: Number(pose.tracker_confidence ?? 0),
      mapper_confidence: Number(pose.mapper_confidence ?? 0),
      tracker_state: Number(pose.tracker_state ?? 0),
    });
    if ((this.poseSeq & 31) === 0) this.emitStats();
  }

  publishDepth(frame) {
    if (!frame?.data || !frame.width || !frame.height) return;
    const host = this.now();
    const hz = this.updateRate(this.depthRate);
    this.stats.d435 = {
      active: true,
      frames: ++this.depthSeq,
      hz,
      width: frame.width,
      height: frame.height,
      scaleM: Number(frame.scaleM ?? 0.001),
      lastHostMs: host,
      label: frame.label || "",
    };
    this.post({
      type: "d435_depth",
      seq: this.depthSeq,
      host_timestamp_ms: host,
      media_timestamp_ms: frame.mediaTimestampMs ?? null,
      width: frame.width,
      height: frame.height,
      encoding: "z16le",
      depth_scale_m: Number(frame.scaleM ?? 0.001),
      origin: "top-left",
      data: frame.data,
    });
    if ((this.depthSeq & 7) === 0) this.emitStats();
  }

  setDepthStatus(status = {}) {
    this.stats.d435 = { ...this.stats.d435, ...status };
    this.emitStats();
    this.post({ type: "d435_status", status: { ...this.stats.d435 } });
  }

  setT265Status(status = {}) {
    this.stats.t265 = { ...this.stats.t265, ...status };
    this.emitStats();
    this.post({ type: "t265_status", status: { ...this.stats.t265 } });
  }
}

export const sensorHub = new RealSenseSensorHub();
