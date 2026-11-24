"""Generate deterministic local video/audio sources for P235 dual-renderer captures."""

from __future__ import annotations

import math
import json
import subprocess
import tempfile
import wave
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np


ROOT = Path(__file__).resolve().parent
MEDIA = ROOT / "media"
MEDIA.mkdir(parents=True, exist_ok=True)


def video_frame(index: int, fps: int, width: int, height: int) -> np.ndarray:
    t = index / fps
    phase = (index * 7) % width
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    for y in range(height):
        frame[y, :, 0] = np.clip(28 + y * 0.47 + 24 * math.sin(t * 0.7), 0, 255)
        frame[y, :, 1] = np.clip(68 + y * 0.23 + 24 * math.cos(t * 0.4), 0, 255)
        frame[y, :, 2] = np.clip(112 + y * 0.19, 0, 255)
    cv2.rectangle(frame, (0, height // 2), (width, height - 1), (44, 76, 46), -1)
    cv2.line(frame, (0, height - 1), (width - 1, height - 1), (214, 216, 180), 2)
    cv2.line(frame, (0, int(height * 0.73)), (width - 1, int(height * 0.73)), (190, 194, 166), 1)
    cv2.circle(frame, (phase, int(height * (0.36 + 0.04 * math.sin(t)))), 17, (28, 104, 236), -1)
    cv2.circle(frame, (width - phase, int(height * 0.62)), 8, (72, 221, 224), -1)
    cv2.putText(frame, f"P235  {int(t // 5):02d}", (10, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (240, 242, 244), 1, cv2.LINE_AA)
    return frame


def write_video() -> None:
    path = MEDIA / "p235-timeline-video.mp4"
    with tempfile.TemporaryDirectory(prefix="p235-video-") as temporary:
        source = Path(temporary) / "video-source.mp4"
        writer = cv2.VideoWriter(str(source), cv2.VideoWriter_fourcc(*"mp4v"), 15, (320, 180))
        if not writer.isOpened():
            raise RuntimeError("OpenCV could not open the MP4V writer")
        try:
            for index in range(21 * 15):
                writer.write(video_frame(index, 15, 320, 180))
        finally:
            writer.release()
        subprocess.run([
            imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-i", str(MEDIA / "p235-timeline-audio.wav"),
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
            "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
            "-shortest", "-movflags", "+faststart", str(path),
        ], check=True)

    capture = cv2.VideoCapture(str(path))
    try:
        for seconds in range(0, 21, 2):
            capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError(f"Could not extract the shared filmstrip frame at {seconds}s")
            cv2.imwrite(str(MEDIA / f"p235-frame-{seconds:02d}s.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    finally:
        capture.release()


def write_audio() -> None:
    path = MEDIA / "p235-timeline-audio.wav"
    sample_rate = 48_000
    duration_seconds = 60
    frames = bytearray()
    for i in range(sample_rate * duration_seconds):
        t = i / sample_rate
        envelope = 0.16 + 0.66 * (0.5 + 0.5 * math.sin(2 * math.pi * t / 5.2))
        envelope *= 0.18 if int(t) % 11 in (7, 8) else 1.0
        sample = int(32767 * envelope * (0.65 * math.sin(2 * math.pi * 220 * t) + 0.35 * math.sin(2 * math.pi * 613 * t)))
        frames.extend(sample.to_bytes(2, "little", signed=True))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(frames)

    with wave.open(str(path), "rb") as source:
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
    hop = sample_rate // 40
    peaks = [float(np.max(np.abs(samples[i : i + hop]))) for i in range(0, len(samples), hop)]
    waveform = MEDIA / "p235-timeline-audio-waveform.json"
    waveform.write_text(json.dumps({"duration": duration_seconds, "peaks": peaks}, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    write_audio()
    write_video()
    for path in sorted(MEDIA.iterdir()):
        print(f"{path.name} {path.stat().st_size}")
