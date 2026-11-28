"""P203 回归锁：带 display matrix 旋转的素材必须被「不旋转」地解码。

**为什么在 unit/ 而不是 integration/**：本仓的强制 Python 门
（`tools/ci/run_pytest_gate.py` → `pnpm test:python` → CI `python-unit` job）
只收集 `services/core/tests/unit` 与 `integration/test_*_routes.py`。本文件原先
放在 `integration/` 且文件名不匹配 `test_*_routes.py`，因此**从未在任何门里执行过**——
一个不执行的回归锁等于没有。挪入 unit 后由强制门覆盖。

**为什么带 skipif 而 integration/ 里没有**：unit 侧调用随包 ffmpeg 的既有先例
（`test_keyframe_encode.py:32`）都用 `pytestmark = pytest.mark.skipif(not FFMPEG.exists())`。
"缺 ffmpeg 就静默跳过"不会变成假绿——`tools/ci/check_pytest_skips.py` 对白名单外的
任何 skip 直接非零退出，而 CI 会先按 ffmpeg-manifest.json 取回二进制，因此在本仓
runner 上这些用例必须真跑。


**这个锁守的是什么**：`decode_nv12_frames` 曾不加 `-noautorotate`，而 ffmpeg 默认
按 display matrix 旋转后输出像素，导致 NV12 平面**行宽错位** ⇒ 画面横向条纹花屏
（2026-11-01 真机复现，与用户截图一致）。

**⚠️ 为什么不能用「长度/尺寸」做断言（第一版踩过的坑）**：
NV12 的 `width*height*1.5` 对宽高互换**恒等**（乘法可交换），所以
`len(frame.y) == width*height` 在旋转与不旋转时**都成立**——第一版锁用这个判据，
变异（移除 `-noautorotate`）后**仍然全绿**，是个假锁。

**实际差异只有内容**：实测同一帧「加/不加 `-noautorotate`」输出字节数相同但
**87.7% 的字节不同**。故本锁改用**内容结构**判据：
旋转后的画面把「行」和「列」对调，其**行间相关性**会显著下降。
正常竖直画面相邻行高度相关；行宽错位的花屏则近似随机。

**夹具为何现造**：用 `-display_rotation` 给现有夹具加旋转元数据（`-c copy` 不重编码）。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from aivs_core.media.ffprobe import normalize_probe
from aivs_core.media.frame_decode import decode_frames
from aivs_core.rendering.ffmpeg import build_timeline_args

REPO = Path(__file__).resolve().parents[4]
FFMPEG = REPO / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
FFPROBE = REPO / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe"
BASE = REPO / "test-assets" / "test-faststart.mp4"

# 与 test_keyframe_encode.py 同口径：随包 ffmpeg 缺失时跳过（由 skip 门兜底）。
pytestmark = pytest.mark.skipif(not FFMPEG.exists(), reason="随包 ffmpeg 不在预期位置")


def _decode_raw(path: Path, extra: list[str], width: int, height: int) -> bytes:
    proc = subprocess.run(
        [str(FFMPEG), "-v", "error", *extra, "-i", str(path),
         "-frames:v", "1", "-pix_fmt", "nv12", "-f", "rawvideo", "pipe:1"],
        check=True, capture_output=True,
    )
    return proc.stdout


def _row_correlation(buf: bytes, width: int, height: int, rows: int = 120) -> float:
    """相邻行「相同列位置」的归一化相关度（0..1，越高越像正常画面）。

    正常画面相邻行几乎相同 ⇒ 接近 1；行宽错位后每行被平移 ⇒ 显著降低。
    """
    import statistics

    pairs: list[float] = []
    span = min(height - 1, rows)
    for r in range(1, span + 1):
        prev = buf[(r - 1) * width: r * width]
        cur = buf[r * width: (r + 1) * width]
        if len(prev) != width or len(cur) != width:
            continue
        mp, mc = statistics.fmean(prev), statistics.fmean(cur)
        var_p = statistics.fmean((v - mp) ** 2 for v in prev)
        var_c = statistics.fmean((v - mc) ** 2 for v in cur)
        if var_p <= 1e-9 or var_c <= 1e-9:
            continue
        cov = statistics.fmean((a - mp) * (b - mc) for a, b in zip(prev, cur))
        pairs.append(cov / ((var_p ** 0.5) * (var_c ** 0.5)))
    return statistics.fmean(pairs) if pairs else 0.0


@pytest.fixture(scope="module")
def rotated_fixture(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, int, int]:
    out = tmp_path_factory.mktemp("rot") / "rot90.mp4"
    subprocess.run(
        [str(FFMPEG), "-v", "error", "-display_rotation", "90", "-i", str(BASE),
         "-c", "copy", "-y", str(out)],
        check=True, capture_output=True,
    )
    probe = subprocess.run(
        [str(FFPROBE), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-show_entries", "stream_side_data=rotation",
         "-of", "default=noprint_wrappers=1", str(out)],
        check=True, capture_output=True, text=True,
    )
    info = dict(line.split("=", 1) for line in probe.stdout.strip().splitlines() if "=" in line)
    assert "rotation" in info, "夹具未带上 rotation 元数据 ⇒ 本锁会空转"
    return out, int(info["width"]), int(info["height"])


def test_lock_fixture_actually_rotates(rotated_fixture) -> None:
    """前置守卫：该夹具在「加/不加 -noautorotate」下必须产出**不同内容**。

    若相同，说明夹具构造已变（ffmpeg 版本行为或元数据写入方式变了），
    后面的相关性断言就会变成恒真——**必须先红，不能空转**。
    """
    path, width, height = rotated_fixture
    with_flag = _decode_raw(path, ["-noautorotate"], width, height)
    without_flag = _decode_raw(path, [], width, height)
    assert len(with_flag) == len(without_flag), "两者长度本应相同（NV12 恒等）"
    diff = sum(1 for a, b in zip(with_flag, without_flag) if a != b)
    assert diff > len(with_flag) * 0.1, (
        f"加/不加 -noautorotate 只差 {diff}/{len(with_flag)} 字节 ⇒ 夹具不再触发旋转，"
        "本锁已空转，请修复夹具或换素材"
    )


@pytest.mark.asyncio
async def test_rotated_source_decoded_without_rotation(rotated_fixture) -> None:
    path, width, height = rotated_fixture
    frames = await decode_frames(
        FFMPEG, FFPROBE, path,
        width=width, height=height,
        frame_numbers=[0], fps=30.0,
    )
    assert frames, "未解出帧"
    corr = _row_correlation(bytes(frames[0].y), width, height)
    assert corr > 0.8, (
        f"相邻行相关度 {corr:.3f} 过低 ⇒ 平面被按旋转后尺寸切分（缺 -noautorotate）"
    )


def test_row_correlation_discriminates(rotated_fixture) -> None:
    """区分力对照：旋转输出（错误）的相关度必须**显著低于**不旋转（正确）。

    这条保证 `_row_correlation` 本身有判别力，而不是恒返回高值。
    """
    path, width, height = rotated_fixture
    good = _decode_raw(path, ["-noautorotate"], width, height)
    bad = _decode_raw(path, [], width, height)
    good_corr = _row_correlation(good, width, height)
    bad_corr = _row_correlation(bad, width, height)
    assert good_corr > bad_corr + 0.1, (
        f"两种输出的相关度过于接近（good={good_corr:.3f} bad={bad_corr:.3f}）⇒ 判据无区分力"
    )


def _probe_normalized(path: Path) -> dict:
    proc = subprocess.run(
        [str(FFPROBE), "-v", "error", "-print_format", "json", "-show_streams", str(path)],
        check=True, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return normalize_probe(json.loads(proc.stdout), path)


def _render_portrait_and_sample(tmp_path: Path, name: str, src: Path, probe: dict, *, on_v2: bool) -> bytes:
    out = tmp_path / f"{name}.mp4"
    segments = [
        {
            "clip_id": "c0",
            "track_id": "V2" if on_v2 else "V1",
            "track_index": 0,
            "asset_kind": "video",
            "source_start_us": 0,
            "source_end_us": 1_000_000,
            "timeline_start_us": 0,
            "timeline_end_us": 1_000_000,
            "layout": "fit",
            "audio_enabled": False,
            "gain_db": 0.0,
            "transform": {"x": 0.5, "y": 0.5, "scale": 1.0},
        }
    ]
    plan = {
        "segments": segments,
        "captions": {"items": []},
        "output": {"width": 180, "height": 320, "fps_num": 30, "fps_den": 1},
    }
    args = build_timeline_args(plan, [src], [probe], "libopenh264", str(out), captions=False)
    subprocess.run([str(FFMPEG), "-hide_banner", "-y", *args], check=True, capture_output=True)
    raw = subprocess.run(
        [str(FFMPEG), "-v", "error", "-ss", "0.5", "-i", str(out),
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        check=True, capture_output=True,
    ).stdout
    assert len(raw) == 180 * 320 * 3
    return raw


def _rgb_at(buf: bytes, x: int, y: int) -> tuple[int, int, int]:
    idx = (y * 180 + x) * 3
    return buf[idx], buf[idx + 1], buf[idx + 2]


def test_rotated_portrait_ffmpeg_render_fills_916_canvas(tmp_path: Path) -> None:
    """P206 真 FFmpeg 像素锁：rotation=-90 竖拍素材渲染到 9:16 竖画布必须四边铺满无黑边。"""
    plain = tmp_path / "plain.mp4"
    rot = tmp_path / "rot_neg90.mp4"
    subprocess.run(
        [str(FFMPEG), "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=1.0",
         "-c:v", "libopenh264", "-b:v", "2M", "-pix_fmt", "yuv420p", "-an", "-y", str(plain)],
        check=True, capture_output=True,
    )
    subprocess.run(
        [str(FFMPEG), "-v", "error", "-display_rotation", "-90", "-i", str(plain),
         "-c", "copy", "-y", str(rot)],
        check=True, capture_output=True,
    )
    rot_probe = _probe_normalized(rot)
    plain_probe = _probe_normalized(plain)
    assert rot_probe["video_streams"][0]["width"] == 320
    assert rot_probe["video_streams"][0]["height"] == 180
    assert rot_probe["video_streams"][0]["rotation"] in (90, 270)

    for tag, on_v2 in [("v2", True), ("v1_tx", False)]:
        buf = _render_portrait_and_sample(tmp_path, f"rot_{tag}", rot, rot_probe, on_v2=on_v2)
        for px, py in [(90, 8), (90, 312), (8, 160), (172, 160)]:
            r, g, b = _rgb_at(buf, px, py)
            assert b > 180 and r < 40 and g < 40, f"{tag} ({px},{py})={(r,g,b)}"

    # 负向对照：未旋转横拍 320×180 在 180×320 竖画布上下留黑、仅中心为蓝
    plain_buf = _render_portrait_and_sample(tmp_path, "plain_neg", plain, plain_probe, on_v2=True)
    for px, py in [(90, 8), (90, 312)]:
        assert max(_rgb_at(plain_buf, px, py)) < 20
    _, _, cb = _rgb_at(plain_buf, 90, 160)
    assert cb > 180
