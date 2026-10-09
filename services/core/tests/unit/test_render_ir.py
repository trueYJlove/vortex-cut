from __future__ import annotations

import pytest

from aivs_core.projects import DomainError
from aivs_core.rendering.ir import project_preview_ir, resolved_caption_styles

US = 1_000_000


def _geometry(width: int = 1920, height: int = 1080) -> dict:
    return {"video_streams": [{"width": width, "height": height, "sample_aspect_ratio": "1:1"}]}


def _segment(clip_id: str, src0: int, src1: int, tl0: int, tl1: int, *, asset_idx: int = 0, **extra) -> dict:
    base = {"clip_id": clip_id, "track_id": "V1", "asset_kind": "video",
            "asset_id": f"asset{asset_idx}", "input_id": f"I{asset_idx}",
            "source_start_us": src0, "source_end_us": src1,
            "timeline_start_us": tl0, "timeline_end_us": tl1,
            "layout": "fit", "audio_enabled": False, "gain_db": 0.0}
    base.update(extra)
    return base


def _plan(segments: list[dict], *, transitions: list[dict] | None = None,
          captions: list[dict] | None = None) -> dict:
    return {
        "schema_version": 1, "compiler_version": "render-plan-v1",
        "content_fingerprint": "sha256:test", "mode": "authoritative_preview",
        "timeline_revision_id": "rev1", "canvas_background_color": "#000000",
        "output": {"profile_id": "preview-169-v1", "width": 960, "height": 540,
                   "fps_num": 30, "fps_den": 1, "video_codec": "h264",
                   "audio_codec": "aac", "audio_sample_rate": 48000, "pixel_format": "yuv420p"},
        "inputs": [{"input_id": f"I{i}", "asset_id": f"asset{i}", "asset_kind": "video",
                    "fingerprint": f"fp{i}", "duration_us": 30_000_000, "has_audio": False}
                   for i in sorted({int(s["input_id"][1:]) for s in segments})],
        "segments": segments,
        "captions": {"format": "ass", "preset_version": 1, "font_bundle_version": 1,
                     "items": captions or []},
        "transitions": transitions or [],
    }


def _probe(plan: dict) -> dict[str, dict]:
    return {item["asset_id"]: _geometry() for item in plan["inputs"]}


def _frames(plan: dict) -> list[dict]:
    return project_preview_ir(plan, _probe(plan), {"default-bottom": {
        "font_size": 64, "primary_rgb": [255, 255, 255], "outline_rgb": [0, 0, 0],
        "outline": 4, "shadow": 0, "border_style": 1, "margin_v": 150}})["frames"]


def test_simple_timeline_frame_table() -> None:
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US), _segment("b", 0, 1 * US, 2 * US, 3 * US)])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["canvas"]["duration_frames"] == 90
    assert ir["frames"][0]["main"] == {
        "kind": "segment", "clip_id": "a", "input_id": "I0", "src_n": 0, "src_t_us": 0,
        "content": {"x": 0, "y": 0, "w": 960, "h": 540},
        "shift": {"dx": 0.0, "dy": 0.0}, "alpha": 1.0, "rotation_deg": 0.0,
        "layout": "fit"}
    # 1920x1080 fit 960x540：恰为 2:1，无黑边
    assert ir["frames"][30]["main"]["src_n"] == 30
    assert ir["frames"][60]["main"]["clip_id"] == "b"
    assert ir["frames"][89]["main"]["src_n"] == 29


def test_transition_borrowed_offset_and_blend() -> None:
    plan = _plan([
        _segment("a", 0, 20 * US, 0, 20 * US,
                 transition_in={"transition_id": "t", "kind": "fade", "duration_us": 1 * US}),
        _segment("b", 0, 25 * US, 20 * US, 45 * US),
    ], transitions=[{"transition_id": "t", "after_clip_id": "a", "kind": "fade", "duration_us": 1 * US}])
    frames = _frames(plan)
    # 输出时长 = 45s − 1s 借用 = 44s；blend 窗口 [19, 20)
    assert len(frames) == 44 * 30
    assert frames[570]["main"]["kind"] == "transition" and frames[570]["main"]["p"] == 0.0
    assert frames[585]["main"]["p"] == 0.5
    assert frames[585]["main"]["left"]["src_n"] == 585
    assert frames[585]["main"]["right"]["src_n"] == 15  # 头部借用：blend 相对 0.5s × 30fps（1×）
    assert frames[600]["main"]["kind"] == "segment"
    assert frames[600]["main"]["src_n"] == 30  # body 起点跳过头借 1s（1× = 30 帧）
    assert frames[570]["main"]["left"]["shift"]["dx"] == 0.0


