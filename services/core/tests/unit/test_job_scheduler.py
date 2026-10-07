"""B16 优先级与资源配额调度器单测。

覆盖（计划第 6 节 B16 测试要求）：
- 混合 100 任务无超 token、无死锁（network 2 并行 + light 2 并行；
  heavy 单槽）。
- 取消/异常/retry 路径令牌恰好释放一次（幂等 release；重复 release 无效）。
- 同级 FIFO + aging（等待 30s/级，封顶 3 级）；分级顺序正确
  （waveform=2 < proxy=3 < export=4 < sample=5）。
- 多资源一次原子申请：不足即整体 None（无部分持有——held 不残留）。
- lease（B16b）：playing/scrubbing 暂缓新的 ≥4 级重任务；idle 不拦；
  TTL 3s 过期回 idle；无心跳视 idle（Renderer 崩溃不饿死）。
- unknown kind 保守独占（heavy 单槽路径）。
- 恢复语义：调度器无持久状态（重启后 queued 由 jobs._loop 拾取——
  本文件以 snapshot 空 + admit 可用断言）。
"""
from __future__ import annotations

import asyncio

import pytest

from aivs_core.job_scheduler import (
    AGE_STEP_S,
    LEASE_TTL_S,
    EditorLoadLease,
    JobScheduler,
    LeaseClock,
    policy_for,
)


def test_kind_policies_cover_plan_tiers() -> None:
    # 2 波形（用户视野）；3 代理；4 导出/ASR/生成；5 sample 预热
    assert policy_for("waveform").priority == 2
    assert policy_for("proxy").priority == 3
    assert policy_for("final_export").priority == 4
    assert policy_for("transcription").priority == 4
    assert policy_for("media_generation").priority == 4
    assert policy_for("vertical_sample").priority == 5
    # 资源：heavy 三合一；network/light 有界
    assert set(policy_for("final_export").resources) == {"cpu_heavy", "gpu_heavy", "disk_heavy"}
    assert policy_for("candidate_generation").resources == ("network",)
    assert policy_for("waveform").resources == ("light",)
    # captions Provider 生成与其它 Provider 生成同档（network，优先级 4）
    assert policy_for("captions_provider_generation").resources == ("network",)
    assert policy_for("captions_provider_generation").priority == 4


def test_unknown_kind_conservative_exclusive() -> None:
    policy = policy_for("mystery_kind")
    assert policy.priority == 5
    assert "cpu_heavy" in policy.resources  # 保守独占 = 行为不劣于现状单槽


def test_admit_and_release_once() -> None:
    async def run() -> None:
        scheduler = JobScheduler()
        admission = await scheduler.admit("waveform", "job_1")
        assert admission is not None
        assert scheduler.held_for("light") == 1
        # 重复 release：恰好一次（第二次无操作）
        await scheduler.release("job_1")
        await scheduler.release("job_1")
        assert scheduler.held_for("light") == 0
        # 未持有 job 的 release：无操作不抛
        await scheduler.release("job_never")
        assert scheduler.held_for("light") == 0

    asyncio.run(run())


def test_capacity_enforced_no_oversubscribe() -> None:
    async def run() -> None:
        scheduler = JobScheduler()
        # network=2：第三个 network 任务 admit 失败
        assert await scheduler.admit("transcription", "n1") is not None
        assert await scheduler.admit("transcription", "n2") is not None
        assert await scheduler.admit("candidate_generation", "n3") is None
        # light 通道独立（未被 network 占用）
        assert await scheduler.admit("waveform", "w1") is not None
        assert scheduler.held_for("network") == 2
        await scheduler.release("n1")
        assert await scheduler.admit("candidate_generation", "n3") is not None

    asyncio.run(run())


def test_atomic_multi_resource_no_partial_hold() -> None:
    async def run() -> None:
        scheduler = JobScheduler()
        # 先占满 disk_heavy（通过一个 final_export）
        assert await scheduler.admit("final_export", "e1") is not None
        # 第二个 final_export：任一资源不足 → 整体 None，无部分持有残留
        assert await scheduler.admit("final_export", "e2") is None
        snapshot = scheduler.snapshot()
        assert snapshot["held"]["cpu_heavy"] == 1
        assert snapshot["held"]["gpu_heavy"] == 1
        assert snapshot["held"]["disk_heavy"] == 1
        # 无死锁条件：失败申请不持有任何令牌——其他 light 任务可继续
        assert await scheduler.admit("waveform", "w1") is not None

    asyncio.run(run())


def test_fifo_and_priority_order() -> None:
    clock = LeaseClock()
    scheduler = JobScheduler(clock=clock)
    # 同级 FIFO：created_at 早者先
    assert scheduler.pick([
        {"job_id": "b", "kind": "waveform", "created_ts": 20.0},
        {"job_id": "a", "kind": "waveform", "created_ts": 10.0},
    ]) == "a"
    # 分级：waveform(2) 先于 proxy(3) 先于 export(4)，无论到达序
    assert scheduler.pick([
        {"job_id": "export", "kind": "final_export", "created_ts": 5.0},
        {"job_id": "proxy", "kind": "proxy", "created_ts": 15.0},
        {"job_id": "wf", "kind": "waveform", "created_ts": 25.0},
    ]) == "wf"
    assert scheduler.pick([
        {"job_id": "export", "kind": "final_export", "created_ts": 5.0},
        {"job_id": "proxy", "kind": "proxy", "created_ts": 15.0},
    ]) == "proxy"


