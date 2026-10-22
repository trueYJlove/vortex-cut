"""音频淡入/淡出（fade_in_us / fade_out_us）：契约 → Core 校验 → 渲染图。

本文件只覆盖**不进真实 FFmpeg** 的三层；真实包络见
tests/integration/test_audio_fade_render_real.py。
"""
from __future__ import annotations

import copy
from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.projects import DomainError
from aivs_core.rendering.ffmpeg import build_timeline_args
from aivs_core.timeline import TimelineService

# ── Core：时间线文档 / set_audio op ────────────────────────────────────────


def _service(tmp_path: Path) -> TimelineService:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "p1", "active", "{}", "root", "root", "now", "now", "now"),
        )
        for asset_id, kind, has_audio, duration in (
            ("v1", "video", True, 5_000_000),
            ("a1", "audio", True, 8_000_000),
        ):
            db.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,media_info_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    asset_id, "p1", kind, "external", asset_id, f"fp-{asset_id}", 1,
                    "available",
                    json_dumps({
                        "duration_us": duration,
                        "video_streams": [{}] if kind == "video" else [],
                        "audio_streams": [{}] if has_audio else [],
                    }),
                    "now", "now",
                ),
            )
    return TimelineService(database)


def _create(service: TimelineService, asset_id: str) -> dict:
    return service.create(
        "p1",
        {
            "schema_version": 1,
            "source": {"kind": "full_asset", "asset_id": asset_id},
            "default_layout": "blurred_background",
            "caption_preset_id": "default-bottom",
        },
    )


def _patch(service: TimelineService, state: dict, operations: list[dict]) -> dict:
    return service.patch(
        "p1",
        {
            "schema_version": 1,
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
            "operations": operations,
            "summary": "修改",
        },
    )


def _only_clip(state: dict) -> dict:
    clips = state["current_revision"]["document"]["clips"]
    assert len(clips) == 1
    return clips[0]


def test_old_document_without_fade_keeps_identical_field_set(tmp_path: Path) -> None:
    """回归锁：老文档（audio 只有 enabled/gain_db）解析后字段集**逐字节不变**。

    负向对照 0：给 audio 写入 fade_in_us/fade_out_us 的默认值 ⇒ 本条红。
    """
    service = _service(tmp_path)
    state = _create(service, "v1")
    clip = _only_clip(state)
    assert clip["audio"] == {"enabled": True, "gain_db": 0.0}
    assert json_dumps(clip["audio"]) == '{"enabled":true,"gain_db":0.0}'

    # 老文档经草稿校验往返：不得被补上 fade 键。
    document = copy.deepcopy(state["current_revision"]["document"])
    draft = service.save_draft(
        "p1",
        {
            "schema_version": 1,
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
            "document": document,
        },
    )
    assert draft["document"]["clips"][0]["audio"] == {"enabled": True, "gain_db": 0.0}
    assert "fade_in_us" not in draft["document"]["clips"][0]["audio"]
    assert "fade_out_us" not in draft["document"]["clips"][0]["audio"]


def test_set_audio_accepts_fade_and_defaults_keep_old_behavior(tmp_path: Path) -> None:
    """set_audio 能带 fade；不带的既有 op 行为完全不变（且不清掉已设的 fade）。"""
    service = _service(tmp_path)
    state = _create(service, "a1")
    clip = _only_clip(state)

    # 既有 op 形态（无 fade 字段）继续工作，结果字段集与今天一致。
    state = _patch(
        service,
        state,
        [{"op": "set_audio", "clip_id": clip["clip_id"], "enabled": True, "gain_db": -3}],
    )
    assert _only_clip(state)["audio"] == {"enabled": True, "gain_db": -3.0}

    # 带 fade：写入两个字段。
    state = _patch(
        service,
        state,
        [{
            "op": "set_audio", "clip_id": clip["clip_id"], "enabled": True, "gain_db": -3,
            "fade_in_us": 500_000, "fade_out_us": 250_000,
        }],
    )
    assert _only_clip(state)["audio"] == {
        "enabled": True, "gain_db": -3.0, "fade_in_us": 500_000, "fade_out_us": 250_000,
    }

    # 只写淡入：淡出保留（整段覆盖操作不能静默丢掉用户已设的另一半）。
    state = _patch(
        service,
        state,
        [{
            "op": "set_audio", "clip_id": clip["clip_id"], "enabled": True, "gain_db": -3,
            "fade_in_us": 400_000,
        }],
    )
    audio = _only_clip(state)["audio"]
    assert (audio["fade_in_us"], audio["fade_out_us"]) == (400_000, 250_000)

    # 既有响度统一式 op（只有 enabled/gain_db）不得清掉 fade。
    state = _patch(
        service,
        state,
        [{"op": "set_audio", "clip_id": clip["clip_id"], "enabled": True, "gain_db": -6}],
    )
    audio = _only_clip(state)["audio"]
    assert (audio["fade_in_us"], audio["fade_out_us"], audio["gain_db"]) == (
        400_000, 250_000, -6.0,
    )

    # 显式 0 = 清除该淡变（归一为键不存在，与老文档同形）。
    state = _patch(
        service,
        state,
        [{
            "op": "set_audio", "clip_id": clip["clip_id"], "enabled": True, "gain_db": -6,
            "fade_in_us": 0, "fade_out_us": 0,
        }],
    )
    assert _only_clip(state)["audio"] == {"enabled": True, "gain_db": -6.0}