def test_speed_nearest_frame_mapping() -> None:
    plan = _plan([_segment("b", 0, 20 * US, 0, 25 * US, speed_milli=800)])
    frames = _frames(plan)
    # 0.8×：输出 t=1s → 源 0.8s → 帧 24
    assert frames[30]["main"]["src_n"] == 24
    assert frames[60]["main"]["src_n"] == 48
    # 帧边界恰为整帧时取该帧
    assert frames[375]["main"]["src_n"] == 300


def test_position_keyframes_lerp() -> None:
    plan = _plan([_segment("c", 0, 15 * US, 0, 15 * US, keyframes={
        "position": {"frames": [
            {"t_us": 0, "x": -0.6, "y": 0.0},
            {"t_us": 5 * US, "x": 0.0, "y": -0.4},
            {"t_us": 10 * US, "x": 0.6, "y": 0.0}]}})])
    frames = _frames(plan)
    # t_seg=2.5s：x=-0.3 → dx=-144；y=-0.2 → dy=-54
    f = frames[75]["main"]
    assert f["shift"] == {"dx": -144.0, "dy": -54.0}
    # 窗口外取边界值
    assert frames[0]["main"]["shift"]["dx"] == -288.0
    assert frames[14 * 30]["main"]["shift"]["dx"] == 288.0


def test_opacity_fade_approximation() -> None:
    plan = _plan([_segment("c", 0, 15 * US, 0, 15 * US, keyframes={
        "opacity": {"frames": [{"t_us": 0, "v": 0.0}, {"t_us": 6 * US, "v": 1.0}]}})])
    frames = _frames(plan)
    assert frames[90]["main"]["alpha"] == 0.5  # t=3s / d=6s
    assert frames[180]["main"]["alpha"] == 1.0
    # 帧值 v 不参与（近似语义：恒 0→1）
    assert frames[0]["main"]["alpha"] == 0.0


def test_pip_content_box_and_transform() -> None:
    plan = _plan([
        _segment("a", 0, 30 * US, 0, 30 * US),
        _segment("p", 0, 20 * US, 10 * US, 30 * US, asset_idx=1, track_id="V2",
                 transform={"x": 0.7, "y": 0.3, "scale": 0.35, "rotate": 15.0}),
    ])
    frames = _frames(plan)
    # 内容盒 960x540 × 0.35 → pip 336x188；中心 (672, 162)
    assert frames[450]["overlays"] == [{
        "clip_id": "p", "input_id": "I1", "src_n": 150, "src_t_us": 5_000_000,
        "box": {"x": 504.0, "y": 68.0, "w": 336, "h": 188},
        "rotation_deg": 15.0, "alpha": 1.0}]
    # enable 窗口外无叠加（窗口 [10s,30s] 含末帧 899）
    assert frames[0]["overlays"] == []
    assert frames[899]["overlays"][0]["src_n"] == 599
    assert frames[900 - 1 - 1]["overlays"][0]["src_n"] == 598


def test_overlay_mask_keying_effects_passthrough() -> None:
    # v0.4 重入：覆盖轨 mask/keying 静态参数随 overlay 条目携带（effects），
    # 白名单放行；主轨同字段仍拒绝（test_whitelist_hard_fail）。
    mask = {"kind": "ellipse", "x": 0.4, "y": 0.6, "width": 0.8, "height": 0.5,
            "rotation": 30.0, "feather": 0.1, "invert": True}
    keying = {"color": "00FF00", "similarity": 0.3, "blend": 0.1}
    plan = _plan([
        _segment("a", 0, 30 * US, 0, 30 * US),
        _segment("p", 0, 20 * US, 10 * US, 30 * US, asset_idx=1, track_id="V2",
                 mask=mask, keying=keying),
        _segment("q", 0, 20 * US, 10 * US, 30 * US, asset_idx=1, track_id="V2"),
    ])
    frames = _frames(plan)
    ov = frames[450]["overlays"]
    assert ov[0]["clip_id"] == "p"
    assert ov[0]["effects"] == {"mask": mask, "keying": keying}
    # 无效果的覆盖轨条目不携带 effects 键（形状向后兼容）
    assert ov[1]["clip_id"] == "q"
    assert "effects" not in ov[1]


