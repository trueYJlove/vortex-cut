"""E8 响度归一 端到端（真实素材 + 真实 ffmpeg + 真实三段式提案链）。

链路：导入素材 → 建时间线 → prepare（真实 EBU R128 测量）→ propose（落库）
→ apply（写正式 Revision）→ 文档里的 gain_db 真的变了。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings

FFMPEG = Path(__file__).resolve().parents[4] / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
FFPROBE = FFMPEG.parent / "ffprobe.exe"

# 440Hz 单声道正弦的实测口径（真实 ffmpeg 实测值，非推算）：
#   LUFS ≈ 20*log10(amplitude) - 3.7
QUIET_AMPLITUDE = 0.08   # 实测约 -25.6 LUFS ⇒ 需要 +9.6 dB（在 +12 上限内）
LOUD_AMPLITUDE = 0.5     # 实测约 -9.6 LUFS  ⇒ 需要 -6.4 dB
# 低于 -28 LUFS 就需要 >+12 dB，超出契约上限 ⇒ 用来验证 cap 分支的端到端行为。
TOO_QUIET_AMPLITUDE = 0.02  # 实测约 -37.7 LUFS ⇒ 需要 +21.7 dB（必然 cap 命中）


def _require_ffmpeg() -> None:
    if not FFMPEG.is_file() or not FFPROBE.is_file():
        pytest.skip("bundled ffmpeg/ffprobe unavailable")


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-e8")
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
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-e8"})
    return {"Authorization": "Bearer " + response.json()["token"]}


ADMIN = {"Authorization": "Bearer admin-e8"}


def _make_clip(tmp_path: Path, name: str, amplitude: float, seconds: float = 4.0) -> Path:
    """视频（含音轨）：黑色画面 + 指定振幅 440Hz 正弦。"""
    media = tmp_path / f"{name}.mp4"
    subprocess.run(
        [
            str(FFMPEG), "-hide_banner", "-nostdin", "-y",
            "-f", "lavfi", "-i", f"color=c=black:s=320x180:r=15:d={seconds}",
            "-f", "lavfi", "-i",
            f"aevalsrc={amplitude}*sin(2*PI*440*t):s=48000:d={seconds}",
            "-map", "0:v", "-map", "1:a",
            "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(media),
        ],
        check=True, capture_output=True,
    )
    return media


def _import(client: TestClient, project_id: str, media: Path) -> str:
    grant = client.post(
        "/api/v1/internal/file-grants", json={"path": str(media)}, headers=ADMIN).json()
    asset = client.post(
        "/api/v1/projects/" + project_id + "/assets",
        json={"grant_id": grant["grant_id"], "kind": "video"}, headers=_ui(client)).json()
    return asset["asset_id"]


def _seed(client: TestClient, tmp_path: Path) -> tuple[str, dict, dict]:
    project = client.post("/api/v1/projects", json={"name": "响度归一"}, headers=_ui(client)).json()
    project_id = project["project_id"]
    quiet_id = _import(client, project_id, _make_clip(tmp_path, "quiet", QUIET_AMPLITUDE))
    loud_id = _import(client, project_id, _make_clip(tmp_path, "loud", LOUD_AMPLITUDE))
    timeline = client.post(
        "/api/v1/projects/" + project_id + "/timelines",
        json={
            "schema_version": 1,
            "source": {"kind": "empty"},
            "default_layout": "blurred_background",
            "caption_preset_id": "default-bottom",
        },
        headers=_ui(client),
    ).json()
    revision_id = timeline["current_revision"]["timeline_revision_id"]
    base = {"schema_version": 1, "base_revision_id": revision_id, "summary": "放入两段素材"}
    for index, asset_id in enumerate((quiet_id, loud_id)):
        base["operations"] = [{
            "op": "insert_asset_clip",
            "asset_id": asset_id,
            "at_index": index,
            "source_start_us": 0,
            "source_end_us": 3_000_000,
        }]
        state = client.post(
            "/api/v1/projects/" + project_id + "/timeline/patches", json=base,
            headers=_ui(client))
        assert state.status_code == 200, state.text
        base["base_revision_id"] = state.json()["current_revision"]["timeline_revision_id"]
    document = state.json()["current_revision"]["document"]
    clips = {clip["asset_id"]: clip for clip in document["clips"]}
    return project_id, clips[quiet_id], clips[loud_id]


def test_prepare_measures_real_lufs_and_proposes_gains(client: TestClient, tmp_path: Path) -> None:
    _require_ffmpeg()
    project_id, quiet, loud = _seed(client, tmp_path)
    revision_id = client.get(
        "/api/v1/projects/" + project_id + "/timeline", headers=_ui(client)
    ).json()["current_revision"]["timeline_revision_id"]

    preview = client.post(
        "/api/v1/projects/" + project_id + "/editing-grammar/prepare",
        json={"base_revision_id": revision_id, "planner": "unify_loudness", "params": {}},
        headers=_ui(client),
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["planner"] == "unify_loudness"
    assert body["noop"] is False
    assert body["operations_count"] == 2

    rationale = body["rationale"]
    assert rationale["algorithm_version"].startswith("ebu-r128-")
    by_clip = {item["clip_id"]: item for item in rationale["clips"]}
    quiet_decision = by_clip[quiet["clip_id"]]
    loud_decision = by_clip[loud["clip_id"]]
    # 真实测量：安静片段远低于 -16，响片段高于 -16（符号相反的增益）。
    assert quiet_decision["measured_lufs"] == pytest.approx(-25.6, abs=1.5)
    assert loud_decision["measured_lufs"] == pytest.approx(-9.6, abs=1.5)
    quiet_op = next(op for op in body["operations"] if op["clip_id"] == quiet["clip_id"])
    loud_op = next(op for op in body["operations"] if op["clip_id"] == loud["clip_id"])
    assert quiet_op["gain_db"] > 0 > loud_op["gain_db"]
    assert -60 <= loud_op["gain_db"] <= 12 and -60 <= quiet_op["gain_db"] <= 12


def test_apply_actually_writes_gain_db_into_document(client: TestClient, tmp_path: Path) -> None:
    """端到端：apply 之后正式 Revision 里的 gain_db 真的变了（不是只改本地状态）。"""
    _require_ffmpeg()
    project_id, quiet, loud = _seed(client, tmp_path)
    revision_id = client.get(
        "/api/v1/projects/" + project_id + "/timeline", headers=_ui(client)
    ).json()["current_revision"]["timeline_revision_id"]

    proposal = client.post(
        "/api/v1/projects/" + project_id + "/editing-grammar/proposals",
        json={"base_revision_id": revision_id, "planner": "unify_loudness", "params": {}},
        headers=_ui(client),
    ).json()
    assert proposal["patch"]["operations"], proposal
    quiet_op = next(
        op for op in proposal["patch"]["operations"] if op["clip_id"] == quiet["clip_id"]
    )

    applied = client.post(
        "/api/v1/projects/" + project_id
        + "/editing-grammar/proposals/" + proposal["editing_grammar_proposal_id"] + "/apply",
        json={
            "base_revision_id": proposal["base_revision_id"],
            "proposed_document_sha256": proposal["proposed_document_sha256"],
        },
        headers=_ui(client),
    )
    assert applied.status_code == 200, applied.text
    state = applied.json()
    new_document = state["current_revision"]["document"]
    new_quiet = next(c for c in new_document["clips"] if c["clip_id"] == quiet["clip_id"])
    new_loud = next(c for c in new_document["clips"] if c["clip_id"] == loud["clip_id"])

    # apply 前是 0，apply 后是真值（且与新 Revision 一致）。
    old_quiet = next(c for c in _document_of(client, project_id, revision_id)["clips"]
                     if c["clip_id"] == quiet["clip_id"])
    assert old_quiet["audio"]["gain_db"] == 0
    assert new_quiet["audio"]["gain_db"] == quiet_op["gain_db"]
    assert new_quiet["audio"]["gain_db"] != 0
    assert new_loud["audio"]["gain_db"] < 0
    # 生效响度都≈目标（±容差）——这是「一键统一音量」的实质。
    by_clip = {item["clip_id"]: item for item in proposal["rationale"]["clips"]}
    for clip_id in (quiet["clip_id"], loud["clip_id"]):
        assert by_clip[clip_id]["effective_lufs"] + by_clip[clip_id]["delta_db"] == pytest.approx(-16.0, abs=0.01)


def test_replanning_after_apply_is_noop(client: TestClient, tmp_path: Path) -> None:
    """收敛性：采纳后再次规划 ⇒ 全达标 ⇒ noop=True（幂等，不叠加增益）。"""
    _require_ffmpeg()
    project_id, _, _ = _seed(client, tmp_path)
    revision_id = client.get(
        "/api/v1/projects/" + project_id + "/timeline", headers=_ui(client)
    ).json()["current_revision"]["timeline_revision_id"]
    proposal = client.post(
        "/api/v1/projects/" + project_id + "/editing-grammar/proposals",
        json={"base_revision_id": revision_id, "planner": "unify_loudness", "params": {}},
        headers=_ui(client),
    ).json()
    applied = client.post(
        "/api/v1/projects/" + project_id
        + "/editing-grammar/proposals/" + proposal["editing_grammar_proposal_id"] + "/apply",
        json={
            "base_revision_id": proposal["base_revision_id"],
            "proposed_document_sha256": proposal["proposed_document_sha256"],
        },
        headers=_ui(client),
    ).json()
    next_revision = applied["current_revision"]["timeline_revision_id"]

    again = client.post(
        "/api/v1/projects/" + project_id + "/editing-grammar/prepare",
        json={"base_revision_id": next_revision, "planner": "unify_loudness", "params": {}},
        headers=_ui(client),
    ).json()
    # 测量是现测的，重测值与提案时的测量有极小浮动 ⇒ 允许 1 LU 内仍判达标。
    assert again["operations_count"] == 0, again["rationale"]
    assert again["noop"] is True


def test_silent_clip_is_skipped_not_given_gain(client: TestClient, tmp_path: Path) -> None:
    """无音轨片段 ⇒ 跳过并点名，不产 op（绝不当作 0 LUFS 算增益）。"""
    _require_ffmpeg()
    project = client.post("/api/v1/projects", json={"name": "静音"}, headers=_ui(client)).json()
    project_id = project["project_id"]
    silent = tmp_path / "silent.mp4"
    subprocess.run(
        [
            str(FFMPEG), "-hide_banner", "-nostdin", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=320x180:r=15:d=3",
            "-c:v", "mpeg4", str(silent),
        ],
        check=True, capture_output=True,
    )
    asset_id = _import(client, project_id, silent)
    timeline = client.post(
        "/api/v1/projects/" + project_id + "/timelines",
        json={"schema_version": 1, "source": {"kind": "full_asset", "asset_id": asset_id},
              "default_layout": "blurred_background", "caption_preset_id": "default-bottom"},
        headers=_ui(client),
    ).json()
    revision_id = timeline["current_revision"]["timeline_revision_id"]
    preview = client.post(
        "/api/v1/projects/" + project_id + "/editing-grammar/prepare",
        json={"base_revision_id": revision_id, "planner": "unify_loudness", "params": {}},
        headers=_ui(client),
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["operations_count"] == 0
    assert body["noop"] is True
    assert body["rationale"]["skipped"]
    skipped = body["rationale"]["clips"][0]
    assert skipped["reason"] == "MEDIA_NO_AUDIO"
    assert skipped["measured_lufs"] is None


def test_cap_hit_end_to_end_produces_no_misleading_op(
    client: TestClient, tmp_path: Path
) -> None:
    """端到端 cap：太轻的素材需要 +21.7 dB（> +12 上限）⇒ 点名且不写假 op。

    负向对照 1 的端到端版：若实现无条件钳到 +12，这里会多出一条 gain_db=12
    的 op（用户以为已经统一，实际仍差 9.7 dB）。
    """
    _require_ffmpeg()
    project = client.post("/api/v1/projects", json={"name": "上限"}, headers=_ui(client)).json()
    project_id = project["project_id"]
    asset_id = _import(
        client, project_id, _make_clip(tmp_path, "too_quiet", TOO_QUIET_AMPLITUDE)
    )
    timeline = client.post(
        "/api/v1/projects/" + project_id + "/timelines",
        json={"schema_version": 1, "source": {"kind": "full_asset", "asset_id": asset_id},
              "default_layout": "blurred_background", "caption_preset_id": "default-bottom"},
        headers=_ui(client),
    ).json()
    preview = client.post(
        "/api/v1/projects/" + project_id + "/editing-grammar/prepare",
        json={"base_revision_id": timeline["current_revision"]["timeline_revision_id"],
              "planner": "unify_loudness", "params": {}},
        headers=_ui(client),
    ).json()
    assert preview["operations_count"] == 0
    assert preview["noop"] is True
    clip_id = timeline["current_revision"]["document"]["clips"][0]["clip_id"]
    assert preview["rationale"]["unreachable"] == [clip_id]
    decision = preview["rationale"]["clips"][0]
    assert decision["decision"] == "unreachable_cap"
    assert decision["measured_lufs"] < -30
    assert decision["needed_gain_db"] > 12
    assert clip_id in preview["summary"]


def test_planners_list_includes_unify_loudness(client: TestClient, tmp_path: Path) -> None:
    """负向对照 4：从 default_registry() 摘掉注册 ⇒ 本条红。"""
    project = client.post("/api/v1/projects", json={"name": "目录"}, headers=_ui(client)).json()
    page = client.get(
        "/api/v1/projects/" + project["project_id"] + "/editing-grammar/planners",
        headers=_ui(client),
    ).json()
    names = [tool["name"] for tool in page["items"]]
    assert "unify_loudness" in names


def _document_of(client: TestClient, project_id: str, revision_id: str) -> dict:
    return client.get(
        "/api/v1/timeline-revisions/" + revision_id, headers=_ui(client)
    ).json()["document"]
