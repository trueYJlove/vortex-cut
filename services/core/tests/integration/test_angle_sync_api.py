"""W2.1 机位同步 Core API 集成测试（真实 ffmpeg 素材 + 真实互相关）。

覆盖 Planning Gate §3：1（已知偏移容差，含 AAC/adelay 真实链路）、2（人工偏移并列）、
3（幂等短路）、4（stale）、6（零 egress + 无新模型面）、7（性能）、9的合成半边。

真实素材：同一段 anoisesrc 音频（seed 固定）→ ref 原样、mem 用 adelay 平移 687ms，
各自配一条 mpeg4 视频轨（打包 ffmpeg 无 libx264，仓库既有真实测试同款）。
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings

FFMPEG = Path(__file__).resolve().parents[4] / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
FFPROBE = FFMPEG.parent / "ffprobe.exe"
OFFSET_MS = 687
TOLERANCE_MS = 10.0


def _require_ffmpeg() -> None:
    if not FFMPEG.is_file() or not FFPROBE.is_file():
        pytest.skip("bundled ffmpeg/ffprobe unavailable")


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-angle")
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
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-angle"})
    return {"Authorization": "Bearer " + response.json()["token"]}


ADMIN = {"Authorization": "Bearer admin-angle"}


def _make_pair(tmp_path: Path, seconds: int = 20) -> tuple[Path, Path]:
    """同源音频的两个视频：mem 的音频整体延后 OFFSET_MS（adelay）。

    信号用 **pink noise**（近似真实音频频谱）：白噪声是 AAC 的最坏情况
    （感知编码把高频量化噪声暴露出来），实测解码后置信度只有 0.46，
    会被如实判为 low_confidence——那是编解码失真而非算法问题。
    """
    audio = tmp_path / "audio.wav"
    subprocess.run([
        str(FFMPEG), "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"anoisesrc=color=pink:seed=42:duration={seconds}:sample_rate=48000",
        "-ac", "1", "-c:a", "pcm_s16le", str(audio),
    ], check=True, capture_output=True)
    ref = tmp_path / "ref.mp4"
    mem = tmp_path / "mem.mp4"
    subprocess.run([
        str(FFMPEG), "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"color=c=black:s=320x180:r=30:d={seconds}",
        "-i", str(audio), "-map", "0:v", "-map", "1:a",
        "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(ref),
    ], check=True, capture_output=True)
    subprocess.run([
        str(FFMPEG), "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"color=c=black:s=320x180:r=30:d={seconds}",
        "-i", str(audio), "-map", "0:v", "-map", "1:a",
        "-af", f"adelay={OFFSET_MS}", "-c:v", "mpeg4", "-c:a", "aac", "-b:a", "192k", str(mem),
    ], check=True, capture_output=True)
    return ref, mem


def _import(client: TestClient, project_id: str, media: Path, kind: str = "video") -> str:
    grant = client.post(
        "/api/v1/internal/file-grants", json={"path": str(media)}, headers=ADMIN).json()
    asset = client.post(
        "/api/v1/projects/" + project_id + "/assets",
        json={"grant_id": grant["grant_id"], "kind": kind}, headers=_ui(client)).json()
    return asset["asset_id"]


def _seed(client: TestClient, ref: Path, mem: Path) -> tuple[str, str, str]:
    project = client.post("/api/v1/projects", json={"name": "机位"}, headers=_ui(client)).json()
    project_id = project["project_id"]
    return project_id, _import(client, project_id, ref), _import(client, project_id, mem)


def _create_group(client: TestClient, project_id: str, reference: str, member: str) -> dict:
    response = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups",
        json={"name": "双机位", "reference_asset_id": reference, "member_asset_ids": [member]},
        headers=_ui(client),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _entry(summary: dict, asset_id: str) -> dict:
    return next(entry for entry in summary["angles"] if entry["asset_id"] == asset_id)


def test_requires_session_and_cross_project(tmp_path: Path) -> None:
    _require_ffmpeg()
    with TestClient(create_app(Settings(
        data_dir=tmp_path / "d", manifest_dir=tmp_path / "m",
        ffmpeg=FFMPEG, ffprobe=FFPROBE,
    ))) as application:
        assert application.post("/api/v1/projects/p1/angle-groups", json={}).status_code == 401


def test_end_to_end_known_offset(client: TestClient, tmp_path: Path) -> None:
    _require_ffmpeg()
    ref, mem = _make_pair(tmp_path)
    project_id, ref_id, mem_id = _seed(client, ref, mem)
    group = _create_group(client, project_id, ref_id, mem_id)
    assert [entry["status"] for entry in group["angles"]] == ["missing", "missing"]

    started = time.monotonic()
    sync = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"] + "/sync",
        json={"generate": True}, headers=_ui(client)).json()
    assert sync["job_id"], sync

    state = client.app.state.core
    with state.db.connection() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (sync["job_id"],)).fetchone()
    assert row["kind"] == "angle_sync" and row["resource_class"] == "light"
    asyncio.run(state.angle_sync.run_sync_job(row, asyncio.Event()))
    elapsed = time.monotonic() - started

    summary = client.get(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"],
        headers=_ui(client)).json()
    reference_entry = _entry(summary, ref_id)
    member_entry = _entry(summary, mem_id)
    assert reference_entry["status"] == "ready" and reference_entry["offset_us"] == 0
    assert member_entry["status"] == "ready", member_entry
    assert abs(member_entry["offset_us"] / 1000 - OFFSET_MS) <= TOLERANCE_MS, member_entry

    # 幂等短路（验收 3）
    again = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"] + "/sync",
        json={"generate": True}, headers=_ui(client)).json()
    assert again["job_id"] is None

    # 人工偏移并列（验收 2/8）
    manual = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"]
        + "/angles/" + mem_id + "/offset",
        json={"offset_us": 123_000}, headers=_ui(client)).json()
    entry = _entry(manual, mem_id)
    assert entry["source"] == "manual" and entry["offset_us"] == 123_000
    with state.db.connection() as db:
        sources = [r["source"] for r in db.execute(
            "SELECT source FROM angle_syncs WHERE asset_id=? ORDER BY created_at",
            (mem_id,)).fetchall()]
    assert sources == ["auto", "manual"], sources  # 成员侧：自动测量 + 人工偏移（并列）

    # 零 egress + 无新模型面（验收 6）
    with state.db.connection() as db:
        invocations = db.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0]
        downloads = db.execute(
            "SELECT COUNT(*) FROM jobs WHERE kind='model_download'").fetchone()[0]
        installations = db.execute("SELECT COUNT(*) FROM model_installations").fetchone()[0]
    assert (invocations, downloads, installations) == (0, 0, 0)
    assert elapsed < 30.0, f"性能门：{elapsed:.1f}s（2×20s 素材）"


def test_stale_after_fingerprint_change(client: TestClient, tmp_path: Path) -> None:
    """验收 4：素材变化后摘要必须报 stale（读时计算），且可重算。"""
    _require_ffmpeg()
    ref, mem = _make_pair(tmp_path)
    project_id, ref_id, mem_id = _seed(client, ref, mem)
    group = _create_group(client, project_id, ref_id, mem_id)
    state = client.app.state.core
    sync = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"] + "/sync",
        json={"generate": True}, headers=_ui(client)).json()
    with state.db.connection() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (sync["job_id"],)).fetchone()
    asyncio.run(state.angle_sync.run_sync_job(row, asyncio.Event()))

    with state.db.connection() as db:
        db.execute("UPDATE assets SET fingerprint='sha256:changed' WHERE id=?", (mem_id,))
    summary = client.get(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"],
        headers=_ui(client)).json()
    assert _entry(summary, mem_id)["status"] == "stale"
    assert _entry(summary, ref_id)["status"] == "ready"   # 参考侧不受影响



def test_resync_after_member_fingerprint_change_succeeds(client: TestClient, tmp_path: Path) -> None:
    """M1（验证门 ③-1）：成员指纹变化后重算必须成功。

    此前 run_sync_job 会为参考机位无条件再插一条 ready/auto 行，而部分唯一索引
    idx_angle_syncs_ready 以 (组,机位,版本,来源,双侧指纹) 为键 ⇒ 第二次同指纹插入抛
    sqlite3.IntegrityError；它不是 DomainError，run_sync_job 的 except 接不住，
    整个作业崩（触发场景正是「换素材后点重算」）。
    """
    _require_ffmpeg()
    ref, mem = _make_pair(tmp_path)
    project_id, ref_id, mem_id = _seed(client, ref, mem)
    group = _create_group(client, project_id, ref_id, mem_id)
    state = client.app.state.core

    first = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"] + "/sync",
        json={"generate": True}, headers=_ui(client)).json()
    with state.db.connection() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (first["job_id"],)).fetchone()
    asyncio.run(state.angle_sync.run_sync_job(row, asyncio.Event()))

    # 成员侧素材**真的被换掉**：改文件内容 + refresh（指纹更新、availability 回到 available）
    # ⇒ 旧结果 stale ⇒ 必须允许且能够重算（不撞唯一索引、不崩）
    changed = tmp_path / "mem-changed.mp4"
    subprocess.run([
        str(FFMPEG), "-hide_banner", "-nostdin", "-y", "-f", "lavfi",
        "-i", "color=c=black:s=320x180:r=30:d=20",
        "-i", str(tmp_path / "audio.wav"), "-map", "0:v", "-map", "1:a",
        "-af", "adelay=" + str(OFFSET_MS + 120), "-c:v", "mpeg4", "-c:a", "aac", "-b:a", "192k",
        str(changed),
    ], check=True, capture_output=True)
    mem.write_bytes(changed.read_bytes())
    first_refresh = client.post("/api/v1/assets/" + mem_id + "/refresh", headers=_ui(client)).json()
    assert first_refresh["availability"] == "changed"   # 第一次：如实报「素材已变化」并记新基准
    refreshed = client.post("/api/v1/assets/" + mem_id + "/refresh", headers=_ui(client)).json()
    assert refreshed["availability"] == "available"     # 再次校验：新内容被接受 ⇒ 可用
    assert _entry(client.get(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"],
        headers=_ui(client)).json(), mem_id)["status"] == "stale"
    second = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"] + "/sync",
        json={"generate": True}, headers=_ui(client)).json()
    assert second["job_id"], "stale 后必须能登记重算作业"
    with state.db.connection() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (second["job_id"],)).fetchone()
    asyncio.run(state.angle_sync.run_sync_job(row, asyncio.Event()))   # 修复前在此崩

    summary = client.get(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"],
        headers=_ui(client)).json()
    assert _entry(summary, ref_id)["status"] == "ready"
    assert _entry(summary, ref_id)["offset_us"] == 0
    assert _entry(summary, mem_id)["status"] == "ready"     # 用新指纹重算成功


def test_manual_stale_falls_back_to_auto(client: TestClient, tmp_path: Path) -> None:
    """验证门次要项：manual 行 stale 时必须回退到指纹相符的 auto 行并标注 manual_stale
    （Planning Gate §2.1 冻结例外）。"""
    _require_ffmpeg()
    ref, mem = _make_pair(tmp_path, seconds=8)
    project_id, ref_id, mem_id = _seed(client, ref, mem)
    group = _create_group(client, project_id, ref_id, mem_id)
    state = client.app.state.core
    sync = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"] + "/sync",
        json={"generate": True}, headers=_ui(client)).json()
    with state.db.connection() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (sync["job_id"],)).fetchone()
    asyncio.run(state.angle_sync.run_sync_job(row, asyncio.Event()))

    client.post(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"]
        + "/angles/" + mem_id + "/offset",
        json={"offset_us": 111_000}, headers=_ui(client))

    with state.db.connection() as db:
        db.execute("UPDATE assets SET fingerprint='sha256:changed2' WHERE id=?", (mem_id,))
    entry = _entry(client.get(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"],
        headers=_ui(client)).json(), mem_id)
    # manual 行 stale ⇒ 回退 auto（auto 也因指纹变了而 stale ⇒ 整体仍是 stale，
    # 但不得把 stale 的 manual 值当作有效结果返回）
    assert entry["status"] == "stale"
    assert entry["source"] == "auto", entry



def test_group_reference_blocks_asset_delete_and_group_delete_unblocks(
    client: TestClient, tmp_path: Path
) -> None:
    """C3①（验证门 M2）：机位组引用素材 ⇒ 删除给出**机位文案**；删组后即可删除素材，
    且同步行随组 CASCADE 清理。"""
    _require_ffmpeg()
    ref, mem = _make_pair(tmp_path, seconds=5)
    project_id, ref_id, mem_id = _seed(client, ref, mem)
    group = _create_group(client, project_id, ref_id, mem_id)

    blocked = client.delete("/api/v1/assets/" + mem_id, headers=_ui(client))
    assert blocked.status_code >= 400
    assert "机位组" in blocked.text, blocked.text

    deleted = client.delete(
        "/api/v1/projects/" + project_id + "/angle-groups/" + group["group_id"],
        headers=_ui(client))
    assert deleted.status_code == 200 and deleted.json()["deleted"] is True

    state = client.app.state.core
    with state.db.connection() as db:
        remaining = db.execute(
            "SELECT COUNT(*) FROM angle_syncs WHERE group_id=?", (group["group_id"],)
        ).fetchone()[0]
    assert remaining == 0, "同步行必须随组 CASCADE 清理"

    after = client.delete("/api/v1/assets/" + mem_id, headers=_ui(client))
    assert after.status_code == 200, after.text


def test_non_video_asset_rejected(client: TestClient, tmp_path: Path) -> None:
    _require_ffmpeg()
    ref, mem = _make_pair(tmp_path, seconds=5)
    project_id, ref_id, _ = _seed(client, ref, mem)
    audio_asset = _import(client, project_id, tmp_path / "audio.wav", kind="audio")
    response = client.post(
        "/api/v1/projects/" + project_id + "/angle-groups",
        json={"name": "x", "reference_asset_id": ref_id, "member_asset_ids": [audio_asset]},
        headers=_ui(client),
    )
    assert response.status_code >= 400
    assert "ANGLE_GROUP_UNSUPPORTED" in response.text
