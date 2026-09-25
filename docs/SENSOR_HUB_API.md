# RealSense Sensor Hub API v1

The root RealSense Web Viewer can now act as a browser-only sensor hub for other pages under the same origin.

## Channel

```js
new BroadcastChannel("realsense-sensor-api-v1")
```

All messages include:

```json
{
  "protocol": 1,
  "source": "realsense-web-viewer",
  "type": "..."
}
```

## T265 pose

The direct WebUSB receiver publishes the raw T265 pose stream before viewer-rate throttling.

Message type:

```
t265_pose
```

Fields include:

- `seq`
- `host_timestamp_ms`
- `device_timestamp_ns`
- `raw_frame`
- `raw_pose_hz`
- `position {x,y,z}`
- `quaternion {x,y,z,w}`
- `velocity`
- `angular_velocity`
- `acceleration`
- `angular_acceleration`
- `tracker_confidence`
- `mapper_confidence`
- `tracker_state`

The physically verified T265 path receives raw pose packets at approximately 200 Hz.

## D435 depth

The browser UVC/R32F path remains the source. For the API, the GPU depth texture is downsampled to 320×240 and read back as Z16 at up to 10 Hz.

Message type:

```
d435_depth
```

Important fields:

```json
{
  "width": 320,
  "height": 240,
  "encoding": "z16le",
  "depth_scale_m": 0.001,
  "origin": "top-left",
  "data": "Uint16Array"
}
```

The typed array is delivered through BroadcastChannel structured cloning.

## Simultaneous D435 + T265 workflow

1. Open the main viewer.
2. Select D400.
3. Start the D435 Depth stream.
4. Click Connect T265 WebUSB.
5. The viewer switches to the live T265 view, but the D435 Depth stream remains active in the background.
6. Open `sensor-api-test.html` to verify both streams are being received.

## Client library

```js
import { RealSenseSensorClient } from "./src/realsense-sensor-client.js";

const sensors = new RealSenseSensorClient("my-app");

sensors.addEventListener("t265_pose", (e) => {
  console.log(e.detail.position, e.detail.quaternion);
});

sensors.addEventListener("d435_depth", (e) => {
  const frame = e.detail;
  console.log(frame.width, frame.height, frame.data);
});
```

This API is intended to be consumed by `realsense-browser-slam` next.

## Current scope

v1 publishes T265 pose and D435 depth. D435 RGB remains directly available through the browser UVC path and can be added to the hub after the pose/depth transport is physically verified.