def test_overlay_only_timeline_full_length_black() -> None:
    # 主轨为空（V1 无可见段）但覆盖轨有内容：对齐权威端「全程黑场 + 覆盖轨
    # 照常叠加」（ffmpeg.py 空主轨黑场分支，时长 = 全时间线含覆盖轨终点）。
    # 缺失该下限时 total_frames=0 → 前端 play() 首个 tick 即结束、静默无任何
    # 提示（W2.6 末条登记缺陷）。门控的负向对照由
    # test_overlay_beyond_main_does_not_extend_duration 钉死。
    plan = _plan([
        _segment("p", 0, 2 * US, 0, 2 * US, asset_idx=1, track_id="V2"),
    ])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["canvas"]["duration_frames"] == 60
    assert ir["frames"][0]["main"] == {"kind": "black"}
    assert ir["frames"][0]["overlays"][0]["clip_id"] == "p"
    assert ir["frames"][59]["overlays"][0]["src_n"] == 59
    assert ir["frames"][-1]["overlays"]  # 末帧仍在 overlay 窗口内


def test_overlay_beyond_main_does_not_extend_duration() -> None:
    # V1 非空：视频长度 = 主轨链长（权威端 overlay 滤镜随主输入时长截断），
    # 覆盖轨窗口超出主画面的部分不延长输出。**负向对照**：若覆盖轨终点
    # 无条件参与时长（去掉 `if not visual` 门控），duration 变 120 → 本测试红。
    plan = _plan([
        _segment("a", 0, 2 * US, 0, 2 * US),
        _segment("p", 0, 3 * US, 1 * US, 4 * US, asset_idx=1, track_id="V2"),
    ])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["canvas"]["duration_frames"] == 60
    assert ir["frames"][59]["main"]["clip_id"] == "a"  # 主轨段覆盖到末帧
    assert ir["frames"][59]["overlays"][0]["clip_id"] == "p"  # 窗口内 overlay 正常


def test_overlay_only_audio_tail_still_extends() -> None:
    # 主轨空 + 覆盖轨 + A1 音频更长：三者取大（音频黑场延长语义保持）。
    plan = _plan([
        _segment("p", 0, 2 * US, 0, 2 * US, asset_idx=1, track_id="V2"),
        _segment("s", 0, 5 * US, 0, 5 * US, asset_idx=2, track_id="A1",
                 asset_kind="audio", input_id="I2"),
    ])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["canvas"]["duration_frames"] == 150
    assert ir["frames"][100]["main"] == {"kind": "black"}
    assert ir["frames"][100]["overlays"] == []  # overlay 窗口已过


def test_output_duration_uses_borrow_compression() -> None:
    plan = _plan([
        _segment("a", 0, 5 * US, 0, 5 * US,
                 transition_in={"transition_id": "t", "kind": "fade", "duration_us": 500_000}),
        _segment("b", 0, 5 * US, 5 * US, 10 * US),
    ], transitions=[{"transition_id": "t", "after_clip_id": "a", "kind": "fade", "duration_us": 500_000}])
    ir = project_preview_ir(plan, _probe(plan))
    # 时间线 10s，借用 0.5s → 输出 9.5s（285 帧），非时间线口径的 300 帧
    assert ir["canvas"]["duration_frames"] == 285
    # blend [4.5,5)，b body [5,9.5)
    assert ir["frames"][149]["main"]["kind"] == "transition"
    assert ir["frames"][150]["main"]["kind"] == "segment"


