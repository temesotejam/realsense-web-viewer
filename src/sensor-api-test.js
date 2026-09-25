import { RealSenseSensorClient, REALSENSE_SENSOR_CHANNEL } from "./realsense-sensor-client.js";

const $ = (id) => document.getElementById(id);
const client = new RealSenseSensorClient("sensor-api-test");
let poseCount = 0, depthCount = 0, poseStart = performance.now(), depthStart = performance.now(), prevDepth = null;

$("channel").textContent = REALSENSE_SENSOR_CHANNEL;
const hubFrame = $("hubFrame");
hubFrame?.addEventListener("load", () => {
  setTimeout(() => client.requestStatus(), 400);
  setTimeout(() => client.requestStatus(), 1200);
});

client.addEventListener("sensor_api_status", (e) => {
  const s = e.detail.status || {};
  $("hubStatus").textContent = "ONLINE";
  $("clients").textContent = String(s.clients ?? 0);
  $("t265Status").textContent = s.t265?.active ? `LIVE · ${Number(s.t265.hz || 0).toFixed(1)} Hz` : "OFF";
  $("depthStatus").textContent = s.d435?.active ? `LIVE · ${s.d435.width || 0}×${s.d435.height || 0} · ${Number(s.d435.hz || 0).toFixed(1)} Hz` : "OFF";
});

client.addEventListener("t265_pose", (e) => {
  const m = e.detail, p = m.position || {}, q = m.quaternion || {};
  poseCount++;
  const dt = (performance.now() - poseStart) / 1000;
  $("poseRate").textContent = dt > 0 ? `${(poseCount / dt).toFixed(1)} Hz` : "—";
  $("poseSeq").textContent = String(m.seq ?? "—");
  $("confidence").textContent = String(m.tracker_confidence ?? "—");
  $("position").textContent = `${Number(p.x||0).toFixed(3)}, ${Number(p.y||0).toFixed(3)}, ${Number(p.z||0).toFixed(3)} m`;
  $("quaternion").textContent = `${Number(q.x||0).toFixed(4)}, ${Number(q.y||0).toFixed(4)}, ${Number(q.z||0).toFixed(4)}, ${Number(q.w??1).toFixed(4)}`;
});

client.addEventListener("d435_depth", (e) => {
  const m = e.detail;
  depthCount++;
  const dt = (performance.now() - depthStart) / 1000;
  $("depthRate").textContent = dt > 0 ? `${(depthCount / dt).toFixed(1)} Hz` : "—";
  $("depthSeq").textContent = String(m.seq ?? "—");
  $("depthShape").textContent = `${m.width}×${m.height} · scale ${Number(m.depth_scale_m||0).toFixed(6)}`;
  analyzeDepth(m);
  drawDepth(m);
});

function analyzeDepth(m) {
  if (!(m.data instanceof Uint16Array) || !m.data.length) return;
  let min=65535,max=0,nonzero=0,checksum=2166136261>>>0,changed=0,samples=0;
  for (let i=0;i<m.data.length;i++) {
    const v=m.data[i];
    if (v) { nonzero++; if(v<min)min=v; if(v>max)max=v; }
    if ((i & 15) === 0) {
      checksum ^= v & 255; checksum = Math.imul(checksum,16777619)>>>0;
      checksum ^= v >>> 8; checksum = Math.imul(checksum,16777619)>>>0;
      if (prevDepth && Math.abs(v-prevDepth[i]) >= 2) changed++;
      samples++;
    }
  }
  $("depthMinMax").textContent = nonzero ? `${min} / ${max} Z16` : "all zero";
  $("depthNonzero").textContent = `${((nonzero/m.data.length)*100).toFixed(1)}%`;
  $("depthChecksum").textContent = `0x${checksum.toString(16).padStart(8,"0")}`;
  $("depthChanged").textContent = prevDepth ? `${((changed/Math.max(1,samples))*100).toFixed(1)}%` : "first frame";
  prevDepth = m.data.slice();
}

function drawDepth(m) {
  const canvas = $("depthCanvas");
  if (!(m.data instanceof Uint16Array)) return;
  canvas.width = m.width;
  canvas.height = m.height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(m.width, m.height);
  const scale = Number(m.depth_scale_m || 0.001);
  for (let i=0;i<m.data.length;i++) {
    const z = m.data[i] * scale;
    const t = z > 0 ? Math.max(0, Math.min(1, z / 4)) : 0;
    const j=i*4;
    image.data[j] = z > 0 ? Math.round(255*(1-t)) : 0;
    image.data[j+1] = z > 0 ? Math.round(255*Math.min(1,t*2)) : 0;
    image.data[j+2] = z > 0 ? Math.round(255*t) : 0;
    image.data[j+3] = 255;
  }
  ctx.putImageData(image,0,0);
}

$("refresh").onclick = () => client.requestStatus();
setInterval(() => client.requestStatus(), 2000);
window.addEventListener("beforeunload", () => client.close());
client.requestStatus();
