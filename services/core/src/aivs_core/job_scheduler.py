"""B16 优先级与资源配额调度器：多资源令牌原子申请 + 分级 FIFO + aging。

约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B16）：
- 任务描述由服务端 kind→policy 决定（Renderer 不传任意优先级）。
- 初始资源：cpuHeavy=1、gpuHeavy=1、diskHeavy=1、network=2、轻量 light=2。
  多资源一次原子申请（申请期间持调度锁，禁止单独占一令牌等另一令牌
  ——申请失败即整体失败，无部分持有状态，无死锁）。
- 分级（数字小 = 优先级高）：
  1 已授权当前 seek 所需 PCM/媒体块（B15 内联路径，不走本调度器——
    其容量由 ensure_chunk 并发闸门保留，此层只声明语义）；
  2 用户主动权威预览/当前视口派生（waveform——时间轴可见触发即用户视野）；
  3 当前项目代理/波形/再加工（proxy）；
  4 导出/ASR/后台生成（final_export/authoritative_preview/transcription/
    model_download/media_generation/candidate_generation/
    timeline_patch_generation）；
  5 预热和维护（legacy proxy/vertical_sample——兼容旧 kind，保守归末级）。
- 同级 FIFO（created_at）+ aging：等待越久优先级等效提升（AGE_STEP_S
  每等待 30s 视作提升一级，封顶 PRIORITY_FLOOR）——防同低级长队饿死。
- B16a：有界并发 = network 类 2 并行 + light 类 2 并行；cpu/gpu/disk
  heavy（render）仍严格单个。B16b：编辑器负载 lease（playing/scrubbing
  时暂停新的低优先级（≥2）重任务启动；已运行任务不受影响——不可抢占）。
- 令牌释放恰好一次（异常/retry/取消路径统一经 finally 归还）；unknown
  kind 保守独占（heavy 单槽路径，行为不劣于现状单槽）。
- 应用重启恢复：调度器无持久状态（令牌内存态）；重启后 queued 行由
  jobs._loop 重新拾取（既有恢复链路不变）。
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

# ---- 资源与档位（初始工程值；G0 冻结后可调） ----

RESOURCES: dict[str, int] = {
    "cpu_heavy": 1,   # 权威渲染/最终导出（FFmpeg 合成）
    "gpu_heavy": 1,   # 硬件编码路径（与 cpu_heavy 同任务——render 合计 1）
    "disk_heavy": 1,  # 大文件复制/再封装（当前无专用 kind，保留容量声明）
    "network": 2,     # Provider/ASR/模型下载（B16a 有界并发）
    "light": 2,       # 波形/轻量派生（B16a 有界并发）
}

PRIORITY_FLOOR = 3          # aging 封顶（等效提升不超过 3 级）
AGE_STEP_S = 30.0           # 每等待 30s 视作提升一级

# lease 模式（B16b）
LEASE_MODES = ("playing", "scrubbing", "idle")
LEASE_TTL_S = 3.0


@dataclass(frozen=True)
class JobPolicy:
    """kind → 资源需求 + 优先级（服务端唯一决定；Renderer 不可传）。"""
    kind: str
    resources: tuple[str, ...]
    priority: int


# kind → policy 白名单（新 kind 不在表内 = unknown → 保守独占 heavy）
KIND_POLICIES: dict[str, JobPolicy] = {
    # 2 级：用户视野派生（波形——时间轴可见即触发）
    "waveform": JobPolicy("waveform", ("light",), 2),
    # AI-2 Layer 0：CV 信号分析（关键帧采样——当前项目级）
    "cv_analysis": JobPolicy("cv_analysis", ("light",), 3),
    # 3 级：当前项目代理（B11 全源代理）
    "proxy": JobPolicy("proxy", ("light",), 3),
    # 4 级：导出/ASR/后台生成
    "final_export": JobPolicy("final_export", ("cpu_heavy", "gpu_heavy", "disk_heavy"), 4),
    "authoritative_preview": JobPolicy("authoritative_preview", ("cpu_heavy",), 4),
    "transcription": JobPolicy("transcription", ("network",), 4),
    "model_download": JobPolicy("model_download", ("network",), 4),
    "candidate_generation": JobPolicy("candidate_generation", ("network",), 4),
    "timeline_patch_generation": JobPolicy("timeline_patch_generation", ("network",), 4),
    "captions_provider_generation": JobPolicy("captions_provider_generation", ("network",), 4),
    "agent_session": JobPolicy("agent_session", ("network",), 4),
    "media_generation": JobPolicy("media_generation", ("network",), 4),
    # 5 级：预热/维护（legacy sample 路径）
    "vertical_sample": JobPolicy("vertical_sample", ("light",), 5),
}


def policy_for(kind: str) -> JobPolicy:
    """kind → 调度策略；unknown kind 保守独占（heavy 单槽，行为不劣于现状）。"""
    return KIND_POLICIES.get(kind, JobPolicy(kind, ("cpu_heavy", "gpu_heavy", "disk_heavy"), 5))


@dataclass
class _Admission:
    """已获令牌的准入记录（释放恰好一次的凭据）。"""
    job_id: str
    resources: tuple[str, ...]
    released: bool = False


class EditorLoadLease:
    """B16b 编辑器负载租约（TTL 3s；无租约视 idle——Renderer 崩溃不饿死）。

    mode 取 playing/scrubbing/idle；过期后 editor_mode() 返回 "idle"。
    """

    def __init__(self) -> None:
        self._mode: str = "idle"
        self._expires_at: float = 0.0
        self._window_id: str | None = None

    def heartbeat(self, window_id: str, mode: str, now: float | None = None) -> None:
        if mode not in LEASE_MODES:
            raise ValueError(f"invalid lease mode: {mode}")
        self._mode = mode
        self._window_id = window_id
        stamp = now if now is not None else time.monotonic()
        self._expires_at = stamp + LEASE_TTL_S

    def editor_mode(self, now: float | None = None) -> str:
        current = now if now is not None else time.monotonic()
        if current > self._expires_at:
            return "idle"  # 过期（含从未收到心跳）= idle
        return self._mode

    @property
    def window_id(self) -> str | None:
        return self._window_id

    def snapshot(self) -> dict[str, Any]:
        return {"mode": self.editor_mode(), "window_id": self._window_id}


class JobScheduler:
    """多资源令牌调度器：admit() 原子申请；release() 恰好一次归还。

    - admit(kind, job_id)：可用即占（返回 Admission）；不足返回 None
      （调用方下轮 poll 再试——不做排队内部结构，等待队列就是 jobs 表
      的 queued 行 + created_at FIFO；aging 在 effective_priority 计算）。
    - 分级挑选：candidates 传入（含 created_at/kind），调度器按
      effective_priority 排序选第一个 admit 成功者——高优先级任务资源
      不足时低优先级任务可用资源互补（防头阻塞，FIFO 只在同级内生效）。
    - lease（B16b）：editor_mode 为 playing/scrubbing 时，新的
      priority ≥ LEASE_HOLD_PRIORITY 的重任务（cpu/gpu/disk）暂缓准入。
    """

    # lease 语义：播放/拖动中暂缓的最低优先级门槛（重任务 = 4/5 级）
    LEASE_HOLD_PRIORITY = 4

    def __init__(self, resources: dict[str, int] | None = None,
                 clock: Any = time.monotonic) -> None:
        self._capacity = dict(resources or RESOURCES)
        self._held: dict[str, int] = {name: 0 for name in self._capacity}
        self._admissions: dict[str, _Admission] = {}
        self._lock = asyncio.Lock()
        self._clock = clock
        self.lease = EditorLoadLease()

    # ---- 观测（诊断/测试断言） ----

    def snapshot(self) -> dict[str, Any]:
        return {
            "capacity": dict(self._capacity),
            "held": dict(self._held),
            "admissions": len(self._admissions),
            "lease": self.lease.snapshot(),
        }

    def held_for(self, resource: str) -> int:
        return self._held.get(resource, 0)

    # ---- 准入/释放 ----

    async def admit(self, kind: str, job_id: str) -> _Admission | None:
        """原子申请：多资源一次判定（锁内）——不足即 None，无部分持有。"""
        policy = policy_for(kind)
        async with self._lock:
            # B16b lease：编辑器高负载时暂缓新的低优先级重任务
            if self._lease_blocks(policy):
                return None
            for name in policy.resources:
                if self._held[name] + 1 > self._capacity[name]:
                    return None
            for name in policy.resources:
                self._held[name] += 1
            admission = _Admission(job_id, policy.resources)
            self._admissions[job_id] = admission
            return admission

    async def release(self, job_id: str) -> None:
        """恰好一次归还：未持有/已释放均无操作（幂等；异常路径统一走此）。"""
        async with self._lock:
            admission = self._admissions.pop(job_id, None)
            if admission is None or admission.released:
                return
            admission.released = True
            for name in admission.resources:
                self._held[name] = max(0, self._held[name] - 1)

    # ---- 分级挑选（FIFO + aging） ----

    def effective_priority(self, policy: JobPolicy, created_at: float,
                           now: float | None = None) -> int:
        """等待 aging：每 AGE_STEP_S 等待等效提升一级，封顶 PRIORITY_FLOOR。"""
        current = now if now is not None else self._clock()
        waited = max(0.0, current - created_at)
        boost = min(PRIORITY_FLOOR, int(waited / AGE_STEP_S))
        return max(1, policy.priority - boost)

    def _lease_blocks(self, policy: JobPolicy) -> bool:
        mode = self.lease.editor_mode(self._clock())
        if mode == "idle":
            return False
        heavy = any(name in ("cpu_heavy", "gpu_heavy", "disk_heavy") for name in policy.resources)
        return heavy and policy.priority >= self.LEASE_HOLD_PRIORITY

    def pick(self, candidates: list[dict[str, Any]], now: float | None = None) -> str | None:
        """按（effective priority, created_at, job_id）挑下一个候选 job_id。

        候选 = queued 行摘要（job_id/kind/created_at）。资源不足的高优先级
        任务不阻塞可用资源的低优先级任务（无头阻塞）：挑选只排顺序，最终
        admit 成功与否由资源态决定——调用方从排序头逐个尝试 admit。
        本方法不持锁、不占令牌（纯排序决策）。
        """
        if not candidates:
            return None
        current = now if now is not None else self._clock()

        def sort_key(candidate: dict[str, Any]) -> tuple[int, float, str]:
            policy = policy_for(str(candidate.get("kind") or "proxy"))
            created = float(candidate.get("created_ts") or 0.0)
            job_id = str(candidate.get("job_id"))
            return (self.effective_priority(policy, created, current), created, job_id)

        ranked = sorted(candidates, key=sort_key)
        return str(ranked[0].get("job_id"))


class LeaseClock:
    """可注入的时钟（测试快进 lease TTL / aging 用）。"""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


__all__ = [
    "RESOURCES", "KIND_POLICIES", "JobPolicy", "policy_for",
    "EditorLoadLease", "JobScheduler", "LeaseClock",
    "LEASE_MODES", "LEASE_TTL_S", "PRIORITY_FLOOR", "AGE_STEP_S",
]