def test_black_fill_for_timeline_gap() -> None:
    plan = _plan([
        _segment("a", 0, 1 * US, 0, 1 * US),
        _segment("b", 0, 1 * US, 2 * US, 3 * US),
    ])
    frames = _frames(plan)
    assert frames[15]["main"]["kind"] == "segment"   # a 段播放中
    assert frames[45]["main"]["kind"] == "black"     # 空隙 [1s,2s)
    assert frames[59]["main"]["kind"] == "black"
    assert frames[60]["main"]["kind"] == "segment" and frames[60]["main"]["clip_id"] == "b"


def test_caption_timing() -> None:
    plan = _plan([_segment("a", 0, 3 * US, 0, 3 * US)],
                 captions=[{"caption_id": "c1", "start_us": US, "end_us": 2 * US,
                            "text": "测试", "preset_id": "default-bottom"}])
    frames = _frames(plan)
    assert frames[0]["captions"] == []
    assert frames[45]["captions"] == ["c1"]
    assert frames[89]["captions"] == []


def test_resolved_caption_styles() -> None:
    styles = resolved_caption_styles({"presets": {"default-bottom": {
        "font_size": 64, "primary_color": "&H00FFFFFF", "outline_color": "&H00000000",
        "outline": 4, "shadow": 0, "border_style": 1, "margin_v": 150}}})
    assert styles == {"default-bottom": {
        "font_size": 64, "primary_rgb": [255, 255, 255], "outline_rgb": [0, 0, 0],
        "outline": 4, "shadow": 0, "border_style": 1, "margin_v": 150}}


@pytest.mark.parametrize("mutation,fragment", [
    # v0.4 重入：覆盖轨 mask/keying 放行（见 test_overlay_mask_keying_effects）；
    # 主轨（默认 V1）仍拒绝并明示原因。
    ({"mask": {"kind": "rect"}}, "主轨蒙版"),
    ({"keying": {"color": "00FF00"}}, "主轨抠像"),
    ({"reverse_playback": True}, "reverse_playback（倒放）"),
    ({"keyframes": {"blink": {"frames": [{"t_us": 0, "v": 1.0}]}}}, "关键帧属性"),
    ({"keyframes": {"rotate": {"frames": [{"t_us": 0, "v": 30.0}]}}, "track_id": "V2"}, "非 V1 轨关键帧"),
    ({"transition_in": {"transition_id": "t", "kind": "dissolve", "duration_us": US}}, "转场 dissolve"),
])
def test_whitelist_hard_fail(mutation: dict, fragment: str) -> None:
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US, **mutation)])
    with pytest.raises(DomainError) as exc:
        project_preview_ir(plan, _probe(plan))
    assert exc.value.code == "PREVIEW_IR_UNSUPPORTED"
    assert fragment in exc.value.message


def test_whitelist_allows_numeric_style_override() -> None:
    """B4 收官：数值样式覆盖（字号等）进入预览子集，随 per-caption 覆盖下发。"""
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US)],
                 captions=[{"caption_id": "c1", "start_us": 0, "end_us": US, "text": "x",
                            "preset_id": "default-bottom", "style_override": {"font_size": 80}}])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["caption_override_styles"]["c1"]["font_size"] == 80


def test_whitelist_rejects_structural_style_override() -> None:
    """结构性字段（font_name/pos 坐标）维持"仅权威预览"：需要 FontFace 注册
    链路与合成器坐标换算，均为独立增量。"""
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US)],
                 captions=[{"caption_id": "c1", "start_us": 0, "end_us": US, "text": "x",
                            "preset_id": "default-bottom",
                            "style_override": {"font_name": "LXGW WenKai"}}])
    with pytest.raises(DomainError) as exc:
        project_preview_ir(plan, _probe(plan))
    assert exc.value.code == "PREVIEW_IR_UNSUPPORTED"
    assert "font_name" in exc.value.message


def test_whitelist_rejects_missing_geometry() -> None:
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US)])
    with pytest.raises(DomainError) as exc:
        project_preview_ir(plan, {**_probe(plan), "asset0": {"video_streams": []}})
    assert exc.value.code == "PREVIEW_IR_UNSUPPORTED"