@pytest.mark.parametrize(
    "fade",
    [
        {"fade_in_us": -1},
        {"fade_out_us": -1},
        {"fade_in_us": 1.5},
        {"fade_out_us": "500000"},
        {"fade_in_us": True},
        {"fade_out_us": None},
    ],
)
def test_set_audio_rejects_invalid_fade(tmp_path: Path, fade: dict) -> None:
    """负向对照：非法 fade（负/非整数/bool/字符串/None）必须被 Core 拒绝。"""
    service = _service(tmp_path)
    state = _create(service, "a1")
    clip = _only_clip(state)
    with pytest.raises(DomainError) as exc:
        _patch(
            service,
            state,
            [{
                "op": "set_audio", "clip_id": clip["clip_id"], "enabled": True,
                "gain_db": 0, **fade,
            }],
        )
    assert exc.value.code == "TIMELINE_INVALID"


def test_document_with_fade_validates_and_invalid_fade_in_document_is_rejected(
    tmp_path: Path,
) -> None:
    """草稿校验层：合法 fade 通过；文档里出现非法 fade 必须被拒。"""
    service = _service(tmp_path)
    state = _create(service, "a1")
    base_revision_id = state["current_revision"]["timeline_revision_id"]
    document = copy.deepcopy(state["current_revision"]["document"])

    good = copy.deepcopy(document)
    good["clips"][0]["audio"]["fade_in_us"] = 750_000
    good["clips"][0]["audio"]["fade_out_us"] = 250_000
    draft = service.save_draft(
        "p1",
        {"schema_version": 1, "base_revision_id": base_revision_id, "document": good},
    )
    assert draft["document"]["clips"][0]["audio"]["fade_in_us"] == 750_000

    for bad in (-1, 2.5, "600000", True):
        broken = copy.deepcopy(document)
        broken["clips"][0]["audio"]["fade_in_us"] = bad
        with pytest.raises(DomainError) as exc:
            service.save_draft(
                "p1",
                {"schema_version": 1, "base_revision_id": base_revision_id, "document": broken},
            )
        assert exc.value.code == "TIMELINE_INVALID"


def test_split_edit_derives_a1_clips_with_fade_on_the_side_it_belongs(tmp_path: Path) -> None:
    """split_edit 派生 A1 段同样各留一半（淡出必须取自右段，不是已被清空的左段）。"""
    service = _service(tmp_path)
    state = _create(service, "v1")
    clip = _only_clip(state)
    state = _patch(
        service,
        state,
        [{
            "op": "set_audio", "clip_id": clip["clip_id"], "enabled": True, "gain_db": 0,
            "fade_in_us": 500_000, "fade_out_us": 500_000,
        }],
    )
    state = _patch(
        service, state,
        [{
            "op": "split_edit", "clip_id": clip["clip_id"],
            "source_time_us": 3_000_000, "audio_delta_us": 0,
        }],
    )
    document = state["current_revision"]["document"]
    derived = [
        c["audio"] for c in document["clips"]
        if c["track_id"] == "A1"
    ]
    assert len(derived) == 2
    assert derived[0] == {"enabled": True, "gain_db": 0.0, "fade_in_us": 500_000}
    assert derived[1] == {"enabled": True, "gain_db": 0.0, "fade_out_us": 500_000}
    # V1 两侧静音，且不再带衰减（它们是派生 A1 的镜像，不能重复出声）。
    for v1 in (c for c in document["clips"] if c["track_id"] == "V1"):
        assert v1["audio"] == {"enabled": False, "gain_db": 0.0}


