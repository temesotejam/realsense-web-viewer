#!/usr/bin/env python3
"""Minimal librealsense -> WebSocket bridge for RealSense Web Viewer.

T265 mode streams 6DoF pose JSON.
Depth mode streams Z16 depth as base64 JSON (simple v1 transport).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import pyrealsense2 as rs
from websockets.legacy.server import serve


@dataclass
class DeviceChoice:
    serial: str
    name: str
    mode: str


def device_info(device: rs.device, key: rs.camera_info, fallback: str = "unknown") -> str:
    try:
        if device.supports(key):
            return device.get_info(key)
    except Exception:
        pass
    return fallback


def enumerate_devices() -> list[tuple[str, str]]:
    ctx = rs.context()
    result: list[tuple[str, str]] = []
    for device in ctx.query_devices():
        result.append(
            (
                device_info(device, rs.camera_info.serial_number),
                device_info(device, rs.camera_info.name),
            )
        )
    return result


def choose_device(requested_mode: str, requested_serial: str | None) -> DeviceChoice:
    devices = enumerate_devices()
    if not devices:
        raise RuntimeError("No RealSense device detected")

    if requested_serial:
        matches = [item for item in devices if item[0] == requested_serial]
        if not matches:
            known = ", ".join(serial for serial, _ in devices)
            raise RuntimeError(f"Serial {requested_serial!r} not found. Connected: {known}")
        serial, name = matches[0]
        mode = requested_mode
        if mode == "auto":
            mode = "t265" if "T265" in name.upper() else "depth"
        return DeviceChoice(serial=serial, name=name, mode=mode)

    if requested_mode in ("auto", "t265"):
        t265 = [item for item in devices if "T265" in item[1].upper()]
        if t265:
            serial, name = t265[0]
            return DeviceChoice(serial=serial, name=name, mode="t265")
        if requested_mode == "t265":
            raise RuntimeError("T265 mode requested, but no T265 was detected")

    depth_candidates = [item for item in devices if "T265" not in item[1].upper()]
    if not depth_candidates:
        raise RuntimeError("No depth-camera candidate detected")
    serial, name = depth_candidates[0]
    return DeviceChoice(serial=serial, name=name, mode="depth")


class RealSenseBridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.choice = choose_device(args.mode, args.serial)
        self.clients: set[Any] = set()
        self.pipeline = rs.pipeline()
        self.profile: rs.pipeline_profile | None = None
        self.depth_scale_m = 0.001
        self.send_fps = args.send_fps or (60.0 if self.choice.mode == "t265" else 10.0)
        self.last_send = 0.0

    def start_camera(self) -> None:
        config = rs.config()
        config.enable_device(self.choice.serial)

        if self.choice.mode == "t265":
            config.enable_stream(rs.stream.pose)
        else:
            config.enable_stream(
                rs.stream.depth,
                self.args.width,
                self.args.height,
                rs.format.z16,
                self.args.source_fps,
            )

        self.profile = self.pipeline.start(config)
        device = self.profile.get_device()
        self.choice.name = device_info(device, rs.camera_info.name, self.choice.name)
        self.choice.serial = device_info(device, rs.camera_info.serial_number, self.choice.serial)

        if self.choice.mode == "depth":
            self.depth_scale_m = float(device.first_depth_sensor().get_depth_scale())

    def stop_camera(self) -> None:
        if self.profile is not None:
            try:
                self.pipeline.stop()
            finally:
                self.profile = None

    def device_message(self) -> dict[str, Any]:
        return {
            "type": "device",
            "protocol": 1,
            "model": self.choice.name,
            "serial": self.choice.serial,
            "stream": "pose" if self.choice.mode == "t265" else "depth",
        }

    async def handle_client(self, websocket: Any, path: str | None = None) -> None:
        del path
        self.clients.add(websocket)
        print(f"[viewer] connected ({len(self.clients)} client(s))")
        try:
            await websocket.send(json.dumps(self.device_message(), separators=(",", ":")))
            async for raw in websocket:
                if not isinstance(raw, str):
                    continue
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if message.get("type") == "viewer_hello":
                    await websocket.send(json.dumps(self.device_message(), separators=(",", ":")))
        finally:
            self.clients.discard(websocket)
            print(f"[viewer] disconnected ({len(self.clients)} client(s))")

    async def broadcast(self, message: dict[str, Any]) -> None:
        if not self.clients:
            return
        payload = json.dumps(message, separators=(",", ":"))
        dead = []
        for client in tuple(self.clients):
            try:
                await client.send(payload)
            except Exception:
                dead.append(client)
        for client in dead:
            self.clients.discard(client)

    def should_send(self) -> bool:
        now = time.monotonic()
        period = 1.0 / max(0.1, self.send_fps)
        if now - self.last_send < period:
            return False
        self.last_send = now
        return True

    async def stream_t265(self) -> None:
        while True:
            frames = await asyncio.to_thread(self.pipeline.wait_for_frames, 2000)
            pose_frame = frames.get_pose_frame()
            if not pose_frame or not self.should_send():
                continue

            data = pose_frame.get_pose_data()
            message = {
                "type": "pose",
                "timestamp_ms": float(pose_frame.get_timestamp()),
                "position": {
                    "x": float(data.translation.x),
                    "y": float(data.translation.y),
                    "z": float(data.translation.z),
                },
                "velocity": {
                    "x": float(data.velocity.x),
                    "y": float(data.velocity.y),
                    "z": float(data.velocity.z),
                },
                "acceleration": {
                    "x": float(data.acceleration.x),
                    "y": float(data.acceleration.y),
                    "z": float(data.acceleration.z),
                },
                "angular_velocity": {
                    "x": float(data.angular_velocity.x),
                    "y": float(data.angular_velocity.y),
                    "z": float(data.angular_velocity.z),
                },
                "quaternion": {
                    "x": float(data.rotation.x),
                    "y": float(data.rotation.y),
                    "z": float(data.rotation.z),
                    "w": float(data.rotation.w),
                },
                "tracker_confidence": int(data.tracker_confidence),
                "mapper_confidence": int(data.mapper_confidence),
            }
            await self.broadcast(message)

    async def stream_depth(self) -> None:
        while True:
            frames = await asyncio.to_thread(self.pipeline.wait_for_frames, 2000)
            depth_frame = frames.get_depth_frame()
            if not depth_frame or not self.should_send():
                continue

            array = np.asanyarray(depth_frame.get_data())
            if array.dtype != np.uint16:
                array = array.astype(np.uint16, copy=False)
            raw = array.tobytes(order="C")
            message = {
                "type": "depth",
                "timestamp_ms": float(depth_frame.get_timestamp()),
                "width": int(depth_frame.get_width()),
                "height": int(depth_frame.get_height()),
                "depth_scale_m": self.depth_scale_m,
                "encoding": "z16le-base64",
                "data": base64.b64encode(raw).decode("ascii"),
            }
            await self.broadcast(message)

    async def camera_loop(self) -> None:
        if self.choice.mode == "t265":
            await self.stream_t265()
        else:
            await self.stream_depth()

    async def run(self) -> None:
        self.start_camera()
        print(
            f"[camera] {self.choice.name} serial={self.choice.serial} "
            f"mode={self.choice.mode} send_fps={self.send_fps:g}"
        )
        print(f"[bridge] ws://{self.args.host}:{self.args.port}")

        producer = asyncio.create_task(self.camera_loop())
        try:
            async with serve(
                self.handle_client,
                self.args.host,
                self.args.port,
                max_size=None,
                ping_interval=20,
                ping_timeout=20,
            ):
                await asyncio.Future()
        finally:
            producer.cancel()
            try:
                await producer
            except asyncio.CancelledError:
                pass
            self.stop_camera()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="RealSense Web Viewer local bridge")
    parser.add_argument("--mode", choices=("auto", "t265", "depth"), default="auto")
    parser.add_argument("--serial", help="RealSense serial number to open")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--send-fps", type=float, default=0.0, help="0 = 60 for T265, 10 for depth")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--source-fps", type=int, default=30)
    parser.add_argument("--list", action="store_true", help="List connected RealSense devices and exit")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.list:
        devices = enumerate_devices()
        if not devices:
            print("No RealSense devices detected")
            return 1
        for serial, name in devices:
            print(f"{serial}\t{name}")
        return 0

    bridge = RealSenseBridge(args)
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        print("\nStopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