def test_whitelist_rejects_oversized_timeline() -> None:
    long_segments = [_segment(f"c{i}", 0, 2 * US, i * 2 * US, (i + 1) * 2 * US,
                              asset_idx=i % 2)
                     for i in range(8)]  # 16s < 15min，需直接构造超长
    long_segments = [_segment("a", 0, 920 * US, 0, 920 * US)]
    # 920s ≈ 27600 帧 > 27000
    with pytest.raises(DomainError) as exc:
        project_preview_ir(long_segments and _plan(long_segments), _probe(_plan(long_segments)))
    assert exc.value.code == "PREVIEW_IR_TOO_LARGE"


def test_scale_keyframes_are_noop_and_rotate_visible() -> None:
    plan = _plan([_segment("c", 0, 15 * US, 0, 15 * US, keyframes={
        "scale": {"frames": [{"t_us": 0, "v": 1.0}, {"t_us": 5 * US, "v": 0.5}]},
        "rotate": {"frames": [{"t_us": 0, "v": 0.0}, {"t_us": 5 * US, "v": 30.0}]}})])
    frames = _frames(plan)
    # scale：权威端归一化抵消为无视觉效果 → IR 不携带、shift/content 不变
    f = frames[75]["main"]
    assert f["content"] == {"x": 0, "y": 0, "w": 960, "h": 540}
    assert f["shift"] == {"dx": 0.0, "dy": 0.0}
    # rotate：绕画布中心逐帧旋转（t=2.5s → v=15°）
    assert f["rotation_deg"] == 15.0
    # 白名单：scale/rotate 关键帧不再拒绝（v0.3 重入）
    assert frames[0]["main"]["rotation_deg"] == 0.0


def test_v1_blurred_background_layout_passes_through() -> None:
    # V1 主轨 blurred_background：白名单放行，main 条目携带 layout（合成器垫底）
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US, layout="blurred_background")])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["frames"][0]["main"]["layout"] == "blurred_background"
    # 内容盒语义与 fit 相同（权威端 blurred_background 前景 = fit 缩放）
    assert ir["frames"][0]["main"]["content"] == {"x": 0, "y": 0, "w": 960, "h": 540}


def test_v1_static_transform_content_box() -> None:
    # 用户真实数据形态：V1 clip transform {scale: 0.63}，无关键帧
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US,
                           transform={"scale": 0.63, "x": 0.5, "y": 0.5})])
    frames = _frames(plan)
    f = frames[30]["main"]
    # 内容盒 = fit 盒 960x540 × 0.63 → 604x340，居中 (178, 100)
    assert f["content"] == {"x": 178, "y": 100, "w": 604, "h": 340}, f["content"]
    assert f["alpha"] == 1.0
    # opacity 乘入
    plan2 = _plan([_segment("a", 0, 2 * US, 0, 2 * US,
                            transform={"scale": 0.63, "opacity": 0.5})])
    assert project_preview_ir(plan2, _probe(plan2))["frames"][0]["main"]["alpha"] == 0.5


def test_pip_blurred_background_content_box() -> None:
    # 用户真实数据形态：V2 pip layout=blurred_background（内容盒语义与 fit 相同），
    # 源几何 682x686（近方形生成图）
    plan = _plan([
        _segment("a", 0, 30 * US, 0, 30 * US),
        _segment("p", 0, 20 * US, 10 * US, 30 * US, asset_idx=1, track_id="V2",
                 layout="blurred_background",
                 transform={"x": 0.7288, "y": 0.4173, "scale": 0.2725, "rotate": 0.0}),
    ])
    plan["output"]["width"], plan["output"]["height"] = 540, 960  # 用户真实项目为竖版画布
    probes = {**_probe(plan), "asset1": _geometry(682, 686)}
    frames = project_preview_ir(plan, probes)["frames"]
    ov = frames[450]["overlays"][0]
    # 682x686 → fit 540x542 × 0.2725 → 148x148，中心 (0.7288*540, 0.4173*960)
    assert ov["box"]["w"] == 148 and ov["box"]["h"] == 148
    assert abs(ov["box"]["x"] - (0.7288 * 540 - 74)) < 1


def _audio_segment(clip_id: str, tl0: int, tl1: int, *, asset_idx: int = 0, **extra) -> dict:
    base = {"clip_id": clip_id, "track_id": "A1", "asset_kind": "audio",
            "asset_id": f"asset{asset_idx}", "input_id": f"I{asset_idx}",
            "source_start_us": 0, "source_end_us": tl1 - tl0,
            "timeline_start_us": tl0, "timeline_end_us": tl1,
            "layout": "fit", "audio_enabled": True, "gain_db": 0.0}
    base.update(extra)
    return base


