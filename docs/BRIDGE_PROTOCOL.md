# Live Bridge Protocol v1

The GitHub Pages frontend is intentionally independent from `librealsense`. A small native process can connect to the camera and stream normalized messages to the browser over WebSocket.

Protocol version: **1**

Default development endpoint:

```text
ws://127.0.0.1:8765
```

> Note: an HTTPS-hosted page may reject an insecure `ws://` endpoint depending on browser security policy. For production use, expose the local bridge through a trusted `wss://` endpoint or run the viewer locally over HTTP while developing the bridge. The transport layer may be changed later without changing the normalized RealSense messages below.

## Viewer hello

After a WebSocket connection opens, the browser sends:

```json
{
  "type": "viewer_hello",
  "protocol": 1,
  "viewer": "realsense-web-viewer"
}
```

The bridge may ignore this message in v1.

## Device announcement

```json
{
  "type": "device",
  "model": "Intel RealSense T265",
  "serial": "00000000"
}
```

Only `type` is mandatory. `model` and `serial` are optional.

## T265 pose

Angles use radians. Position and velocity use SI units.

Quaternion orientation is preferred because it preserves the SDK pose without an Euler conversion at the bridge.

```json
{
  "type": "pose",
  "timestamp_ms": 123456.78,
  "position": {
    "x": 0.120,
    "y": -0.035,
    "z": 0.842
  },
  "velocity": {
    "x": 0.050,
    "y": 0.002,
    "z": -0.010
  },
  "quaternion": {
    "x": 0.001,
    "y": 0.031,
    "z": -0.004,
    "w": 0.999
  },
  "tracker_confidence": 3,
  "mapper_confidence": 3
}
```

The frontend also accepts Euler orientation when a bridge has already converted it:

```json
{
  "type": "pose",
  "position": { "x": 0, "y": 0, "z": 0 },
  "velocity": { "x": 0, "y": 0, "z": 0 },
  "euler": {
    "roll": 0.01,
    "pitch": -0.02,
    "yaw": 1.20
  },
  "tracker_confidence": 3
}
```

`tracker_confidence` follows the T265 SDK convention:

- `0` — failed
- `1` — low
- `2` — medium
- `3` — high

## D400 depth frame

For protocol v1, a depth frame can be sent as base64-encoded little-endian unsigned 16-bit samples. This is deliberately simple, not bandwidth-optimal.

```json
{
  "type": "depth",
  "timestamp_ms": 123456.78,
  "width": 640,
  "height": 480,
  "depth_scale_m": 0.001,
  "encoding": "z16le-base64",
  "data": "AAABAAIA..."
}
```

The decoded sample count must equal `width * height`.

The browser calculates metric depth as:

```text
depth_m = raw_z16 * depth_scale_m
```

## Future message types

The following are intentionally reserved for later versions:

- `imu` — accelerometer / gyroscope
- `fisheye` — T265 fisheye left/right
- `color` — D400 RGB stream
- `infrared` — D400 IR stream
- `intrinsics`
- `extrinsics`
- `pointcloud`
- `event` — reset/relocalization/device status

High-rate image streams should move to binary WebSocket frames or another efficient local transport in a later protocol revision. JSON + base64 is only the v1 interoperability baseline.

## Coordinate policy

The bridge should preserve RealSense SDK coordinates in the transmitted pose. Coordinate conversion for visualization belongs in the frontend so recorded data remains traceable to the native source.

For T265, do not silently swap axes or change quaternion handedness in the bridge. If a later application needs another world convention (robotics ENU/NED, Unity, ROS, etc.), make that an explicit viewer transform.
