"""B11 代理档位与时间映射纯函数（计划第 6 节 B11）。

- 档位：短边 540/720/1080，禁止上采样；保持旋转/SAR 后的显示比例；
  编码宽高为偶数。
- 归一化：MP4/AVC、yuv420p、faststart、CFR30、GOP≤15 帧、无 B 帧。
- 时间映射：以原源微秒为权威，proxyTimeUs = sourceTimeUs - origin_us；
  禁止用 avg_frame_rate 直接换算原片帧号。

FFmpeg 参数只在本模块白名单式组装（编码器禁传 veryfast——libx264 档位
预设、libopenh264 比特率、硬编仅 flags 参数），调用方不可注入任意参数。
"""
from __future__ import annotations

from typing import Any

# 输出时间域：当前合成时间域 30fps（ir.py FPS 同源常量，代理侧保持一致）
OUTPUT_FPS = 30
# GOP 上限（帧）：闭合 GOP 减少回退重解代价（B11 规范"≤15 帧"）
GOP_FRAMES = 15

# 短边档位（显示域短边像素）。档位字符串参与派生缓存 params——新增/修改
# 档位即键变化，不与旧条目互撞。
PROFILE_IDS = ("preview-540-v1", "preview-720-v1", "preview-1080-v1")
_SHORT_EDGE_BY_PROFILE = {
    "preview-540-v1": 540,
    "preview-720-v1": 720,
    "preview-1080-v1": 1080,
}


def short_edge(profile_id: str) -> int:
    if profile_id not in _SHORT_EDGE_BY_PROFILE:
        raise ValueError(f"unknown proxy profile: {profile_id}")
    return _SHORT_EDGE_BY_PROFILE[profile_id]


def display_size(width: int, height: int, sar: float, rotation: int) -> tuple[int, int]:
    """旋转/SAR 归一后的显示尺寸（整数）。负/非法几何返回 (0, 0)。"""
    if width <= 0 or height <= 0:
        return 0, 0
    disp_w = width * (sar if sar > 0 else 1.0)
    if rotation in (90, 270):
        return int(round(height)), int(round(disp_w))
    return int(round(disp_w)), int(round(height))


