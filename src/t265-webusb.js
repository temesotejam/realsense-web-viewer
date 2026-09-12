const BOOT_FILTER = { vendorId: 0x03e7, productId: 0x2150 };
const RUNTIME_FILTERS = [
  { vendorId: 0x8087, productId: 0x0b37 },
  { vendorId: 0x8087, productId: 0x0af3 },
];

const $ = (id) => document.getElementById(id);
const ui = {
  apiStatus: $("apiStatus"),
  chooseBoot: $("chooseBoot"),
  usePermittedBoot: $("usePermittedBoot"),
  firmwareFile: $("firmwareFile"),
  bootButton: $("bootButton"),
  findRuntime: $("findRuntime"),
  chooseRuntime: $("chooseRuntime"),
  copyLog: $("copyLog"),
  clearLog: $("clearLog"),
  bootDevice: $("bootDevice"),
  bootInterface: $("bootInterface"),
  bootEndpoint: $("bootEndpoint"),
  firmwareName: $("firmwareName"),
  firmwareSize: $("firmwareSize"),
  firmwareHash: $("firmwareHash"),
  runtimeDevice: $("runtimeDevice"),
  runtimeClaim: $("runtimeClaim"),
  resultText: $("resultText"),
  log: $("log"),
};

const state = {
  bootDevice: null,
  bootTarget: null,
  firmwareFile: null,
  firmwareBytes: null,
  runtimeDevice: null,
  report: "",
};

function hex(value, width = 4) {
  return Number(value ?? 0).toString(16).toUpperCase().padStart(width, "0");
}

function deviceId(device) {
  return `${hex(device.vendorId)}:${hex(device.productId)}`;
}

function stamp() {
  return new Date().toISOString();
}

function setApiStatus(kind, text) {
  ui.apiStatus.className = `status ${kind || ""}`;
  ui.apiStatus.innerHTML = `<span class="dot"></span><span>${text}</span>`;
}

function setResult(text, kind = "muted") {
  ui.resultText.className = kind;
  ui.resultText.textContent = text;
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]} (${bytes.toLocaleString()} B)`;
}

function sameId(device, filter) {
  return device.vendorId === filter.vendorId && device.productId === filter.productId;
}

function isRuntime(device) {
  return RUNTIME_FILTERS.some((filter) => sameId(device, filter));
}

async function ensureOpen(device) {
  if (!device.opened) await device.open();
  if (!device.configuration) {
    const configurationValue = device.configurations?.[0]?.configurationValue || 1;
    await device.selectConfiguration(configurationValue);
  }
}

function endpointsText(alt) {
  return (alt?.endpoints || [])
    .map((ep) => `${ep.direction} ${ep.type} #${ep.endpointNumber} packet=${ep.packetSize}`)
    .join(", ") || "none";
}

function findBootTarget(device) {
  const intf = device.configuration?.interfaces?.find((candidate) => candidate.interfaceNumber === 0);
  if (!intf) throw new Error("USB interface 0 is not exposed.");

  const alternatives = Array.from(intf.alternates || []);
  const preferred = alternatives.find((alt) => alt.endpoints?.some((ep) => ep.direction === "out" && ep.type === "bulk"));
  if (!preferred) throw new Error("Interface 0 has no Bulk OUT endpoint.");

  const endpoint = preferred.endpoints.find((ep) => ep.direction === "out" && ep.type === "bulk");
  return { interfaceNumber: 0, alternateSetting: preferred.alternateSetting, endpoint };
}

async function prepareBootDevice(device) {
  await ensureOpen(device);
  const target = findBootTarget(device);
  state.bootDevice = device;
  state.bootTarget = target;
  ui.bootDevice.textContent = `${deviceId(device)} ${device.productName || "Movidius boot device"}`;
  ui.bootInterface.textContent = `IF ${target.interfaceNumber} / alt ${target.alternateSetting}`;
  ui.bootEndpoint.textContent = `EP ${target.endpoint.endpointNumber} · ${target.endpoint.type} OUT · packet ${target.endpoint.packetSize}`;
  const intf = device.configuration.interfaces.find((candidate) => candidate.interfaceNumber === target.interfaceNumber);
  const alt = Array.from(intf?.alternates || []).find((candidate) => candidate.alternateSetting === target.alternateSetting);
  log(`[${stamp()}] Boot device ready: ${deviceId(device)} ${device.productName || ""}`);
  log(`Interface ${target.interfaceNumber}, alt ${target.alternateSetting}, ${endpointsText(alt)}`);
  updateBootButton();
  setResult("Boot device found. Select a genuine T265 target-*.mvcmd image.");
}

