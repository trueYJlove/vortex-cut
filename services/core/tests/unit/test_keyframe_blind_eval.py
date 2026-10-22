"""W3.3 S5b：盲评包与统计（A9）。

验收口径是「可独立运行 + 口径诚实」，不是分数高低（预登记 §7）。
因此本文件验的是：
  1. 抽样规则与预登记一致（5 素材 × 前 3 帧）
  2. 包内**不含**会破坏盲评的信息（素材名/模型名/分数）
  3. 统计脚本能独立运行，并**强制同报样本量限制**
  4. 未勾选/多勾选被如实标出，不被静默计入
"""
from __future__ import annotations

import asyncio
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


# ─────────────────────────────────────────────────────────────────────────────
# S5b 收口：main() 必须真能产包，且 sha256 自证必须能拦住「另一张图」。
#
# 上一轮 STATUS P178 声称「真实产出已验证」，而 main() 当时只是 print 后
# return 0，assemble() 只被内存字典调用过 ⇒ 没有代码路径能从真实素材出包。
# 下列用例把三件事钉死：
#   1. CLI 端到端（真实 ffmpeg + 真实 mp4）必须产出 frames/ + 两张表；
#   2. 重抽字节与 frames_json 记录的 payload_sha256 不一致时，该帧必须被
#      点名排除且**不写进 frames/**（负向对照：删掉那道比对即红）；
#   3. main() 若退回 print-only，回归锁用例必红。
# ─────────────────────────────────────────────────────────────────────────────

FFMPEG = ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
SOURCE_MP4 = ROOT / "test-assets/test-faststart.mp4"


def _seed_tagged_world(db_path: Path, *, frames: int = 3) -> dict:
    """建一个**真实落库**的世界：项目 / 素材 / Provider / 预览 / 生成 / 标签行。

    预览行的 frames_json 由**真实 ffmpeg 编码**得到（不是编造哈希），
    端到端用例里的 sha256 自证因此是真的在证。
    """
    import asyncio
    import hashlib

    from aivs_core.database import Database, json_dumps, utc_now
    from aivs_core.media.keyframe_encode import encode_frames

    db = Database(db_path)
    db.initialize()
    now = utc_now()
    project_id, asset_id, provider_id = "proj_1", "asset_b", "prov_1"
    preview_id, generation_id = "prev_1", "gen_1"
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (project_id, "P", "active", "{}", None, "C:/tmp/p", "p", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,"
            "fingerprint,size_bytes,availability,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (asset_id, project_id, "video", "external", "a.mp4",
             "fp_1", SOURCE_MP4.stat().st_size, "available", now, now),
        )
        conn.execute(
            "INSERT INTO asset_locations (asset_id,uri,last_verified_at) VALUES (?,?,?)",
            (asset_id, SOURCE_MP4.as_uri(), now),
        )
        conn.execute(
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at,vision_capability_status,"
            "vision_capability_tested_at,vision_response_adapter_id,"
            "vision_probe_protocol_version,vision_capability_failure_code,"
            "vision_capability_probe_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (provider_id, "openai_compatible_text", "P", "https://x", "m", 1, now, now,
             "supported", now, "openai_chat_completions_image_url_v1", "1",
             None, "sha256:" + "0" * 64),
        )

    plan = [(200_000 + i * 400_000, "scene_cut") for i in range(frames)]
    encoded = asyncio.run(encode_frames(FFMPEG, SOURCE_MP4, plan))
    metas = [
        {
            "frame_index": i,
            "timestamp_us": frame.timestamp_us,
            "source_reason": "scene_cut",
            "payload_sha256": frame.payload_sha256,
            "payload_bytes": len(frame.payload_bytes),
        }
        for i, frame in enumerate(encoded)
    ]
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO keyframe_egress_previews (id,project_id,asset_id,"
            "provider_config_id,source_fingerprint,model_id,payload_sha256,"
            "frames_json,excluded_frames_json,sampling_mode,covered_scene_cuts,"
            "total_frame_bytes,expires_at,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (preview_id, project_id, asset_id, provider_id, "fp_1", "m",
             "sha256:" + "1" * 64, json_dumps(metas), "[]", "scene_cut",
             len(metas), sum(len(f.payload_bytes) for f in encoded),
             "2099-01-01T00:00:00.000Z", now, now),
        )
        conn.execute(
            "INSERT INTO keyframe_egress_consents VALUES (?,?,?,?,?)",
            ("consent_1", preview_id, "sha256:" + "1" * 64, now, now),
        )
        conn.execute(
            "INSERT INTO keyframe_generations VALUES (?,?,?,?,?,?,?,?,?,?)",
            (generation_id, project_id, preview_id, "consent_1", provider_id,
             "fp_1", "succeeded", "sha256:" + "1" * 64, now, now),
        )
        for i, meta in enumerate(metas):
            conn.execute(
                "INSERT INTO asset_frame_tags (id,asset_id,source_fingerprint,"
                "algorithm_version,vocabulary_id,vocabulary_version,status,reason,"
                "frame_index,timestamp_us,labels_json,notes,provider_config_id,"
                "generation_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"tag_{i}", asset_id, "fp_1", 1, "vocab", 1, "ready", None,
                 meta["frame_index"], meta["timestamp_us"],
                 json_dumps(["人物"] if i % 2 == 0 else []),
                 None if i % 2 == 0 else "画面无可匹配类目",
                 provider_id, generation_id, now, now),
            )
    return {
        "db_path": db_path,
        "asset_id": asset_id,
        "preview_id": preview_id,
        "generation_id": generation_id,
        "metas": metas,
        "sha256": hashlib.sha256,
    }


