# Local RealSense Bridge

This directory contains the first live-camera bridge for RealSense Web Viewer.

The browser frontend remains static and can be hosted on GitHub Pages. The bridge is only needed when the browser must receive live RealSense SDK streams that normal browser camera APIs cannot expose reliably.

## T265 compatibility environment

For the first T265 implementation, use **Python 3.10 x64** and the pinned dependencies in `requirements-t265.txt`.

```powershell
py -3.10 -m venv .venv-t265
.\.venv-t265\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r bridge\requirements-t265.txt
```

The pin uses `pyrealsense2 2.53.1.4623`, keeping the old T265 pose API available.

## Check connected devices

```powershell
python bridge\realsense_bridge.py --list
```

Example:

```text
123456789012    Intel RealSense T265
```

## T265 pose stream

Connect the T265, then run:

```powershell
python bridge\realsense_bridge.py --mode t265
```

Default endpoint:

```text
ws://127.0.0.1:8765
```

The bridge reads the native pose frame and transmits:

- translation X/Y/Z
- velocity X/Y/Z
- acceleration X/Y/Z
- angular velocity X/Y/Z
- orientation quaternion X/Y/Z/W
- tracker confidence
- mapper confidence

The web viewer currently consumes position, velocity, quaternion, and tracker confidence for the live 3D visualization.

To choose a specific camera:

```powershell
python bridge\realsense_bridge.py --mode t265 --serial 123456789012
```

The default T265 browser send rate is 60 messages/s. Override it with:

```powershell
python bridge\realsense_bridge.py --mode t265 --send-fps 30
```

## D400 depth stream

```powershell
python bridge\realsense_bridge.py --mode depth
```

The default source is 640×480 Z16 at 30 FPS. Protocol v1 sends up to 10 depth frames/s because JSON + base64 is intentionally a simple compatibility transport.

```powershell
python bridge\realsense_bridge.py --mode depth --width 640 --height 480 --source-fps 30 --send-fps 10
```

Future versions should replace base64 depth transfer with binary frames or another efficient local transport.

## First live test

For the least-friction first hardware test, serve the repository locally so the page is HTTP and can connect to the local `ws://` bridge without HTTPS mixed-content restrictions.

From the repository root:

```powershell
py -3.10 -m http.server 8000
```

Open:

```text
http://127.0.0.1:8000
```

Then:

1. Select **Live**.
2. Keep `ws://127.0.0.1:8765` as the endpoint.
3. Click **Connect**.
4. Start the bridge if it is not already running.

For a true GitHub-Pages-to-live-camera path, the bridge transport needs a browser-trusted `wss://` endpoint or another secure local transport. The viewer/demo itself does not need the bridge.

## Auto mode

```powershell
python bridge\realsense_bridge.py --mode auto
```

Auto mode prefers a connected T265. If no T265 is found, it selects a non-T265 RealSense device as a depth camera.

## Protocol

See [`../docs/BRIDGE_PROTOCOL.md`](../docs/BRIDGE_PROTOCOL.md).
