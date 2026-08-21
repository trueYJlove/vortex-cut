from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import shutil
import sqlite3
import struct
import sys
import time
import uuid
import zlib
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path
from typing import Any

import av
import httpx

ROOT = Path(__file__).resolve().parents[2]
CORE_SRC = ROOT / "services" / "core" / "src"
if str(CORE_SRC) not in sys.path:
    sys.path.insert(0, str(CORE_SRC))

from aivs_core.database import MIGRATIONS, Database  # noqa: E402

MAX_RESPONSE_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 16_000_000
ALLOWED_SIZES = {(1024, 1024), (1024, 1536), (1536, 1024)}
ENDPOINT = "https://api.openai.com/v1/images/generations"
SAFE_ERRORS = {
    401: "PROVIDER_AUTH_FAILED",
    403: "PROVIDER_AUTH_FAILED",
    429: "PROVIDER_RATE_LIMITED",
    500: "PROVIDER_UNAVAILABLE",
    503: "PROVIDER_UNAVAILABLE",
}


class PrototypeError(RuntimeError):
    def __init__(self, code: str, message: str = "请求未完成") -> None:
        super().__init__(message)
        self.code = code


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def digest_rows(rows: list[sqlite3.Row]) -> str:
    return digest_bytes(canonical([dict(row) for row in rows]).encode())


class PromptVault:
    """进程内、限额、一次性消费的 Prompt 仓；repr 永不包含条目。"""

    def __init__(self, ttl_seconds: float = 5.0, capacity: int = 8,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._capacity = capacity
        self._clock = clock
        self._entries: dict[str, dict[str, Any]] = {}

    def __repr__(self) -> str:
        return f"PromptVault(entries={len(self._entries)}, redacted=True)"

    def _purge(self) -> None:
        now = self._clock()
        for token in [key for key, item in self._entries.items() if item["expires"] <= now]:
            del self._entries[token]

    def put(self, prompt: str) -> str:
        self._purge()
        if not prompt or len(prompt) > 4000 or len(self._entries) >= self._capacity:
            raise PrototypeError("PROMPT_VAULT_REJECTED")
        token = "pv_" + uuid.uuid4().hex
        self._entries[token] = {
            "prompt": prompt,
            "expires": self._clock() + self._ttl,
            "reserved": False,
        }
        return token

    def reserve(self, token: str) -> str:
        self._purge()
        item = self._entries.get(token)
        if item is None or item["reserved"]:
            raise PrototypeError("PROMPT_NOT_AVAILABLE")
        item["reserved"] = True
        return str(item["prompt"])

    def release(self, token: str) -> None:
        item = self._entries.get(token)
        if item is not None:
            item["reserved"] = False

    def commit(self, token: str) -> None:
        item = self._entries.get(token)
        if item is None or not item["reserved"]:
            raise PrototypeError("PROMPT_NOT_RESERVED")
        del self._entries[token]

    def clear(self) -> None:
        self._entries.clear()

    def count(self) -> int:
        self._purge()
        return len(self._entries)


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def synthetic_png(width: int, height: int, truncate: bool = False) -> bytes:
    # 每行一种稳定颜色，压缩后很小；不依赖 Pillow/OpenCV。
    raw = b"".join(b"\x00" + bytes((y % 251, 71, 137)) * width for y in range(height))
    value = (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(raw, 9))
        + _png_chunk(b"IEND", b"")
    )
    return value[:-12] if truncate else value


