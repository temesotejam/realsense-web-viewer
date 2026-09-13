# RealSense Web Viewer

Browser-based visualization for Intel RealSense depth and tracking cameras. The project is intentionally **browser-first**: use standard browser camera/USB APIs where they preserve the RealSense data, and keep a native `librealsense` bridge only as a fallback for features that browsers cannot expose.

> Status: experimental v0.4 — direct D400 depth and direct T265 6DoF are both physically verified in desktop Chromium.

## Current direction

### D400 / D405 depth cameras — direct browser path

On Windows 10 + Chrome, physical testing confirmed that RealSense depth pins can appear as ordinary `videoinput` devices and can be opened with `getUserMedia()`.

The important discovery is that Chrome's historical floating-point depth-video path is usable on the tested D430 configuration:

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

The browser probe produced a `LIKELY_Z16` signature: `R * 65535` was extremely close to integer values across the frame. The main viewer contains a **Direct USB** section under the D400 tab that uses the same R32F path in real time.

Current direct-browser features:

- RealSense Depth input discovery
- Start/stop direct UVC Depth streaming
- GPU depth colorizer
- Display-range control
- Raw Z16 probe under the mouse pointer
- Metric-distance display using an editable depth scale
- D430/D435-style and D405 Depth inputs can be discovered by label

The default depth scale is currently `0.001 m / Z16 unit`, matching the historical D435 browser calibration data, but the field is deliberately editable. Do not treat metric values as calibrated measurements until the actual device/configuration depth unit has been verified.

### T265 — verified browser-only WebUSB path

The T265 initially enumerates as a Movidius boot device (`03E7:2150`). Physical testing confirmed the complete browser-only startup and pose path:

```text
03E7:2150 Movidius boot device
        |
        | WebUSB · IF0 · Bulk OUT #1
        | target-0.2.0.951.mvcmd
        v
USB disconnect / re-enumeration
        |
        v
8087:0B37 T265 runtime
        |
        | claim vendor-specific IF0
        | Bulk OUT/IN #2 = TM2 command transport
        | Interrupt IN #3 = 6DoF pose
        v
104-byte live pose packets
~200 Hz measured on the physical test unit
```

The physical boot test transferred the complete 9,323,648-byte boot image in one WebUSB `transferOut()` and the device re-enumerated as `8087:0B37`. The runtime interface exposed Bulk #1, Bulk #2 and Interrupt #3 endpoint pairs and was claimable from Chrome.

`DEV_GET_DEVICE_INFO`, `DEV_GET_TIME`, `DEV_GET_SUPPORTED_RAW_STREAMS`, `DEV_RAW_STREAMS_CONTROL`, `SLAM_6DOF_CONTROL` and `DEV_START` were all verified over the browser TM2 transport. Firmware `0.2.0.951` reports `UNKNOWN_MESSAGE_ID` for `SLAM_SET_6DOF_INTERRUPT_RATE`, so the working browser path follows the compatible behavior of leaving the firmware's default interrupt rate in place.

The verified tracking configuration mirrors T265-compatible librealsense selection:

- Fisheye[0] — 848×800 @ 30 Hz
- Fisheye[1] — 848×800 @ 30 Hz
- Gyro[0] — 200 Hz
- Accelerometer[0] — 62 Hz

The raw image/IMU streams remain internal to the T265 for SLAM; only pose packets are consumed by the browser in the direct-pose path.

### T265 browser pages

`t265-webusb.html` handles the boot/re-enumeration experiment. It can:

- request only the `03E7:2150` boot device
- locate interface 0 and its Bulk OUT endpoint
- load a user-supplied `target-*.mvcmd` image without bundling proprietary firmware
- calculate and log the selected image SHA-256
- send the complete boot image with one WebUSB `transferOut()` operation
- detect / authorize `8087:0B37` / `8087:0AF3` runtime devices
- enumerate runtime interfaces/endpoints and test claimability

`t265-pose.html` is the isolated runtime diagnostic. It verifies command transport and live pose parsing without involving the main visualization.

