"""W2.1 机位同步：音频互相关 → 机位时间偏移表（本地、零 egress）。

冻结口径见 docs/W2_1_CAMERA_SYNC_PLANNING_GATE_2026-10-10.md §2.1/§2.2（评审修订版）：
- PCM：48kHz / 单声道（显式下混）/ f32le / 单遍流式（不复用 audio_chunks 的块路径）；
- 算法：包络（10ms RMS）归一化互相关粗对齐 → 按粗对齐平移后取 2s 窗做样本级归一化互相关
  → 双窗一致性 → 归一化相关峰置信度阈值；
- stale：读时计算（不落状态位）；指纹入唯一键（素材变更 = 新行，旧行保留）。

实现约束（Planning Gate §2.4 spike 踩出来的三个坑）：
1. 符号约定由 test_sign_convention 钉死（offset_us = -(peak - zero) * unit）；
2. 精对齐窗必须按粗对齐平移之后再取（否则偏移被双计成 2x）；
3. 负偏移对称处理（参考窗后移，而非只处理 start >= 0）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from ..projects import DomainError

ANGLE_SYNC_ALGORITHM_VERSION = 1
SAMPLE_RATE = 48_000
ENVELOPE_HOP = 480
COARSE_MAX_S = 60.0
FINE_WINDOW_S = 2.0
FINE_WINDOW_OFFSET_S = 1.0
CONFIDENCE_THRESHOLD = 0.5
DUAL_WINDOW_TOLERANCE_US = 5_000
MIN_WINDOW_S = 1.0
# R1（时钟漂移）：在相隔 DRIFT_WINDOW_SPACING_S 的两处各测一次残差；两者的差
# 就是这段跨度上的漂移量。超阈 ⇒ 如实判 unavailable(clock_drift)——**不静默给单值**
# （单偏移在漂移下两端各错一半，剪辑点会整体偏）。分段偏移/线性拟合按 D4 待真实
# 素材取证后再实现。
DRIFT_WINDOW_SPACING_S = 20.0
DRIFT_TOLERANCE_US = 10_000
DECODE_PREROLL_S = 0.5
MANUAL_OFFSET_LIMIT_US = 600_000_000


def _xcorr(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, int]:
    """归一化互相关（0-lag 居中）：返回 (corr, zero_index)。

    经验约定（sign check 钉死）：offset_us = -(peak - zero_index) * unit。
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    a = a - float(np.mean(a))
    b = b - float(np.mean(b))
    size = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    corr = np.fft.irfft(np.fft.rfft(a, size) * np.conj(np.fft.rfft(b, size)), size)
    corr = np.concatenate((corr[-(len(b) - 1):], corr[: len(a)]))
    norm = float(np.sqrt(float(np.sum(a ** 2)) * float(np.sum(b ** 2)))) + 1e-12
    return corr / norm, len(b) - 1


def envelope(pcm: np.ndarray) -> np.ndarray:
    """10ms hop 的 RMS 包络（粗对齐用）。"""
    frames = len(pcm) // ENVELOPE_HOP
    if frames < 2:
        return np.zeros(0, dtype=np.float64)
    trimmed = pcm[: frames * ENVELOPE_HOP].reshape(frames, ENVELOPE_HOP)
    return np.sqrt(np.mean(trimmed ** 2, axis=1) + 1e-12)


def _take(pcm: np.ndarray, start_sample: int, samples: int) -> np.ndarray | None:
    """按（可负）起点取窗；负起点 = 参考窗后移（坑 3）。"""
    if start_sample >= 0:
        window = pcm[start_sample:start_sample + samples]
    else:
        window = pcm[: max(samples + start_sample, 0)]
    return window if len(window) == samples else None


