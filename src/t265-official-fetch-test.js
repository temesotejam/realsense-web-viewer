(() => {
  const officialButton = document.getElementById("fetchOfficialFirmware");
  const officialStatus = document.getElementById("officialFirmwareStatus");
  const githubButton = document.getElementById("fetchGitHubFirmware");
  const githubStatus = document.getElementById("githubFirmwareStatus");
  if (!officialButton || !officialStatus) return;

  const officialUrls = [
    "https://librealsense.intel.com/Releases/TM2/FW/target/0.2.0.951/target-0.2.0.951.mvcmd",
    "https://realsense-hw-public.s3.amazonaws.com/Releases/TM2/FW/target/0.2.0.951/target-0.2.0.951.mvcmd",
  ];

  // Third-party mirror discovered through GitHub code search. It is pinned to a
  // specific commit and is accepted only if the full firmware SHA-256 matches
  // the previously verified Intel image exactly.
  const githubMirrorUrl = "https://raw.githubusercontent.com/utahrobotics/t265-rs/46f88fcef679e766fb7b81f4ef5b9c6fa3b50424/firmware/target-0.2.0.951.mvcmd";

  const expectedSize = 9323648;
  const expectedSha256 = "0265fd111611908b822cdaf4a3fe5b631c50539b2805d2f364c498aa71c007c0";

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
      bytes: buffer.byteLength,
      sha256,
      sizeOk: buffer.byteLength === expectedSize,
      hashOk: sha256 === expectedSha256,
    };
  }

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
          officialStatus.className = result.sizeOk && result.hashOk ? "good" : "warning";
          officialStatus.textContent = `FETCH OK · ${new URL(url).host} · ${result.bytes.toLocaleString()} B · size ${result.sizeOk ? "OK" : "NG"} · SHA-256 ${result.hashOk ? "OK" : "NG"}`;
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
      githubStatus.textContent = "Fetching commit-pinned GitHub mirror…";
      try {
        const result = await fetchAndVerify(githubMirrorUrl);
        githubStatus.className = result.sizeOk && result.hashOk ? "good" : "warning";
        githubStatus.textContent = `GITHUB FETCH OK · ${result.bytes.toLocaleString()} B · size ${result.sizeOk ? "OK" : "NG"} · SHA-256 ${result.hashOk ? "OK" : "NG"}`;
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
