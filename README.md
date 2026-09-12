# RealSense Web Viewer

Browser-based visualization for Intel RealSense depth and tracking cameras. The project is intentionally **browser-first**: use standard browser camera/USB APIs where they preserve the RealSense data, and keep a native `librealsense` bridge only as a fallback for features that browsers cannot expose.

> Status: experimental v0.2 — direct browser depth streaming is now integrated for testing.

## Current direction

### D400 / D405 depth cameras — direct browser path

On Windows 10 + Chrome 151, physical testing has confirmed that RealSense depth pins can appear as ordinary `videoinput` devices and can be opened with `getUserMedia()`.

The important discovery is that Chrome's historical floating-point depth-video path is still usable on the tested D430 configuration:

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

The browser probe produced a `LIKELY_Z16` signature: `R * 65535` was extremely close to integer values across the frame. The main viewer now contains a **Direct USB** section under the D400 tab that uses the same R32F path in real time.

Current direct-browser features:

- RealSense Depth input discovery
- Start/stop direct UVC Depth streaming
- GPU depth colorizer
- Display-range control
- Raw Z16 probe under the mouse pointer
- Metric-distance display using an editable depth scale
- D430/D435-style and D405 Depth inputs can be discovered by label

The default depth scale is currently `0.001 m / Z16 unit`, matching the historical D435 browser calibration data, but the field is deliberately editable. Do not treat metric values as calibrated measurements until the actual device/configuration depth unit has been verified.

### T265 — WebUSB research path

The T265 initially enumerates as a Movidius boot device (`03E7:2150`). Physical testing confirmed that Chrome can open it and claim its vendor-specific interface through WebUSB. This is promising because the interface is not one of Chromium's protected UVC/HID classes.

The browser boot experiment now mirrors the boot step used by librealsense:

```text
03E7:2150 Movidius boot device
        |
        | WebUSB · interface 0 · first Bulk OUT endpoint
        | complete target-*.mvcmd boot image
        v
USB disconnect / re-enumeration
        |
        v
8087:0B37 T265 runtime
(8087:0AF3 is also recognized as a T265-family runtime ID)
```

Open `t265-webusb.html` to run the experiment. It can:

- request only the `03E7:2150` boot device
- locate interface 0 and its Bulk OUT endpoint
- load a user-supplied `target-*.mvcmd` image without bundling proprietary firmware
- calculate and log the selected image SHA-256
- send the complete boot image with one WebUSB `transferOut()` operation
- wait for an already-permitted `8087:0B37` / `8087:0AF3` runtime device
- explicitly request runtime permission when Chrome treats the re-enumerated device as a new permission target
- enumerate runtime interfaces/endpoints and test claimability of vendor-specific interfaces

The transport code is implemented, but the boot/re-enumeration path still needs a physical T265 test before it should be considered verified. Runtime commands and pose decoding are intentionally not sent yet.

The next T265 browser-only milestones are:

1. Physically verify the browser boot transfer with a genuine T265 boot image.
2. Confirm re-enumeration and the exact claimable runtime interface/endpoints.
3. Implement the T265 runtime message transport in JavaScript.
4. Decode live pose packets and validate them against `pyrealsense2`.
5. Feed live 6DoF pose into the existing trajectory viewer.

The native T265 bridge remains available as a fallback and as a reference implementation while the browser-only transport is developed.

## Viewer modes

### T265 demo

- Simulated 6DoF pose
- 3D trajectory
- Position, orientation and velocity readouts
- Origin reset and trail clearing

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

A local bridge is still included for SDK-backed streams and T265 development:

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
- `webusb-probe.html` — USB descriptors and interface claimability
- `uvc-probe.html` — manual `getUserMedia()` stream inspection
- `uvc-scan.html` — automatic RealSense RGB/Depth input scan
- `depth-float-probe.html` — WebGL2 R32F precision / Z16 preservation test

These pages are intentionally separated from the main viewer so hardware/browser behavior can be tested without destabilizing the application.

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
- [x] Runtime VID/PID permission + interface diagnostic implemented
- [ ] Physical browser boot-image transfer confirmation
- [ ] Runtime device re-enumeration confirmation
- [ ] Runtime USB protocol
- [ ] Live 6DoF pose
- [ ] Fisheye / IMU where practical
- [ ] CSV trajectory recording

## T265 compatibility note

Intel RealSense T265 is an end-of-life product. The bridge pins `pyrealsense2` to a T265-compatible SDK generation so that browser work can continue without tying the whole web frontend to a legacy SDK.

## License

No license has been selected yet.