def _fine_residual(
    ref: np.ndarray, mem: np.ndarray, coarse_us: float, window_offset_s: float
) -> tuple[float, float]:
    """在粗对齐处取窗做样本级精对齐。

    坑 2：**两个窗必须同步平移**——成员窗右移粗对齐量，参考窗右移第二窗偏移量；
    只移一侧会把偏移双计，完全不移则第二窗的偏移量无处体现。
    """
    base = int(round(coarse_us / 1e6 * SAMPLE_RATE))
    offset = int(round(window_offset_s * SAMPLE_RATE))
    samples = int(FINE_WINDOW_S * SAMPLE_RATE)
    if base >= 0:
        # a(t) = ref[t+offset]，b(t) = mem[t+offset+base] ⇒ 残差 = 真值 − base
        a = _take(ref, offset, samples)
        b = _take(mem, offset + base, samples)
    else:
        # 成员整体早于参考：改由参考窗右移 |base|（负偏移对称处理，坑 3）
        a = _take(ref, offset - base, samples)
        b = _take(mem, offset, samples)
    if a is None or b is None:
        return float("nan"), 0.0
    corr, zero = _xcorr(a, b)
    peak = int(np.argmax(np.abs(corr)))
    return -(peak - zero) / SAMPLE_RATE * 1e6, float(abs(corr[peak]))


def measure_offset(ref: np.ndarray, mem: np.ndarray) -> dict[str, Any]:
    """测成员相对参考的偏移（正 = 成员更晚）。"""
    blank = {"offset_us": None, "confidence": 0.0, "coarse_us": None, "dual_delta_us": None,
             "drift_us": None}
    if len(ref) < MIN_WINDOW_S * SAMPLE_RATE or len(mem) < MIN_WINDOW_S * SAMPLE_RATE:
        return {"status": "unavailable", "reason": "window_too_short", **blank}
    ref_env, mem_env = envelope(ref), envelope(mem)
    if len(ref_env) < 2 or len(mem_env) < 2:
        return {"status": "unavailable", "reason": "window_too_short", **blank}
    coarse_corr, coarse_zero = _xcorr(ref_env, mem_env)
    coarse_peak = int(np.argmax(np.abs(coarse_corr)))
    coarse_us = -(coarse_peak - coarse_zero) * ENVELOPE_HOP / SAMPLE_RATE * 1e6
    res1, conf1 = _fine_residual(ref, mem, coarse_us, 0.0)
    res2, conf2 = _fine_residual(ref, mem, coarse_us, FINE_WINDOW_OFFSET_S)
    if res1 != res1 or res2 != res2:
        # 素材短到连「1s 间隔的双窗」都取不齐 ⇒ 给可读 reason（复核 M-b）：
        # window_too_short 说明时长不够，window_out_of_range 才是真正的越界异常。
        short = len(ref) < int((FINE_WINDOW_S + FINE_WINDOW_OFFSET_S) * SAMPLE_RATE)
        return {"status": "unavailable",
                "reason": "window_too_short" if short else "window_out_of_range",
                "offset_us": None, "confidence": 0.0, "coarse_us": int(coarse_us),
                "dual_delta_us": None, "drift_us": None}
    dual_delta_us = abs(res1 - res2)
    confidence = min(conf1, conf2)
    if confidence < CONFIDENCE_THRESHOLD or dual_delta_us > DUAL_WINDOW_TOLERANCE_US:
        return {"status": "unavailable", "reason": "low_confidence", "offset_us": None,
                "confidence": confidence, "coarse_us": int(coarse_us), "dual_delta_us": dual_delta_us,
                "drift_us": None}
    # R1：漂移取证——远距窗口再测一次；偏差超阈即如实拒答（不返回看似可用的单值）
    # drift_us 语义（复核 M-b）：数值 = 该跨度上的实测漂移；**None = 未取证**
    # （素材短于 DRIFT_WINDOW_SPACING_S + 2s，远窗取不齐）。调用方据此知道 R1 检查没跑，
    # 而不是把 None 当成「无漂移」；短视频跨度内的漂移有界（≤ 跨度×时钟差），
    # 故此时照常 ready，属**已知限制**而非静默承诺。
    drift_us: float | None = None
    res_far, conf_far = _fine_residual(ref, mem, coarse_us, DRIFT_WINDOW_SPACING_S)
    if res_far == res_far and conf_far >= CONFIDENCE_THRESHOLD:
        drift_us = res_far - res1
        if abs(drift_us) > DRIFT_TOLERANCE_US:
            return {"status": "unavailable", "reason": "clock_drift", "offset_us": None,
                    "confidence": min(confidence, conf_far), "coarse_us": int(coarse_us),
                    "dual_delta_us": dual_delta_us, "drift_us": int(round(drift_us))}
    return {"status": "ready", "reason": None, "offset_us": int(round(coarse_us + res1)),
            "confidence": confidence, "coarse_us": int(coarse_us), "dual_delta_us": dual_delta_us,
            "drift_us": None if drift_us is None else int(round(drift_us))}


