# RealSense Web Viewer

Browser-based visualization for Intel RealSense depth and tracking cameras. The project is intentionally **browser-first**: use standard browser camera/USB APIs where they preserve the RealSense data, and keep a native `librealsense` bridge only as a fallback/reference path.

> Status: experimental v0.4 — direct D400 depth and the complete T265 browser-only boot → runtime → live 6DoF → 3D viewer path are physically verified in desktop Chromium.

## Current status at a glance

### D400 / D405

- Direct browser Depth input discovery through `getUserMedia()`
- WebGL2 `R32F / FLOAT` path preserving Z16-like samples
- Live depth colorizer
- Raw Z16 probe
- Editable depth scale
- No Python process or local server required for the direct depth path

### T265

The T265 path now works end to end from the **main viewer**:

```text
Connect T265 WebUSB
        |
        +-- 8087:0B37 runtime already present
        |       |
        |       +--> start TM2 runtime transport
        |
        +-- 03E7:2150 boot device
                |
                | download known 0.2.0.951 image
                | verify exact size + SHA-256
                | WebUSB IF0 / Bulk OUT boot transfer
                v
          8087:0B37 runtime
                |
                | Bulk OUT/IN #2 = TM2 commands
                | Interrupt IN #3 = 6DoF pose
                v
          104-byte live pose packets
                |
                | ~200 Hz raw pose reception
                | ~display-rate viewer feed
                v
          main 3D trajectory viewer
```

This complete flow has been physically verified with a T265 running firmware `0.2.0.951`.

## T265 direct browser path

### Verified USB states

The T265 initially appears as the Movidius boot device:

- Boot VID:PID: `03E7:2150`
- Runtime VID:PID: `8087:0B37`
- `8087:0AF3` is also accepted as a T265-family runtime ID

The verified boot transfer is:

```text
03E7:2150
  -> interface 0
  -> first Bulk OUT endpoint (#1 on the tested unit)
  -> one transfer of the complete target-0.2.0.951.mvcmd image
  -> USB disconnect / re-enumeration
  -> 8087:0B37
```

The physically verified boot image is:

```text
name:     target-0.2.0.951.mvcmd
size:     9,323,648 bytes
SHA-256:  0265fd111611908b822cdaf4a3fe5b631c50539b2805d2f364c498aa71c007c0
```

A successful browser boot transferred all `9,323,648` bytes in a single WebUSB `transferOut()` and re-enumerated as `8087:0B37`.

### Firmware retrieval strategy

The repository does **not** bundle the T265 firmware image.

The known Intel/librealsense source is:

```text
https://librealsense.intel.com/Releases/TM2/FW/target/0.2.0.951/target-0.2.0.951.mvcmd
```

A GitHub Actions diagnostic has physically verified that this official source still returns the expected `9,323,648`-byte file with the SHA-256 above.

Direct browser `fetch()` from GitHub Pages to the Intel/RealSense firmware hosts failed on the tested Chrome setup because of the cross-origin response policy. For the browser auto-boot path, the viewer therefore uses a **commit-pinned GitHub Raw mirror** discovered in `utahrobotics/t265-rs`:

```text
repository: utahrobotics/t265-rs
commit:     46f88fcef679e766fb7b81f4ef5b9c6fa3b50424
path:       firmware/target-0.2.0.951.mvcmd
```

The mirror is never accepted blindly. Before any USB write, the browser requires both:

- exact size: `9,323,648` bytes
- exact SHA-256: `0265fd111611908b822cdaf4a3fe5b631c50539b2805d2f364c498aa71c007c0`

The GitHub mirror path has also been physically verified through the Boot Lab: download → hash verification → WebUSB boot → `8087:0B37` re-enumeration succeeded.

`Boot Lab` still supports a manually supplied `target-*.mvcmd` file as a diagnostic/fallback path.

### Verified T265 runtime protocol

The runtime interface on the tested unit is vendor-specific interface 0 with:

