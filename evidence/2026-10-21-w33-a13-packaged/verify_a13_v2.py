"""A13 packaged-artifact verification (v2): independent, self-computed assertions."""
from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

PKG = Path(sys.argv[1])
SRC_FFMPEG = Path(sys.argv[2])
FIXTURES = [Path(p) for p in sys.argv[3].split("|")]
PKG_FFMPEG = PKG / "ffmpeg/win-x64/ffmpeg.exe"
PKG_FFPROBE = PKG / "ffmpeg/win-x64/ffprobe.exe"

LONG_EDGE = 768
QSCALE = 3


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """Independent SOF parser (mirrors keyframe_encode.jpeg_dimensions at HEAD)."""
    if data[:2] != b"\xff\xd8":
        raise ValueError(f"not a JPEG (SOI={data[:2]!r})")
    i, end = 2, len(data)
    while i + 1 < end:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            i += 2
            continue
        if i + 4 > end:
            break
        seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height, width = struct.unpack(">HH", data[i + 5:i + 9])
            return width, height
        if seg_len < 2:
            break
        i += 2 + seg_len
    raise ValueError("no SOF segment")


def jpeg_args(inp: Path, ts_us: int, long_edge: int = LONG_EDGE, qscale: int = QSCALE) -> list[str]:
    """Byte-for-byte mirror of keyframe_encode.jpeg_args (HEAD)."""
    scale = "scale='if(gt(iw,ih),{0},-2)':'if(gt(iw,ih),-2,{0})'".format(long_edge)
    return [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", f"{ts_us / 1_000_000:.6f}",
        "-i", str(inp),
        "-frames:v", "1",
        "-vf", scale,
        "-c:v", "mjpeg",
        "-q:v", str(qscale),
        "-f", "image2",
        "-",
    ]


