"""素材外部修改后「改回原样」的 refresh 语义（revert 分支回归）。

2026-10-10 真机观察：refresh_asset 把新指纹写成基准，内容改回原样也无法自证 ⇒
availability 永久停在 changed，且 Core 对任何 TimelinePatch fail-closed
（TIMELINE_SOURCE_INVALID 素材不可用于 Timeline），只能重新导入。

修复后接受集与 relocate_asset 同口径（当前指纹 ∪ previous_fingerprint），并把该指纹
对应的转录从 stale 恢复为 ready；只记忆「上一版」，第三版内容仍判 changed（不无限记忆）。
负向对照：还原 refresh_asset 的单向判定 ⇒ 本文件前两项红。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import utc_now

FFMPEG = Path(__file__).resolve().parents[4] / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
FFPROBE = FFMPEG.parent / "ffprobe.exe"


def _require_ffmpeg() -> None:
    if not FFMPEG.is_file() or not FFPROBE.is_file():
        pytest.skip("bundled ffmpeg/ffprobe unavailable")


def _synthetic_wav(path: Path, seconds: int) -> None:
    """真实 wav（refresh 要走 probe，故必须能被 ffprobe 解析）。"""
    subprocess.run([
        str(FFMPEG), "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"sine=frequency=220:sample_rate=48000:duration={seconds}",
        "-c:a", "pcm_s16le", str(path),
    ], check=True, capture_output=True)


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-revert")
    settings = Settings(
        data_dir=tmp_path / "data",
        manifest_dir=tmp_path / "manifests",
        ffmpeg=FFMPEG,
        ffprobe=FFPROBE,
    )
    application = TestClient(create_app(settings))
    with application:
        yield application


def _ui(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-revert"}
    )
    return {"Authorization": "Bearer " + response.json()["token"]}


ADMIN = {"Authorization": "Bearer admin-revert"}


def _import_asset(client: TestClient, media: Path) -> tuple[str, str]:
    project = client.post("/api/v1/projects", json={"name": "revert"}, headers=_ui(client)).json()
    grant = client.post(
        "/api/v1/internal/file-grants", json={"path": str(media)}, headers=ADMIN
    ).json()
    asset = client.post(
        "/api/v1/projects/" + project["project_id"] + "/assets",
        json={"grant_id": grant["grant_id"], "kind": "audio"},
        headers=_ui(client),
    ).json()
    return project["project_id"], asset["asset_id"]


def _asset(state: object, asset_id: str) -> dict:
    with state.db.connection() as db:  # type: ignore[attr-defined]
        return dict(db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone())


def _location(state: object, asset_id: str) -> dict:
    with state.db.connection() as db:  # type: ignore[attr-defined]
        return dict(db.execute(
            "SELECT * FROM asset_locations WHERE asset_id=?", (asset_id,)
        ).fetchone())


def _seed_ready_transcript(state: object, asset_id: str, fingerprint: str) -> None:
    now = utc_now()
    with state.db.connection() as db:  # type: ignore[attr-defined]
        db.execute(
            "INSERT INTO transcripts(id,asset_id,status,language,provider,model_id,"
            "model_revision,source_fingerprint,duration_us,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("transcript_revert_1", asset_id, "ready", "zh", "local", "tiny",
             "rev1", fingerprint, 1_000_000, now, now),
        )


def _transcript_status(state: object, asset_id: str) -> str:
    with state.db.connection() as db:  # type: ignore[attr-defined]
        row = db.execute(
            "SELECT status FROM transcripts WHERE asset_id=?", (asset_id,)
        ).fetchone()
    return str(row["status"])


class TestAssetRefreshRevert:
    def test_revert_restores_availability_and_transcript(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _require_ffmpeg()
        media = tmp_path / "bgm.wav"
        _synthetic_wav(media, 1)
        original = media.read_bytes()
        _, asset_id = _import_asset(client, media)
        state = client.app.state.core
        first = _asset(state, asset_id)
        assert first["availability"] == "available"
        fingerprint_a = str(first["fingerprint"])
        _seed_ready_transcript(state, asset_id, fingerprint_a)

        # 外部改成另一版内容（真实 wav，probe 仍可解析）→ refresh：changed
        other = tmp_path / "other.wav"
        _synthetic_wav(other, 2)
        media.write_bytes(other.read_bytes())
        body = client.post(
            "/api/v1/assets/" + asset_id + "/refresh", headers=_ui(client)
        ).json()
        fingerprint_b = str(_asset(state, asset_id)["fingerprint"])
        assert body["availability"] == "changed"
        assert fingerprint_b != fingerprint_a
        assert _location(state, asset_id)["previous_fingerprint"] == fingerprint_a
        assert _transcript_status(state, asset_id) == "stale"

        # 改回原样 → refresh：恢复 available（与 relocate 同接受集），转录回到 ready
        media.write_bytes(original)
        body = client.post(
            "/api/v1/assets/" + asset_id + "/refresh", headers=_ui(client)
        ).json()
        assert body["availability"] == "available"
        assert str(_asset(state, asset_id)["fingerprint"]) == fingerprint_a
        assert _location(state, asset_id)["previous_fingerprint"] == fingerprint_b
        assert _transcript_status(state, asset_id) == "ready"

    def test_third_content_still_changed(self, client: TestClient, tmp_path: Path) -> None:
        """回退接受集只记「上一版」：再改成第三版内容仍判 changed（不无限记忆）。"""
        _require_ffmpeg()
        media = tmp_path / "bgm.wav"
        _synthetic_wav(media, 1)
        _, asset_id = _import_asset(client, media)
        state = client.app.state.core

        second = tmp_path / "second.wav"
        third = tmp_path / "third.wav"
        _synthetic_wav(second, 2)
        _synthetic_wav(third, 3)
        media.write_bytes(second.read_bytes())
        client.post("/api/v1/assets/" + asset_id + "/refresh", headers=_ui(client))
        media.write_bytes(third.read_bytes())
        body = client.post(
            "/api/v1/assets/" + asset_id + "/refresh", headers=_ui(client)
        ).json()
        assert body["availability"] == "changed"
