"""C20b 窗口化 IR 投影（preview-ir-v2 manifest/window，第 7 节 C20）。

约束（PERFORMANCE_IMPLEMENTATION_PLAN C20b）：
- Core compile 一次生成不可变 manifest（inputs/styles/canvas/segments 等非
  帧字段的显式 DTO）；窗口帧表按请求从缓存的同一投影切片——manifest 与
  窗口数据同源（同一 plan 的 v1 投影），一致性由构造保证。
- 每窗最多 300 帧（frame_count 1..300）；随机窗口拼接与 v1 逐帧深度相等
  （在 v1 支持范围内）——见 test_render_ir_window。
- v1 endpoint/response 完全保留；v2 独立 endpoint，不让同一路由静默改变
  frames 形状。
- 纯函数：同 plan 必得同投影（与 project_preview_ir 单点共享帧语义——
  v1 帧计算是 t_exact 的纯函数，切片即等价；RegionSweep/IntervalLookup
  的 active_at 状态恢复语义见 ir_window 对 v1 全量投影的逐帧深比较测试）。
"""
from __future__ import annotations

from typing import Any

from .ir import (
    FPS,
    IR_PROJECTOR_VERSION,
    project_preview_ir,
)

IR_V2_SCHEMA = "preview-ir-v2"
MAX_WINDOW_FRAMES = 300
DEFAULT_WINDOW_FRAMES = 150


def manifest_id_of(plan: dict[str, Any]) -> str:
    """manifest 身份 = 内容指纹 + 模式 + 输出规格（profile_id 含 ratio）。

    revision/编辑/比例变化 → content_fingerprint 变化 → 新 manifest；同
    fingerprint 的窗口请求共享同一投影缓存。
    """
    return f"{plan['content_fingerprint']}@{plan['mode']}@{plan['output']['profile_id']}"


def build_manifest(plan: dict[str, Any], probes: dict[str, dict[str, Any]],
                   caption_styles: dict[str, Any] | None = None,
                   *, ir: dict[str, Any] | None = None) -> dict[str, Any]:
    """v2 manifest：非帧字段的显式 DTO。

    两种用法：
    - 纯函数路径：不传 ir，完整投影一次（复用 v1 单点语义）——测试/工具用；
    - 缓存复用路径：传 ir（service 已投影的全量 IR），直接拆 manifest 字段
      ——生产路径（manifest 与窗口切片同源，零重复投影）。
    """
    if ir is None:
        ir = project_preview_ir(plan, probes, caption_styles)
    return {
        "schema": IR_V2_SCHEMA,
        "projector_version": IR_PROJECTOR_VERSION,
        "manifest_id": manifest_id_of(plan),
        "timeline_revision_id": plan["timeline_revision_id"],
        "content_fingerprint": plan["content_fingerprint"],
        "fps_num": FPS,
        "fps_den": 1,
        "total_frames": ir["canvas"]["duration_frames"],
        "duration_us": ir["canvas"]["duration_us"],
        "canvas": ir["canvas"],
        "inputs": ir["inputs"],
        "segments": ir["segments"],
        "captions": ir["captions"],
        "caption_styles": ir["caption_styles"],
        "transition_windows": ir["transition_windows"],
        "known_approximations": ir["known_approximations"],
    }