async function requestBootDevice() {
  const device = await navigator.usb.requestDevice({ filters: [BOOT_FILTER] });
  await prepareBootDevice(device);
}

async function usePermittedBootDevice() {
  const devices = await navigator.usb.getDevices();
  const device = devices.find((candidate) => sameId(candidate, BOOT_FILTER));
  if (!device) throw new Error("No previously permitted 03E7:2150 device was found.");
  await prepareBootDevice(device);
}

async function digestHex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadFirmware(file) {
  state.firmwareFile = file || null;
  state.firmwareBytes = null;
  ui.firmwareName.textContent = file?.name || "—";
  ui.firmwareSize.textContent = file ? formatBytes(file.size) : "—";
  ui.firmwareHash.textContent = file ? "calculating…" : "—";
  updateBootButton();
  if (!file) return;

  const bytes = await file.arrayBuffer();
  state.firmwareBytes = bytes;
  const sha256 = await digestHex(bytes);
  ui.firmwareHash.textContent = `${sha256.slice(0, 16)}…`;
  log(`[${stamp()}] Boot image selected: ${file.name}, ${file.size} bytes`);
  log(`SHA-256: ${sha256}`);
  if (!/\.mvcmd$/i.test(file.name)) log("WARNING: expected a T265 target-*.mvcmd boot image; filename does not end in .mvcmd.");
  updateBootButton();
}

function updateBootButton() {
  ui.bootButton.disabled = !(state.bootDevice && state.bootTarget && state.firmwareBytes?.byteLength);
}

async function claimBootTarget(device, target) {
  await ensureOpen(device);
  const intf = device.configuration.interfaces.find((candidate) => candidate.interfaceNumber === target.interfaceNumber);
  if (!intf) throw new Error(`Interface ${target.interfaceNumber} disappeared.`);
  if (!intf.claimed) await device.claimInterface(target.interfaceNumber);
  if (intf.alternate?.alternateSetting !== target.alternateSetting) {
    await device.selectAlternateInterface(target.interfaceNumber, target.alternateSetting);
  }
}

async function sendBootImage() {
  const { bootDevice: device, bootTarget: target, firmwareBytes } = state;
  if (!device || !target || !firmwareBytes?.byteLength) throw new Error("Boot device or image is missing.");

  ui.bootButton.disabled = true;
  setResult("Sending T265 boot image over Bulk OUT…", "warning");
  log(`[${stamp()}] Claiming boot IF ${target.interfaceNumber}…`);
  await claimBootTarget(device, target);
  log(`CLAIMED IF ${target.interfaceNumber}. Sending ${firmwareBytes.byteLength} bytes to EP ${target.endpoint.endpointNumber}…`);

  const started = performance.now();
  const result = await device.transferOut(target.endpoint.endpointNumber, new Uint8Array(firmwareBytes));
  const elapsed = performance.now() - started;
  log(`transferOut status=${result.status}, bytesWritten=${result.bytesWritten ?? "?"}, elapsed=${elapsed.toFixed(1)} ms`);
  if (result.status !== "ok") throw new Error(`Boot bulk transfer returned status '${result.status}'.`);
  if (Number.isFinite(result.bytesWritten) && result.bytesWritten !== firmwareBytes.byteLength) {
    throw new Error(`Short boot transfer: ${result.bytesWritten}/${firmwareBytes.byteLength} bytes.`);
  }

  setResult("Boot payload sent. Waiting for T265 runtime re-enumeration…", "warning");
  log("Boot payload accepted by WebUSB. Waiting for 8087:0B37/0AF3…");
  await safeClose(device);
  state.bootDevice = null;
  state.bootTarget = null;
  updateBootButton();

  const runtime = await waitForPermittedRuntime(10000);
  if (runtime) {
    log(`[${stamp()}] Runtime appeared in permitted-device list: ${deviceId(runtime)}`);
    await inspectRuntime(runtime);
  } else {
    log(`[${stamp()}] Runtime was not visible via usb.getDevices() within 10 s.`);
    log("This can be a permission boundary rather than a boot failure. Click 'Authorize runtime T265'.");
    setResult("Boot transfer finished. Authorize the runtime T265 to verify re-enumeration.", "warning");
  }
}