def window_pcm_args(input_path: str, start_s: float, duration_s: float) -> list[str]:
    """窗口 PCM 参数（48k/单声道/f32le；单遍流式，与 audio_chunks 块路径无关）。

    预滚 + atrim 精裁：两个机位各自 -ss 定位，误差不同源会直接污染偏移测量。
    """
    seek_s = max(0.0, start_s - DECODE_PREROLL_S)
    trim_start = start_s - seek_s
    return [
        "-hide_banner", "-nostdin", "-y",
        "-ss", "%.6f" % seek_s,
        "-i", str(input_path),
        "-vn", "-map", "0:a:0",
        "-af", "aresample=%d:async=1:first_pts=0,atrim=start=%.6f:end=%.6f" % (
            SAMPLE_RATE, trim_start, trim_start + duration_s),
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_f32le", "-f", "f32le",
        "pipe:1",
    ]


async def decode_window(
    ffmpeg: Path, input_path: str, start_s: float, duration_s: float,
    cancel_event: asyncio.Event | None = None,
) -> np.ndarray:
    """解码单窗口为 float32 PCM（单声道 48k）；无音轨/失败抛 DomainError。"""
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg), *window_pcm_args(input_path, start_s, duration_s),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert process.stdout is not None and process.stderr is not None
    stdout_task = asyncio.create_task(process.stdout.read())
    stderr_task = asyncio.create_task(process.stderr.read())
    await process.wait()
    raw = await stdout_task
    stderr = (await stderr_task).decode("utf-8", errors="replace")
    if cancel_event is not None and cancel_event.is_set():
        raise DomainError("JOB_CANCELLED", "任务已取消")
    if process.returncode != 0 or not raw:
        raise DomainError("ANGLE_SYNC_NO_AUDIO", "素材无音轨或音频解码失败: " + stderr[-200:])
    return np.frombuffer(raw, dtype="<f4").astype(np.float64)

