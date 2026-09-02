# RealSense Web Viewer

Browser-based visualization for Intel RealSense depth and tracking cameras, with first-class support for **T265** motion tracking and a path toward **D400-series** depth visualization.

> Status: early prototype / Version 1 scaffold.

## Goals

- Run the viewer UI as a static site on GitHub Pages.
- Visualize T265-style 6DoF pose in 3D, including trajectory, position, orientation, velocity, and tracking confidence.
- Visualize D400-style depth data as a colorized depth image.
- Keep the frontend independent from the native RealSense SDK.
- Define a small transport protocol so a local `librealsense` bridge can feed live camera data later.

## Version 1

The initial prototype contains two built-in demo modes so the UI can be tested without RealSense hardware:

- **T265 Tracking Demo** — simulated 6DoF camera motion, 3D trajectory, pose and velocity readouts.
- **D400 Depth Demo** — simulated depth frame with an interactive depth probe.

A **Live Bridge** connection mode is also represented in the UI. The frontend protocol is documented in [`docs/BRIDGE_PROTOCOL.md`](docs/BRIDGE_PROTOCOL.md).

## Architecture

```text
RealSense camera
      |
      | librealsense (native)
      v
Local bridge
      |
      | WebSocket / local transport
      v
GitHub Pages frontend
      |
      +-- T265 pose / trajectory / IMU
      +-- D400 depth / color / IR
      +-- recording / analysis (future)
```

The static viewer does not bundle `librealsense`. Direct browser access to all RealSense USB interfaces is not currently treated as a dependable cross-platform path, so native camera access is intentionally isolated behind a bridge.

## Run locally

Because this is a static application, any simple HTTP server is enough.

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## GitHub Pages

A Pages deployment workflow is included in `.github/workflows/pages.yml`.

After the first push, set the repository's **Settings → Pages → Build and deployment → Source** to **GitHub Actions** if GitHub has not already selected it.

## Planned milestones

### v0.1 — Browser prototype
- [x] Static viewer shell
- [x] T265 trajectory demo
- [x] 6DoF pose readout
- [x] D400 depth demo
- [x] Depth probe
- [x] GitHub Pages workflow
- [ ] Live `librealsense` bridge

### v0.2 — T265 live mode
- [ ] T265 pose stream
- [ ] Fisheye left/right
- [ ] Gyroscope / accelerometer
- [ ] Tracking confidence
- [ ] Origin reset
- [ ] CSV recording

### v0.3 — D400 live mode
- [ ] Depth
- [ ] Color
- [ ] Infrared
- [ ] Depth colorizer
- [ ] Point cloud
- [ ] Pixel distance measurement

### v0.4 — Analysis
- [ ] Timeline playback
- [ ] Pose graphs
- [ ] ROI depth statistics
- [ ] PLY/CSV export
- [ ] Multi-camera view (for example T265 + D435i)

## T265 compatibility note

Intel RealSense T265 is an end-of-life product. The native bridge should therefore keep T265-specific SDK compatibility isolated from the web frontend. This repository is designed so the frontend can continue evolving without tying the entire project to one legacy SDK version.

## License

No license has been selected yet.
