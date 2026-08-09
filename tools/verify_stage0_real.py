from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TEMP = Path(os.environ.get("TEMP", "C:/Temp")) / "aivideo-stage0-real-py"
RUN_ID = f"{os.getpid()}-{time.time_ns()}"
RUNTIME = TEMP / f"runtime-{RUN_ID}"
DATA = TEMP / f"data-{RUN_ID}"
EVIDENCE = RUNTIME / "evidence"
REPORT = TEMP / "report.json"
READY = RUNTIME / "ready.json"
CORE_LOG = RUNTIME / "core.log"
CORE_ERR_LOG = RUNTIME / "core.err.log"
TOKEN = "stage0-admin-token"


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def checkpoint(report_data: dict[str, Any]) -> None:
    report_data["updated_at"] = time.time()
    write_json(REPORT, report_data)


def add_check(
    report_data: dict[str, Any],
    name: str,
    status: str,
    details: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    check: dict[str, Any] = {"name": name, "status": status}
    if details:
        check.update(details)
    if error:
        check["error"] = error
    report_data.setdefault("checks", []).append(check)
    checkpoint(report_data)


def request(
    base: str,
    path: str,
    token: str | None = None,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if payload else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {path}: {body_text}") from exc


def wait_job(base: str, token: str, job_id: str, timeout: float = 90) -> dict[str, Any]:
    deadline = time.time() + timeout
    state = request(base, f"/api/v1/jobs/{job_id}", token)
    while state["status"] not in {"succeeded", "failed", "cancelled", "interrupted"}:
        if time.time() >= deadline:
            raise RuntimeError(f"job timeout: {job_id}")
        time.sleep(0.3)
        state = request(base, f"/api/v1/jobs/{job_id}", token)
    return state


def wait_status(
    base: str, token: str, job_id: str, wanted: set[str], timeout: float = 30
) -> dict[str, Any]:
    deadline = time.time() + timeout
    state = request(base, f"/api/v1/jobs/{job_id}", token)
    while state["status"] not in wanted:
        if time.time() >= deadline:
            raise RuntimeError(f"job did not reach {sorted(wanted)}: {job_id}")
        time.sleep(0.2)
        state = request(base, f"/api/v1/jobs/{job_id}", token)
    return state


def process_ids_for(executable_name: str) -> set[int]:
    command = (
        "Get-CimInstance Win32_Process | "
        f"Where-Object {{$_.Name -eq '{executable_name}'}} | "
        "Select-Object -ExpandProperty ProcessId"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", command],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return {int(line.strip()) for line in result.stdout.splitlines() if line.strip().isdigit()}


def run_ffprobe(ffprobe: Path, source: Path, evidence_path: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [str(ffprobe), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"ffprobe failed ({completed.returncode}): {completed.stderr[-1000:]}")
    try:
        info = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ffprobe returned invalid JSON: {completed.stdout[:500]}") from exc
    write_json(evidence_path, info)
    return info


def output_spec(
    ffprobe: Path,
    output: Path,
    kind: str,
    expected_audio: bool,
    evidence_name: str,
) -> dict[str, Any]:
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError(f"artifact missing or empty: {output}")
    info = run_ffprobe(ffprobe, output, EVIDENCE / evidence_name)
    streams = info.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if video is None:
        raise RuntimeError(f"artifact has no video stream: {output}")
    if video.get("codec_name") != "h264":
        raise RuntimeError(f"artifact codec is not h264: {video}")
    if video.get("pix_fmt") != "yuv420p":
        raise RuntimeError(f"artifact pixel format is not yuv420p: {video}")
    if video.get("r_frame_rate") != "30/1":
        raise RuntimeError(f"artifact is not CFR 30fps: {video}")
    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    if kind == "vertical_sample" and (width, height) != (1080, 1920):
        raise RuntimeError(f"vertical artifact has wrong dimensions: {width}x{height}")
    if kind == "proxy" and (width <= 0 or height <= 0 or width > 960 or height > 960):
        raise RuntimeError(f"proxy artifact has wrong dimensions: {width}x{height}")
    if expected_audio and (audio is None or audio.get("codec_name") != "aac"):
        raise RuntimeError(f"audio artifact is not AAC: {audio}")
    if not expected_audio and audio is not None:
        raise RuntimeError(f"no-audio artifact unexpectedly contains audio: {audio}")
    return {
        "path": str(output),
        "size_bytes": output.stat().st_size,
        "video": video,
        "audio": audio,
        "ffprobe_json": str(EVIDENCE / evidence_name),
    }


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def probe_media(base: str, admin: str, ui: str, asset: Path) -> tuple[str, dict[str, Any]]:
    grant = request(
        base,
        "/api/v1/internal/file-grants",
        admin,
        "POST",
        {"path": str(asset)},
    )
    media = request(base, "/api/v1/media/probe", ui, "POST", {"grant_id": grant["grant_id"]})
    return media["media_id"], media


def verify_job(
    base: str,
    admin: str,
    ui: str,
    ffprobe: Path,
    asset: Path,
    kind: str,
    duration_us: int,
    expected_audio: bool,
) -> dict[str, Any]:
    media_id, media = probe_media(base, admin, ui, asset)
    endpoint = "/api/v1/jobs/vertical-sample" if kind == "vertical_sample" else "/api/v1/jobs/proxy"
    job = request(
        base,
        endpoint,
        ui,
        "POST",
        {
            "media_id": media_id,
            "encoder_mode": "software",
            "start_us": 0,
            "duration_us": duration_us,
            "layout": "blurred_background",
        },
    )
    state = wait_job(base, ui, job["job_id"])
    if state["status"] != "succeeded":
        raise RuntimeError(f"{kind} job failed: {state}")
    if not state.get("artifacts"):
        raise RuntimeError(f"{kind} job produced no artifact: {state}")
    artifact_id = state["artifacts"][0]["id"]
    resolved = request(base, f"/api/v1/internal/artifacts/{artifact_id}/resolve", admin)
    artifact = Path(resolved["path"])
    return {
        "asset": str(asset),
        "media_id": media_id,
        "input_probe": media,
        "job_id": job["job_id"],
        "job_status": state["status"],
        "artifact": output_spec(
            ffprobe,
            artifact,
            kind,
            expected_audio,
            f"{safe_name(asset.stem)}-{kind}-{safe_name(job['job_id'])}.json",
        ),
    }


def preflight_paths() -> dict[str, Path]:
    return {
        "core": ROOT / "apps/desktop/release/win-unpacked/resources/core/aivs-core/aivs-core.exe",
        "ffmpeg": ROOT / "apps/desktop/release/win-unpacked/resources/ffmpeg/win-x64/ffmpeg.exe",
        "ffprobe": ROOT / "apps/desktop/release/win-unpacked/resources/ffmpeg/win-x64/ffprobe.exe",
    }


def main() -> int:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    report_data: dict[str, Any] = {
        "status": "running",
        "report_path": str(REPORT),
        "runtime_dir": str(RUNTIME),
        "data_dir": str(DATA),
        "evidence_dir": str(EVIDENCE),
        "started_at": time.time(),
        "pid": os.getpid(),
        "checks": [],
    }
    checkpoint(report_data)
    process: subprocess.Popen[bytes] | None = None
    base = ""
    exit_code = 0
    paths = preflight_paths()
    assets = ROOT / "test-assets/generated"
    required_assets = {
        "vfr": assets / "vfr-landscape-av.mp4",
        "no_audio": assets / "cfr-portrait-video-only.mp4",
        "chinese": assets / "中文路径-横屏有音轨.mp4",
        "baseline": assets / "cfr-landscape-av.mp4",
        "corrupt": assets / "corrupt.mp4",
    }
    try:
        missing = [
            str(path)
            for path in [*paths.values(), *required_assets.values()]
            if not path.is_file()
        ]
        if missing:
            add_check(
                report_data,
                "preflight",
                "unverified",
                {"missing_paths": missing},
                "required packaged binaries or fixtures are missing",
            )
            exit_code = 2
            return exit_code
        add_check(
            report_data,
            "preflight",
            "passed",
            {"paths": {k: str(v) for k, v in paths.items()}},
        )
        core = paths["core"]
        ffmpeg = paths["ffmpeg"]
        ffprobe = paths["ffprobe"]
        READY.unlink(missing_ok=True)
        env = {**os.environ, "AIVS_ADMIN_TOKEN": TOKEN}
        with CORE_LOG.open("ab") as log, CORE_ERR_LOG.open("ab") as err:
            process = subprocess.Popen(
                [
                    str(core),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "0",
                    "--data-dir",
                    str(DATA),
                    "--ffmpeg",
                    str(ffmpeg),
                    "--ffprobe",
                    str(ffprobe),
                    "--runtime-dir",
                    str(RUNTIME),
                    "--ready-file",
                    str(READY),
                    "--log-level",
                    "info",
                ],
                cwd=core.parent,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=err,
            )
        deadline = time.time() + 20
        while not READY.exists() and time.time() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Core exited with code {process.returncode}")
            time.sleep(0.1)
        if not READY.exists():
            raise RuntimeError(f"Core ready timeout; see {CORE_LOG} and {CORE_ERR_LOG}")
        ready = json.loads(READY.read_text(encoding="utf-8"))
        base = f"http://127.0.0.1:{ready['port']}"
        report_data["core_log"] = str(CORE_LOG)
        report_data["core_err_log"] = str(CORE_ERR_LOG)
        add_check(report_data, "core_ready", "passed", {"ready": ready})
        health = request(base, "/api/v1/health")
        session = request(base, "/api/v1/internal/sessions", TOKEN, "POST")
        add_check(report_data, "health_and_session", "passed", {"health": health})
        admin = TOKEN
        ui = session["token"]

        _, baseline = probe_media(base, admin, ui, required_assets["baseline"])
        add_check(report_data, "baseline_probe", "passed", {"probe": baseline})
        _, no_audio = probe_media(base, admin, ui, required_assets["no_audio"])
        if no_audio["audio_streams"]:
            raise RuntimeError(f"no-audio fixture has audio streams: {no_audio}")
        add_check(report_data, "no_audio_probe", "passed", {"probe": no_audio})
        _, vfr = probe_media(base, admin, ui, required_assets["vfr"])
        vfr_raw = run_ffprobe(ffprobe, required_assets["vfr"], EVIDENCE / "vfr-source.json")
        vfr_video = next(
            stream for stream in vfr_raw.get("streams", []) if stream.get("codec_type") == "video"
        )
        if vfr_video.get("avg_frame_rate") == vfr_video.get("r_frame_rate"):
            raise RuntimeError(f"VFR fixture is not variable-frame-rate: {vfr_video}")
        add_check(report_data, "vfr_probe", "passed", {"probe": vfr})
        try:
            probe_media(base, admin, ui, required_assets["corrupt"])
        except RuntimeError as exc:
            add_check(report_data, "corrupt_probe_rejected", "passed", {"error": str(exc)})
        else:
            raise RuntimeError("corrupt fixture was accepted by FFprobe")

        cases = [
            ("vfr_proxy", required_assets["vfr"], "proxy", True),
            ("no_audio_proxy", required_assets["no_audio"], "proxy", False),
            ("no_audio_vertical", required_assets["no_audio"], "vertical_sample", False),
            ("chinese_proxy", required_assets["chinese"], "proxy", True),
            ("chinese_vertical", required_assets["chinese"], "vertical_sample", True),
        ]
        for name, asset, kind, has_audio in cases:
            try:
                result = verify_job(base, admin, ui, ffprobe, asset, kind, 2_000_000, has_audio)
            except Exception as exc:
                add_check(report_data, name, "failed", error=repr(exc))
                exit_code = 1
            else:
                add_check(report_data, name, "passed", result)

        cancel_fixture = DATA / "cancel-long.mp4"
        subprocess.run(
            [
                str(ffmpeg),
                "-hide_banner",
                "-y",
                "-stream_loop",
                "-1",
                "-i",
                str(required_assets["baseline"]),
                "-t",
                "45",
                "-c",
                "copy",
                str(cancel_fixture),
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
        cancel_media_id, _ = probe_media(base, admin, ui, cancel_fixture)
        cancel_job = request(
            base,
            "/api/v1/jobs/proxy",
            ui,
            "POST",
            {"media_id": cancel_media_id, "encoder_mode": "software", "duration_us": 25_000_000},
        )
        running = wait_status(base, ui, cancel_job["job_id"], {"running", "succeeded", "failed"})
        if running["status"] != "running":
            raise RuntimeError(f"cancel scenario did not reach running: {running}")
        before_cancel = process_ids_for("ffmpeg.exe")
        request(base, f"/api/v1/jobs/{cancel_job['job_id']}/cancel", ui, "POST")
        cancelled = wait_job(base, ui, cancel_job["job_id"], 30)
        deadline = time.time() + 5
        remaining = process_ids_for("ffmpeg.exe") & before_cancel
        while remaining and time.time() < deadline:
            time.sleep(0.2)
            remaining = process_ids_for("ffmpeg.exe") & before_cancel
        cancel_details = {
            "job_status": cancelled["status"],
            "ffmpeg_before": sorted(before_cancel),
            "ffmpeg_remaining_after_5s": sorted(remaining),
        }
        if cancelled["status"] != "cancelled" or remaining:
            raise RuntimeError(f"cancel cleanup failed: {cancel_details}")
        add_check(report_data, "cancel_cleanup", "passed", cancel_details)
    except Exception as exc:
        add_check(report_data, "real_media_chain", "failed", error=repr(exc))
        exit_code = 1
    finally:
        if base:
            try:
                request(base, "/api/v1/internal/shutdown", TOKEN, "POST")
            except Exception:
                pass
        if process is not None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if exit_code == 0 and any(check["status"] == "failed" for check in report_data["checks"]):
            exit_code = 1
        report_data["status"] = (
            "unverified" if exit_code == 2 else "failed" if exit_code else "passed"
        )
        report_data["finished_at"] = time.time()
        checkpoint(report_data)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