pack_requires_ffmpeg = pytest.mark.skipif(
    not (FFMPEG.exists() and SOURCE_MP4.exists()),
    reason="随包 ffmpeg 或测试素材不在预期位置",
)


@pack_requires_ffmpeg
def test_cli_end_to_end_produces_real_pack(pack, tmp_path: Path) -> None:
    """CLI 真的产出包：frames/ 下 N 张 jpg + 评分表 + manifest。

    这条用例是「main() 是空壳」的直接反例：它调用的是 main([...])，
    断言的是磁盘上的产物，不是内存里的 dict。
    """
    world = _seed_tagged_world(tmp_path / "app.db")
    out = tmp_path / "pack"
    code = pack.main(["--db", str(world["db_path"]), "--out", str(out),
                      "--ffmpeg", str(FFMPEG)])
    assert code == 0

    frames = sorted((out / "frames").iterdir())
    assert len(frames) == 3
    assert [f.name for f in frames] == [
        "sample-01.jpg", "sample-02.jpg", "sample-03.jpg",
    ]
    # 写进去的必须是真的 JPEG（真实 ffmpeg 编码 + 自证通过），不是占位字节。
    assert frames[0].read_bytes()[:2] == b"\xff\xd8"
    assert (out / "score-sheet.md").exists()
    assert (out / "manifest.json").exists()
    assert (out / "summarize.py").exists()


@pack_requires_ffmpeg
def test_cli_reencode_matches_recorded_sha256(pack, tmp_path: Path) -> None:
    """自证的正向面：写进包的字节必须与 frames_json 记录的 sha256 逐帧一致。"""
    world = _seed_tagged_world(tmp_path / "app.db")
    out = tmp_path / "pack"
    assert pack.main(["--db", str(world["db_path"]), "--out", str(out),
                      "--ffmpeg", str(FFMPEG)]) == 0
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["excluded_count"] == 0, manifest["excluded"]
    for sample in manifest["samples"]:
        data = (out / "frames" / (sample["sample_id"] + ".jpg")).read_bytes()
        expected = next(
            m for m in world["metas"] if m["timestamp_us"] == sample["timestamp_us"]
        )
        assert world["sha256"](data).hexdigest() == expected["payload_sha256"]


@pack_requires_ffmpeg
def test_mismatched_reencode_is_excluded_and_not_written(pack, tmp_path: Path) -> None:
    """sha256 自证有效：重抽与记录不一致 ⇒ 该帧点名排除且**不写进 frames/**。

    **负向对照**：把 build_pack 里那道 `actual != expected` 比对去掉后本用例
    转红（实跑输出见交付报告）。只篡改**第二帧**，因此若实现是整包一刀切
    或静默跳过，断言同样会红。
    """
    world = _seed_tagged_world(tmp_path / "app.db")
    out = tmp_path / "pack"
    real_encode = pack._encode_one_frame
    victim = world["metas"][1]["timestamp_us"]

    async def liar(ffmpeg: Path, path: Path, timestamp_us: int) -> bytes:
        data = await real_encode(ffmpeg, path, timestamp_us)
        return b"\xff\xd8other-image\xff\xd9" if timestamp_us == victim else data

    result = asyncio.run(
        pack.build_pack(world["db_path"], out, FFMPEG, encoder=liar)
    )

    assert result["sampled"] == 3
    assert result["sample_count"] == 2
    assert [f["frame_index"] for f in result["failures"]] == [1]
    failure = result["failures"][0]
    assert failure["reason"] == pack.REASON_SHA_MISMATCH
    assert failure["asset_id"] == world["asset_id"]
    assert failure["expected_sha256"] != failure["actual_sha256"]
    # 被排除的帧不得出现在 frames/ 里（编号连续重排，不留空洞）。
    assert [f.name for f in sorted((out / "frames").iterdir())] == [
        "sample-01.jpg", "sample-02.jpg",
    ]
    # 留下来的每一张都必须真的通过过自证。
    good = world["metas"][0]
    assert world["sha256"]((out / "frames/sample-01.jpg").read_bytes()).hexdigest()
    assert (world["sha256"]((out / "frames/sample-01.jpg").read_bytes()).hexdigest()
            == good["payload_sha256"])
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["excluded_count"] == 1
    assert manifest["excluded"][0]["reason"] == pack.REASON_SHA_MISMATCH
    assert manifest["excluded"][0]["frame_index"] == 1