class AngleSyncService:
    """机位同步服务：组 / 摘要（行选择 + 读时 stale）/ 作业 / 人工偏移。"""

    def __init__(
        self,
        db: Database,
        ffmpeg: Path,
        resolve_asset_path: Callable[[str], dict[str, Any]],
    ) -> None:
        self.db = db
        self.ffmpeg = ffmpeg
        self.resolve_asset_path = resolve_asset_path

    # ---- 组 ----

    def create_group(self, project_id: str, name: str, reference_asset_id: str,
                     member_asset_ids: list[str]) -> dict[str, Any]:
        cleaned = (name or "").strip()
        if not cleaned or len(cleaned) > 120:
            raise DomainError("ANGLE_GROUP_NAME_INVALID", "机位组名称需为 1-120 个字符")
        members = [reference_asset_id] + [
            asset_id for asset_id in member_asset_ids if asset_id != reference_asset_id]
        if len(members) < 2:
            raise DomainError("ANGLE_GROUP_TOO_SMALL", "机位组至少需要 2 个机位")
        assets = self._asset_rows(project_id, members)
        for asset_id in members:
            row = assets.get(asset_id)
            if row is None:
                raise DomainError("ASSET_NOT_FOUND", "机位素材不存在")
            if row["kind"] != "video":
                raise DomainError("ANGLE_GROUP_UNSUPPORTED", "机位必须是视频素材")
        group_id = "angle_group_" + new_id()
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO angle_groups(id,project_id,name,reference_asset_id,"
                "members_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                (group_id, project_id, cleaned, reference_asset_id, json_dumps(members), now, now),
            )
        return self.group_summary(project_id, group_id)

    def list_groups(self, project_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT id FROM angle_groups WHERE project_id=? ORDER BY created_at DESC",
                (project_id,),
            ).fetchall()
        return [self.group_summary(project_id, row["id"]) for row in rows]

    def group_summary(self, project_id: str, group_id: str) -> dict[str, Any]:
        group = self._group_row(project_id, group_id)
        if group is None:
            raise DomainError("ANGLE_GROUP_NOT_FOUND", "机位组不存在")
        members = json_loads(group["members_json"])
        assets = self._asset_rows(project_id, members)
        rows = self._sync_rows(group_id)
        reference_id = group["reference_asset_id"]
        reference = assets.get(reference_id)
        reference_fingerprint = reference["fingerprint"] if reference else None
        angles = [
            self._entry_for(asset_id, assets.get(asset_id), rows, reference_id,
                            reference_fingerprint)
            for asset_id in members
        ]
        return {
            "group_id": group["id"],
            "project_id": group["project_id"],
            "name": group["name"],
            "reference_asset_id": reference_id,
            # 与 CvAnalysisSummary / BeatAnalysisSummary 同口径：DTO 出 **string**
            # （P74 的教训——Core 出 int 而 Desktop 契约要 string，真实接线必红）。
            "algorithm_version": str(ANGLE_SYNC_ALGORITHM_VERSION),
            "angles": angles,
            "created_at": group["created_at"],
            "updated_at": group["updated_at"],
        }

    def _entry_for(self, asset_id: str, asset: dict[str, Any] | None,
                   rows: list[dict[str, Any]], reference_id: str,
                   reference_fingerprint: str | None) -> dict[str, Any]:
        mine = [row for row in rows if row["asset_id"] == asset_id]
        usable = [row for row in mine if row["status"] in ("ready", "unavailable")]
        # 行选择规则（Planning Gate §2.1）：manual 优先 → 版本降序 → 时间降序
        usable.sort(key=lambda row: (row["source"] == "manual", row["algorithm_version"],
                                     row["created_at"]), reverse=True)
        chosen = usable[0] if usable else None
        pending = next((row for row in mine if row["status"] in ("queued", "running")), None)
        entry: dict[str, Any] = {
            "asset_id": asset_id,
            "is_reference": asset_id == reference_id,
            "status": "missing",
            "reason": None,
            "offset_us": None,
            "confidence": None,
            "source": None,
            "stale": False,
            "recorded_at": None,
        }
        if asset is None:
            entry.update(status="unavailable", reason="asset_not_found")
            return entry
        if asset.get("availability") != "available":
            entry.update(status="unavailable", reason="asset_not_available")
            return entry
        if chosen is not None:
            stale = (chosen["asset_fingerprint"] != asset["fingerprint"] or
                     reference_fingerprint is None or
                     chosen["reference_fingerprint"] != reference_fingerprint)
            # 冻结例外（Planning Gate §2.1）：manual 行若 stale，不参与优先——回退到
            # 最佳 auto 行（按正常排序取第一条）并**重算它的失鲜**，同时标注 manual_stale
            # （不让用户修正被一次重导出静默作废，也不让陈旧人工值冒充有效结果）。
            if stale and chosen["source"] == "manual":
                fallback = next((row for row in usable if row["source"] == "auto"), None)
                if fallback is not None:
                    entry["manual_stale"] = True
                    chosen = fallback
                    stale = (chosen["asset_fingerprint"] != asset["fingerprint"] or
                             reference_fingerprint is None or
                             chosen["reference_fingerprint"] != reference_fingerprint)
            entry.update(
                status="stale" if stale else chosen["status"],
                reason=chosen["reason"],
                offset_us=chosen["offset_us"],
                confidence=chosen["confidence"],
                source=chosen["source"],
                stale=stale,
                recorded_at=chosen["created_at"],
            )
        if pending is not None:
            entry["pending"] = True
            entry["status"] = pending["status"]
        return entry

    def delete_group(self, project_id: str, group_id: str) -> dict[str, Any]:
        """删除机位组及其同步行（ON DELETE CASCADE）。组是元数据的所有者，删组即丢同步数据。"""
        group = self._group_row(project_id, group_id)
        if group is None:
            raise DomainError("ANGLE_GROUP_NOT_FOUND", "机位组不存在")
        with self.db.connection() as db:
            db.execute("DELETE FROM angle_groups WHERE id=?", (group_id,))
        return {"group_id": group_id, "deleted": True}

    # ---- 作业 ----

    def create_sync_job(self, project_id: str, group_id: str) -> str | None:
        """登记同步作业；组内全部机位都有指纹相符的可用行时幂等短路（返回 None）。"""
        summary = self.group_summary(project_id, group_id)
        # 短路条件：每个机位都有「指纹相符的可用行」。注意 "unavailable(asset_not_available)"
        # / "asset_not_found" **不算**可用——素材被换掉（availability=changed）时必须允许登记
        # 重算（不然换过素材的组永远重算不了：摘要显示不可用、却又不给作业）。
        def usable(entry: dict[str, Any]) -> bool:
            if entry["status"] not in ("ready", "unavailable"):
                return False
            return entry["reason"] not in ("asset_not_available", "asset_not_found")

        if all(usable(entry) for entry in summary["angles"]):
            return None
        # 在飞短路（复核 M-a）：Core 只在完成时落行，摘要看不到 queued/running，因此
        # 「连点重算」会入队两个作业、两个 worker 并发跑同一组（正是 TOCTOU 的生产同源路径）。
        with self.db.connection() as db:
            active = db.execute(
                "SELECT id FROM jobs WHERE kind='angle_sync' AND status IN ('queued','running') "
                "AND input_json LIKE ?", ("%" + group_id + "%",),
            ).fetchone()
        if active is not None:
            return None
        job_id = new_id()
        now = utc_now()
        payload = {"group_id": group_id, "project_id": project_id}
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,kind,type,status,stage,progress,"
                "input_json,encoder_requested,resource_class,attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, project_id, "angle_sync", "angle_sync", "queued", "queued", 0,
                 json_dumps(payload), None, "light", 1, now, now),
            )
        return job_id

    async def run_sync_job(self, row: Any, cancel_event: asyncio.Event,
                           progress: Callable[[float], None] | None = None,
                           stage: Callable[[str], None] | None = None) -> dict[str, Any]:
        payload = json_loads(row["input_json"])
        group_id = payload.get("group_id")
        project_id = payload.get("project_id")
        group = self._group_row(project_id, group_id) if group_id else None
        if group is None:
            raise DomainError("ANGLE_GROUP_NOT_FOUND", "机位组不存在")
        members = json_loads(group["members_json"])
        reference_id = group["reference_asset_id"]
        assets = self._asset_rows(project_id, members)
        reference = assets.get(reference_id)
        if reference is None:
            raise DomainError("ASSET_NOT_FOUND", "参考机位素材不存在")
        if stage:
            stage("angle_sync:decode")
        duration_s = min(COARSE_MAX_S, self._duration_s(reference))
        ref_pcm = await decode_window(
            self.ffmpeg, self._resolve(reference_id), 0.0, duration_s, cancel_event)
        if progress:
            progress(0.2)
        results: list[dict[str, Any]] = []
        for index, asset_id in enumerate(members):
            if cancel_event.is_set():
                raise DomainError("JOB_CANCELLED", "任务已取消")
            asset = assets.get(asset_id)
            try:
                if asset_id == reference_id:
                    self._insert_row(group_id, asset_id, 0, 1.0, "ready", None, "auto",
                                     reference["fingerprint"], reference["fingerprint"])
                elif asset is None or not self._has_audio(asset):
                    self._insert_row(group_id, asset_id, None, None, "unavailable", "no_audio",
                                     "auto", reference["fingerprint"],
                                     asset["fingerprint"] if asset else None)
                else:
                    mem_pcm = await decode_window(
                        self.ffmpeg, self._resolve(asset_id), 0.0, duration_s, cancel_event)
                    measured = measure_offset(ref_pcm, mem_pcm)
                    self._insert_row(group_id, asset_id, measured["offset_us"],
                                     measured["confidence"], measured["status"],
                                     measured["reason"], "auto", reference["fingerprint"],
                                     asset["fingerprint"])
                results.append({"asset_id": asset_id, "status": "done"})
            except DomainError as exc:
                if exc.code == "JOB_CANCELLED":
                    raise
                status = "unavailable" if exc.code == "ANGLE_SYNC_NO_AUDIO" else "failed"
                self._insert_row(group_id, asset_id, None, None, status, exc.code, "auto",
                                 reference["fingerprint"],
                                 asset["fingerprint"] if asset else None)
                results.append({"asset_id": asset_id, "status": status, "reason": exc.code})
            if progress:
                progress(0.2 + 0.8 * (index + 1) / max(len(members), 1))
        return {"group_id": group_id, "duration_s": duration_s, "results": results}

    # ---- 人工偏移 ----

    def write_manual_offset(self, project_id: str, group_id: str, asset_id: str,
                            offset_us: int) -> dict[str, Any]:
        group = self._group_row(project_id, group_id)
        if group is None:
            raise DomainError("ANGLE_GROUP_NOT_FOUND", "机位组不存在")
        if asset_id not in json_loads(group["members_json"]):
            raise DomainError("ANGLE_ASSET_NOT_IN_GROUP", "该素材不在机位组内")
        if abs(int(offset_us)) > MANUAL_OFFSET_LIMIT_US:
            raise DomainError("ANGLE_OFFSET_OUT_OF_RANGE", "人工偏移超出允许范围（±600s）")
        if asset_id == group["reference_asset_id"] and int(offset_us) != 0:
            raise DomainError("ANGLE_OFFSET_REFERENCE_FIXED", "参考机位偏移必须为 0")
        asset = self._asset_rows(project_id, [asset_id]).get(asset_id)
        reference = self._asset_rows(project_id, [group["reference_asset_id"]]).get(
            group["reference_asset_id"])
        if asset is None or reference is None:
            raise DomainError("ASSET_NOT_FOUND", "素材不存在")
        self._insert_row(group_id, asset_id, int(offset_us), None, "ready", None, "manual",
                         reference["fingerprint"], asset["fingerprint"])
        return self.group_summary(project_id, group_id)

    # ---- 内部 ----

    def _group_row(self, project_id: str, group_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM angle_groups WHERE id=? AND project_id=?",
                (group_id, project_id),
            ).fetchone()
        return dict(row) if row else None

    def _asset_rows(self, project_id: str, asset_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not asset_ids:
            return {}
        placeholders = ",".join("?" for _ in asset_ids)
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT * FROM assets WHERE project_id=? AND id IN (" + placeholders + ")",
                (project_id, *asset_ids),
            ).fetchall()
        return {row["id"]: dict(row) for row in rows}

    def _sync_rows(self, group_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT * FROM angle_syncs WHERE group_id=?", (group_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _insert_row(self, group_id: str, asset_id: str, offset_us: int | None,
                    confidence: float | None, status: str, reason: str | None,
                    source: str, reference_fingerprint: str,
                    asset_fingerprint: str | None) -> None:
        now = utc_now()
        with self.db.connection() as db:
            # 幂等写入（验证门 ③-1 / 复核 M-a）：同 (组, 机位, 算法版本, 来源, 双侧指纹)
            # 的结论行已存在时不再插入。**用 ON CONFLICT DO NOTHING 而非 SELECT→INSERT 预检**：
            # 后者是 TOCTOU——并发执行同一作业（内置 worker + 手工 runner / 连点重算两个作业）
            # 会双双通过预检，随后撞部分唯一索引抛 sqlite3.IntegrityError（非 DomainError，
            # 作业整条崩；复核实测 1/8 概率复现）。ON CONFLICT 只吞唯一性冲突，
            # CHECK / NOT NULL 违规照旧抛出（不会掩盖真实缺陷）。
            db.execute(
                "INSERT INTO angle_syncs(id,group_id,asset_id,is_reference,offset_us,"
                "confidence,status,reason,source,reference_fingerprint,asset_fingerprint,"
                "algorithm_version,created_at,updated_at,finished_at) VALUES "
                "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                ("angle_sync_" + new_id(), group_id, asset_id,
                 1 if self._is_reference_asset(group_id, asset_id) else 0,
                 offset_us, confidence, status, reason, source,
                 reference_fingerprint, asset_fingerprint or reference_fingerprint,
                 ANGLE_SYNC_ALGORITHM_VERSION, now, now, now),
            )

    def _is_reference_asset(self, group_id: str, asset_id: str) -> bool:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT reference_asset_id FROM angle_groups WHERE id=?", (group_id,)
            ).fetchone()
        return bool(row) and row["reference_asset_id"] == asset_id

    def _resolve(self, asset_id: str) -> str:
        return str(self.resolve_asset_path(asset_id)["path"])

    @staticmethod
    def _media_info(asset: dict[str, Any]) -> dict[str, Any]:
        try:
            return json_loads(asset.get("media_info_json") or "{}")
        except Exception:
            return {}

    def _duration_s(self, asset: dict[str, Any]) -> float:
        duration_us = self._media_info(asset).get("duration_us")
        if not isinstance(duration_us, (int, float)) or duration_us <= 0:
            return COARSE_MAX_S
        return float(duration_us) / 1e6

    def _has_audio(self, asset: dict[str, Any]) -> bool:
        return bool(self._media_info(asset).get("audio_streams") or [])