def run(exe: Path, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([str(exe), *args], capture_output=True, check=False)


def probe_streams(fx: Path) -> dict:
    cp = run(PKG_FFPROBE, ["-hide_banner", "-v", "error", "-show_entries",
                           "stream=index,codec_type,codec_name,width,height,sample_rate,channels",
                           "-of", "json", str(fx)])
    try:
        return json.loads(cp.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return {}


report: dict = {"pkg_root": str(PKG)}

# --- 1. artifact presence ---
report["artifact"] = {}
for p in (PKG_FFMPEG, PKG_FFPROBE):
    report["artifact"][p.name] = {
        "path": str(p), "exists": p.is_file(),
        "bytes": p.stat().st_size if p.is_file() else None,
        "sha256": sha256(p) if p.is_file() else None,
    }
report["artifact"]["matches_source_ffmpeg"] = (
    report["artifact"]["ffmpeg.exe"]["sha256"] == sha256(SRC_FFMPEG))

# --- 2. encoder / decoder inventory (packaged binary only) ---
enc = run(PKG_FFMPEG, ["-hide_banner", "-encoders"])
enc_lines = enc.stdout.decode("utf-8", errors="replace").splitlines()
report["encoders"] = {
    "returncode": enc.returncode,
    "total_lines": len(enc_lines),
    "mjpeg_lines": [ln for ln in enc_lines if " mjpeg" in ln],
    "exact_mjpeg_encoder_line": [ln for ln in enc_lines
                                 if len(ln.split()) > 1 and ln.split()[1] == "mjpeg"],
}

# --- 3+4 per fixture ---
report["fixtures"] = []
for fx in FIXTURES:
    row: dict = {
        "fixture": str(fx),
        "fixture_bytes": fx.stat().st_size,
        "fixture_sha256": sha256(fx),
    }
    streams = probe_streams(fx).get("streams", [])
    row["streams"] = streams
    vstream = next((s for s in streams if s.get("codec_type") == "video"), None)
    astream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    row["has_audio"] = astream is not None

    # 3. encode parity packaged vs source tree
    row["encode"] = {}
    for ts_us in (500_000, 1_500_000):
        variants, same = {}, True
        for label, exe in (("packaged", PKG_FFMPEG), ("source_tree", SRC_FFMPEG)):
            cp = run(exe, jpeg_args(fx, ts_us))
            e: dict = {"returncode": cp.returncode,
                       "stderr_tail": cp.stderr.decode("utf-8", "replace")[-300:]}
            if cp.returncode == 0 and cp.stdout:
                w, h = jpeg_dimensions(cp.stdout)
                e.update({"bytes": len(cp.stdout),
                          "sha256": hashlib.sha256(cp.stdout).hexdigest(),
                          "dims": [w, h], "long_edge": max(w, h),
                          "long_edge_ok": max(w, h) == LONG_EDGE,
                          "soi_ok": cp.stdout[:2] == b"\xff\xd8",
                          "eoi_ok": cp.stdout[-2:] == b"\xff\xd9"})
            variants[label] = e
        same = variants["packaged"].get("sha256") == variants["source_tree"].get("sha256")
        row["encode"][f"{ts_us}us"] = {"variants": variants, "byte_identical": same}

    # 4a. video decode: 5 frames -> NV12 raw, assert exact byte count
    cp = run(PKG_FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error",
                          "-i", str(fx), "-frames:v", "5",
                          "-f", "rawvideo", "-pix_fmt", "nv12", "-"])
    d: dict = {"returncode": cp.returncode, "bytes": len(cp.stdout),
               "stderr_tail": cp.stderr.decode("utf-8", "replace")[-300:]}
    if vstream and cp.returncode == 0:
        w, h = int(vstream["width"]), int(vstream["height"])
        frame_bytes = w * h * 3 // 2
        d.update({"frame_wh": [w, h], "frame_bytes": frame_bytes,
                  "expected_bytes": frame_bytes * 5,
                  "nv12_bytes_match": len(cp.stdout) == frame_bytes * 5,
                  "frames_decoded": len(cp.stdout) // frame_bytes})
    row["video_decode_nv12"] = d

    # 4b. video decode -> PNG, assert PNG signature + IHDR dims
    png = run(PKG_FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error",
                           "-ss", "0.500000", "-i", str(fx), "-frames:v", "1",
                           "-f", "image2", "-c:v", "png", "-"])
    p: dict = {"returncode": png.returncode, "bytes": len(png.stdout),
               "stderr_tail": png.stderr.decode("utf-8", "replace")[-300:]}
    if png.returncode == 0 and png.stdout[:8] == b"\x89PNG\r\n\x1a\n":
        pw, ph = struct.unpack(">II", png.stdout[16:24])
        p.update({"png_signature_ok": True, "ihdr_dims": [pw, ph],
                  "dims_match_stream": vstream is not None
                  and [pw, ph] == [int(vstream["width"]), int(vstream["height"])]})
    else:
        p["png_signature_ok"] = False
    row["video_decode_png"] = p

    # 4c. audio decode -> PCM s16le (only meaningful when a stream exists)
    au = run(PKG_FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error",
                          "-i", str(fx), "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-"])
    a: dict = {"returncode": au.returncode, "bytes": len(au.stdout),
               "stderr_tail": au.stderr.decode("utf-8", "replace")[-300:]}
    if astream is not None:
        sr = int(astream.get("sample_rate", 0))
        dur = float(probe_streams(fx).get("format", {}).get("duration", 0) or 0)
        a.update({"sample_rate": sr, "duration_s": dur,
                  "expected_bytes_approx": int(sr * 2 * dur),
                  "decoded_seconds": round(len(au.stdout) / (sr * 2), 3) if sr else None,
                  "pcm_nonempty": len(au.stdout) > 0})
    row["audio_decode_pcm"] = a
    report["fixtures"].append(row)

# --- 5. summary assertions ---
summary = {
    "artifact_present": all(v.get("exists") for k, v in report["artifact"].items()
                            if k.endswith(".exe")),
    "bundled_ffmpeg_matches_pin": report["artifact"]["matches_source_ffmpeg"],
    "packaged_has_mjpeg_encoder": bool(report["encoders"]["exact_mjpeg_encoder_line"]),
    "all_encodes_byte_identical": all(
        r["byte_identical"] for f in report["fixtures"]
        for r in f["encode"].values() if "byte_identical" in r),
    "all_encodes_long_edge_768": all(
        v.get("long_edge_ok") for f in report["fixtures"]
        for e in f["encode"].values() for v in e["variants"].values()),
    "all_video_decode_nv12_exact": all(
        f["video_decode_nv12"].get("nv12_bytes_match") for f in report["fixtures"]),
    "all_png_decode_ok": all(f["video_decode_png"].get("png_signature_ok") for f in report["fixtures"]),
    "audio_fixtures_tested": [f["fixture"] for f in report["fixtures"] if f["has_audio"]],
    "audio_decode_all_ok": all(
        f["audio_decode_pcm"].get("pcm_nonempty") for f in report["fixtures"] if f["has_audio"]),
}
report["summary"] = summary

print(json.dumps(report, indent=2))