def coded_size(profile_id: str, width: int, height: int, sar: float = 1.0,
               rotation: int = 0) -> tuple[int, int]:
    """档位编码尺寸：短边 min(档位, 原短边)（禁止上采样），偶数。

    90°/270° 旋转源：先换轴再缩放（编码产物已含旋转元数据，显示短边
    即编码短边）。奇数结果向内收 1 像素（不越档、不上采样）。
    """
    target = short_edge(profile_id)
    disp_w, disp_h = display_size(width, height, sar, rotation)
    if disp_w <= 0 or disp_h <= 0:
        raise ValueError("invalid source geometry for proxy sizing")
    short = min(disp_w, disp_h)
    if short <= target:
        scale = 1.0
    else:
        scale = target / short
    w = max(2, int(round(disp_w * scale)) // 2 * 2)
    h = max(2, int(round(disp_h * scale)) // 2 * 2)
    return w, h


# ---- 编码参数（白名单式组装；调用方不可追加任意参数） ----

# 各编码器专属（编码器探测失败回退软件，由 encoders.py choose 决定）：
# - libx264：质量档位预设（crf 23 平衡）；"-preset veryfast" 禁止用于硬编
#   编码器（计划第 6 节），软件 x264 走自身档位体系。
# - libopenh264：CBR 比特率。
# - h264_nvenc/h264_qsv/h264_amf：短边≤720 档低比特率，1080 档提高，
#   并显式禁用 B 帧（nvenc 支持 -bf 0；qsv/amf 经通用 flags 路径）。
_X264_RATE = ["-preset", "medium", "-crf", "23"]
_OPENH264_RATE = ["-b:v", "2M"]
_HW_RATE_BY_SHORT = {540: "3M", 720: "5M", 1080: "9M"}


def _rate_args(profile_id: str, encoder: str) -> list[str]:
    """编码器专属码率/质量参数（硬编不给 veryfast——计划 B11 硬约束）。"""
    if encoder == "libopenh264":
        return list(_OPENH264_RATE)
    if encoder == "libx264":
        return list(_X264_RATE)
    if encoder in {"h264_nvenc", "h264_qsv", "h264_amf"}:
        return ["-b:v", _HW_RATE_BY_SHORT[short_edge(profile_id)]]
    raise ValueError(f"encoder not allowed for proxy: {encoder}")


def proxy_args(
    input_path: str,
    output_path: str,
    profile_id: str,
    width: int,
    height: int,
    encoder: str,
    *,
    sar: float = 1.0,
    rotation: int = 0,
) -> list[str]:
    """全源代理 FFmpeg 参数（pts 归零 + CFR30 + 偶数尺寸 + 无 B 帧）。

    负责整段代理（不是 build_render_args 的 10 秒 sample）：`-copyts` 不用，
    `-ss 0` 显式丢弃源起始 PTS 偏移（rewrite timestamps，代理 PTS 0 起）
    ——decode-worker demux PTS 即原源零基时间。
    尺寸计算失败（无视频流）抛 ValueError，调用方拒绝生成。
    """
    w, h = coded_size(profile_id, width, height, sar, rotation)
    args: list[str] = [
        "-hide_banner", "-nostdin", "-y",
        # 全源（不限制时长）：pts 归零 = rewrite；-ss 0 丢弃源首帧偏移
        "-ss", "0",
        "-i", str(input_path),
        "-map", "0:v:0",
        "-an",  # 音频仍走原素材（B15 服务）；代理 AAC 延迟不混入播放时间基
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=disable:force_divisible_by=2,fps={OUTPUT_FPS}",
        "-c:v", encoder,
        *_rate_args(profile_id, encoder),
        "-pix_fmt", "yuv420p",
        "-r", str(OUTPUT_FPS),
        "-g", str(GOP_FRAMES),
        "-keyint_min", str(GOP_FRAMES),
        "-sc_threshold", "0",  # 场景切换不插关键帧 → 严格闭合 GOP
        "-bf", "0",  # 无 B 帧：seek/喂包顺序简单，避免 DTS/PTS 交错复杂度
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        str(output_path),
    ]
    return args


# ---- 时间映射 ----

def proxy_time_us(source_time_us: int, origin_us: int) -> int:
    """原源时间（微秒，权威）→ 代理时间。原源 PTS 零点归一（计划 B11：
    source_origin_us 为首显示帧 PTS；不能直接用 avg_frame_rate 猜索引）。"""
    return int(source_time_us) - int(origin_us)


def source_time_us(proxy_time_us_value: int, origin_us: int) -> int:
    """逆映射（诊断/测试对拍）。"""
    return int(proxy_time_us_value) + int(origin_us)


def frame_n_to_source_us(frame_n: int) -> int:
    """30fps 等效帧号 → 原源微秒（帧中点采样：f + 0.5 帧消 0/1 偏置）。

    与 decode-worker 的最近邻 PTS 匹配（±33ms 容差）配套：CFR30 代理的
    第 f 帧 PTS=f/30s，帧中点请求稳定命中第 f 帧。此映射只用于构造解码
    请求，不用来判定原片的显示帧（那由真实 PTS 最近邻决定）。
    """
    return int(round((int(frame_n) + 0.5) * 1_000_000 / OUTPUT_FPS))


def choose_profile(disp_w: int, disp_h: int, budget_short_edge: int = 720) -> str:
    """按原源显示短边选择代理档位。

    - 短边 ≤ 540 → 540 档（已是常见竖屏源尺寸；不长边取高，避免方形
      源 720×720 升到 720 档时编码尺寸 720×720 其实超过原 540 短边——
      禁止上采样由 coded_size 封顶，档位只决定目标）。
    - 540 < 短边 ≤ 720 → 720 档；> 720 → 1080 档。
    - budget_short_edge：调用方预算上限（B13 接入显存/负载预算时可降档；
      当前默认 720——高分辨率源降到 720 档，预览画布≤1080 的场景足够）。
    """
    if disp_w <= 0 or disp_h <= 0:
        raise ValueError("invalid geometry for profile choice")
    short = min(disp_w, disp_h)
    if budget_short_edge <= 540:
        return "preview-540-v1"
    if short <= 540:
        return "preview-540-v1"
    if short <= 720 or budget_short_edge <= 720:
        return "preview-720-v1"
    return "preview-1080-v1"


def normalize_source(stream: dict[str, Any]) -> dict[str, Any] | None:
    """视频流归一（来自 media_info_json video_streams[0] 的宽泛 dict）。

    返回 dict：width/height/rotation/sar_num/sar_den/fps_num/fps_den/
    codec（缺失字段为 0/None）。无可用几何（宽高 ≤ 0）返回 None。
    """
    if not isinstance(stream, dict):
        return None
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        return None
    return {
        "codec": stream.get("codec"),
        "width": width,
        "height": height,
        "rotation": int(stream.get("rotation") or 0) % 360,
        "sar_num": int(stream.get("sample_aspect_ratio_num") or 0),
        "sar_den": int(stream.get("sample_aspect_ratio_den") or 0),
        "fps_num": int(stream.get("avg_frame_rate_num") or 0),
        "fps_den": int(stream.get("avg_frame_rate_den") or 0),
    }


def normalized_codec(raw: Any) -> str | None:
    """codec 归一小写（None 安全）。"""
    return str(raw).lower() if raw else None
