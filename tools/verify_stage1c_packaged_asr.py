from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "test-results" / "stage1c-render-rework-core-20260811"
PACKAGE_ROOT = EVIDENCE / "package-dist" / "aivs-core"
EXECUTABLE = PACKAGE_ROOT / "aivs-core.exe"
MODEL_DIR = (
    ROOT
    / "test-results"
    / "stage1b-acceptance-20260811-102810"
    / "real-script-temp"
    / "aivideo-stage1b-real"
    / "data-13600-1786415777395528100"
    / "models"
    / "asr"
    / "faster-whisper-tiny"
    / "d90ca5fe260221311c53c58e660288d3deb8d356"
)
SOURCE_AUDIO = (
    ROOT
    / "test-results"
    / "stage1b-acceptance-20260811-102810"
    / "real-script-temp"
    / "aivideo-stage1b-real"
    / "sample-mixed.wav"
)
ADMIN_TOKEN = "stage1c-packaged-asr"


def _request(
    base_url: str,
    method: str,
    path: str,
    token: str,
    payload: dict | None = None,
    timeout: float = 30,
) -> dict:
    response = httpx.request(
        method,
        base_url + path,
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=timeout,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path}: {response.status_code} {response.text}")
    return response.json() if response.content else {}


def _wait_ready(process: subprocess.Popen[str], ready_path: Path) -> dict:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if ready_path.is_file():
            return json.loads(ready_path.read_text(encoding="utf-8"))
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise RuntimeError(
                f"packaged core exited {process.returncode}: {stdout[-2000:]} {stderr[-4000:]}"
            )
        time.sleep(0.1)
    raise TimeoutError("packaged core ready timeout")


def _runtime_files() -> list[dict[str, int | str]]:
    patterns = (
        "*ctranslate2*",
        "*tokenizers*",
        "*onnxruntime*",
        "*av*.pyd",
        "*iomp*.dll",
        "*cudnn*.dll",
    )
    found: dict[Path, dict[str, int | str]] = {}
    for pattern in patterns:
        for path in PACKAGE_ROOT.rglob(pattern):
            if path.is_file():
                found[path] = {
                    "path": path.relative_to(PACKAGE_ROOT).as_posix(),
                    "size_bytes": path.stat().st_size,
                }
    return [found[path] for path in sorted(found)]


def main() -> None:
    if not EXECUTABLE.is_file() or not MODEL_DIR.is_dir() or not SOURCE_AUDIO.is_file():
        raise FileNotFoundError("packaged ASR prerequisites are missing")
    run_dir = EVIDENCE / "packaged-asr"
    run_dir.mkdir(parents=True, exist_ok=True)
    ready_path = run_dir / "ready.json"
    ready_path.unlink(missing_ok=True)
    env = os.environ.copy()
    env["AIVS_ADMIN_TOKEN"] = ADMIN_TOKEN
    env["AIVS_E2E_MODEL_DIR"] = str(MODEL_DIR)
    process = subprocess.Popen(
        [
            str(EXECUTABLE),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--data-dir",
            str(run_dir / "data"),
            "--runtime-dir",
            str(run_dir / "runtime"),
            "--ready-file",
            str(ready_path),
            "--ffmpeg",
            str(ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"),
            "--ffprobe",
            str(ROOT / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe"),
            "--log-level",
            "warning",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    result: dict = {}
    try:
        ready = _wait_ready(process, ready_path)
        base_url = f"http://127.0.0.1:{ready['port']}"
        session = _request(
            base_url, "POST", "/api/v1/internal/sessions", ADMIN_TOKEN
        )
        ui_token = session["token"]
        models = _request(base_url, "GET", "/api/v1/models?limit=100", ui_token)
        model = next(
            item
            for item in models["items"]
            if item["model_id"] == "faster-whisper-tiny"
        )
        if model["status"] != "ready" or model["provider_status"] != "installed":
            raise RuntimeError(f"packaged model runtime unavailable: {model}")
        project = _request(
            base_url, "POST", "/api/v1/projects", ui_token, {"name": "Packaged ASR"}
        )
        grant = _request(
            base_url,
            "POST",
            "/api/v1/internal/file-grants",
            ADMIN_TOKEN,
            {"path": str(SOURCE_AUDIO)},
        )
        asset = _request(
            base_url,
            "POST",
            f"/api/v1/projects/{project['project_id']}/assets",
            ui_token,
            {"grant_id": grant["grant_id"], "kind": "audio"},
        )
        created = _request(
            base_url,
            "POST",
            f"/api/v1/assets/{asset['asset_id']}/transcription",
            ui_token,
            {
                "model_id": "faster-whisper-tiny",
                "language": "auto",
                "word_timestamps": True,
                "license_acceptance": None,
            },
        )
        job_id = created["job"]["job_id"]
        deadline = time.monotonic() + 240
        job = created["job"]
        while time.monotonic() < deadline:
            job = _request(base_url, "GET", f"/api/v1/jobs/{job_id}", ui_token)
            if job["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
                break
            time.sleep(0.25)
        if job["status"] != "succeeded":
            raise RuntimeError(f"packaged transcription failed: {job}")
        transcripts = _request(
            base_url,
            "GET",
            f"/api/v1/assets/{asset['asset_id']}/transcription",
            ui_token,
        )
        transcript_id = transcripts["items"][0]["transcript_id"]
        transcript = _request(
            base_url, "GET", f"/api/v1/transcriptions/{transcript_id}", ui_token
        )
        segment_count = len(transcript["segments"])
        word_count = sum(len(segment["words"]) for segment in transcript["segments"])
        if segment_count < 1 or word_count < 1:
            raise RuntimeError("packaged transcript did not contain segments and words")
        result = {
            "status": "passed",
            "ready": ready,
            "default_manifest_count": len(models["items"]),
            "model": model,
            "job": job,
            "transcript": transcript,
            "segment_count": segment_count,
            "word_count": word_count,
            "runtime_files": _runtime_files(),
            "manifest_files": [
                path.relative_to(PACKAGE_ROOT).as_posix()
                for path in sorted((PACKAGE_ROOT / "_internal" / "model-manifests").glob("*.json"))
            ],
            "font_files": [
                path.relative_to(PACKAGE_ROOT).as_posix()
                for path in sorted((PACKAGE_ROOT / "_internal" / "fonts").rglob("*"))
                if path.is_file()
            ],
        }
        _request(base_url, "POST", "/api/v1/internal/shutdown", ADMIN_TOKEN)
        process.wait(timeout=15)
    finally:
        if process.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                timeout=15,
                check=False,
            )
        stdout, stderr = process.communicate(timeout=5)
        result["stdout"] = stdout
        result["stderr"] = stderr
        (EVIDENCE / "packaged-asr.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    if result.get("status") != "passed":
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