The main viewer now also exposes **Connect T265 WebUSB**. It routes direct browser pose into the existing live-pose path, so the existing 3D trajectory, position/orientation/velocity readouts, origin reset and trail clearing can be reused without a Python process or local server.

The direct receiver measures every raw interrupt packet (about 200 Hz on the tested unit) while feeding the visualization at approximately display rate to avoid coupling USB reception to canvas rendering.

The native T265 bridge remains available as a fallback and a reference implementation.

## Viewer modes

### T265 demo / direct WebUSB

- Simulated 6DoF pose when no hardware is connected
- Direct T265 WebUSB runtime connection
- 3D trajectory
- Position, orientation and velocity readouts
- Origin reset and trail clearing
- Raw T265 pose rate shown in the WebUSB status hint

For direct hardware:

1. If the T265 is `03E7:2150`, use **Boot Lab** and send a genuine `target-*.mvcmd` first.
2. Return to the main viewer and click **Connect T265 WebUSB**.
3. Select the `8087:0B37` T265 runtime device.
4. The viewer switches to the existing Live path and begins drawing real T265 pose.
5. Use the normal **Disconnect** button in Live mode to stop the direct session.

### D400 demo

- Synthetic depth frame
- Depth colorizer
- Interactive distance probe

### D400 Direct USB

Open the **D400** tab on the GitHub Pages viewer, then:

1. Click **Refresh USB** and allow camera permission if requested.
2. Select the RealSense input whose label contains `Depth`.
3. Click **Start Depth**.
4. Move the pointer over the image to inspect raw Z16 and converted distance.
5. Adjust **Display range** or **Depth scale** as needed.

No Python process or local server is required for this path.

### Native bridge

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

## Browser diagnostic pages

The repository includes small experiments used to verify what the browser actually receives:

- `t265-webusb.html` — T265 boot-image transfer, runtime re-enumeration and vendor-interface diagnostics
- `t265-pose.html` — T265 runtime TM2 command transport and live 6DoF pose diagnostics
- `webusb-probe.html` — USB descriptors and interface claimability
- `uvc-probe.html` — manual `getUserMedia()` stream inspection
- `uvc-scan.html` — automatic RealSense RGB/Depth input scan
- `depth-float-probe.html` — WebGL2 R32F precision / Z16 preservation test

These pages are intentionally retained even after main-viewer integration because they isolate hardware/browser behavior during regression testing.

## GitHub Pages

The repository is deployed as a static GitHub Pages site with `.github/workflows/pages.yml`. No backend build step is required for the viewer.

## Planned milestones

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

- [ ] Point cloud
- [ ] Device/resolution intrinsics profiles
- [ ] Pixel-to-3D coordinate conversion
- [ ] ROI depth statistics
- [ ] PLY export
- [ ] Depth recording/playback

### v0.4 — T265 direct browser mode

- [x] Movidius boot device discovered through WebUSB
- [x] Vendor-specific interface claim test
- [x] Browser boot transport implemented from librealsense behavior
- [x] Physical browser boot-image transfer confirmation
- [x] Runtime device re-enumeration confirmation (`8087:0B37`)
- [x] Runtime TM2 USB protocol over Bulk #2
- [x] Live 104-byte 6DoF pose over Interrupt #3
- [x] Physical ~200 Hz pose reception confirmation
- [x] Feed direct WebUSB pose into the existing trajectory viewer
- [ ] Cross-check browser pose numerically against `pyrealsense2`
- [ ] Fisheye / IMU host streaming where practical
- [ ] CSV trajectory recording

## T265 compatibility note

Intel RealSense T265 is an end-of-life product. The bridge pins `pyrealsense2` to a T265-compatible SDK generation so that browser work can continue without tying the whole web frontend to a legacy SDK. The browser implementation is derived from the public T265-compatible librealsense TM2 protocol definitions and is tested against firmware `0.2.0.951`.

## License

No license has been selected yet.