@pack_requires_ffmpeg
def test_missing_asset_is_reported_not_silently_skipped(pack, tmp_path: Path) -> None:
    """素材不在盘上 ⇒ 如实计入失败（预登记 §1「排除项要在报告中列出」）。"""
    import sqlite3

    world = _seed_tagged_world(tmp_path / "app.db")
    with sqlite3.connect(world["db_path"]) as conn:
        conn.execute(
            "UPDATE asset_locations SET uri=? WHERE asset_id=?",
            ((tmp_path / "gone.mp4").as_uri(), world["asset_id"]),
        )

    out = tmp_path / "pack"
    code = pack.main(["--db", str(world["db_path"]), "--out", str(out),
                      "--ffmpeg", str(FFMPEG)])
    assert code == 1  # 一帧都没入包：不能当成成功
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["excluded_count"] == 3
    assert {f["reason"] for f in manifest["excluded"]} == {pack.REASON_ASSET_MISSING}


def test_main_requires_db_and_never_fakes_success(pack, tmp_path: Path) -> None:
    """空壳回归锁：main() 必须接受 --db 并**真的**尝试建包。

    上一轮 P178 的假声明就是 main() 只 print 后 return 0。若它再退回
    print-only，下面的第二条断言会红：没有标签行时必须返回非 0，
    而不是假装成功。第一条锁住「--db 是必填参数」这一契约。
    """
    from aivs_core.database import Database

    with pytest.raises(SystemExit):
        pack.main(["--out", str(tmp_path / "pack")])  # 缺 --db ⇒ argparse 退出

    empty = tmp_path / "empty.db"
    Database(empty).initialize()
    out = tmp_path / "pack"
    before = empty.read_bytes()
    code = pack.main(["--db", str(empty), "--out", str(out), "--ffmpeg", str(FFMPEG)])
    assert code == 1
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["samples"] == []
    # 输出目录**确实有文件**——print-only 的空壳在这里会留下空目录。
    assert sorted(p.name for p in out.iterdir()) == [
        "frames", "manifest.json", "score-sheet.md", "summarize.py",
    ]
    # 建包只读：源库字节不得被建包改动。
    assert empty.read_bytes() == before
# ── 同一物理内容只计一次（2026-10-22 收口补充） ──


def _rows_with_duplicate() -> list[dict]:
    """两个 asset 行指向同一物理文件（真实库里实测存在的情形）。

    asset_a 与 asset_b 指纹相同 ⇒ 只应有一个进包；asset_c 指纹不同 ⇒ 照常进。
    """
    rows = []
    for asset, fingerprint in (
        ("asset_a", "fp_same"), ("asset_b", "fp_same"), ("asset_c", "fp_other"),
    ):
        for frame_index in (0, 1, 2):
            rows.append({
                "preview_id": f"kp_{asset}",
                "asset_id": asset,
                "asset_fingerprint": fingerprint,
                "frame_index": frame_index,
                "timestamp_us": frame_index * 1_000_000,
                "labels": ["人物"],
                "notes": None,
            })
    return rows


def test_same_fingerprint_counts_once(pack) -> None:
    """去重后只剩 2 个素材 × 3 帧；按 id 升序保留 asset_a（不是 asset_b）。"""
    picked = pack.sample_frames(_rows_with_duplicate())
    assert len(picked) == 6
    assert {row["asset_id"] for row in picked} == {"asset_a", "asset_c"}


def test_duplicate_assets_are_reported_not_silently_dropped(pack) -> None:
    """被跳过的素材必须可在报告里点名，否则「12 张里有重复」根本看不见。"""
    duplicates = pack.duplicate_assets(_rows_with_duplicate())
    assert len(duplicates) == 1
    assert duplicates[0]["asset_id"] == "asset_b"
    assert duplicates[0]["duplicate_of"] == "asset_a"
    assert duplicates[0]["frames_skipped"] == 3
    assert duplicates[0]["reason"] == pack.REASON_DUPLICATE_CONTENT


def test_rows_without_fingerprint_are_not_deduplicated(pack) -> None:
    """缺指纹时**不得**把它们当成同一个（未知不等于相同）。"""
    picked = pack.sample_frames(_rows())  # 既有 fixture 无 asset_fingerprint
    assert len(picked) == 9
    assert pack.duplicate_assets(_rows()) == []
