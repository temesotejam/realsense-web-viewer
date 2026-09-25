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


## Headless Hub

Normal applications should embed:

```text
https://temesotejam.github.io/realsense-web-viewer/sensor-hub.html
```

The page has no required operator controls. On load it automatically:

1. finds an already-permitted RealSense Depth UVC input and starts it;
2. finds an already-authorized T265 runtime, or an already-authorized boot device and boots it;
3. publishes both streams on `realsense-sensor-api-v1`;
4. retries missing devices after reconnect.

The client can also issue:

```js
client.start();
client.stop();
client.restart();
```

which send `sensor_api_start`, `sensor_api_stop`, and `sensor_api_restart`.

### Browser permission limitation

The first camera permission and the first WebUSB device authorization are controlled by the browser and cannot be silently granted by JavaScript. After the devices have been authorized for the origin, the headless Hub uses the permitted-device lists and starts without Viewer interaction.


## D435 image orientation

The D435 used by this project is mounted in its physically correct orientation. Physical testing showed that the browser-visible Depth image requires only a horizontal correction; vertical orientation is already handled by the WebGL/readback coordinate path. Sensor Hub v1 therefore normalizes the D435 Depth stream before publishing it:

```text
pixel_transform: flip-x
orientation: physical-upright
origin: top-left
```

The same correction is applied to the live Depth viewer and probe coordinates. Consumers should use the published image as-is and must not apply another horizontal flip.
