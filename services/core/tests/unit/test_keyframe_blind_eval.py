"""W3.3 S5b：盲评包与统计（A9）。

验收口径是「可独立运行 + 口径诚实」，不是分数高低（预登记 §7）。
因此本文件验的是：
  1. 抽样规则与预登记一致（5 素材 × 前 3 帧）
  2. 包内**不含**会破坏盲评的信息（素材名/模型名/分数）
  3. 统计脚本能独立运行，并**强制同报样本量限制**
  4. 未勾选/多勾选被如实标出，不被静默计入
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

# 本文件在 services/core/tests/unit/ ⇒ 向上 4 级才是仓库根。
# 用 __file__ 推导而非 cwd（P66 教训：不要引入「必须从某目录运行」的隐藏假设）。
ROOT = Path(__file__).resolve().parents[4]


def _load(name: str, rel: str):
    path = ROOT / "tools/quality_eval" / rel
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def pack():
    return _load("build_keyframe_blind_pack", "build_keyframe_blind_pack.py")


@pytest.fixture(scope="module")
def summ():
    return _load("summarize_keyframe_blind", "summarize_keyframe_blind.py")


def _rows() -> list[dict]:
    rows = []
    index = 0
    for asset in ("asset_c", "asset_a", "asset_b"):
        for frame_index in (2, 0, 1):  # 刻意乱序，验证排序
            index += 1
            rows.append({
                "preview_id": "kp_1",
                "asset_id": asset,
                "frame_index": frame_index,
                "timestamp_us": frame_index * 1_000_000,
                "labels": ["人物"],
                "notes": None,
            })
    return rows


def test_sampling_follows_preregistration(pack) -> None:
    """预登记 §1：素材按 id 升序取前 5，每个取其前 3 帧。"""
    picked = pack.sample_frames(_rows())
    assert len(picked) == 9  # 3 素材 × 3 帧
    # 素材按 id 升序：asset_a, asset_b, asset_c
    assert [p["asset_id"] for p in picked[:3]] == ["asset_a"] * 3
    # 帧按 frame_index 升序：0, 1, 2
    assert [p["frame_index"] for p in picked[:3]] == [0, 1, 2]


def test_sampling_caps_assets_and_frames(pack) -> None:
    rows = []
    for a in range(8):
        for f in range(10):
            rows.append({
                "preview_id": "kp", "asset_id": f"asset_{a:02d}", "frame_index": f,
                "timestamp_us": f, "labels": [], "notes": None,
            })
    picked = pack.sample_frames(rows)
    assert len(picked) == 5 * 3
    assert {p["asset_id"] for p in picked} == {f"asset_{a:02d}" for a in range(5)}


def test_blind_label_hides_provenance(pack) -> None:
    label = pack.blind_label(7)
    assert label == "sample-07"
    assert "asset" not in label


def test_score_sheet_has_no_leaking_fields(pack) -> None:
    """盲评前提：评分表里不出现素材名、预览 ID、时间戳。"""
    samples = pack.sample_frames(_rows())
    enriched = [{**s, "sample_id": pack.blind_label(i)} for i, s in enumerate(samples, 1)]
    sheet = pack.build_score_sheet(enriched)
    assert "asset_" not in sheet
    assert "kp_1" not in sheet
    assert "人物" in sheet  # 标签本身必须在（评分对象）


def test_assemble_writes_frames_sheet_and_manifest(pack, tmp_path: Path) -> None:
    rows = pack.sample_frames(_rows())
    for i, row in enumerate(rows):
        row["preview_id"] = f"kp_{i}"

    def loader(preview_id: str, frame_index: int) -> bytes:
        return b"\xff\xd8" + preview_id.encode() + b"\xff\xd9"

    result = pack.assemble(rows, loader, tmp_path)
    assert result["sample_count"] == 9
    assert (tmp_path / "score-sheet.md").exists()
    assert (tmp_path / "manifest.json").exists()
    frames = sorted((tmp_path / "frames").iterdir())
    assert len(frames) == 9
    assert frames[0].name == "sample-01.jpg"


def test_manifest_maps_back_to_source(pack, tmp_path: Path) -> None:
    """manifest 是评分后才看的映射；必须能还原到素材与帧。"""
    rows = pack.sample_frames(_rows())
    for i, row in enumerate(rows):
        row["preview_id"] = f"kp_{i}"
    pack.assemble(rows, lambda p, f: b"x", tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["samples"]) == 9
    assert manifest["samples"][0]["sample_id"] == "sample-01"
    assert "asset_id" in manifest["samples"][0]
    assert "评分完成前不要查看" in manifest["note"]


def test_summarize_counts_tiers(summ) -> None:
    sheet = "\n".join([
        "| sample-01 | 人物 | | ✓ | ☐ | ☐ |",
        "| sample-02 | 动物 | | ✓ | ☐ | ☐ |",
        "| sample-03 | 建筑 | | ☐ | ✓ | ☐ |",
        "| sample-04 | 食物 | | ☐ | ☐ | ✓ |",
    ])
    rows, problems = summ.parse_sheet(sheet)
    result = summ.summarize(rows, problems)
    assert result["counts"] == {"合理": 2, "部分合理": 1, "不合理": 1}
    assert result["agree_rate"] == 0.5


def test_unscored_rows_are_flagged_not_counted(summ) -> None:
    """未勾选不得静默计入分母——那会人为压低或抬高合理率。"""
    sheet = "\n".join([
        "| sample-01 | 人物 | | ✓ | ☐ | ☐ |",
        "| sample-02 | 动物 | | ☐ | ☐ | ☐ |",
    ])
    rows, problems = summ.parse_sheet(sheet)
    assert problems == ["sample-02"]
    assert summ.summarize(rows, problems)["sample_count"] == 1


def test_multi_checked_rows_are_flagged(summ) -> None:
    sheet = "| sample-01 | 人物 | | ✓ | ✓ | ☐ |"
    rows, problems = summ.parse_sheet(sheet)
    assert problems == ["sample-01"]
    assert rows == []


def test_summary_forces_sample_size_caveat(summ) -> None:
    """预登记 §6：结论上限必须与结果同报，不能只写在文档里。"""
    rows, problems = summ.parse_sheet("| sample-01 | 人物 | | ✓ | ☐ | ☐ |")
    caveat = summ.summarize(rows, problems)["caveat"]
    assert "±25" in caveat
    assert "不得表述为" in caveat


def test_preregistration_exists_before_results() -> None:
    """A9 的硬要求：判据先于看数入库。"""
    prereg = ROOT / "evidence/2026-10-21-w33-keyframe-blind-eval/PRE_REGISTRATION.md"
    assert prereg.exists()
    text = prereg.read_text(encoding="utf-8")
    assert "先定死" in text or "预登记" in text
    assert "±25" in text
