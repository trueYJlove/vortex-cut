"""阶段 1B 真实 Core 进程、SQLite 恢复和 migration v2 验证。

本工具故意通过 ``python -m aivs_core.bootstrap`` 启动独立子进程，报告中的
real_process 证据不使用 TestClient、线程内 uvicorn 或单元测试替代。
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CORE_SRC = ROOT / "services" / "core" / "src"
TEMP_ROOT = Path(os.environ.get("TEMP", str(Path.cwd() / ".tmp"))) / "aivideo-stage1b-real"
RUN_ID = f"{os.getpid()}-{time.time_ns()}"
RUN_ROOT = TEMP_ROOT / RUN_ID
DATA = RUN_ROOT / "data"
RUNTIME = RUN_ROOT / "runtime"
MANIFESTS = RUN_ROOT / "manifests"
MODEL_SEED = RUN_ROOT / "seed-model"
EVIDENCE = RUN_ROOT / "evidence"
REPORT = Path(os.environ.get("AIVS_STAGE1B_REPORT", str(RUN_ROOT / "report.json")))
TOKEN = "stage1b-real-token"
MODEL_ID = "stage1b-test-model"
REVISION = "stage1b-real-revision-1"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checkpoint(report: dict[str, Any]) -> None:
    report["updated_at"] = time.time()
    write_json(REPORT, report)


def add_check(
    report: dict[str, Any],
    name: str,
    status: str,
    *,
    execution_kind: str,
    evidence: dict[str, Any] | None = None,
    limitation: str | None = None,
    error: str | None = None,
) -> None:
    if status not in {"passed", "failed", "unverified"}:
        raise ValueError(status)
    item: dict[str, Any] = {"name": name, "status": status, "execution_kind": execution_kind}
    if evidence:
        item["evidence"] = evidence
    if limitation:
        item["limitation"] = limitation
    if error:
        item["error"] = error
    report.setdefault("checks", []).append(item)
    checkpoint(report)


def request(
    base: str,
    path: str,
    token: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 10,
) -> dict[str, Any]:
    payload = json.dumps(body).encode() if body is not None else None
    request_obj = urllib.request.Request(
        base + path,
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request_obj, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {method} {path}: {detail}") from exc


def request_error(
    base: str, path: str, token: str, method: str, body: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    payload = json.dumps(body).encode()
    request_obj = urllib.request.Request(
        base + path,
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request_obj, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def wait_for(predicate, description: str, timeout: float = 20) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            last = predicate()
        except (OSError, urllib.error.URLError, RuntimeError):
            time.sleep(0.15)
            continue
        if last.get("done"):
            return last
        time.sleep(0.15)
    raise RuntimeError(f"等待 {description} 超时: {last}")


def make_audio(path: Path, frames: int = 16_000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(b"\0\0" * frames)


def make_manifest_and_seed() -> Path:
    MANIFESTS.mkdir(parents=True, exist_ok=True)
    MODEL_SEED.mkdir(parents=True, exist_ok=True)
    files = {"config.json": b"{}\n", "model.bin": b"stage1b deterministic seed\n"}
    manifest_files: list[dict[str, Any]] = []
    for name, content in files.items():
        target = MODEL_SEED / name
        target.write_bytes(content)
        manifest_files.append(
            {"path": name, "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        )
    aggregate = hashlib.sha256()
    for name in files:
        aggregate.update(files[name])
    manifest = {
        "model_id": MODEL_ID,
        "provider": "faster-whisper",
        "revision": REVISION,
        "display_name": "Stage 1B deterministic model",
        "purpose": "asr",
        "download_url": None,
        "trusted_source_id": "stage1b-real-harness",
        "size_bytes": sum(item["size_bytes"] for item in manifest_files),
        "installed_size_bytes": sum(item["size_bytes"] for item in manifest_files),
        "sha256": aggregate.hexdigest(),
        "license": {"id": "test", "name": "Test", "acceptance_required": False},
        "supported_languages": ["auto", "en"],
        "supports_word_timestamps": False,
        "runtime_version": "test",
        "runtime_requirements": {},
        "files": manifest_files,
        "created_at": "2026-08-11T00:00:00.000Z",
    }
    manifest_path = MANIFESTS / f"{MODEL_ID}.json"
    write_json(manifest_path, manifest)
    return manifest_path


def make_legacy_v1_database(audio: Path) -> dict[str, str]:
    """Create only v1 tables/rows; the first real Core start performs v2 migration."""
    sys.path.insert(0, str(CORE_SRC))
    from aivs_core.database import V1_SQL, V1_VERSION  # noqa: PLC0415

    DATA.mkdir(parents=True, exist_ok=True)
    now = "2026-08-11T00:00:00.000Z"
    project_id = "project_legacy_stage1b"
    asset_id = "asset_legacy_stage1b"
    fingerprint = f"sha256:{sha256_file(audio)}"
    with sqlite3.connect(DATA / "app.db") as db:
        for statement in V1_SQL.split(";"):
            if statement.strip():
                db.execute(statement)
        db.execute(
            "CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)"
        )
        db.execute(
            "INSERT INTO schema_migrations VALUES (?,?,?)",
            (V1_VERSION, now, hashlib.sha256(V1_SQL.encode()).hexdigest()),
        )
        db.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            (project_id, "Legacy Stage1B", "active", "{}", None, str(DATA / "projects" / project_id), "legacy", now, now, now),
        )
        db.execute(
            "INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (asset_id, project_id, "audio", "external", audio.name, fingerprint, audio.stat().st_size, now, "available", json.dumps({"duration_us": 1_000_000}), now, now),
        )
        db.execute(
            "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,?)",
            (asset_id, audio.as_uri(), now),
        )
        db.commit()
    return {"project_id": project_id, "asset_id": asset_id, "fingerprint": fingerprint}


def start_core(hold_seconds: float) -> tuple[subprocess.Popen[str], str, Path]:
    ready = RUNTIME / f"ready-{time.time_ns()}.json"
    log_path = EVIDENCE / f"core-{time.time_ns()}.log"
    environment = os.environ.copy()
    environment["AIVS_ADMIN_TOKEN"] = TOKEN
    environment["PYTHONPATH"] = str(CORE_SRC) + os.pathsep + environment.get("PYTHONPATH", "")
    environment["AIVS_E2E_MODEL_DIR"] = str(MODEL_SEED)
    environment["AIVS_E2E_HOLD_ASR_SECONDS"] = str(hold_seconds)
    command = [
        sys.executable, "-m", "aivs_core.bootstrap", "--host", "127.0.0.1", "--port", "0",
        "--data-dir", str(DATA), "--runtime-dir", str(RUNTIME), "--ready-file", str(ready),
        "--manifest-dir", str(MANIFESTS), "--ffmpeg", "ffmpeg", "--ffprobe", "ffprobe",
    ]
    log = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, text=True)
    wait_for(lambda: {"done": ready.is_file()}, "Core ready file", 20)
    payload = json.loads(ready.read_text(encoding="utf-8"))
    return process, f"http://127.0.0.1:{payload['port']}", log_path


def sqlite_evidence(
    path: Path, job_id: str, output: Path, transcript_id: str | None = None
) -> dict[str, Any]:
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        migration = [dict(row) for row in db.execute("SELECT * FROM schema_migrations ORDER BY rowid")]
        job = db.execute(
            "SELECT id,kind,status,stage,attempt,error_code,input_fingerprint,model_revision FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
        counts = {table: int(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]) for table in ("projects", "assets", "jobs", "transcripts")}
        transcript = None
        segments: list[dict[str, Any]] = []
        if transcript_id:
            transcript_row = db.execute(
                "SELECT * FROM transcripts WHERE id=?", (transcript_id,)
            ).fetchone()
            transcript = dict(transcript_row) if transcript_row else None
            if transcript_row:
                segment_rows = db.execute(
                    "SELECT * FROM transcript_segments WHERE transcript_id=? ORDER BY ordinal",
                    (transcript_id,),
                ).fetchall()
                for segment_row in segment_rows:
                    segment = dict(segment_row)
                    segment["words"] = [
                        dict(word)
                        for word in db.execute(
                            "SELECT * FROM transcript_words WHERE segment_id=? ORDER BY ordinal",
                            (segment_row["id"],),
                        ).fetchall()
                    ]
                    segments.append(segment)
    evidence = {
        "schema_migrations": migration,
        "job": dict(job) if job else None,
        "counts": counts,
        "transcript_id": transcript_id,
        "transcript": transcript,
        "segments": segments,
    }
    write_json(output, evidence)
    return evidence


def finish_process(process: subprocess.Popen[str], force: bool) -> None:
    if process.poll() is None:
        if force:
            process.kill()
        else:
            process.terminate()
        process.wait(timeout=10)


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    audio = RUN_ROOT / "legacy.wav"
    make_audio(audio)
    make_manifest_and_seed()
    legacy = make_legacy_v1_database(audio)
    report: dict[str, Any] = {
        "schema": "stage1b-verification-v1",
        "status": "running",
        "report_path": str(REPORT),
        "command": " ".join(sys.argv),
        "environment": {"python": sys.version, "platform": platform.platform(), "cwd": str(ROOT)},
        "data_dir": str(DATA),
        "evidence_dir": str(EVIDENCE),
        "limitations": ["ASR 强制终止链路使用 deterministic model seed；不会伪造 succeeded。"],
        "checks": [],
    }
    checkpoint(report)
    exit_code = 0
    first: subprocess.Popen[str] | None = None
    second: subprocess.Popen[str] | None = None
    try:
        first, base, first_log = start_core(120)
        admin = request(base, "/api/v1/internal/sessions", TOKEN, "POST")["token"]
        ui = admin
        legacy_project = request(base, f"/api/v1/projects/{legacy['project_id']}", ui)
        schema_before = sqlite_evidence(DATA / "app.db", "missing", EVIDENCE / "migration-before.json")
        if [row["version"] for row in schema_before["schema_migrations"]] != ["v1", "v2"]:
            raise RuntimeError("first Core start did not apply v2 migration")
        add_check(report, "migration_v2_first_start", "passed", execution_kind="real_process", evidence={"core_log": str(first_log), "sqlite": str(EVIDENCE / "migration-before.json"), "legacy_project": legacy_project["project_id"]})

        project = request(base, "/api/v1/projects", ui, "POST", {"name": "New Stage1B"})
        grant = request(base, "/api/v1/internal/file-grants", TOKEN, "POST", {"path": str(audio)})
        asset = request(base, f"/api/v1/projects/{project['project_id']}/assets", ui, "POST", {"grant_id": grant["grant_id"], "kind": "audio"})
        sys.path.insert(0, str(CORE_SRC))
        from aivs_core.database import Database  # noqa: PLC0415
        from aivs_core.transcription import (  # noqa: PLC0415
            TranscriptRepository,
            TranscriptResult,
            TranscriptSegmentResult,
        )

        persistence_probe = TranscriptRepository(Database(DATA / "app.db")).save_ready(
            asset["asset_id"],
            asset["fingerprint"],
            "stage1b-probe",
            MODEL_ID,
            REVISION,
            TranscriptResult(
                language="en",
                duration_us=1_000_000,
                segments=(
                    TranscriptSegmentResult(
                        start_us=0,
                        end_us=1_000_000,
                        text="deterministic persistence probe",
                        confidence=None,
                        words=(),
                    ),
                ),
            ),
        )
        transcript_id = persistence_probe["transcript_id"]
        write_json(EVIDENCE / "persistence-probe-before-restart.json", persistence_probe)
        interrupt_audio = RUN_ROOT / "interrupt.wav"
        make_audio(interrupt_audio, frames=16_001)
        interrupt_grant = request(
            base,
            "/api/v1/internal/file-grants",
            TOKEN,
            "POST",
            {"path": str(interrupt_audio)},
        )
        interrupt_asset = request(
            base,
            f"/api/v1/projects/{project['project_id']}/assets",
            ui,
            "POST",
            {"grant_id": interrupt_grant["grant_id"], "kind": "audio"},
        )
        interrupt_asset_id = interrupt_asset["asset_id"]
        transcription_attempts: list[dict[str, Any]] = []
        running: dict[str, Any] | None = None
        job_id: str | None = None
        for attempt_number in range(1, 4):
            created = request(
                base,
                f"/api/v1/assets/{interrupt_asset_id}/transcription",
                ui,
                "POST",
                {"model_id": MODEL_ID, "language": "auto"},
            )
            candidate_job_id = created["job"]["job_id"]
            observed: list[dict[str, Any]] = []
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                candidate = request(base, f"/api/v1/jobs/{candidate_job_id}", ui)
                observed.append(
                    {
                        "status": candidate.get("status"),
                        "stage": candidate.get("stage"),
                    }
                )
                if candidate.get("status") == "running" and candidate.get("stage") == "transcribing":
                    job_id = candidate_job_id
                    running = candidate
                    break
                if candidate.get("status") in {"succeeded", "failed", "cancelled", "interrupted"}:
                    break
                time.sleep(0.15)
            transcription_attempts.append(
                {
                    "attempt_number": attempt_number,
                    "job_id": candidate_job_id,
                    "observed": observed,
                    "selected_for_interruption": job_id == candidate_job_id,
                }
            )
            if running is not None:
                break
        write_json(EVIDENCE / "transcription-job-attempts.json", transcription_attempts)
        if running is None or job_id is None:
            raise RuntimeError(
                "未能在 3 次 transcription 创建尝试中取得 status=running 且 stage=transcribing 的任务；"
                f"证据: {EVIDENCE / 'transcription-job-attempts.json'}"
            )
        write_json(EVIDENCE / "running-job-api.json", running)
        finish_process(first, True)
        first = None
        second, base2, second_log = start_core(2)
        ui2 = request(base2, '/api/v1/internal/sessions', TOKEN, 'POST')['token']
        recovered = request(base2, f"/api/v1/jobs/{job_id}", ui2)
        sqlite = sqlite_evidence(DATA / "app.db", job_id, EVIDENCE / "interrupted-job-sqlite.json", transcript_id)
        required = ("status", "stage", "attempt", "error_code", "input_fingerprint", "model_revision")
        if recovered["status"] != "interrupted" or recovered["stage"] != "interrupted" or recovered["error"]["code"] != "JOB_INTERRUPTED" or any(recovered.get(field) in (None, "") for field in ("attempt", "input_fingerprint", "model_revision")):
            raise RuntimeError(f"API interrupted evidence incomplete: {recovered}")
        if not sqlite["job"] or sqlite["job"]["status"] != "interrupted" or any(sqlite["job"].get(field) in (None, "") for field in required[1:]):
            raise RuntimeError(f"SQLite interrupted evidence incomplete: {sqlite}")
        write_json(EVIDENCE / "interrupted-job-api.json", recovered)
        add_check(report, "real_process_interrupt_recovery", "passed", execution_kind="real_process", evidence={"first_core_log": str(EVIDENCE / first_log.name) if first_log else None, "second_core_log": str(second_log), "api": str(EVIDENCE / "interrupted-job-api.json"), "sqlite": str(EVIDENCE / "interrupted-job-sqlite.json"), "job_id": job_id})

        retry_status = request(base2, f"/api/v1/jobs/{job_id}/retry", ui2, "POST")
        if retry_status["status"] != "queued" or retry_status["attempt"] <= recovered["attempt"]:
            raise RuntimeError(f"explicit retry did not return queued: {retry_status}")
        write_json(EVIDENCE / "retry-api.json", retry_status)
        add_check(report, "explicit_retry_revalidates_and_queues", "passed", execution_kind="real_process", evidence={"api": str(EVIDENCE / "retry-api.json"), "fingerprint": retry_status["input_fingerprint"], "model_revision": retry_status["model_revision"]}, limitation="重试后的 ASR 运行时 intentionally 未执行成功；本项只验收显式 retry 和前置校验。")

        projects = request(base2, "/api/v1/projects", ui2)
        assets = request(base2, f"/api/v1/projects/{project['project_id']}/assets", ui2)
        post_restart_transcript = request(base2, f"/api/v1/transcriptions/{transcript_id}", ui2)
        write_json(EVIDENCE / "post-restart-transcript.json", post_restart_transcript)
        if (
            post_restart_transcript.get("status") != "ready"
            or post_restart_transcript.get("asset_id") != asset["asset_id"]
            or not post_restart_transcript.get("segments")
            or post_restart_transcript["segments"][0].get("text")
            != "deterministic persistence probe"
        ):
            raise RuntimeError(f"post-restart transcript evidence incomplete: {post_restart_transcript}")
        final_sqlite = sqlite_evidence(DATA / "app.db", job_id, EVIDENCE / "migration-after-restart.json", transcript_id)
        versions = [row["version"] for row in final_sqlite["schema_migrations"]]
        if versions != ["v1", "v2"] or not projects["items"] or not assets["items"] or final_sqlite["counts"]["jobs"] < 1 or final_sqlite["counts"]["transcripts"] < 1:
            raise RuntimeError(f"post-restart migration data unreadable: {final_sqlite}")
        write_json(EVIDENCE / "post-restart-api.json", {"projects": projects, "assets": assets})
        add_check(report, "migration_v2_same_db_restart_readable", "passed", execution_kind="real_process", evidence={"api": str(EVIDENCE / "post-restart-api.json"), "transcript": str(EVIDENCE / "post-restart-transcript.json"), "transcript_id": transcript_id, "sqlite": str(EVIDENCE / "migration-after-restart.json"), "schema": versions, "counts": final_sqlite["counts"]}, limitation="本检查验证仓储持久化数据可在 Core 重启后读取，不代表 ASR 推理成功。")
    except Exception as exc:
        add_check(report, "stage1b_real_process_chain", "failed", execution_kind="real_process", error=repr(exc), limitation="真实进程链路中止，后续项未执行。")
        exit_code = 1
    finally:
        if first is not None:
            finish_process(first, False)
        if second is not None:
            finish_process(second, False)
        report["status"] = "failed" if exit_code else "passed"
        report["finished_at"] = time.time()
        checkpoint(report)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