def test_split_derives_a1_clips_with_fade_on_the_side_it_belongs(tmp_path: Path) -> None:
    """拆分带 fade 的视频片段：派生的前后两个 A1 段各留一半（否则切点处多两次渐变）。"""
    service = _service(tmp_path)
    state = _create(service, "v1")
    clip = _only_clip(state)
    state = _patch(
        service,
        state,
        [{
            "op": "set_audio", "clip_id": clip["clip_id"], "enabled": True, "gain_db": 0,
            "fade_in_us": 500_000, "fade_out_us": 500_000,
        }],
    )
    state = _patch(
        service, state,
        [{"op": "split_clip", "clip_id": clip["clip_id"], "source_time_us": 3_000_000}],
    )
    clips = state["current_revision"]["document"]["clips"]
    assert [c["track_id"] for c in clips] == ["V1", "V1"]
    assert clips[0]["audio"] == {"enabled": True, "gain_db": 0.0, "fade_in_us": 500_000}
    assert clips[1]["audio"] == {"enabled": True, "gain_db": 0.0, "fade_out_us": 500_000}


# ── 渲染图：计划层透传 ────────────────────────────────────────────────────


def _plan_segments(tmp_path: Path, audio: dict) -> list[dict]:
    from aivs_core.rendering.plan import RenderPlanCompiler

    database = Database(tmp_path / "plan.db")
    database.initialize()
    document = {
        "schema_version": 1,
        "project_id": "p1",
        "canvas": {"width": 1080, "height": 1920, "fps_num": 30, "fps_den": 1,
                   "background_color": "#000000"},
        "tracks": [{"id": "V1", "kind": "visual", "locked": False}],
        "clips": [{
            "clip_id": "c1", "track_id": "V1", "order_index": 0, "asset_id": "v1",
            "asset_kind": "video", "source_start_us": 0, "source_end_us": 2_000_000,
            "timeline_start_us": 0, "timeline_end_us": 2_000_000, "layout": "fit",
            "audio": audio,
        }],
        "captions": [],
        "provenance": {"created_by": "user", "source_transcript_ids": []},
    }
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES "
            "('p1','P','active','{}','r1','root','root','now','now','now')"
        )
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("v1", "p1", "video", "external", "v1", "sha256:v1", 1, "available",
             json_dumps({"duration_us": 2_000_000, "video_streams": [{}],
                         "audio_streams": [{}]}), "now", "now"),
        )
        db.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            ("r1", "p1", None, 1, json_dumps(document), "sha256:rev", "s", "user", "now"),
        )
    plan = RenderPlanCompiler(database).compile("p1", "r1", "authoritative_preview")
    return plan["segments"]


def test_plan_passes_fade_through_and_omits_zero(tmp_path: Path) -> None:
    """0/缺省不写键（老时间线的计划与指纹逐字节不变）；有值才透传。"""
    plain = _plan_segments(tmp_path / "plain", {"enabled": True, "gain_db": 0.0})
    zero = _plan_segments(
        tmp_path / "zero",
        {"enabled": True, "gain_db": 0.0, "fade_in_us": 0, "fade_out_us": 0},
    )
    faded = _plan_segments(
        tmp_path / "faded",
        {"enabled": True, "gain_db": 0.0, "fade_in_us": 600_000, "fade_out_us": 400_000},
    )
    assert "fade_in_us" not in plain[0] and "fade_out_us" not in plain[0]
    assert zero == plain
    assert faded[0]["fade_in_us"] == 600_000
    assert faded[0]["fade_out_us"] == 400_000


# ── 渲染图：afade 生成 / 不生成 ───────────────────────────────────────────


def _video_segment(**overrides) -> dict:
    segment = {
        "clip_id": "v", "input_id": "I0", "asset_kind": "video",
        "source_start_us": 0, "source_end_us": 2_000_000,
        "timeline_start_us": 0, "timeline_end_us": 2_000_000,
        "layout": "fit", "audio_enabled": True, "gain_db": 0.0,
        "speed_milli": 1000, "reverse_playback": False, "transition_in": None,
    }
    segment.update(overrides)
    return segment


def _audio_segment(**overrides) -> dict:
    return _video_segment(asset_kind="audio", clip_id="a", **overrides)


def _graph(segments: list[dict], paths: list[Path], probes: list[dict]) -> str:
    plan = {"segments": segments, "captions": {"items": []},
            "output": {"width": 320, "height": 180}}
    args = build_timeline_args(plan, paths, probes, "libopenh264", "out.mp4", captions=False)
    return args[args.index("-filter_complex") + 1]


def _chain(graph: str, marker: str) -> str:
    return next(clause for clause in graph.split(";") if marker in clause)