def test_aging_promotes_waiting_jobs() -> None:
    clock = LeaseClock()
    scheduler = JobScheduler(clock=clock)
    # export(4) 等待 90s → aging 3 级 → 等效优先级 1，超过 waveform(2)
    assert scheduler.pick([
        {"job_id": "wf", "kind": "waveform", "created_ts": 100.0},
        {"job_id": "old_export", "kind": "final_export", "created_ts": 10.0},
    ], now=100.0) == "old_export"
    # 未到 aging 阈值：维持原级
    assert scheduler.pick([
        {"job_id": "wf", "kind": "waveform", "created_ts": 100.0},
        {"job_id": "new_export", "kind": "final_export", "created_ts": 80.0},
    ], now=100.0) == "wf"
    # aging 封顶：等 1000s 也不低于 1
    policy = policy_for("final_export")
    assert scheduler.effective_priority(policy, created_at=0.0, now=10_000.0) >= 1


def test_aging_step_boundaries() -> None:
    clock = LeaseClock()
    scheduler = JobScheduler(clock=clock)
    policy = policy_for("vertical_sample")  # priority 5
    # 0s 等待：原级 5
    assert scheduler.effective_priority(policy, 100.0, now=100.0) == 5
    # 30s：4；60s：3；90s：2（= boost 封顶 3 级；更长等待不再降）
    assert scheduler.effective_priority(policy, 100.0, now=100.0 + AGE_STEP_S) == 4
    assert scheduler.effective_priority(policy, 100.0, now=100.0 + 2 * AGE_STEP_S) == 3
    assert scheduler.effective_priority(policy, 100.0, now=100.0 + 9 * AGE_STEP_S) == 2
    assert scheduler.effective_priority(policy, 100.0, now=100.0 + 99 * AGE_STEP_S) == 2


class TestLease:
    def test_lease_modes_and_ttl(self) -> None:
        lease = EditorLoadLease()
        # 无心跳 = idle（Renderer 崩溃不饿死）
        assert lease.editor_mode(now=0.0) == "idle"
        lease.heartbeat("window_1", "playing", now=100.0)
        assert lease.editor_mode(now=101.0) == "playing"
        # TTL 3s 过期 → idle
        assert lease.editor_mode(now=100.0 + LEASE_TTL_S + 0.01) == "idle"
        lease.heartbeat("window_1", "scrubbing", now=200.0)
        assert lease.editor_mode(now=201.0) == "scrubbing"
        assert lease.window_id == "window_1"

    def test_lease_rejects_invalid_mode(self) -> None:
        lease = EditorLoadLease()
        with pytest.raises(ValueError):
            lease.heartbeat("w", "bogus")

    def test_lease_blocks_heavy_low_priority_when_playing(self) -> None:
        async def run() -> None:
            clock = LeaseClock()
            scheduler = JobScheduler(clock=clock)
            # idle：export(4, heavy) 可入
            assert await scheduler.admit("final_export", "e1") is not None
            await scheduler.release("e1")
            # playing：新 export 暂缓；但 waveform(2, light) 不拦
            scheduler.lease.heartbeat("w", "playing", now=clock.now)
            assert await scheduler.admit("final_export", "e2") is None
            assert await scheduler.admit("waveform", "w1") is not None
            # 已运行任务不受影响（e1 已释放，语义上"不抢占已运行"由
            # admit 只在启动前判定保证）
            await scheduler.release("w1")
            # scrubbing 同语义
            scheduler.lease.heartbeat("w", "scrubbing", now=clock.now)
            assert await scheduler.admit("authoritative_preview", "p1") is None
            # TTL 过期回 idle：重任务恢复准入
            clock.advance(LEASE_TTL_S + 0.1)
            assert await scheduler.admit("final_export", "e3") is not None

        asyncio.run(run())


def test_mixed_100_tasks_no_oversubscribe_no_deadlock() -> None:
    """计划测试矩阵：混合 100 任务并发 admit/release——任意时刻 held ≤ 容量，
    全部可完成（无死锁：失败申请不持有部分令牌）。"""
    async def run() -> None:
        scheduler = JobScheduler()
        kinds = ["waveform", "proxy", "transcription", "candidate_generation",
                 "final_export", "model_download", "vertical_sample", "unknown_kind"]
        admitted: list[str] = []
        violations: list[str] = []
        for round_index in range(10):
            for i in range(10):
                job_id = f"job_{round_index}_{i}"
                kind = kinds[(round_index * 10 + i) % len(kinds)]
                admission = await scheduler.admit(kind, job_id)
                if admission is None:
                    continue
                admitted.append(job_id)
                # 不变量：任意资源 held ≤ capacity
                for name, capacity in scheduler.snapshot()["capacity"].items():
                    if scheduler.held_for(name) > capacity:
                        violations.append(f"{name} over capacity")
            # 随机释放一半（模拟取消/完成/异常混合）
            for job_id in admitted[::2]:
                await scheduler.release(job_id)
            admitted = [job for job in admitted if job not in admitted[::2]]
        assert violations == []
        # 清空全部后容量归零（无令牌泄漏）
        for job_id in list(admitted):
            await scheduler.release(job_id)
        snapshot = scheduler.snapshot()
        assert all(held == 0 for held in snapshot["held"].values())

    asyncio.run(run())


def test_restart_semantics_scheduler_is_memory_only() -> None:
    """恢复语义：调度器无持久状态——新实例即全量容量可用（queued 行由
    jobs._loop 拾取，恢复链路既有行为不变）。"""
    async def run() -> None:
        scheduler_a = JobScheduler()
        assert await scheduler_a.admit("waveform", "j1") is not None
        # "重启" = 新实例（旧实例令牌丢弃）
        scheduler_b = JobScheduler()
        assert scheduler_b.snapshot()["admissions"] == 0
        assert await scheduler_b.admit("waveform", "j1") is not None

    asyncio.run(run())