async function waitForPermittedRuntime(timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const devices = await navigator.usb.getDevices();
    const runtime = devices.find(isRuntime);
    if (runtime) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function findPermittedRuntime() {
  const devices = await navigator.usb.getDevices();
  const runtime = devices.find(isRuntime);
  if (!runtime) throw new Error("No permitted 8087:0B37/0AF3 runtime device was found.");
  await inspectRuntime(runtime);
}

async function requestRuntime() {
  const runtime = await navigator.usb.requestDevice({ filters: RUNTIME_FILTERS });
  await inspectRuntime(runtime);
}

async function inspectRuntime(device) {
  await ensureOpen(device);
  state.runtimeDevice = device;
  ui.runtimeDevice.textContent = `${deviceId(device)} ${device.productName || "T265 runtime"}`;
  log(`[${stamp()}] Runtime device: ${deviceId(device)} ${device.productName || ""}`);

  let claimable = 0;
  const interfaces = Array.from(device.configuration?.interfaces || []);
  for (const intf of interfaces) {
    for (const alt of Array.from(intf.alternates || [])) {
      log(`Runtime IF ${intf.interfaceNumber} alt ${alt.alternateSetting} class=0x${hex(alt.interfaceClass, 2)} endpoints=[${endpointsText(alt)}]`);
    }

    const vendorAlt = Array.from(intf.alternates || []).find((alt) => alt.interfaceClass === 0xff);
    if (!vendorAlt) continue;
    try {
      if (!intf.claimed) await device.claimInterface(intf.interfaceNumber);
      if (intf.alternate?.alternateSetting !== vendorAlt.alternateSetting) {
        await device.selectAlternateInterface(intf.interfaceNumber, vendorAlt.alternateSetting);
      }
      claimable++;
      log(`Runtime IF ${intf.interfaceNumber}: CLAIMED vendor-specific interface.`);
      await device.releaseInterface(intf.interfaceNumber);
    } catch (error) {
      log(`Runtime IF ${intf.interfaceNumber}: claim FAILED — ${error.name}: ${error.message}`);
    }
  }

  ui.runtimeClaim.textContent = String(claimable);
  if (claimable > 0) {
    setResult(`SUCCESS: ${deviceId(device)} runtime detected; ${claimable} vendor interface(s) claimable.`, "good");
    setApiStatus("ok", "T265 runtime reachable");
    log("RESULT: browser-only boot reached a claimable T265 runtime interface.");
    log("NEXT: implement librealsense T265 runtime message transport and pose parsing.");
  } else {
    setResult(`Runtime ${deviceId(device)} detected, but no vendor interface was claimable.`, "warning");
    setApiStatus("warn", "Runtime found; interface blocked");
    log("RESULT: runtime re-enumeration succeeded, but browser runtime access is still blocked or uses a non-vendor interface.");
  }

  await safeClose(device);
}

async function safeClose(device) {
  if (!device?.opened) return;
  try { await device.close(); } catch (_) {}
}

function reportError(context, error) {
  const message = `${context}: ${error?.name || "Error"}: ${error?.message || error}`;
  log(`[${stamp()}] ${message}`);
  setResult(message, "warning");
  setApiStatus("bad", "T265 test error");
}

ui.chooseBoot.addEventListener("click", () => requestBootDevice().catch((error) => {
  if (error?.name !== "NotFoundError") reportError("Boot device request failed", error);
}));
ui.usePermittedBoot.addEventListener("click", () => usePermittedBootDevice().catch((error) => reportError("Permitted boot lookup failed", error)));
ui.firmwareFile.addEventListener("change", () => loadFirmware(ui.firmwareFile.files?.[0]).catch((error) => reportError("Boot image read failed", error)));
ui.bootButton.addEventListener("click", () => sendBootImage().catch((error) => reportError("Boot transfer failed", error)).finally(updateBootButton));
ui.findRuntime.addEventListener("click", () => findPermittedRuntime().catch((error) => reportError("Runtime lookup failed", error)));
ui.chooseRuntime.addEventListener("click", () => requestRuntime().catch((error) => {
  if (error?.name !== "NotFoundError") reportError("Runtime authorization failed", error);
}));
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
  setApiStatus("ok", "WebUSB available");
  log(`[${stamp()}] WebUSB available. Secure context=${window.isSecureContext}`);
  navigator.usb.addEventListener("connect", (event) => {
    const device = event.device;
    log(`[${stamp()}] USB connect event: ${deviceId(device)} ${device.productName || ""}`);
  });
  navigator.usb.addEventListener("disconnect", (event) => {
    const device = event.device;
    log(`[${stamp()}] USB disconnect event: ${deviceId(device)} ${device.productName || ""}`);
  });
} else {
  setApiStatus("bad", "WebUSB unavailable");
  setResult("Use a current desktop Chromium browser (Chrome/Edge) over HTTPS.", "warning");
  for (const button of [ui.chooseBoot, ui.usePermittedBoot, ui.bootButton, ui.findRuntime, ui.chooseRuntime]) button.disabled = true;
}