def test_fade_absent_or_zero_emits_no_afade_filter() -> None:
    """负向对照 2：0/缺省也生成 afade（哪怕是 d=0）⇒ 本条红。

    默认路径零变化：无 fade 的链必须与今天逐字节一致。
    """
    baseline = _chain(
        _graph([_video_segment()], [Path("a.mp4")], [{"audio_streams": [{}]}]),
        ":a:0",
    )
    zero = _chain(
        _graph(
            [_video_segment(fade_in_us=0, fade_out_us=0)],
            [Path("a.mp4")], [{"audio_streams": [{}]}],
        ),
        ":a:0",
    )
    assert "afade" not in baseline
    assert zero == baseline
    assert baseline == (
        "[0:a:0]atrim=start=0.000000:end=2.000000,asetpts=PTS-STARTPTS,"
        "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
        "volume=0.000dB,apad,atrim=duration=2.000000[a0]"
    )


def test_fade_in_and_out_are_inserted_after_volume_before_atrim() -> None:
    """afade 的位置有语义：在 volume 之后（增益线性叠加）、apad/atrim 之前。"""
    chain = _chain(
        _graph(
            [_video_segment(fade_in_us=500_000, fade_out_us=300_000)],
            [Path("a.mp4")], [{"audio_streams": [{}]}],
        ),
        ":a:0",
    )
    assert (
        "volume=0.000dB,afade=t=in:st=0:d=0.500000,"
        "afade=t=out:st=1.700000:d=0.300000,apad"
    ) in chain
    assert chain.index("afade") > chain.index("volume=")
    assert chain.index("afade=t=out") < chain.index("apad")


def test_a1_mix_segment_gets_afade_too() -> None:
    """A1 纯音频段走的是另一条链（adelay 之前），淡变同样要生效。"""
    chain = _chain(
        _graph(
            [_video_segment(audio_enabled=False),
             _audio_segment(fade_in_us=1_000_000, fade_out_us=1_000_000)],
            [Path("v.mp4"), Path("m.mp3")],
            [{"audio_streams": []}, {"audio_streams": [{}]}],
        ),
        "a1s0",
    )
    assert "afade=t=in:st=0:d=1.000000" in chain
    assert "afade=t=out:st=1.000000:d=1.000000" in chain
    assert chain.index("afade=t=out") < chain.index("adelay=")


def test_fade_not_applied_to_silent_placeholders() -> None:
    """倒放段 / 无音轨 / disabled 段本来就是 anullsrc：不得生成 afade。"""
    reversed_graph = _graph(
        [_video_segment(reverse_playback=True, fade_in_us=500_000)],
        [Path("a.mp4")], [{"audio_streams": [{}]}],
    )
    assert "afade" not in reversed_graph

    muted_graph = _graph(
        [_video_segment(audio_enabled=False, fade_in_us=500_000)],
        [Path("a.mp4")], [{"audio_streams": [{}]}],
    )
    assert "afade" not in muted_graph

    silent_source_graph = _graph(
        [_video_segment(fade_in_us=500_000)], [Path("a.mp4")], [{"audio_streams": []}],
    )
    assert "afade" not in silent_source_graph

    # A1 无音轨占位同理。
    a1_graph = _graph(
        [_video_segment(audio_enabled=False),
         _audio_segment(fade_in_us=500_000)],
        [Path("v.mp4"), Path("m.mp3")],
        [{"audio_streams": []}, {"audio_streams": []}],
    )
    assert "afade" not in a1_graph


def test_fade_overflow_is_clamped_to_exactly_fill_the_segment() -> None:
    """负向对照 3：去掉上限保护 ⇒ st 变负 / ffmpeg 报错 ⇒ 本条红。"""
    chain = _chain(
        _graph(
            [_video_segment(fade_in_us=5_000_000, fade_out_us=5_000_000)],
            [Path("a.mp4")], [{"audio_streams": [{}]}],
        ),
        ":a:0",
    )
    # 2s 段：两个 5s 淡变等比收缩到恰好占满 2s（1s + 1s），st 非负。
    assert "afade=t=in:st=0:d=1.000000" in chain
    assert "afade=t=out:st=1.000000:d=1.000000" in chain
    assert "st=-" not in chain


def test_fade_overflow_clamp_preserves_short_side_proportion() -> None:
    """收缩按比例：3s 段 2s 淡入 + 4s 淡出 ⇒ 1s + 2s（1:2 比例保持，和恰为 3s）。"""
    chain = _chain(
        _graph(
            [_video_segment(
                timeline_end_us=3_000_000, source_end_us=3_000_000,
                fade_in_us=2_000_000, fade_out_us=4_000_000,
            )],
            [Path("a.mp4")], [{"audio_streams": [{}]}],
        ),
        ":a:0",
    )
    assert "afade=t=in:st=0:d=1.000000" in chain
    assert "afade=t=out:st=1.000000:d=2.000000" in chain