- Bulk OUT #1 / Bulk IN #1
- Bulk OUT #2 / Bulk IN #2
- Interrupt OUT #3 / Interrupt IN #3

The browser runtime implementation uses:

- Bulk OUT/IN #2 for TM2 request/response commands
- Interrupt IN #3 for live pose packets

The following runtime commands have been physically verified from JavaScript:

- `DEV_SET_LOW_POWER_MODE`
- `DEV_GET_DEVICE_INFO`
- `DEV_GET_TIME`
- `DEV_GET_SUPPORTED_RAW_STREAMS`
- `DEV_RAW_STREAMS_CONTROL`
- `SLAM_6DOF_CONTROL`
- `DEV_START`
- `DEV_STOP`

Firmware `0.2.0.951` reports `UNKNOWN_MESSAGE_ID` for `SLAM_SET_6DOF_INTERRUPT_RATE`, so the working path intentionally leaves the firmware's default pose interrupt behavior in place.

The verified internal tracking profile selection mirrors the T265-compatible librealsense path:

- Fisheye[0] — 848×800 @ 30 Hz
- Fisheye[1] — 848×800 @ 30 Hz
- Gyro[0] — 200 Hz
- Accelerometer[0] — 62 Hz

Those streams are configured for the T265's internal SLAM pipeline; the direct-pose path only consumes the resulting pose packets on the host.

### Verified live pose

Live pose packets are `104` bytes on the tested unit. Sustained browser reception was measured at approximately `200 Hz`:

```text
Pose frame 300:  199.4 Hz
Pose frame 600:  200.5 Hz
Pose frame 900:  200.4 Hz
Pose frame 1200: 200.3 Hz
```

The USB receiver processes the raw pose stream independently from the canvas refresh rate. The main viewer therefore keeps receiving the high-rate pose stream while feeding visualization updates at roughly display rate.

## Using the main viewer

### T265 direct WebUSB

For normal use, **Boot Lab is no longer required**.

1. Open the main GitHub Pages viewer in desktop Chrome/Edge.
2. Select the **T265** tab.
3. Click **Connect T265 WebUSB**.
4. Select the connected T265 from the browser device chooser.
5. If the device is in boot mode (`03E7:2150`), the viewer automatically:
   - downloads the commit-pinned firmware mirror,
   - verifies size and SHA-256,
   - boots the T265,
   - waits for `8087:0B37`,
   - starts the existing direct runtime/6DoF path.
6. If the T265 is already in runtime mode, tracking starts directly.

The main viewer then provides:

- live X / Y / Z position
- Roll / Pitch / Yaw
- velocity
- tracker confidence
- 3D trajectory
- origin reset
- trail clearing
- raw T265 pose-rate status

No Python process, local server, or running librealsense process is required for this path.

### D400 Direct USB

Open the **D400** tab on the GitHub Pages viewer, then:

1. Click **Refresh USB** and allow camera permission if requested.
2. Select the RealSense input whose label contains `Depth`.
3. Click **Start Depth**.
4. Move the pointer over the image to inspect raw Z16 and converted distance.
5. Adjust **Display range** or **Depth scale** as needed.

The default depth scale is currently `0.001 m / Z16 unit`. Treat metric values as provisional until the actual device/configuration depth unit has been verified.

## D400 / D405 browser depth details

On Windows 10 + Chrome, physical testing confirmed that RealSense depth pins can appear as ordinary `videoinput` devices and can be opened with `getUserMedia()`.

The tested browser path is:

```text
RealSense Depth UVC pin
        |
        | getUserMedia()
        v
HTML video element
        |
        | WebGL2 R32F / FLOAT upload
        v
Preserved normalized 16-bit samples
        |
        | round(R * 65535)
        v
Z16 depth value
```

The browser probe produced a `LIKELY_Z16` signature: `R * 65535` was extremely close to integer values across the frame.

Current direct-browser depth features include:

- RealSense Depth input discovery
- Start/stop direct UVC Depth streaming
- GPU depth colorizer
- Display-range control
- Raw Z16 probe under the mouse pointer
- Metric-distance display using an editable depth scale
- D430/D435-style and D405 Depth inputs discoverable by label

## Browser diagnostic pages

The diagnostic pages are intentionally retained even though the main viewer now supports the normal T265 flow end to end.

- `t265-webusb.html` — boot-image retrieval/verification, boot transfer, re-enumeration and runtime-interface diagnostics
- `t265-pose.html` — isolated TM2 command transport and live 6DoF pose diagnostics
- `webusb-probe.html` — generic USB descriptors and interface claimability
- `uvc-probe.html` — manual `getUserMedia()` stream inspection
- `uvc-scan.html` — automatic RealSense RGB/Depth input scan
- `depth-float-probe.html` — WebGL2 R32F precision / Z16 preservation test

Use these pages for regression testing and protocol debugging; normal T265 operation should start from the main viewer.

## Native bridge

A local bridge is still included for SDK-backed streams and comparison/reference testing:

```text
RealSense camera
      |
      | librealsense / pyrealsense2
      v
Local bridge
      |
      | WebSocket
      v
GitHub Pages frontend
```

See [`bridge/README.md`](bridge/README.md) and [`docs/BRIDGE_PROTOCOL.md`](docs/BRIDGE_PROTOCOL.md).

## GitHub Pages

The repository is deployed as a static GitHub Pages site with `.github/workflows/pages.yml`. No backend build step is required for the viewer.

A separate GitHub Actions firmware-source probe verifies that the official Intel/librealsense T265 firmware source is still reachable from a GitHub-hosted runner and still matches the expected size/SHA-256. The diagnostic workflow deletes its temporary copy and does not publish the firmware as an artifact.

## Milestones

### v0.2 — direct D400 live depth

- [x] Browser-visible Depth input discovery
- [x] `getUserMedia()` Depth open
- [x] R32F float path
- [x] Z16 preservation probe
- [x] Live GPU depth colorizer in the main viewer
- [x] Raw Z16 mouse probe
- [x] Editable depth scale
- [ ] Verify device-specific depth units without relying on a hardcoded default
- [ ] RGB + Depth simultaneous viewer

### v0.3 — 3D depth tools

- [ ] Device/resolution intrinsics profiles
- [ ] Pixel-to-3D coordinate conversion
- [ ] ROI depth statistics
- [ ] PLY export
- [ ] Depth recording/playback

### v0.4 — T265 direct browser mode

- [x] Movidius boot device discovered through WebUSB
- [x] Physical browser boot-image transfer confirmation
- [x] Runtime re-enumeration confirmation (`8087:0B37`)
- [x] Runtime vendor interface/endpoints confirmed and claimable
- [x] Runtime TM2 USB protocol over Bulk #2
- [x] T265-compatible four-profile tracking configuration
- [x] Live 104-byte 6DoF pose over Interrupt #3
- [x] Physical ~200 Hz sustained pose reception confirmation
- [x] Feed direct WebUSB pose into the existing trajectory viewer
- [x] Verify official firmware retrieval and expected SHA-256 from GitHub Actions
- [x] Verify commit-pinned GitHub Raw mirror against the same size/SHA-256
- [x] Browser boot using the verified GitHub Raw mirror
- [x] Main-viewer automatic boot → runtime → live 6DoF flow
- [ ] Cross-check browser pose numerically against `pyrealsense2`
- [ ] CSV trajectory recording
- [ ] Fisheye / IMU host streaming where practical

## T265 compatibility note

Intel RealSense T265 is an end-of-life product. The native bridge pins `pyrealsense2` to a T265-compatible SDK generation, while the browser implementation is derived from public T265-compatible librealsense TM2 protocol definitions and is tested against firmware `0.2.0.951`.

The project does not bundle Intel firmware. The automatic browser path currently depends on a commit-pinned third-party GitHub mirror that is accepted only after exact byte-size and SHA-256 verification against the known Intel image.

## License

No license has been selected yet.
