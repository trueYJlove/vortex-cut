from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMP = Path(os.environ.get("TEMP", "C:/Temp")) / "aivideo-stage0-real-py"
RUN_ID = f"{os.getpid()}-{time.time_ns()}"
RUNTIME = TEMP / f"runtime-{RUN_ID}"
DATA = TEMP / f"data-{RUN_ID}"
READY = RUNTIME / "ready.json"
CORE_LOG = RUNTIME / "core.log"
TOKEN = "stage0-admin-token"


def request(base: str, path: str, token: str | None = None, method: str = "GET", body: dict | None = None) -> dict:
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if payload else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=payload, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read())


def write_report(report: Path, payload: object) -> None:
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def checkpoint(report: Path, report_data: dict[str, object], step: str) -> None:
    report_data["step"] = step
    report_data["updated_at"] = time.time()
    write_report(report, report_data)


def wait_job(base: str, token: str, job_id: str, timeout: float = 90) -> dict:
    deadline = time.time() + timeout
    state = request(base, f"/api/v1/jobs/{job_id}", token)
    while state["status"] not in {"succeeded", "failed", "cancelled", "interrupted"} and time.time() < deadline:
        time.sleep(0.3)
        state = request(base, f"/api/v1/jobs/{job_id}", token)
    return state


def wait_status(base: str, token: str, job_id: str, wanted: set[str], timeout: float = 30) -> dict:
    deadline = time.time() + timeout
    state = request(base, f"/api/v1/jobs/{job_id}", token)
    while state["status"] not in wanted and time.time() < deadline:
        time.sleep(0.2)
        state = request(base, f"/api/v1/jobs/{job_id}", token)
    return state


def process_ids_for(executable_name: str) -> set[int]:
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Get-CimInstance Win32_Process | Where-Object {{$_.Name -eq '{executable_name}'}} | Select-Object -ExpandProperty ProcessId"],
        check=True, capture_output=True, text=True, timeout=10,
    )
    return {int(line.strip()) for line in result.stdout.splitlines() if line.strip().isdigit()}


def assert_vertical_spec(ffprobe: Path, output: Path) -> dict:
    completed = subprocess.run(
        [str(ffprobe), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)],
        check=True, capture_output=True, text=True, timeout=20,
    )
    info = json.loads(completed.stdout)
    video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
    audio = next((stream for stream in info["streams"] if stream["codec_type"] == "audio"), None)
    assert (video["width"], video["height"]) == (1080, 1920), video
    assert video["codec_name"] == "h264", video
    assert video.get("pix_fmt") == "yuv420p", video
    assert video.get("r_frame_rate") == "30/1", video
    assert audio is not None and audio["codec_name"] == "aac", audio
    return {"video": video, "audio": audio}