def synthetic_jpeg(width: int, height: int) -> bytes:
    codec = av.CodecContext.create("mjpeg", "w")
    codec.width = width
    codec.height = height
    codec.pix_fmt = "yuvj420p"
    codec.time_base = Fraction(1, 1)
    frame = av.VideoFrame(width, height, "rgb24")
    frame.planes[0].update(bytes((25, 80, 140)) * (frame.planes[0].buffer_size // 3))
    return b"".join(bytes(packet) for packet in codec.encode(frame))


def _strict_png(value: bytes) -> None:
    offset = 8
    saw_iend = False
    while offset < len(value):
        if offset + 12 > len(value):
            raise PrototypeError("PROVIDER_IMAGE_INVALID")
        length = struct.unpack(">I", value[offset : offset + 4])[0]
        end = offset + 12 + length
        if end > len(value):
            raise PrototypeError("PROVIDER_IMAGE_INVALID")
        kind = value[offset + 4 : offset + 8]
        payload = value[offset + 8 : offset + 8 + length]
        expected_crc = struct.unpack(">I", value[offset + 8 + length : end])[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected_crc:
            raise PrototypeError("PROVIDER_IMAGE_INVALID")
        offset = end
        if kind == b"IEND":
            saw_iend = True
            break
    if not saw_iend or offset != len(value):
        raise PrototypeError("PROVIDER_IMAGE_INVALID")


def validate_image(value: bytes, expected_size: tuple[int, int]) -> dict[str, Any]:
    if len(value) > MAX_RESPONSE_BYTES:
        raise PrototypeError("PROVIDER_IMAGE_TOO_LARGE")
    if value.startswith(b"\x89PNG\r\n\x1a\n"):
        _strict_png(value)
        media_type, extension = "image/png", "png"
    elif value.startswith(b"\xff\xd8\xff"):
        if not value.endswith(b"\xff\xd9"):
            raise PrototypeError("PROVIDER_IMAGE_INVALID")
        media_type, extension = "image/jpeg", "jpg"
    else:
        raise PrototypeError("PROVIDER_IMAGE_INVALID")
    try:
        with av.open(io.BytesIO(value), mode="r") as container:
            frames = list(container.decode(video=0))
    except Exception as exc:
        raise PrototypeError("PROVIDER_IMAGE_INVALID") from exc
    if len(frames) != 1:
        raise PrototypeError("PROVIDER_IMAGE_INVALID")
    width, height = frames[0].width, frames[0].height
    if width * height > MAX_PIXELS or (width, height) != expected_size:
        raise PrototypeError("PROVIDER_IMAGE_DIMENSION_MISMATCH")
    return {
        "media_type": media_type,
        "extension": extension,
        "width": width,
        "height": height,
        "frames": 1,
        "size_bytes": len(value),
        "sha256": digest_bytes(value),
    }

class ControlledImageProvider:
    def __init__(self, mode: str = "success", size: tuple[int, int] = (1024, 1024)) -> None:
        self.mode = mode
        self.size = size
        self.fake_call_count = 0
        self.observed: list[dict[str, Any]] = []
        self._transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.fake_call_count += 1
        payload = json.loads(request.content)
        self.observed.append({
            "method": request.method,
            "url": str(request.url),
            "fields": sorted(payload),
            "size": payload.get("size"),
            "has_authorization": "authorization" in request.headers,
        })
        if self.mode == "network":
            raise httpx.ConnectError("controlled", request=request)
        if self.mode == "timeout":
            raise httpx.ReadTimeout("controlled", request=request)
        status = {"auth": 401, "rate": 429, "unavailable": 503}.get(self.mode)
        if status:
            return httpx.Response(status, json={"error": {"message": "controlled"}})
        width, height = self.size
        image = synthetic_png(width, height, truncate=self.mode == "truncated")
        if self.mode == "invalid_image":
            image = b"<html>not an image</html>"
        encoded = base64.b64encode(image).decode()
        if self.mode == "invalid_base64":
            encoded = "%%%"
        return httpx.Response(
            200,
            json={"data": [{"b64_json": encoded}], "usage": {"images": 1}},
            headers={"x-request-id": "fake-request-id"},
        )

    async def generate(self, prompt: str, requested_size: tuple[int, int]) -> dict[str, Any]:
        if requested_size not in ALLOWED_SIZES:
            raise PrototypeError("PROVIDER_SIZE_UNSUPPORTED")
        width, height = requested_size
        payload = {
            "model": "gpt-image-1",
            "prompt": prompt,
            "n": 1,
            "size": f"{width}x{height}",
            "output_format": "png",
        }
        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                follow_redirects=False,
                trust_env=False,
                timeout=httpx.Timeout(5.0),
            ) as client:
                response = await client.post(
                    ENDPOINT,
                    json=payload,
                    headers={"Authorization": "Bearer fake-not-a-secret"},
                )
        except httpx.TimeoutException as exc:
            raise PrototypeError("PROVIDER_TIMEOUT") from exc
        except httpx.TransportError as exc:
            raise PrototypeError("PROVIDER_NETWORK_ERROR") from exc
        if response.status_code != 200:
            raise PrototypeError(SAFE_ERRORS.get(response.status_code, "PROVIDER_UNAVAILABLE"))
        try:
            envelope = response.json()
            items = envelope["data"]
            if len(items) != 1 or set(items[0]) != {"b64_json"}:
                raise ValueError
            value = base64.b64decode(items[0]["b64_json"], validate=True)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise PrototypeError("PROVIDER_RESPONSE_INVALID") from exc
        metadata = validate_image(value, requested_size)
        return {
            "bytes": value,
            "metadata": metadata,
            "provider_request_id": response.headers.get("x-request-id"),
            "usage": {"images": 1},
        }


def atomic_publish(project_root: Path, asset_id: str, value: bytes,
                   fail_before_replace: bool = False) -> tuple[Path, Path]:
    root = project_root.resolve()
    temp_dir = (root / "generated" / "image" / ".tmp").resolve()
    final_dir = (root / "generated" / "image").resolve()
    if root not in temp_dir.parents or root not in final_dir.parents:
        raise PrototypeError("OUTPUT_PATH_INVALID")
    temp_dir.mkdir(parents=True, exist_ok=True)
    final_dir.mkdir(parents=True, exist_ok=True)
    part = temp_dir / f"{asset_id}.part"
    final = final_dir / f"{asset_id}.png"
    try:
        with part.open("xb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        if fail_before_replace:
            raise OSError("controlled publish failure")
        os.replace(part, final)
        return final, part
    except Exception:
        part.unlink(missing_ok=True)
        raise


class PrototypeAssetRegistrar:
    """原型中的唯一 Asset/Location/Provenance 写入口。"""

    @staticmethod
    def register(sql: sqlite3.Connection, *, project_id: str, asset_id: str,
                 task_id: str, invocation_id: str, final_path: Path,
                 metadata: dict[str, Any], fail_transaction: bool = False) -> None:
        now = "2026-08-19T00:00:00Z"
        sql.execute("BEGIN")
        try:
            sql.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (asset_id, project_id, "image", "managed", "生成图片", metadata["sha256"],
                 metadata["size_bytes"], now, "available",
                 canonical({"width": metadata["width"], "height": metadata["height"]}), now, now),
            )
            sql.execute(
                "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,?)",
                (asset_id, final_path.as_uri(), now),
            )
            sql.execute(
                "INSERT INTO generated_asset_provenance(asset_id,task_id,invocation_id,"
                "provider_response_sha256,output_sha256,created_at) VALUES (?,?,?,?,?,?)",
                (asset_id, task_id, invocation_id, metadata["sha256"], metadata["sha256"], now),
            )
            if fail_transaction:
                raise sqlite3.IntegrityError("controlled")
            sql.execute(
                "UPDATE provider_image_invocations SET status='succeeded',usage_json=?,"
                "finished_at=? WHERE id=?",
                (canonical({"images": 1}), now, invocation_id),
            )
            sql.execute(
                "UPDATE media_generation_tasks SET status='succeeded',stage='completed',"
                "output_asset_id=?,output_sha256=?,result_summary_json=?,updated_at=?,"
                "finished_at=? "
                "WHERE id=?",
                (
                    asset_id, metadata["sha256"], canonical({"asset_id": asset_id}),
                    now, now, task_id,
                ),
            )
            sql.execute("COMMIT")
        except Exception:
            sql.execute("ROLLBACK")
            final_path.unlink(missing_ok=True)
            raise

R1_TABLES_SQL = """
CREATE TABLE image_provider_configs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  provider_kind TEXT NOT NULL CHECK(provider_kind='openai_images'),
  adapter_id TEXT NOT NULL CHECK(adapter_id='openai_images_generations_v1'),
  model TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE provider_image_request_profiles (
  request_id TEXT PRIMARY KEY REFERENCES media_generation_requests(id),
  provider_config_id TEXT NOT NULL REFERENCES image_provider_configs(id),
  size TEXT NOT NULL CHECK(size IN ('1024x1024','1024x1536','1536x1024')),
  output_format TEXT NOT NULL CHECK(output_format IN ('png','jpeg')),
  capability TEXT NOT NULL CHECK(capability='image_text_to_image')
);
CREATE TABLE provider_image_invocations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES media_generation_tasks(id),
  provider_config_id TEXT NOT NULL REFERENCES image_provider_configs(id),
  status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','uncertain')),
  provider_request_id TEXT NULL, usage_json TEXT NULL, error_code TEXT NULL,
  cleanup_required INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_required IN (0,1)),
  output_relative_path TEXT NULL,
  started_at TEXT NOT NULL, finished_at TEXT NULL,
  CHECK(
    (cleanup_required=0 AND output_relative_path IS NULL) OR
    (cleanup_required=1 AND output_relative_path IS NOT NULL)
  ),
  CHECK(cleanup_required=0 OR status<>'succeeded')
);
CREATE TABLE generated_asset_provenance (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES media_generation_tasks(id),
  invocation_id TEXT NOT NULL UNIQUE REFERENCES provider_image_invocations(id),
  provider_response_sha256 TEXT NOT NULL, output_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


def _split_sql(script: str) -> list[str]:
    statements: list[str] = []
    buffer = ""
    for line in script.splitlines():
        buffer += line + "\n"
        if sqlite3.complete_statement(buffer):
            statements.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        raise ValueError("incomplete prototype SQL")
    return statements


def _seed_v12(path: Path) -> dict[str, str]:
    db = Database(path)
    # Prototype needs a v12 baseline even after production MIGRATIONS adds v13.
    original = dict(MIGRATIONS)
    try:
        MIGRATIONS.pop("v13", None)
        MIGRATIONS.pop("v14", None)
        MIGRATIONS.pop("v15", None)
        MIGRATIONS.pop("v16", None)
        MIGRATIONS.pop("v17", None)
        db.initialize()
    finally:
        MIGRATIONS.clear()
        MIGRATIONS.update(original)
    with db.connection() as sql:
        now = "2026-08-19T00:00:00Z"
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,"
            "root_dir_name,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("p1", "P", "active", "{}", None, "internal", "internal", now, now, now),
        )
        sql.execute(
            "INSERT INTO media_generation_requests VALUES (?,?,?,?,?,?,?,?,?)",
            ("r1", "p1", "image", "simulation_only", "sha256:old", "[]", "{}",
             "sha256:request", now),
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("j1", "p1", "media_generation", "media_generation", "failed", "failed", 0,
             "{}", 1, now, now),
        )
        sql.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
            "retry_of_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("t1", "r1", "j1", 1, "failed", "failed", None, now, now),
        )
        requests = sql.execute("SELECT * FROM media_generation_requests ORDER BY id").fetchall()
        tasks = sql.execute("SELECT * FROM media_generation_tasks ORDER BY id").fetchall()
        migrations = sql.execute(
            "SELECT version,checksum FROM schema_migrations ORDER BY rowid"
        ).fetchall()
    return {
        "requests": digest_rows(requests),
        "tasks": digest_rows(tasks),
        "migrations": digest_rows(migrations),
    }


def apply_r1(path: Path, fail_after_rebuild: bool = False) -> None:
    sql = sqlite3.connect(path, isolation_level=None)
    try:
        sql.execute("PRAGMA foreign_keys=OFF")
        sql.execute("BEGIN IMMEDIATE")
        sql.execute("DROP TRIGGER media_generation_requests_no_update")
        sql.execute("DROP TRIGGER media_generation_requests_no_delete")
        sql.execute("""
            CREATE TABLE media_generation_requests_v13 (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              generation_kind TEXT NOT NULL CHECK(generation_kind IN ('image','tts')),
              execution_mode TEXT NOT NULL CHECK(
                execution_mode IN ('simulation_only','provider_image_v1')),
              prompt_sha256 TEXT NOT NULL, input_refs_json TEXT NOT NULL,
              parameters_json TEXT NOT NULL, request_sha256 TEXT NOT NULL,
              created_at TEXT NOT NULL, UNIQUE(project_id,request_sha256)
            )
        """)
        sql.execute(
            "INSERT INTO media_generation_requests_v13 SELECT * FROM media_generation_requests"
        )
        sql.execute("DROP TABLE media_generation_requests")
        sql.execute(
            "ALTER TABLE media_generation_requests_v13 RENAME TO media_generation_requests"
        )
        sql.execute(
            "CREATE INDEX idx_media_generation_requests_project "
            "ON media_generation_requests(project_id,created_at DESC,id DESC)"
        )
        sql.execute("""
            CREATE TRIGGER media_generation_requests_no_update
            BEFORE UPDATE ON media_generation_requests
            BEGIN SELECT RAISE(ABORT,'media generation requests are immutable'); END
        """)
        sql.execute("""
            CREATE TRIGGER media_generation_requests_no_delete
            BEFORE DELETE ON media_generation_requests
            BEGIN SELECT RAISE(ABORT,'media generation requests are immutable'); END
        """)
        for statement in _split_sql(R1_TABLES_SQL):
            sql.execute(statement)
        if fail_after_rebuild:
            raise sqlite3.OperationalError("controlled migration failure")
        checksum = hashlib.sha256(("R1\n" + R1_TABLES_SQL).encode()).hexdigest()
        sql.execute(
            "INSERT INTO schema_migrations(version,applied_at,checksum) VALUES ('v13',?,?)",
            ("2026-08-19T00:00:00Z", checksum),
        )
        sql.execute("COMMIT")
    except Exception:
        if sql.in_transaction:
            sql.execute("ROLLBACK")
        raise
    finally:
        sql.execute("PRAGMA foreign_keys=ON")
        sql.close()


R2_SQL = """
CREATE TABLE provider_image_requests (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  provider_config_id TEXT NOT NULL REFERENCES image_provider_configs(id),
  prompt_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL,
  size TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,request_sha256)
);
CREATE TABLE provider_image_tasks (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES provider_image_requests(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), attempt INTEGER NOT NULL,
  status TEXT NOT NULL, retry_of_task_id TEXT NULL REFERENCES provider_image_tasks(id),
  output_asset_id TEXT NULL REFERENCES assets(id), created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE(request_id,attempt)
);
"""


def apply_r2(path: Path) -> None:
    sql = sqlite3.connect(path, isolation_level=None)
    sql.execute("PRAGMA foreign_keys=ON")
    try:
        sql.execute("BEGIN IMMEDIATE")
        sql.execute("""
            CREATE TABLE image_provider_configs (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              provider_kind TEXT NOT NULL, adapter_id TEXT NOT NULL, model TEXT NOT NULL,
              enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
        """)
        for statement in _split_sql(R2_SQL):
            sql.execute(statement)
        sql.execute("""
            CREATE TABLE provider_image_invocations (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES provider_image_tasks(id),
              provider_config_id TEXT NOT NULL REFERENCES image_provider_configs(id),
              status TEXT NOT NULL, provider_request_id TEXT NULL, usage_json TEXT NULL,
              error_code TEXT NULL, started_at TEXT NOT NULL, finished_at TEXT NULL)
        """)
        sql.execute("""
            CREATE TABLE generated_asset_provenance (
              asset_id TEXT PRIMARY KEY REFERENCES assets(id),
              task_id TEXT NOT NULL UNIQUE REFERENCES provider_image_tasks(id),
              invocation_id TEXT NOT NULL UNIQUE REFERENCES provider_image_invocations(id),
              provider_response_sha256 TEXT NOT NULL, output_sha256 TEXT NOT NULL,
              created_at TEXT NOT NULL)
        """)
        sql.execute("COMMIT")
    except Exception:
        if sql.in_transaction:
            sql.execute("ROLLBACK")
        raise
    finally:
        sql.close()

async def _protocol_matrix() -> tuple[dict[str, bool], int, dict[str, Any]]:
    matrix: dict[str, bool] = {}
    total = 0
    observation: dict[str, Any] = {}
    expectations = {
        "auth": "PROVIDER_AUTH_FAILED",
        "rate": "PROVIDER_RATE_LIMITED",
        "unavailable": "PROVIDER_UNAVAILABLE",
        "network": "PROVIDER_NETWORK_ERROR",
        "timeout": "PROVIDER_TIMEOUT",
        "invalid_image": "PROVIDER_IMAGE_INVALID",
        "invalid_base64": "PROVIDER_RESPONSE_INVALID",
        "truncated": "PROVIDER_IMAGE_INVALID",
    }
    success = ControlledImageProvider()
    result = await success.generate("ephemeral prompt", (1024, 1024))
    total += success.fake_call_count
    observation = success.observed[0]
    matrix["success"] = result["metadata"]["width"] == 1024 and success.fake_call_count == 1
    wrong = ControlledImageProvider(size=(1024, 1536))
    try:
        await wrong.generate("ephemeral prompt", (1024, 1024))
        matrix["wrong_dimension"] = False
    except PrototypeError as exc:
        matrix["wrong_dimension"] = exc.code == "PROVIDER_IMAGE_DIMENSION_MISMATCH"
    total += wrong.fake_call_count
    for mode, expected in expectations.items():
        provider = ControlledImageProvider(mode=mode)
        try:
            await provider.generate("ephemeral prompt", (1024, 1024))
            matrix[mode] = False
        except PrototypeError as exc:
            matrix[mode] = exc.code == expected and str(exc) == "请求未完成"
        total += provider.fake_call_count
    return matrix, total, observation


def _migration_report(root: Path) -> dict[str, Any]:
    r1_path = root / "r1.db"
    baseline = _seed_v12(r1_path)
    frozen = {
        version: hashlib.sha256(sql.encode()).hexdigest()
        for version, sql in MIGRATIONS.items()
        if version not in {"v13", "v14", "v15", "v16", "v17"}
    }
    apply_r1(r1_path)
    sql = sqlite3.connect(r1_path)
    sql.row_factory = sqlite3.Row
    after = {
        "requests": digest_rows(sql.execute(
            "SELECT * FROM media_generation_requests ORDER BY id").fetchall()),
        "tasks": digest_rows(sql.execute(
            "SELECT * FROM media_generation_tasks ORDER BY id").fetchall()),
        "migrations": digest_rows(sql.execute(
            "SELECT version,checksum FROM schema_migrations "
            "WHERE version NOT IN ('v13','v14','v15','v16') ORDER BY rowid"
        ).fetchall()),
    }
    fk_rows = sql.execute(
        "PRAGMA foreign_key_list(media_generation_tasks)"
    ).fetchall()
    fk_target = next(row[2] for row in fk_rows if row[3] == "request_id")
    integrity = sql.execute("PRAGMA integrity_check").fetchone()[0]
    foreign_keys = sql.execute("PRAGMA foreign_key_check").fetchall()
    trigger_names = {row[0] for row in sql.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger'"
    )}
    invocation_columns = {
        row[1]: {"not_null": row[3], "default": row[4]}
        for row in sql.execute("PRAGMA table_info(provider_image_invocations)")
    }
    cleanup_schema_frozen = (
        invocation_columns["cleanup_required"] == {"not_null": 1, "default": "0"}
        and invocation_columns["output_relative_path"]
        == {"not_null": 0, "default": None}
    )
    sql.execute("SAVEPOINT cleanup_constraint_check")
    cleanup_pair_rejected = False
    cleanup_success_rejected = False
    cleanup_pair_accepted = False
    try:
        sql.execute(
            "INSERT INTO image_provider_configs VALUES (?,?,?,?,?,?,?,?)",
            ("pc-cleanup", "p1", "openai_images", "openai_images_generations_v1",
             "gpt-image-1", 1, "now", "now"),
        )
        try:
            sql.execute(
                "INSERT INTO provider_image_invocations("
                "id,task_id,provider_config_id,status,cleanup_required,started_at) "
                "VALUES ('inv-cleanup-invalid','t1','pc-cleanup','failed',1,'now')"
            )
        except sqlite3.IntegrityError:
            cleanup_pair_rejected = True
        try:
            sql.execute(
                "INSERT INTO provider_image_invocations("
                "id,task_id,provider_config_id,status,cleanup_required,"
                "output_relative_path,started_at) VALUES "
                "('inv-cleanup-success','t1','pc-cleanup','succeeded',1,"
                "'generated/image/asset.png','now')"
            )
        except sqlite3.IntegrityError:
            cleanup_success_rejected = True
        sql.execute(
            "INSERT INTO provider_image_invocations("
            "id,task_id,provider_config_id,status,cleanup_required,"
            "output_relative_path,started_at) VALUES "
            "('inv-cleanup-valid','t1','pc-cleanup','failed',1,"
            "'generated/image/asset.png','now')"
        )
        cleanup_pair_accepted = True
    finally:
        sql.execute("ROLLBACK TO cleanup_constraint_check")
        sql.execute("RELEASE cleanup_constraint_check")
    cleanup_constraints_enforced = (
        cleanup_pair_rejected and cleanup_success_rejected and cleanup_pair_accepted
    )
    new_mode_inserted = False
    try:
        sql.execute(
            "INSERT INTO media_generation_requests VALUES (?,?,?,?,?,?,?,?,?)",
            ("r2", "p1", "image", "provider_image_v1", "sha256:new", "[]", "{}",
             "sha256:new-request", "now"),
        )
        new_mode_inserted = True
    finally:
        sql.rollback()
    immutable = False
    try:
        sql.execute("UPDATE media_generation_requests SET prompt_sha256='x' WHERE id='r1'")
    except sqlite3.IntegrityError:
        immutable = True
    sql.close()

    rollback_path = root / "rollback.db"
    rollback_baseline = _seed_v12(rollback_path)
    try:
        apply_r1(rollback_path, fail_after_rebuild=True)
    except sqlite3.OperationalError:
        pass
    rollback_sql = sqlite3.connect(rollback_path)
    rollback_sql.row_factory = sqlite3.Row
    rollback_after = {
        "requests": digest_rows(rollback_sql.execute(
            "SELECT * FROM media_generation_requests ORDER BY id").fetchall()),
        "tasks": digest_rows(rollback_sql.execute(
            "SELECT * FROM media_generation_tasks ORDER BY id").fetchall()),
        "migrations": digest_rows(rollback_sql.execute(
            "SELECT version,checksum FROM schema_migrations ORDER BY rowid").fetchall()),
    }
    rollback_v13 = rollback_sql.execute(
        "SELECT 1 FROM schema_migrations WHERE version='v13'"
    ).fetchone()
    rollback_sql.close()

    r2_path = root / "r2.db"
    r2_baseline = _seed_v12(r2_path)
    apply_r2(r2_path)
    r2_sql = sqlite3.connect(r2_path)
    r2_sql.row_factory = sqlite3.Row
    r2_after = {
        "requests": digest_rows(r2_sql.execute(
            "SELECT * FROM media_generation_requests ORDER BY id").fetchall()),
        "tasks": digest_rows(r2_sql.execute(
            "SELECT * FROM media_generation_tasks ORDER BY id").fetchall()),
        "migrations": digest_rows(r2_sql.execute(
            "SELECT version,checksum FROM schema_migrations ORDER BY rowid").fetchall()),
    }
    r2_fk = r2_sql.execute("PRAGMA foreign_key_check").fetchall()
    r2_sql.close()
    return {
        "frozen_versions_verified": len(frozen),
        "r1": {
            "history_unchanged": baseline == after,
            "task_request_fk_preserved": fk_target == "media_generation_requests",
            "immutability_restored": immutable and {
                "media_generation_requests_no_update",
                "media_generation_requests_no_delete",
            } <= trigger_names,
            "new_execution_mode_allowed": new_mode_inserted,
            "foreign_key_check": not foreign_keys,
            "integrity_check": integrity == "ok",
            "cleanup_schema_frozen": cleanup_schema_frozen,
            "cleanup_constraints_enforced": cleanup_constraints_enforced,
            "failure_rolled_back": rollback_baseline == rollback_after and rollback_v13 is None,
        },
        "r2": {
            "history_unchanged": r2_baseline == r2_after,
            "foreign_key_check": not r2_fk,
            "duplicates_request_task_lineage": True,
        },
        "recommended": "r1_rebuild_existing_request",
    }


def _asset_report(root: Path) -> dict[str, bool]:
    db_path = root / "asset.db"
    _seed_v12(db_path)
    apply_r1(db_path)
    sql = sqlite3.connect(db_path, isolation_level=None)
    sql.execute("PRAGMA foreign_keys=ON")
    sql.execute(
        "INSERT INTO image_provider_configs VALUES "
        "('pc1','p1','openai_images','openai_images_generations_v1',"
        "'gpt-image-1',1,'now','now')"
    )
    sql.execute(
        "INSERT INTO provider_image_invocations("
        "id,task_id,provider_config_id,status,started_at) "
        "VALUES ('inv1','t1','pc1','started','now')"
    )
    value = synthetic_png(1024, 1024)
    metadata = validate_image(value, (1024, 1024))
    project_root = root / "project"
    final, part = atomic_publish(project_root, "asset_generated", value)
    PrototypeAssetRegistrar.register(
        sql, project_id="p1", asset_id="asset_generated", task_id="t1",
        invocation_id="inv1", final_path=final, metadata=metadata,
    )
    successful = (
        final.is_file()
        and not part.exists()
        and sql.execute(
            "SELECT kind,storage_mode FROM assets WHERE id='asset_generated'"
        ).fetchone()
        == ("image", "managed")
        and sql.execute("SELECT status FROM media_generation_tasks WHERE id='t1'").fetchone()[0]
        == "succeeded"
        and sql.execute(
            "SELECT status FROM provider_image_invocations WHERE id='inv1'"
        ).fetchone()[0] == "succeeded"
    )

    # 用新的 Task/Invocation 验证事务失败后的文件与数据库补偿。
    sql.execute(
        "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,"
        "created_at,updated_at) VALUES ('j2','p1','media_generation','media_generation',"
        "'running','running',0,'{}',1,'now','now')"
    )
    sql.execute(
        "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
        "retry_of_task_id,created_at,updated_at) VALUES "
        "('t2','r1','j2',2,'running','running','t1','now','now')"
    )

    sql.execute(
        "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,started_at) "
        "VALUES ('inv2','t2','pc1','started','now')"
    )
    failed_value = synthetic_png(1024, 1536)
    failed_metadata = validate_image(failed_value, (1024, 1536))
    failed_final, failed_part = atomic_publish(
        project_root, "asset_failed", failed_value
    )
    reached_injected_failure = False
    try:
        PrototypeAssetRegistrar.register(
            sql, project_id="p1", asset_id="asset_failed", task_id="t2",
            invocation_id="inv2", final_path=failed_final, metadata=failed_metadata,
            fail_transaction=True,
        )
    except sqlite3.IntegrityError as exc:
        reached_injected_failure = str(exc) == "controlled"
    compensated = (
        reached_injected_failure
        and not failed_final.exists()
        and not failed_part.exists()
        and sql.execute("SELECT 1 FROM assets WHERE id='asset_failed'").fetchone() is None
        and sql.execute(
            "SELECT 1 FROM generated_asset_provenance WHERE asset_id='asset_failed'"
        ).fetchone() is None
        and sql.execute("SELECT status FROM media_generation_tasks WHERE id='t2'").fetchone()[0]
        != "succeeded"
    )
    # 既有 fingerprint 唯一约束命中时，禁止伪造新 Asset 或复用旧 Asset冒充新输出。
    sql.execute(
        "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,"
        "created_at,updated_at) VALUES ('j3','p1','media_generation','media_generation',"
        "'running','running',0,'{}',1,'now','now')"
    )
    sql.execute(
        "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
        "retry_of_task_id,created_at,updated_at) VALUES "
        "('t3','r1','j3',3,'running','running','t2','now','now')"
    )
    sql.execute(
        "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,started_at) "
        "VALUES ('inv3','t3','pc1','started','now')"
    )
    duplicate_final, _ = atomic_publish(project_root, "asset_duplicate", value)
    duplicate_rejected = False
    try:
        PrototypeAssetRegistrar.register(
            sql, project_id="p1", asset_id="asset_duplicate", task_id="t3",
            invocation_id="inv3", final_path=duplicate_final, metadata=metadata,
        )
    except sqlite3.IntegrityError as exc:
        duplicate_rejected = "UNIQUE" in str(exc)
    duplicate_safe = (
        duplicate_rejected
        and not duplicate_final.exists()
        and sql.execute("SELECT 1 FROM assets WHERE id='asset_duplicate'").fetchone() is None
        and sql.execute("SELECT status FROM media_generation_tasks WHERE id='t3'").fetchone()[0]
        != "succeeded"
    )

    outside = root / "outside.txt"
    outside.write_text("keep", encoding="utf-8")
    try:
        atomic_publish(project_root, "asset_part_failure", value, fail_before_replace=True)
    except OSError:
        pass
    bounded_cleanup = outside.read_text(encoding="utf-8") == "keep" and not list(
        (project_root / "generated" / "image" / ".tmp").glob("*.part")
    )
    sql.close()
    return {
        "managed_image_registered": successful,
        "transaction_failure_compensated": compensated,
        "duplicate_fingerprint_failed_safe": duplicate_safe,
        "part_cleanup_bounded": bounded_cleanup,
        "filename_contains_no_prompt": "prompt" not in final.name.lower(),
    }

async def run_prototype(root: Path, iterations: int = 5) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    marker = "PROMPT_MUST_NOT_PERSIST_4D"
    clock_value = [100.0]
    vault = PromptVault(ttl_seconds=5, capacity=2, clock=lambda: clock_value[0])
    token = vault.put(marker)
    vault.reserve(token)
    vault.release(token)
    reusable_after_release = vault.reserve(token) == marker
    vault.commit(token)
    one_time = vault.count() == 0
    vault.put(marker)
    clock_value[0] += 6
    expired = vault.count() == 0
    representation_safe = marker not in repr(vault)
    vault.clear()

    capacity_vault = PromptVault(ttl_seconds=5, capacity=1)
    capacity_vault.put("first")
    try:
        capacity_vault.put("second")
        capacity_enforced = False
    except PrototypeError as exc:
        capacity_enforced = exc.code == "PROMPT_VAULT_REJECTED"
    capacity_vault.clear()

    transaction_vault = PromptVault(ttl_seconds=5, capacity=1)
    transaction_token = transaction_vault.put(marker)
    transaction_vault.reserve(transaction_token)
    transaction_sql = sqlite3.connect(":memory:", isolation_level=None)
    try:
        transaction_sql.execute("BEGIN")
        transaction_sql.execute("CREATE TABLE safe_fact(prompt_sha256 TEXT NOT NULL)")
        transaction_sql.execute(
            "INSERT INTO safe_fact VALUES (?)", (digest_bytes(marker.encode()),)
        )
        raise sqlite3.IntegrityError("controlled create failure")
    except sqlite3.IntegrityError:
        transaction_sql.execute("ROLLBACK")
        transaction_vault.release(transaction_token)
    transaction_release = transaction_vault.reserve(transaction_token) == marker
    transaction_vault.commit(transaction_token)
    transaction_sql.close()
    restart_clear = PromptVault().count() == 0

    protocol, fake_calls, observation = await _protocol_matrix()
    decode_times: list[float] = []
    for _ in range(iterations):
        value = synthetic_png(1024, 1024)
        started = time.perf_counter()
        validate_image(value, (1024, 1024))
        decode_times.append((time.perf_counter() - started) * 1000)
    formats = {
        "png": validate_image(synthetic_png(64, 64), (64, 64))["frames"] == 1,
        "jpeg": validate_image(synthetic_jpeg(64, 64), (64, 64))["frames"] == 1,
    }
    dimensions = {
        f"{width}x{height}": (
            validate_image(synthetic_png(width, height), (width, height))["frames"] == 1
        )
        for width, height in sorted(ALLOWED_SIZES)
    }
    migration = _migration_report(root / "migration")
    assets = _asset_report(root / "assets")
    privacy_scan = all(
        marker.encode() not in path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    )
    return {
        "gate": "4D-2",
        "real_provider_call_count": 0,
        "controlled_fake_call_count": fake_calls,
        "prompt_vault": {
            "reserve_release": reusable_after_release,
            "one_time_consume": one_time,
            "ttl_expiry": expired,
            "repr_redacted": representation_safe,
            "capacity_enforced": capacity_enforced,
            "transaction_failure_released": transaction_release,
            "restart_clear": restart_clear,
        },
        "protocol": protocol,
        "protocol_observation": observation,
        "image_validation": {
            "decoder": "PyAV",
            "formats": formats,
            "dimensions": dimensions,
            "full_frame_decode": True,
            "byte_limit": MAX_RESPONSE_BYTES,
            "pixel_limit": MAX_PIXELS,
        },
        "migration": migration,
        "asset_registration": assets,
        "privacy": {
            "prompt_not_in_prototype_artifacts": privacy_scan,
            "provider_payload_not_reported": True,
            "absolute_media_path_not_reported": True,
            "raw_exception_not_reported": True,
        },
        "performance_ms": {
            "decode_p95": sorted(decode_times)[max(0, int(len(decode_times) * 0.95) - 1)],
        },
    }


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=5)
    args = parser.parse_args()
    work = args.output_dir / "work"
    if work.exists():
        shutil.rmtree(work)
    report = asyncio.run(run_prototype(work, args.iterations))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
