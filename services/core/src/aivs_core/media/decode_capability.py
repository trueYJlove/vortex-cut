"""P30：`ffmpeg -decoders` 能力表数据源（规划门 §2.5）+ FFmpeg build 指纹失效重探。

风险（规划门 §5）：能力表探测结果缓存过期（换 FFmpeg/驱动后不刷新）。
对策（P30）：
- 探测结果带 `probed_at` + **FFmpeg build 指纹键**；
- 指纹变化（换 FFmpeg 二进制）即自动重探，不再沿用陈旧结论；
- 缓存只在进程内（Core 重启即重探——「Core 重启重探」）。

数据面：Desktop 的 DecodeCapabilityTable 中 `ffmpeg_supported` 的唯一数据源
（此前 probeDecodeCapability 空参调用使该位恒为 false）。
"""
from __future__ import annotations

import hashlib
import subprocess
from datetime import UTC, datetime
from typing import Any, Callable

# 与 contracts DECODE_CAPABILITY_CODECS 对齐。
DECODE_CAPABILITY_CODECS = ("avc", "hevc", "av1")

# `ffmpeg -decoders` 输出行里的解码器名（取并集；别名随版本漂移，宁宽勿漏——
# 只影响「FFmpeg 后端可选」判断，实际解码失败仍有工厂回退与 P28 降级兜底）。
_DECODER_NAMES: dict[str, frozenset[str]] = {
    "avc": frozenset({"h264", "h264_cuvid", "h264_qsv", "h264_d3d11va", "h264_dxva2"}),
    "hevc": frozenset({"hevc", "hevc_cuvid", "hevc_qsv", "hevc_d3d11va", "hevc_dxva2"}),
    "av1": frozenset({"av1", "av1_cuvid", "av1_qsv", "libdav1d"}),
}

Runner = Callable[[list[str]], str]


def _subprocess_runner(args: list[str]) -> str:
    completed = subprocess.run(args, capture_output=True, text=True, timeout=30, check=False)
    return completed.stdout


class DecodeCapabilityProbe:
    """`ffmpeg -decoders` 单一真相（进程内缓存 + 指纹失效重探）。"""

    def __init__(self, ffmpeg: Any, runner: Runner | None = None) -> None:
        self._ffmpeg = str(ffmpeg)
        self._runner = runner or _subprocess_runner
        self._cache: dict[str, Any] | None = None

    def _fingerprint(self) -> str:
        # FFmpeg build 指纹：-version 的完整输出（含构建配置行）。
        # 换二进制 → 输出变 → 指纹变 → 重探。
        out = self._runner([self._ffmpeg, "-version"])
        return "sha256:" + hashlib.sha256(out.encode("utf-8", errors="replace")).hexdigest()

    def _probe_decoders(self) -> dict[str, bool]:
        out = self._runner([self._ffmpeg, "-decoders"])
        listed: set[str] = set()
        for line in out.splitlines():
            parts = line.split()
            # 解码器行形如 " V....D h264  H.264 ..."——首列为 6 字符能力标记，
            # 首字符 V=视频；表头/说明行不满足该形状，自然排除。
            if len(parts) >= 2 and len(parts[0]) == 6 and parts[0][0] == "V":
                listed.add(parts[1])
        return {
            codec: bool(names & listed)
            for codec, names in _DECODER_NAMES.items()
        }

    def get(self) -> dict[str, Any]:
        fingerprint = self._fingerprint()
        if self._cache is None or self._cache["ffmpeg_fingerprint"] != fingerprint:
            self._cache = {
                "decoders": self._probe_decoders(),
                "probed_at": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "ffmpeg_fingerprint": fingerprint,
            }
        return dict(self._cache)


__all__ = ["DECODE_CAPABILITY_CODECS", "DecodeCapabilityProbe"]