def _plan_with_audio(segments: list[dict]) -> dict:
    plan = _plan([_segment("v", 0, 2 * US, 0, 2 * US)])
    plan["segments"] = segments
    plan["inputs"] = [
        {"input_id": f"I{i}", "asset_id": f"asset{i}",
         "asset_kind": "audio" if i == 1 else "video",
         "fingerprint": f"fp{i}", "duration_us": 30_000_000, "has_audio": i == 1}
        for i in sorted({int(segment["input_id"][1:]) for segment in segments})
    ]
    return plan


def test_audio_only_timeline_black_frames() -> None:
    # A1 纯音频轨（无任何视觉段）：黑场帧表覆盖音频窗口，段表携带输出窗口
    plan = _plan_with_audio([_audio_segment("a1", 0, 3 * US, asset_idx=1)])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["canvas"]["duration_frames"] == 90
    assert all(frame["main"] == {"kind": "black"} for frame in ir["frames"])
    segment = ir["segments"][0]
    assert segment["output_start_us"] == 0 and segment["output_end_us"] == 3 * US
    # 音频输入几何占位（合成器不消费）
    assert ir["inputs"][0]["asset_kind"] == "audio"
    assert ir["inputs"][0]["geometry"] == {"width": 0, "height": 0, "sar": 1.0}


def test_audio_tail_extends_output_duration() -> None:
    # 视觉 0..2s，A1 音频 0..3.5s → 输出延长到 3.5s（尾部黑场 + 音频照常调度）
    plan = _plan_with_audio([
        _segment("v", 0, 2 * US, 0, 2 * US),
        _audio_segment("a1", 0, 3500000, asset_idx=1),
    ])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["canvas"]["duration_frames"] == 105
    assert ir["frames"][60]["main"] == {"kind": "black"}  # 2s 后黑场
    assert ir["segments"][1]["output_end_us"] == 3500000


def test_audio_output_window_shifted_by_transition_borrow() -> None:
    # 主轨转场借用 1s：借用点（20s）及之后开始的 A1 音频段整体前移 1s
    plan = _plan_with_audio([
        _segment("a", 0, 20 * US, 0, 20 * US,
                 transition_in={"transition_id": "t", "kind": "fade", "duration_us": 1 * US}),
        _segment("b", 0, 25 * US, 20 * US, 45 * US),
        _audio_segment("a1", 20 * US, 40 * US, asset_idx=1),
    ])
    plan["transitions"] = [{"transition_id": "t", "after_clip_id": "a", "kind": "fade", "duration_us": 1 * US}]
    ir = project_preview_ir(plan, _probe(plan))
    by_id = {segment["clip_id"]: segment for segment in ir["segments"]}
    # a 起点在借用点之前：不前移（结束端因借用不连续，起点语义优先）
    assert by_id["a"]["output_start_us"] == 0
    # b 与 a1 起点都在借用点上：前移 1s
    assert by_id["b"]["output_start_us"] == 19 * US
    assert by_id["a1"]["output_start_us"] == 19 * US
    assert by_id["a1"]["output_end_us"] == 39 * US


def test_whitelist_still_rejects_image_assets() -> None:
    plan = _plan([_segment("img", 0, 2 * US, 0, 2 * US, asset_kind="image")])
    plan["inputs"][0]["asset_kind"] = "image"
    with pytest.raises(DomainError) as exc:
        project_preview_ir(plan, _probe(plan))
    assert exc.value.code == "PREVIEW_IR_UNSUPPORTED"


# ---- GAP-CROSS-TRACK-OVERLAP（2026-09-15 缺陷批 W4）：重叠段拆分复制输入 ----

