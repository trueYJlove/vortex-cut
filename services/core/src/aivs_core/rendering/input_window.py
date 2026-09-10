"""C21a：导出输入深定位规划器（input seek 粗定位 + 精裁坐标回移）。

约束（PERFORMANCE_IMPLEMENTATION_PLAN C21a）：
- 每个实际 FFmpeg 输入生成 InputWindow：asset、源区间、粗定位时间、
  eligibility/fallback reason；单位统一整数微秒，FFmpeg 边界只在最终
  组装时转秒字符串。
- C21a 最小放行集：本地可 seek、时间戳可解释、正向 1x、无转场借用/
  倒放/复杂时域滤镜的普通主轨视频段；C21b 扩展：正向变速、转场借用、
  PiP 覆盖轨段（各自以真实 FFmpeg 帧对拍 golden 放行——见
  test_render_seek_parity 的 TestTransitionParity/TestSpeedParity/
  TestPipParity）。倒放/关键帧动画/transform/reframe/mask/keying 仍
  走旧参数图。
- 组合语义实证（见 test_render_input_window 的 real 对拍与开发实验）：
  input `-ss`（放 -i 前为准确 seek）+ 精裁 trim 坐标**回移 ss** 与旧图
  （无 -ss + 原坐标 trim）输出帧哈希一致；不能简单加 -ss 后仍用旧
  trim 坐标（实证输出错帧）。
- 长 GOP 准确定位仍从此前关键帧解码（FFmpeg 内部处理——`-ss` 在 -i
  前为 accurate seek，丢弃目标前帧）；无需额外 preroll 参数。

 eligibility 判定保守起步（放行集合最小化，逐项实测后再扩展——
 C21b 的正向变速/转场扩展各自补 golden）。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

MICRO = 1_000_000

# 粗定位安全下限（µs）：源起点至少前移这么长才有收益（也避免 ss≈0 的
# 无意义参数）。低于它的段不定位（fallback=小偏移）。
MIN_SEEK_US = 1_000_000


@dataclass(frozen=True)
class InputWindow:
    """一个 FFmpeg 输入的深定位决策。

    eligible=False 时调用方走旧参数图（不带 -ss、坐标不变）。
    """

    input_index: int
    eligible: bool
    reason: str
    seek_us: int = 0
    # 精裁坐标回移量（= seek_us；供 ffmpeg.py 组装时 trim/atrim 坐标减去它）
    shift_us: int = 0


def _stream_seekable(probe: dict[str, Any] | None) -> tuple[bool, str]:
    """时间戳可解释性：需要视频流存在且时长可解释。

    normalize_probe 的 duration_us 来自 format.duration；stream
    start_time 未保留在归一化结构中（当前项目素材均为 start_time=0 的
    MP4/MKV——见已知限制：非零起始 PTS 的输入走 legacy，待 ffprobe
    归一化补 start_time 字段后再扩展 eligibility）。
    """
    if not isinstance(probe, dict) or not probe.get("video_streams"):
        return False, "无视频流（几何未知）"
    if not probe.get("duration_us") or probe["duration_us"] <= 0:
        return False, "容器时长不可解释"
    return True, ""


def plan_input_windows(
    plan: dict[str, Any],
    probes_by_segment: list[dict[str, Any] | None],
) -> list[InputWindow]:
    """按 plan 段序生成每段输入的深定位窗口（C21b 放行集）。

    放行条件（全部满足）：
    - 段是视频段（asset_kind=video，非 track_hidden；主轨 V1 与覆盖轨
      PiP 均放行——PiP 输入是独立 -i，定位语义按段独立成立）；
    - 正向（非倒放）；变速放行（head/tail 借用按速度换算进 trim 坐标，
      窗口语义在 ffmpeg.visual_chain 与对拍中锁定）；转场借用放行
      （xfade 双路取窗的 trim 坐标同样回移）；
    - 无关键帧动画（复杂时域滤镜）、无 transform/reframe/mask/keying
      （保守不与深定位组合——各自补 golden 前不放行）；
    - 对应输入的 probe 可解释（有视频流、有时长）；
    - 段源起点 ≥ MIN_SEEK_US（太浅的定位无收益）。

    image 段/音频段/隐藏轨段/倒放段一律 legacy（不带 -ss）。
    共享输入：同一 asset 的多段各自独立 -i（build_timeline_args 逐段
    组装输入），窗口按段独立判定；引用点更深的后续段同样按自己的
    source_start_us 定位（多 -i 同文件不共享解码器状态，语义独立）。
    """
    windows: list[InputWindow] = []
    for index, segment in enumerate(plan["segments"]):
        probe = probes_by_segment[index] if index < len(probes_by_segment) else None
        windows.append(_window_for(segment, index, probe))
    return windows


def _window_for(
    segment: dict[str, Any],
    index: int,
    probe: dict[str, Any] | None,
) -> InputWindow:
    def legacy(reason: str) -> InputWindow:
        return InputWindow(input_index=index, eligible=False, reason=reason)

    if segment["asset_kind"] != "video":
        return legacy("非视频段（image/audio 走旧图）")
    if segment.get("track_hidden", False):
        return legacy("隐藏轨道")
    if segment.get("reverse_playback", False):
        return legacy("倒放段")
    if isinstance(segment.get("keyframes"), dict) and segment["keyframes"]:
        return legacy("关键帧动画（复杂时域滤镜）")
    if (
        isinstance(segment.get("transform"), dict)
        and segment["transform"]
        and segment.get("track_id", "V1") == "V1"
    ):
        # 主轨段上的 transform 会引入 color+overlay 复合链（黑底时长按
        # 窗口算术换算）——保守不与深定位组合。覆盖轨（PiP）段的
        # transform 是浮层元素语义的一部分（_pip_overlay_chain 内建处理
        # 缩放/旋转/透明度，不产生额外时间域滤镜），放行。
        return legacy("静态变换（主轨保守不放行）")
    if segment.get("reframe") or segment.get("mask") or segment.get("keying"):
        return legacy("重构图/蒙版/抠像")
    seekable, reason = _stream_seekable(probe)
    if not seekable:
        return legacy(reason)
    source_start_us = int(segment["source_start_us"])
    if source_start_us < MIN_SEEK_US:
        return legacy("源起点过浅（定位无收益）")
    # 粗定位点 = 段源起点（准确 seek 语义：FFmpeg 从该时间起供给，
    # 精裁 trim 坐标回移该量）。音频与视频用同一窗口和同一回移量。
    # C21b 放行集：正向 1x/变速、带/不带转场借用、主轨与覆盖轨（PiP）
    # 段——窗口算术与滤镜链对每类的源坐标换算见 test_render_seek_parity
    # 的对拍（变速 head/tail 借用×速度换算、转场双路取窗、PiP 独立输入）。
    return InputWindow(
        input_index=index,
        eligible=True,
        reason="",
        seek_us=source_start_us,
        shift_us=source_start_us,
    )


def append_input_seek_args(args: list[str], windows: list[InputWindow],
                           segment_paths: list[Any]) -> None:
    """把 -ss 参数插到对应 -i 之前（原 args 只含 [-i path] 序列）。

    只为 eligible 窗口插入 `-ss <secs>`；legacy 输入零改动。就地修改
    args（调用方按段序组装输入段——与旧图完全同序，仅插入定位参数）。
    """
    for position, path in enumerate(segment_paths):
        window = windows[position] if position < len(windows) else None
        if window is not None and window.eligible:
            args += ["-ss", _seconds(window.seek_us)]
        args += ["-i", str(path)]


def _seconds(value_us: int) -> str:
    return f"{int(value_us) / MICRO:.6f}"
