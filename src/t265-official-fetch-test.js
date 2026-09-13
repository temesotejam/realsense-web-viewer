(() => {
  const officialButton = document.getElementById("fetchOfficialFirmware");
  const officialStatus = document.getElementById("officialFirmwareStatus");
  const githubButton = document.getElementById("fetchGitHubFirmware");
  const githubStatus = document.getElementById("githubFirmwareStatus");
  const firmwareInput = document.getElementById("firmwareFile");
  if (!officialButton || !officialStatus || !firmwareInput) return;

  const officialUrls = [
    "https://librealsense.intel.com/Releases/TM2/FW/target/0.2.0.951/target-0.2.0.951.mvcmd",
    "https://realsense-hw-public.s3.amazonaws.com/Releases/TM2/FW/target/0.2.0.951/target-0.2.0.951.mvcmd",
  ];

  const relayUrl = "https://t265-intel-firmware-relay.temesotejam-t265.workers.dev/t265/0.2.0.951.mvcmd";

  // Third-party mirror discovered through GitHub code search. It is pinned to a
  // specific commit and is accepted only if the full firmware SHA-256 matches
  // the previously verified Intel image exactly.
  const githubMirrorUrl = "https://raw.githubusercontent.com/utahrobotics/t265-rs/46f88fcef679e766fb7b81f4ef5b9c6fa3b50424/firmware/target-0.2.0.951.mvcmd";

  const firmwareName = "target-0.2.0.951.mvcmd";
  const expectedSize = 9323648;
  const expectedSha256 = "0265fd111611908b822cdaf4a3fe5b631c50539b2805d2f364c498aa71c007c0";

  // Add a retrieval-only relay diagnostic beside the existing probes. It never
  // injects the bytes into the Boot Lab and never performs a USB transfer.
  const actions = officialButton.closest(".actions");
  const relayButton = document.createElement("button");
  relayButton.id = "fetchRelayFirmware";
  relayButton.className = "primary";
  relayButton.textContent = "Test Intel relay fetch";
  actions?.insertBefore(relayButton, officialButton);

  const relayStatus = document.createElement("p");
  relayStatus.id = "relayFirmwareStatus";
  relayStatus.className = "muted";
  relayStatus.textContent = "Intel relay: retrieval-only diagnostic. Fetches the official Intel/RealSense image through the no-store Cloudflare relay; no USB transfer is performed.";
  officialStatus.parentNode?.insertBefore(relayStatus, officialStatus);

  const relayLog = document.createElement("pre");
  relayLog.id = "relayFetchLog";
  relayLog.style.minHeight = "150px";
  relayLog.style.maxHeight = "260px";
  relayLog.textContent = "Relay diagnostic ready. No firmware has been fetched yet.";
  const manualFallback = Array.from(officialStatus.parentElement?.querySelectorAll("p") || [])
    .find((node) => node.textContent?.includes("Manual fallback"));
  if (manualFallback) manualFallback.parentNode.insertBefore(relayLog, manualFallback);
  else officialStatus.parentNode?.appendChild(relayLog);

  function relayLogLine(line = "") {
    const current = relayLog.textContent === "Relay diagnostic ready. No firmware has been fetched yet." ? "" : relayLog.textContent;
    relayLog.textContent = `${current}${current ? "\n" : ""}${line}`;
    relayLog.scrollTop = relayLog.scrollHeight;
  }

  function resetRelayLog() {
    relayLog.textContent = "";
  }

  function stamp() {
    return new Date().toISOString();
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }

  async function fetchAndVerify(url) {
    const response = await fetch(url, { mode: "cors", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const sha256 = await sha256Hex(buffer);
    return {
      url,
      buffer,
      bytes: buffer.byteLength,
      sha256,
      sizeOk: buffer.byteLength === expectedSize,
      hashOk: sha256 === expectedSha256,
    };
  }

  function loadIntoExistingBootFlow(result) {
    if (!result.sizeOk || !result.hashOk) {
      throw new Error("Downloaded bytes did not match the verified T265 firmware.");
    }
    if (typeof DataTransfer !== "function" || typeof File !== "function") {
      throw new Error("This browser cannot inject the verified file into the Boot Lab file input.");
    }

    const file = new File([result.buffer], firmwareName, { type: "application/octet-stream" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    firmwareInput.files = transfer.files;
    firmwareInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  relayButton.addEventListener("click", async () => {
    relayButton.disabled = true;
    relayStatus.className = "warning";
    relayStatus.textContent = "Testing Intel official relay…";
    resetRelayLog();
    relayLogLine(`[${stamp()}] Intel relay diagnostic started`);
    relayLogLine(`Page origin: ${window.location.origin}`);
    relayLogLine(`Relay URL: ${relayUrl}`);
    relayLogLine("USB transfer: NOT PERFORMED");

    try {
      const started = performance.now();
      const response = await fetch(relayUrl, { mode: "cors", cache: "no-store" });
      relayLogLine(`HTTP status: ${response.status} ${response.statusText || ""}`.trim());
      relayLogLine(`Content-Type: ${response.headers.get("Content-Type") || "—"}`);
      relayLogLine(`Content-Length: ${response.headers.get("Content-Length") || "—"}`);
      relayLogLine(`X-T265-Firmware-Source: ${response.headers.get("X-T265-Firmware-Source") || "—"}`);
      relayLogLine(`X-T265-Firmware-SHA256: ${response.headers.get("X-T265-Firmware-SHA256") || "—"}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const buffer = await response.arrayBuffer();
      const elapsed = performance.now() - started;
      const sha256 = await sha256Hex(buffer);
      const sizeOk = buffer.byteLength === expectedSize;
      const hashOk = sha256 === expectedSha256;

      relayLogLine(`Elapsed: ${elapsed.toFixed(1)} ms`);
      relayLogLine(`Downloaded: ${buffer.byteLength.toLocaleString()} B`);
      relayLogLine(`Expected size: ${expectedSize.toLocaleString()} B`);
      relayLogLine(`Size check: ${sizeOk ? "OK" : "FAIL"}`);
      relayLogLine(`Computed SHA-256: ${sha256}`);
      relayLogLine(`Expected SHA-256: ${expectedSha256}`);
      relayLogLine(`SHA-256 check: ${hashOk ? "OK" : "FAIL"}`);

      if (!sizeOk || !hashOk) {
        throw new Error("Relay bytes did not match the verified Intel T265 firmware.");
      }

      relayLogLine("RESULT: PASS · Intel relay returned the verified T265 0.2.0.951 image.");
      relayLogLine("Firmware buffer released after verification; nothing was sent over WebUSB.");
      relayStatus.className = "good";
      relayStatus.textContent = `INTEL RELAY OK · ${buffer.byteLength.toLocaleString()} B · size OK · SHA-256 OK · diagnostic only`;
    } catch (error) {
      relayLogLine(`RESULT: FAIL · ${error?.message || error}`);
      relayStatus.className = "warning";
      relayStatus.textContent = `INTEL RELAY FAILED · ${error?.message || error}`;
      console.error("T265 Intel relay diagnostic failed", error);
    } finally {
      relayButton.disabled = false;
    }
  });

  officialButton.addEventListener("click", async () => {
    officialButton.disabled = true;
    officialStatus.className = "warning";
    officialStatus.textContent = "Testing official RealSense download…";
    const failures = [];
    try {
      for (const url of officialUrls) {
        try {
          officialStatus.textContent = `Fetching ${new URL(url).host}…`;
          const result = await fetchAndVerify(url);
          if (!result.sizeOk || !result.hashOk) {
            throw new Error(`content mismatch: ${result.bytes} B, SHA-256 ${result.sha256}`);
          }
          loadIntoExistingBootFlow(result);
          officialStatus.className = "good";
          officialStatus.textContent = `OFFICIAL FETCH OK · ${new URL(url).host} · ${result.bytes.toLocaleString()} B · SHA-256 OK · loaded into Boot Lab`;
          console.info("T265 official fetch", result);
          return;
        } catch (error) {
          failures.push(`${new URL(url).host}: ${error?.message || error}`);
        }
      }
      throw new Error(failures.join(" | "));
    } catch (error) {
      officialStatus.className = "warning";
      officialStatus.textContent = `FETCH FAILED · ${error?.message || error}`;
      console.error("T265 official fetch failed", error);
    } finally {
      officialButton.disabled = false;
    }
  });

  if (githubButton && githubStatus) {
    githubButton.addEventListener("click", async () => {
      githubButton.disabled = true;
      githubStatus.className = "warning";
      githubStatus.textContent = "Fetching and verifying commit-pinned GitHub mirror…";
      try {
        const result = await fetchAndVerify(githubMirrorUrl);
        if (!result.sizeOk || !result.hashOk) {
          throw new Error(`content mismatch: ${result.bytes} B, SHA-256 ${result.sha256}`);
        }
        loadIntoExistingBootFlow(result);
        githubStatus.className = "good";
        githubStatus.textContent = `GITHUB FETCH OK · ${result.bytes.toLocaleString()} B · size OK · SHA-256 OK · loaded into Boot Lab`;
        console.info("T265 GitHub mirror fetch", result);
      } catch (error) {
        githubStatus.className = "warning";
        githubStatus.textContent = `GITHUB FETCH FAILED · ${error?.message || error}`;
        console.error("T265 GitHub mirror fetch failed", error);
      } finally {
        githubButton.disabled = false;
      }
    });
  }
})();
