export const REALSENSE_SENSOR_CHANNEL = "realsense-sensor-api-v1";

export class RealSenseSensorClient extends EventTarget {
  constructor(clientId = `client-${crypto.randomUUID?.() || Math.random().toString(16).slice(2)}`) {
    super();
    this.clientId = clientId;
    this.channel = new BroadcastChannel(REALSENSE_SENSOR_CHANNEL);
    this.status = null;
    this.pose = null;
    this.depth = null;
    this.channel.onmessage = (e) => this.handle(e.data);
    this.channel.postMessage({ type: "sensor_api_hello", protocol: 1, client_id: this.clientId, request_id: crypto.randomUUID?.() || null });
  }
  handle(m) {
    if (!m || m.protocol !== 1) return;
    if (m.type === "sensor_api_status") this.status = m.status;
    else if (m.type === "t265_pose") this.pose = m;
    else if (m.type === "d435_depth") this.depth = m;
    this.dispatchEvent(new CustomEvent(m.type || "message", { detail: m }));
  }
  requestStatus() {
    this.channel.postMessage({ type: "sensor_api_status_request", protocol: 1, client_id: this.clientId, request_id: crypto.randomUUID?.() || null });
  }
  close() {
    this.channel.postMessage({ type: "sensor_api_goodbye", protocol: 1, client_id: this.clientId });
    this.channel.close();
  }
}
