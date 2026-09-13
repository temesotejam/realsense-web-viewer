(() => {
  if (!("usb" in navigator)) return;

  const originalRequestDevice = navigator.usb.requestDevice.bind(navigator.usb);
  const BOOT_FILTER = { vendorId: 0x03e7, productId: 0x2150 };
  const RUNTIME_FILTERS = [
    { vendorId: 0x8087, productId: 0x0b37 },
    { vendorId: 0x8087, productId: 0x0af3 },
  ];

  const INTEL_RELAY = "https://t265-intel-firmware-relay.temesotejam-t265.workers.dev/t265/0.2.0.951.mvcmd";
  const GITHUB_MIRROR = "https://raw.githubusercontent.com/utahrobotics/t265-rs/46f88fcef679e766fb7b81f4ef5b9c6fa3b50424/firmware/target-0.2.0.951.mvcmd";
  const EXPECTED_SIZE = 9323648;
  const EXPECTED_SHA256 = "0265fd111611908b822cdaf4a3fe5b631c50539b2805d2f364c498aa71c007c0";

  function sameId(device, filter) {
    return device.vendorId === filter.vendorId && device.productId === filter.productId;
  }

  function isRuntime(device) {
    return RUNTIME_FILTERS.some((filter) => sameId(device, filter));
  }

  function isBoot(device) {
    return sameId(device, BOOT_FILTER);
  }

  function setHint(text) {
    const hint = document.getElementById("t265WebusbHint");
    if (hint) hint.textContent = text;
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function fetchAndVerify(source) {
    const response = await fetch(source.url, { mode: "cors", cache: "no-store" });
    if (!response.ok) throw new Error(`${source.label}: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== EXPECTED_SIZE) {
      throw new Error(`${source.label}: size ${buffer.byteLength}/${EXPECTED_SIZE}`);
    }
    const sha256 = await sha256Hex(buffer);
    if (sha256 !== EXPECTED_SHA256) {
      throw new Error(`${source.label}: SHA-256 mismatch ${sha256}`);
    }
    return buffer;
  }

  async function fetchVerifiedFirmware() {
    const sources = [
      {
        label: "Intel official relay",
        hint: "Intel RealSense official CDN via no-store relay",
        url: INTEL_RELAY,
      },
      {
        label: "GitHub Raw fallback",
        hint: "commit-pinned GitHub Raw fallback",
        url: GITHUB_MIRROR,
      },
    ];

    const errors = [];
    for (const source of sources) {
      setHint(`T265 boot mode detected · downloading firmware from ${source.hint}…`);
      try {
        const buffer = await fetchAndVerify(source);
        setHint(`Firmware verified from ${source.label} · 9,323,648 B · SHA-256 OK · booting T265…`);
        return buffer;
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }
    throw new Error(`All firmware sources failed: ${errors.join(" | ")}`);
  }

  async function ensureOpen(device) {
    if (!device.opened) await device.open();
    if (!device.configuration) {
      const configurationValue = device.configurations?.[0]?.configurationValue || 1;
      await device.selectConfiguration(configurationValue);
    }
  }

  function findBootTarget(device) {
    const intf = Array.from(device.configuration?.interfaces || []).find((candidate) => candidate.interfaceNumber === 0);
    if (!intf) throw new Error("T265 boot interface 0 was not found.");
    for (const alt of Array.from(intf.alternates || [])) {
      const endpoint = Array.from(alt.endpoints || []).find((ep) => ep.direction === "out" && ep.type === "bulk");
      if (endpoint) {
        return {
          intf,
          interfaceNumber: intf.interfaceNumber,
          alternateSetting: alt.alternateSetting,
          endpointNumber: endpoint.endpointNumber,
        };
      }
    }
    throw new Error("T265 boot Bulk OUT endpoint was not found.");
  }

  async function bootDevice(device) {
    await ensureOpen(device);
    const target = findBootTarget(device);
    let firmware = await fetchVerifiedFirmware();
    let firmwareBytes = new Uint8Array(firmware);

    if (!target.intf.claimed) await device.claimInterface(target.interfaceNumber);
    if (target.intf.alternate?.alternateSetting !== target.alternateSetting) {
      await device.selectAlternateInterface(target.interfaceNumber, target.alternateSetting);
    }

    setHint(`Sending ${firmware.byteLength.toLocaleString()} B to boot EP ${target.endpointNumber}…`);
    const started = performance.now();
    const result = await device.transferOut(target.endpointNumber, firmwareBytes);
    const elapsed = performance.now() - started;
    if (result.status !== "ok") throw new Error(`Boot transfer status=${result.status}`);
    if (Number.isFinite(result.bytesWritten) && result.bytesWritten !== firmware.byteLength) {
      throw new Error(`Boot short write ${result.bytesWritten}/${firmware.byteLength}`);
    }

    firmwareBytes = null;
    firmware = null;

    setHint(`Boot image sent in ${elapsed.toFixed(0)} ms · waiting for 8087:0B37 runtime…`);
    try { if (device.opened) await device.close(); } catch (_) {}

    const deadline = performance.now() + 12000;
    while (performance.now() < deadline) {
      const devices = await navigator.usb.getDevices();
      const runtime = devices.find(isRuntime);
      if (runtime) {
        setHint("T265 runtime detected · starting direct 6DoF…");
        return runtime;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error("T265 boot succeeded but runtime permission was not available. Open Boot Lab once and authorize the runtime device, then retry.");
  }

  function isT265RuntimeRequest(options) {
    const filters = Array.from(options?.filters || []);
    if (filters.length !== RUNTIME_FILTERS.length) return false;
    return RUNTIME_FILTERS.every((wanted) => filters.some((f) => f.vendorId === wanted.vendorId && f.productId === wanted.productId));
  }

  navigator.usb.requestDevice = async function patchedRequestDevice(options) {
    if (!isT265RuntimeRequest(options)) return originalRequestDevice(options);
    setHint("Select the connected T265. Boot mode (03E7:2150) and runtime mode (8087:0B37) are both supported.");
    const device = await originalRequestDevice({ filters: [...RUNTIME_FILTERS, BOOT_FILTER] });
    if (isRuntime(device)) return device;
    if (isBoot(device)) return bootDevice(device);
    throw new Error("Selected USB device is not a supported T265 boot/runtime device.");
  };
})();
