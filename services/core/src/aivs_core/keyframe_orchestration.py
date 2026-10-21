"""W3.3 编排层：把编码（S1a）/ 抽样（S1b）/ 外传预览（S2）串起来。

分层：
  media/keyframe_sampling.py  纯函数抽样决策
  media/keyframe_encode.py    单帧 → JPEG 载荷 + 缩略图
  keyframe_egress.py          三段式 + 载荷文件 + 清理
  本模块                      读切点、判定可用性、编排、落 meta

**本模块不发网络**。真正的外传在 S3（vision 适配器）与 S4（打标作业）。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .database import Database
from .ids import new_id
from .keyframe_egress import KeyframeEgressService
from .media.cv_signals import CV_ALGORITHM_VERSION
from .media.keyframe_encode import encode_frames
from .media.keyframe_sampling import DEFAULT_INTERVAL_US, SamplingPlan, select_frames
from .projects import DomainError


def scene_cut_timestamps(db: Database, asset_id: str) -> list[int] | None:
    """读该素材**当前算法版本** ready 分析里的切点时刻。

    返回值语义（与 keyframe_sampling 的区分一致）：
      None  ⇒ 没有可用的 CV 分析（降级 interval_only）
      []    ⇒ 分析过但一个切点也没有（仍是 scene_cut 模式）
      [...] ⇒ 切点时刻

    **为什么不复用 CvSignalService.samples_for_range**：那个接口按时间范围
    聚合，拿全片切点要传整段范围；而这里只需要 scene_cut 这一列，
    直接查更省（也避免它对 sparse 密度的额外处理）。
    """
    with db.connection() as conn:
        analysis = conn.execute(
            "SELECT id FROM cv_analyses WHERE asset_id=? AND status='ready' "
            "AND algorithm_version=? ORDER BY created_at DESC LIMIT 1",
            (asset_id, CV_ALGORITHM_VERSION),
        ).fetchone()
        if analysis is None:
            return None
        rows = conn.execute(
            "SELECT timestamp_us FROM cv_samples "
            "WHERE analysis_id=? AND scene_cut=1 ORDER BY timestamp_us",
            (analysis["id"],),
        ).fetchall()
    return [int(row["timestamp_us"]) for row in rows]


def plan_for_asset(
    db: Database, asset_id: str, duration_us: int,
    *, interval_us: int = DEFAULT_INTERVAL_US,
) -> tuple[SamplingPlan, list[int] | None]:
    """读切点 + 出抽样计划（纯决策，不解码）。"""
    cuts = scene_cut_timestamps(db, asset_id)
    plan = select_frames(cuts, duration_us, interval_us=interval_us)
    return plan, cuts


class KeyframeOrchestrator:
    """把「计划 → 编码 → 落预览」串成一次 prepare。"""

    def __init__(self, db: Database, egress: KeyframeEgressService, ffmpeg: Path) -> None:
        self.db = db
        self.egress = egress
        self.ffmpeg = ffmpeg

    async def prepare_preview(
        self,
        project_id: str,
        asset_row: dict[str, Any],
        provider: dict[str, Any],
        input_path: Path,
        duration_us: int,
        *,
        interval_us: int = DEFAULT_INTERVAL_US,
        cancel_event: Any = None,
    ) -> dict[str, Any]:
        """整条零网络链路：读切点 → 计划 → 编码 → 落库。"""
        if duration_us <= 0:
            raise DomainError("VISION_FRAMES_UNMAPPED", "素材时长无效")
        if not provider.get("provider_config_id"):
            raise DomainError("VISION_PROVIDER_UNSUPPORTED", "未指定 Provider")
        plan, _cuts = plan_for_asset(
            self.db, asset_row["id"], duration_us, interval_us=interval_us,
        )
        if plan.frame_count == 0:
            raise DomainError("VISION_FRAMES_UNMAPPED", "抽样未得到任何帧")
        frames = await encode_frames(
            self.ffmpeg, input_path, list(plan.frames), cancel_event=cancel_event,
        )
        return self.egress.prepare(project_id, asset_row, provider, frames, plan)


def ensure_video_asset(asset_row: dict[str, Any]) -> None:
    """无视频流 ⇒ 直接拒绝，不登记必然失败的作业（P76 教训）。

    用 availability + kind 双判据而不是「试着解一帧」：
    导入侧已经保证了 kind 与可用性语义（projects「kind == video 才要求视频流」），
    这里重复探测只会多起一个 ffmpeg 进程。
    """
    if asset_row.get("kind") != "video":
        raise DomainError("VISION_FRAMES_UNMAPPED", "该素材不是视频，无法抽帧")
    if asset_row.get("availability") != "available":
        raise DomainError("ASSET_MISSING", "素材当前不可用")


def new_generation_marker() -> str:
    """便于测试与日志追溯的生成序号（不落库，仅用于本次调用）。"""
    return new_id()
