(() => {
  const button = document.getElementById("fetchOfficialFirmware");
  const status = document.getElementById("officialFirmwareStatus");
  if (!button || !status) return;

  const urls = [
    "https://librealsense.intel.com/Releases/TM2/FW/target/0.2.0.951/target-0.2.0.951.mvcmd",
    "https://realsense-hw-public.s3.amazonaws.com/Releases/TM2/FW/target/0.2.0.951/target-0.2.0.951.mvcmd",
  ];
  const expectedSize = 9323648;
  const expectedSha256 = "0265fd111611908b822cdaf4a3fe5b631c50539b2805d2f364c498aa71c007c0";

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    status.className = "warning";
    status.textContent = "Testing official RealSense download…";
    const failures = [];
    try {
      for (const url of urls) {
        try {
          status.textContent = `Fetching ${new URL(url).host}…`;
          const response = await fetch(url, { mode: "cors", cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          const sha256 = await sha256Hex(buffer);
          const sizeOk = buffer.byteLength === expectedSize;
          const hashOk = sha256 === expectedSha256;
          status.className = sizeOk && hashOk ? "good" : "warning";
          status.textContent = `FETCH OK · ${new URL(url).host} · ${buffer.byteLength.toLocaleString()} B · size ${sizeOk ? "OK" : "NG"} · SHA-256 ${hashOk ? "OK" : "NG"}`;
          console.info("T265 official fetch", { url, bytes: buffer.byteLength, sha256, sizeOk, hashOk });
          return;
        } catch (error) {
          failures.push(`${new URL(url).host}: ${error?.message || error}`);
        }
      }
      throw new Error(failures.join(" | "));
    } catch (error) {
      status.className = "warning";
      status.textContent = `FETCH FAILED · ${error?.message || error}`;
      console.error("T265 official fetch failed", error);
    } finally {
      button.disabled = false;
    }
  });
})();
