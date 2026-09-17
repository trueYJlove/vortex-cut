"""M3-0 固定测试工程（冻结方案 §7.2）。

产出固定测试时间线 document JSON（写入证据目录，作为 Gate 证据 e），
在临时 SQLite 中播种 project/assets/timeline_revision，只读调用生产
RenderPlanCompiler 编译渲染计划，并按 §7.2 白名单断言（R11：测试时间线
不得包含子集外语义；投影器遇子集外语义硬失败）。

时间线语义（61s @ 30fps，输出画布 960x540 = authoritative_preview + ratio 169）：
  V1: A(0-20s) --fade 1s--> B(20-45s, speed 0.8x) [空隙 45-46s 黑底填充] C(46-61s, position+opacity 关键帧)
  V2: P1(10-30s, transform x0.7 y0.3 scale0.35 rotate8)   ← 画中画覆盖轨
  V3: P2(35-55s, transform x0.3 y0.7 scale0.28)           ← 画中画覆盖轨
  V4: 效果片段×5（IR 契约 v0.4 蒙版/抠像重入的 P2 留证；窗口互不重叠、
      与 V2/V3 同素材窗错开——不触发 W4 跨轨重叠拆分；字幕帧表之外）：
      ellipse 羽化0.25 (6-10s, P1) / linear 软边0.05 (16-19s, P2) /
      colorkey 键色 140C28 (20-24s, P2) / ellipse 硬边+invert+旋转 (30-35s, P1) /
      rect 硬边+双向旋转 (46-50s, P1)
  C1: 5 条字幕（避开转场区间 19-20s，B2 §4.2 已知偏移帧不入硬门）

用法：python test_project.py <材料目录> <输出目录>
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "core" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import sha256_file  # noqa: E402
from aivs_core.database import Database, json_dumps  # noqa: E402
from aivs_core.rendering.plan import RenderPlanCompiler  # noqa: E402

MATERIALS = ["m3mat_a_1080", "m3mat_b_1080", "m3mat_c_1080", "m3mat_p1_1080", "m3mat_p2_1080"]
US = 1_000_000

# P2 采样帧表（n ↔ PTS n/30）：转场中点/起止±1、黑底填充、关键帧区间非端点、
# PiP 叠加帧、字幕帧、普通帧；转场区间 ∩ 活动字幕 = ∅（§7.2 采样要求）。
CAPTION_FRAMES = [120, 420, 810, 1260, 1590]  # 字幕采样帧（单独口径）
# V4 效果片段采样（v0.4 重入留证）：每片段起/中/末 ±1 帧，覆盖羽化边界内、
# 硬边边界、抠像 blend 渐变带与条纹像素（键色/键色邻域各一）。
#   ellipse 羽化 6-10s → 180-299；linear 16-19s → 480-569；colorkey 20-24s
#   → 600-719（600/601 恰为 V1 转场帧，两效果同帧组合是有意样本）；
#   ellipse 硬边+invert 30-35s → 900-1049（900 与 PiP1 尾采样重叠=多浮层
#   同帧组合）；rect 硬边 46-50s → 1380-1499（叠加在 C 段关键帧主轨上）。
EFFECT_SAMPLE_FRAMES = [
    180, 181, 240, 298, 299,             # ellipse+feather0.25 起中末
    480, 481, 525, 568, 569,             # linear 软边
    600, 601, 660, 718, 719,             # colorkey（含转场同帧）
    900, 901, 975, 1048, 1049,           # ellipse 硬边+invert+rotate
    1381, 1440, 1441, 1498, 1499,        # rect 硬边+rotate（关键帧主轨上）
]
SAMPLE_FRAMES = sorted(set([
    # 转场 fade(1s) 窗口 [19s,20s)：起止±1 帧 + 中点
    569, 570, 571, 585, 599, 600, 601,
    # 黑底填充空隙 [45s,46s)
    1353, 1365,
    # C 段关键帧区间（position 0-10s / opacity fade d=6s）非端点帧 + 端点
    1380, 1395, 1440, 1500, 1560, 1590, 1649,
    # PiP1 [10s,30s] 叠加帧（含首尾邻域）
    330, 450, 750, 899,
    # PiP2 [35s,55s] 叠加帧（含启用边界 1050=35s 首帧）
    1050, 1080, 1200, 1590, 1649,
    # V4 效果片段（v0.4 重入留证）
    *EFFECT_SAMPLE_FRAMES,
    # 字幕帧（单独口径）
    *CAPTION_FRAMES,
    # 普通主轨帧（含首帧；末采样 1799——1829 落入权威端 position-keyframe 超长缺陷的冻结尾部，见报告）
    0, 30, 240, 510, 660, 900, 1000, 1470, 1740, 1799,
]))


def build_document(materials: dict[str, Path]) -> dict:
    def clip(clip_id, track, asset, asset_id, src0, src1, tl0, tl1, layout="fit", **extra):
        base = {
            "clip_id": clip_id, "track_id": track, "order_index": 0,
            "asset_id": asset_id, "asset_kind": "video",
            "source_start_us": src0, "source_end_us": src1,
            "timeline_start_us": tl0, "timeline_end_us": tl1,
            "layout": layout, "audio": {"enabled": False, "gain_db": 0.0},
        }
        base.update(extra)
        return base

    doc = {
        "schema_version": 1,
        "project_id": "m3probe0project",
        "canvas": {"width": 1920, "height": 1080, "fps_num": 30, "fps_den": 1, "background_color": "#000000"},
        "tracks": [
            {"id": "C1", "kind": "text", "locked": False, "hidden": False, "muted": False, "solo": False},
            {"id": "V4", "kind": "video", "locked": False, "hidden": False, "muted": False, "solo": False},
            {"id": "V3", "kind": "video", "locked": False, "hidden": False, "muted": False, "solo": False},
            {"id": "V2", "kind": "video", "locked": False, "hidden": False, "muted": False, "solo": False},
            {"id": "V1", "kind": "video", "locked": False, "hidden": False, "muted": False, "solo": False},
            {"id": "A1", "kind": "audio", "locked": False, "hidden": False, "muted": False, "solo": False},
        ],
        "clips": [
            clip("m3clip_a", "V1", "m3mat_a_1080", "asset_m3_a", 0, 20 * US, 0, 20 * US),
            clip("m3clip_b", "V1", "m3mat_b_1080", "asset_m3_b", 0, 20 * US, 20 * US, 45 * US, speed_milli=800),
            clip("m3clip_c", "V1", "m3mat_c_1080", "asset_m3_c", 0, 15 * US, 46 * US, 61 * US,
                 keyframes={
                     "position": {"frames": [
                         {"t_us": 0, "x": -0.6, "y": 0.0},
                         {"t_us": 5 * US, "x": 0.0, "y": -0.4},
                         {"t_us": 10 * US, "x": 0.6, "y": 0.0},
                     ]},
                     "opacity": {"frames": [
                         {"t_us": 0, "v": 0.0},
                         {"t_us": 6 * US, "v": 1.0},
                     ]},
                 }),
            clip("m3clip_p1", "V2", "m3mat_p1_1080", "asset_m3_p1", 0, 20 * US, 10 * US, 30 * US,
                 transform={"x": 0.7, "y": 0.3, "scale": 0.35, "rotate": 8.0}),
            clip("m3clip_p2", "V3", "m3mat_p2_1080", "asset_m3_p2", 0, 20 * US, 35 * US, 55 * US,
                 transform={"x": 0.3, "y": 0.7, "scale": 0.28, "rotate": 0.0}),
            # V4 效果片段×5（v0.4 蒙版/抠像重入 P2 留证）。素材/窗口与 V2/V3
            # 错开：不触发跨轨重叠拆分（W4 已单独验收）；colorkey 键色取
            # m3mat_p2 底色 RGB(20,12,40)=140C28，blend 渐变带内含条纹像素。
            clip("m3fx_ellipse_feather", "V4", "m3mat_p1_1080", "asset_m3_p1", 2 * US, 6 * US, 6 * US, 10 * US,
                 transform={"x": 0.5, "y": 0.5, "scale": 0.6, "rotate": 0.0},
                 mask={"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.7, "height": 0.7,
                       "rotation": 0.0, "feather": 0.25}),
            clip("m3fx_linear_soft", "V4", "m3mat_p2_1080", "asset_m3_p2", 2 * US, 5 * US, 16 * US, 19 * US,
                 transform={"x": 0.35, "y": 0.35, "scale": 0.5, "rotate": 0.0},
                 mask={"kind": "linear", "x": 0.5, "y": 0.5, "rotation": 30.0, "feather": 0.05}),
            clip("m3fx_colorkey", "V4", "m3mat_p2_1080", "asset_m3_p2", 0, 4 * US, 20 * US, 24 * US,
                 transform={"x": 0.65, "y": 0.6, "scale": 0.5, "rotate": 0.0},
                 keying={"color": "140C28", "similarity": 0.18, "blend": 0.10}),
            clip("m3fx_ellipse_invert", "V4", "m3mat_p1_1080", "asset_m3_p1", 0, 5 * US, 30 * US, 35 * US,
                 transform={"x": 0.4, "y": 0.45, "scale": 0.55, "rotate": 12.0},
                 mask={"kind": "ellipse", "x": 0.4, "y": 0.5, "width": 0.6, "height": 0.6,
                       "rotation": 20.0, "feather": 0.0, "invert": True}),
            clip("m3fx_rect_hard", "V4", "m3mat_p1_1080", "asset_m3_p1", 0, 4 * US, 46 * US, 50 * US,
                 transform={"x": 0.6, "y": 0.5, "scale": 0.5, "rotate": -15.0},
                 mask={"kind": "rect", "x": 0.5, "y": 0.5, "width": 0.6, "height": 0.5,
                       "rotation": 0.0, "feather": 0.0}),
        ],
        "captions": [
            {"caption_id": f"m3cap_{i:02d}", "track_id": "C1", "source_clip_id": None,
             "start_us": start, "end_us": end, "text": text,
             "preset_id": "default-bottom", "origin": "user", "edited": True, "source_segment_ids": []}
            for i, (start, end, text) in enumerate([
                (2 * US, 6 * US, "低帧率合成探针测试字幕一"),
                (12 * US, 16 * US, "第二段字幕在转场之前结束"),
                (25 * US, 29 * US, "转场之后 B 段字幕三"),
                (40 * US, 44 * US, "画中画与字幕同时出现四"),
                (50 * US, 56 * US, "关键帧运动区间内末段字幕五"),
            ], start=1)
        ],
        "transitions": [
            {"transition_id": "m3tr_a", "after_clip_id": "m3clip_a", "kind": "fade", "duration_us": 1 * US},
        ],
        "provenance": {"created_by": "user", "source_transcript_ids": []},
    }
    return doc


def assert_whitelist(document: dict) -> None:
    """R11：测试时间线构建时断言不含排除语义。

    v0.4 起 mask/keying 允许出现在覆盖轨（IR 契约重入），主轨（V1）仍禁止
    （权威端不消费）；关键帧仍只配 V1 主轨。
    """
    for item in document["clips"]:
        if item.get("mask") is not None:
            assert item["track_id"] != "V1", f"{item['clip_id']}: 主轨 mask 不在 P2 子集"
        if item.get("keying") is not None:
            assert item["track_id"] != "V1", f"{item['clip_id']}: 主轨 keying 不在 P2 子集"
        assert item.get("reframe") is None, f"{item['clip_id']}: reframe 不在 P2 子集"
        assert not item.get("reverse_playback"), f"{item['clip_id']}: reverse 不在 P2 实测子集"
        kf = item.get("keyframes")
        if kf:
            assert item["track_id"] == "V1", f"{item['clip_id']}: 关键帧只允许 V1 主轨（权威端覆盖轨链路不叠加）"
            allowed = {"position", "opacity"}
            assert set(kf) <= allowed, f"{item['clip_id']}: 关键帧属性 {set(kf)} 超出实测子集 {allowed}"
        for item_other in document["clips"]:
            assert "rendition" not in str(item_other), "rendition 快照不在此路径"
    for transition in document["transitions"]:
        assert transition["kind"] in ("fade", "fadeblack"), f"转场 {transition['kind']} 不在 P2 实测子集"


def seed_and_compile(asset_paths: dict[str, Path], document: dict, mode="authoritative_preview", output_ratio="169") -> dict:
    """临时 SQLite 播种 → 只读调用生产 RenderPlanCompiler。

    asset_paths: asset_id → 素材文件路径（与 document.clips 引用一致）。
    """
    project_id = document["project_id"]
    with tempfile.TemporaryDirectory(prefix="m3probe_db_") as tmp:
        database = Database(Path(tmp) / "probe.sqlite3")
        database.initialize()
        with database.connection() as db:
            db.execute(
                "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
                "root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (project_id, "M3-0 固定测试工程", "active", json_dumps(document["canvas"]),
                 "m3rev0", str(Path(tmp)), "m3probe", "2026-09-05T00:00:00Z", "2026-09-05T00:00:00Z", "2026-09-05T00:00:00Z"),
            )
            for asset_id, path in asset_paths.items():
                media_info = {
                    "duration_us": 0,  # 编译仅读 duration_us 兜底与 audio_streams
                    "audio_streams": [],
                    "video_streams": [{"width": 1920, "height": 1080, "sample_aspect_ratio": "1:1"}],
                }
                db.execute(
                    "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,"
                    "modified_at,availability,media_info_json,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (asset_id, project_id, "video", "external", path.name,
                     sha256_file(path), path.stat().st_size, None, "available",
                     json_dumps(media_info), "2026-09-05T00:00:00Z", "2026-09-05T00:00:00Z"),
                )
            db.execute(
                "INSERT INTO timeline_revisions(id,project_id,parent_revision_id,schema_version,"
                "document_json,document_sha256,summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                ("m3rev0", project_id, None, 1, json_dumps(document),
                 sha256_file(Path(__file__)), "M3-0 固定测试时间线", "user", "2026-09-05T00:00:00Z"),
            )
        plan = RenderPlanCompiler(database).compile(
            project_id, "m3rev0", mode, output_ratio=output_ratio)
    return plan


def main() -> None:
    material_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("evidence/m3_0/materials")
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("evidence/m3_0/p2")
    out_dir.mkdir(parents=True, exist_ok=True)
    materials = {name: material_dir / f"{name}.mp4" for name in MATERIALS}
    missing = [str(path) for path in materials.values() if not path.is_file()]
    if missing:
        raise SystemExit(f"缺少素材（先运行 make_materials.py）：{missing}")
    document = build_document(materials)
    assert_whitelist(document)
    asset_paths = {
        "asset_m3_a": materials["m3mat_a_1080"],
        "asset_m3_b": materials["m3mat_b_1080"],
        "asset_m3_c": materials["m3mat_c_1080"],
        "asset_m3_p1": materials["m3mat_p1_1080"],
        "asset_m3_p2": materials["m3mat_p2_1080"],
    }
    plan = seed_and_compile(asset_paths, document)
    (out_dir / "document.json").write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "sample_frames.json").write_text(json.dumps(
        {"sample_frames": SAMPLE_FRAMES, "caption_frames": CAPTION_FRAMES}, indent=1), encoding="utf-8")
    (out_dir / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ok] document.json / plan.json → {out_dir}")
    print(f"     content_fingerprint={plan['content_fingerprint']}")
    print(f"     output={plan['output']['width']}x{plan['output']['height']} segments={len(plan['segments'])}")


if __name__ == "__main__":
    main()