def test_cross_track_overlap_splits_duplicate_input() -> None:
    # 同素材 V1 主轨 + V2 浮层时间重叠（跨轨重叠，契约允许）：V2 段得复制
    # 输入 I0~1（桌面侧独立 worker/环池，双位置消费不再互相淘汰槽位）
    plan = _plan([
        _segment("v1", 0, 3 * US, 0, 3 * US),
        _segment("v2", 1 * US, 3 * US, 1 * US, 3 * US, track_id="V2"),
    ])
    ir = project_preview_ir(plan, _probe(plan))
    input_ids = [item["input_id"] for item in ir["inputs"]]
    assert "I0" in input_ids and "I0~1" in input_ids
    dup = next(item for item in ir["inputs"] if item["input_id"] == "I0~1")
    assert dup["asset_id"] == "asset0"  # 同 asset：票据按 asset_id 解析不变
    # 帧表：主轨用 I0，浮层 overlay 用 I0~1
    mid = ir["frames"][45]
    assert mid["main"]["clip_id"] == "v1"
    assert mid["main"]["input_id"] == "I0"
    assert len(mid["overlays"]) == 1
    assert mid["overlays"][0]["input_id"] == "I0~1"
    # 输出 segments 表同步重映射
    seg = next(s for s in ir["segments"] if s["clip_id"] == "v2")
    assert seg["input_id"] == "I0~1"


def test_non_overlapping_same_asset_keeps_single_input() -> None:
    # 同素材 F03 式三窗口 / F07 式矩阵：timeline 不重叠 → 仍单输入单 worker
    plan = _plan([
        _segment("w1", 0, 3 * US, 0, 3 * US),
        _segment("w2", 0, 3 * US, 3 * US, 6 * US),
        _segment("w3", 0, 3 * US, 6 * US, 9 * US),
    ])
    ir = project_preview_ir(plan, _probe(plan))
    assert [item["input_id"] for item in ir["inputs"]] == ["I0"]
    assert all(s["input_id"] == "I0" for s in ir["segments"])


def test_v2_v2_overlap_second_duplicate_input() -> None:
    # 两个 V2 浮层互相重叠 + 与 V1 主轨重叠：三个重叠成员 → I0 / I0~1 / I0~2
    plan = _plan([
        _segment("v1", 0, 4 * US, 0, 4 * US),
        _segment("p1", 0, 3 * US, 0, 3 * US, track_id="V2"),
        _segment("p2", 0, 3 * US, 1 * US, 4 * US, track_id="V2"),
    ])
    ir = project_preview_ir(plan, _probe(plan))
    input_ids = sorted(item["input_id"] for item in ir["inputs"])
    assert input_ids == ["I0", "I0~1", "I0~2"]
    by_clip = {s["clip_id"]: s["input_id"] for s in ir["segments"]}
    # plan 顺序（segments 列表序）编号：v1=I0、p1=I0~1、p2=I0~2
    assert by_clip == {"v1": "I0", "p1": "I0~1", "p2": "I0~2"}
    frame = ir["frames"][45]  # 1.5s：v1 主轨 + p1/p2 双浮层
    assert frame["main"]["input_id"] == "I0"
    assert {o["input_id"] for o in frame["overlays"]} == {"I0~1", "I0~2"}


def test_transition_pair_not_split_by_borrow_overlap() -> None:
    # 转场借用对：输出时间轴上重叠（blend 区），但输入 timeline 窗口首尾相接
    # 不重叠 → 不拆分（影子槽机制保持原语义）
    plan = _plan([
        _segment("a", 0, 20 * US, 0, 20 * US,
                 transition_in={"transition_id": "t", "kind": "fade", "duration_us": 1 * US}),
        _segment("b", 0, 25 * US, 20 * US, 45 * US, asset_idx=1),
    ], transitions=[{"transition_id": "t", "after_clip_id": "a", "kind": "fade", "duration_us": 1 * US}])
    ir = project_preview_ir(plan, _probe(plan))
    assert [item["input_id"] for item in ir["inputs"]] == ["I0", "I1"]


def test_audio_segments_do_not_trigger_split() -> None:
    # A1 音频与 V1 视频同素材时间重叠：音频无视觉装配，不参与拆分
    plan = _plan_with_audio([
        _segment("v1", 0, 3 * US, 0, 3 * US),
        _audio_segment("a1", 0, 3 * US, asset_idx=1),
    ])
    ir = project_preview_ir(plan, _probe(plan))
    assert [item["input_id"] for item in ir["inputs"]] == ["I0", "I1"]