def main() -> None:
    report = TEMP / "report.json"
    report_data: dict[str, object] = {
        "status": "running",
        "started_at": time.time(),
        "pid": os.getpid(),
        "runtime_dir": str(RUNTIME),
        "data_dir": str(DATA),
    }
    process: subprocess.Popen[bytes] | None = None
    base = ""
    core = ROOT / "apps/desktop/release/win-unpacked/resources/core/aivs-core/aivs-core.exe"
    ffmpeg = ROOT / "apps/desktop/release/win-unpacked/resources/ffmpeg/win-x64/ffmpeg.exe"
    ffprobe = ROOT / "apps/desktop/release/win-unpacked/resources/ffmpeg/win-x64/ffprobe.exe"
    RUNTIME.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    READY.unlink(missing_ok=True)
    checkpoint(report, report_data, "launching_core")
    env = {**os.environ, "AIVS_ADMIN_TOKEN": TOKEN}
    try:
        with CORE_LOG.open("ab") as log, (RUNTIME / "core.err.log").open("ab") as err:
            # Standalone verification owns the Core process and shuts it down
            # explicitly; parent-pid supervision is reserved for Electron.
            process = subprocess.Popen([str(core), "--host", "127.0.0.1", "--port", "0",
            "--data-dir", str(DATA), "--ffmpeg", str(ffmpeg),
            "--ffprobe", str(ffprobe), "--runtime-dir", str(RUNTIME), "--ready-file", str(READY),
            "--log-level", "info"], cwd=core.parent, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=err)
        deadline = time.time() + 20
        while not READY.exists() and time.time() < deadline:
            time.sleep(0.1)
        if not READY.exists():
            raise RuntimeError("Core ready timeout")
        checkpoint(report, report_data, "core_ready")
        ready = json.loads(READY.read_text(encoding="utf-8"))
        base = f"http://127.0.0.1:{ready['port']}"
        health = request(base, "/api/v1/health")
        checkpoint(report, report_data, "health_ok")
        session = request(base, "/api/v1/internal/sessions", TOKEN, "POST")
        checkpoint(report, report_data, "session_ok")
        assets = ROOT / "test-assets/generated"
        records: list[dict] = [{"health": health, "ready": ready}]
        media = None
        for name in ("cfr-landscape-av.mp4", "cfr-portrait-video-only.mp4", "short-odd-size.mp4", "corrupt.mp4"):
            grant = request(base, "/api/v1/internal/file-grants", TOKEN, "POST", {"path": str(assets / name)})
            try:
                probe = request(base, "/api/v1/media/probe", session["token"], "POST", {"grant_id": grant["grant_id"]})
                records.append({"asset": name, "probe": "ok", "duration_us": probe["duration_us"],
                    "video": probe["video_streams"][0], "audio_count": len(probe["audio_streams"])})
                if name == "cfr-landscape-av.mp4":
                    media = probe
            except urllib.error.HTTPError as exc:
                records.append({"asset": name, "probe": "error", "status": exc.code})
            checkpoint(report, report_data, f"probe_{name}")
        assert any(item.get("asset") == "cfr-portrait-video-only.mp4" and item.get("probe") == "ok" for item in records)
        assert any(item.get("asset") == "short-odd-size.mp4" and item.get("probe") == "ok" for item in records)
        assert any(item.get("asset") == "corrupt.mp4" and item.get("probe") == "error" for item in records)
        if media is None:
            raise RuntimeError("landscape fixture probe failed")
        # The short fixture is useful for normal output assertions but can
        # finish before the cancellation request reaches Core. Create an
        # isolated long fixture for the cancellation contract so the test
        # observes a real running FFmpeg process deterministically.
        cancel_fixture = DATA / "cancel-long.mp4"
        subprocess.run([str(ffmpeg), "-y", "-stream_loop", "-1", "-i",
                        str(assets / "cfr-landscape-av.mp4"), "-t", "45",
                        "-c", "copy", str(cancel_fixture)],
                       check=True, capture_output=True, timeout=30)
        cancel_grant = request(base, "/api/v1/internal/file-grants", TOKEN, "POST",
                               {"path": str(cancel_fixture)})
        cancel_media = request(base, "/api/v1/media/probe", session["token"], "POST",
                               {"grant_id": cancel_grant["grant_id"]})
        for kind, path in (("proxy", "/api/v1/jobs/proxy"), ("vertical_sample", "/api/v1/jobs/vertical-sample")):
            body = {"media_id": media["media_id"], "encoder_mode": "software", "start_us": 0,
                "duration_us": 3_000_000, "layout": "blurred_background"}
            job = request(base, path, session["token"], "POST", body)
            deadline = time.time() + 60
            state = wait_job(base, session["token"], job["job_id"], deadline - time.time())
            records.append({"job": kind, "status": state["status"], "artifacts": state["artifacts"], "error": state["error"]})
            checkpoint(report, report_data, f"job_{kind}_{state['status']}")
            if state["status"] != "succeeded":
                raise RuntimeError(f"{kind} failed: {state}")
        cancel_job = request(base, "/api/v1/jobs/proxy", session["token"], "POST", {"media_id": cancel_media["media_id"], "encoder_mode": "software", "duration_us": 25_000_000})
        running = wait_status(base, session["token"], cancel_job["job_id"], {"running", "succeeded", "failed"}, 30)
        if running["status"] != "running":
            raise RuntimeError(f"cancel scenario did not reach running: {running}")
        before_cancel = process_ids_for("ffmpeg.exe")
        request(base, f"/api/v1/jobs/{cancel_job['job_id']}/cancel", session["token"], "POST")
        cancelled = wait_job(base, session["token"], cancel_job["job_id"], 30)
        after_deadline = time.time() + 5
        remaining = process_ids_for("ffmpeg.exe") & before_cancel
        while time.time() < after_deadline and remaining:
            time.sleep(0.2)
            remaining = process_ids_for("ffmpeg.exe") & before_cancel
        records.append({"job": "cancel", "status": cancelled["status"], "ffmpeg_before": sorted(before_cancel), "ffmpeg_remaining_after_5s": sorted(remaining)})
        if cancelled["status"] != "cancelled":
            raise RuntimeError(f"cancel failed: {cancelled}")
        if remaining:
            raise RuntimeError(f"FFmpeg processes remained after cancellation: {sorted(remaining)}")
        vertical = next(item for item in records if item.get("job") == "vertical_sample")
        artifact_id = vertical["artifacts"][0]["id"]
        resolved = request(base, f"/api/v1/internal/artifacts/{artifact_id}/resolve", TOKEN)
        artifact_path = Path(resolved["path"])
        vertical["spec"] = assert_vertical_spec(ffprobe, artifact_path)
        report_data = {"status": "passed", "records": records, "finished_at": time.time()}
    except Exception as exc:
        report_data = {"status": "failed", "error": repr(exc), "records": locals().get("records", []), "finished_at": time.time()}
        raise
    finally:
        try:
            if base:
                request(base, "/api/v1/internal/shutdown", TOKEN, "POST")
        except Exception:
            pass
        if process is not None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        write_report(report, report_data)


if __name__ == "__main__":
    main()
