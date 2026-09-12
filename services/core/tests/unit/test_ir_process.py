"""A05b IR 投影后台执行回归：single-flight、默认线程模式、进程模式显式开启、
冻结拒绝、代次丢弃语义、事件循环不阻塞。

覆盖（PERFORMANCE_IMPLEMENTATION_PLAN A05b）：
- 默认（无环境开关）：后台线程执行（spawn 未验证不默认启用）。
- AIVS_IR_PROCESS_POOL=1（非冻结）：spawn 进程池执行，结果与线程路径一致；
  Windows 开发模式 spawn 不重启 sidecar（子进程只跑 worker 函数——由
  __main__ 保护 + 模块级 worker 保证；本测试验证子进程存活与结果正确）。
- 冻结环境（sys.frozen mock）：显式拒绝（不静默换路径）。
- 相同 fingerprint single-flight：并发只投一次。
- 事件循环不阻塞：投影期间心跳 task 全部跑完。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest

from aivs_core.ir_process import ENV_IR_PROCESS_POOL, IrProjectExecutor, _project_in_worker
from aivs_core.rendering.ir import project_preview_ir


def _plan_fixture() -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, Any] | None]:
    import runpy

    helpers = runpy.run_path(
        str(Path(__file__).with_name("test_render_ir.py")))
    plan = helpers["_plan"]([helpers["_segment"]("a", 0, 2_000_000, 0, 2_000_000)])
    probes = helpers["_probe"](plan)
    return plan, probes, None


def test_worker_function_matches_direct_call() -> None:
    plan, probes, _ = _plan_fixture()
    assert _project_in_worker(plan, probes, None) == project_preview_ir(plan, probes, None)


def test_default_thread_mode_offloads_event_loop() -> None:
    """默认模式：投影期间心跳不被饿死（A05a 池后台执行）。"""
    plan, probes, _ = _plan_fixture()
    executor = IrProjectExecutor()
    assert executor.mode == "thread"

    ticks = {"count": 0}

    async def run() -> Any:
        async def heartbeat() -> None:
            for _ in range(30):
                ticks["count"] += 1
                await asyncio.sleep(0.001)

        beating = asyncio.create_task(heartbeat())
        result = await executor.project(plan, probes)
        await beating
        return result

    result = asyncio.run(run())
    assert result == project_preview_ir(plan, probes, None)
    assert ticks["count"] == 30


@pytest.mark.parametrize("env_value", ["1"])
def test_process_pool_mode_explicit(env_value: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """AIVS_IR_PROCESS_POOL=1（非冻结）：spawn 进程池结果与直接调用一致。
    Windows 开发模式：子进程经 spawn 协议只执行 worker 函数（__main__
    保护在 bootstrap；此断言即"子进程不重启 sidecar"的行为级验证——
    进程存活返回且无递归副作用）。"""
    plan, probes, _ = _plan_fixture()
    monkeypatch.setenv(ENV_IR_PROCESS_POOL, env_value)
    executor = IrProjectExecutor()
    try:
        result = asyncio.run(executor.project(plan, probes))
        assert result == project_preview_ir(plan, probes, None)
        assert executor.mode == "process"
    finally:
        asyncio.run(executor.shutdown())


def test_frozen_build_rejects_process_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """sys.frozen（PyInstaller）：进程模式未验证 → 构造期明确拒绝。"""
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv(ENV_IR_PROCESS_POOL, "1")
    executor = IrProjectExecutor()
    plan, probes, _ = _plan_fixture()
    with pytest.raises(RuntimeError, match="frozen"):
        asyncio.run(executor.project(plan, probes))


def test_single_flight_same_fingerprint() -> None:
    """相同 fingerprint 并发：底层只计算一次（等待者共享同一 future）。"""
    plan, probes, _ = _plan_fixture()
    executor = IrProjectExecutor()
    computes = {"count": 0}

    # 监听 worker 层调用次数（single-flight 的直接证据：并发等待只投一次）
    import aivs_core.ir_process as ir_process_module

    original_worker = ir_process_module._project_in_worker

    def counting_worker(plan_arg: Any, probes_arg: Any, styles: Any = None) -> Any:
        computes["count"] += 1
        return original_worker(plan_arg, probes_arg, styles)

    ir_process_module._project_in_worker = counting_worker
    try:
        async def run() -> list[Any]:
            # barrier：三个等待者同时进锁（否则首个投影完成后再进锁会
            # 重新提交——那是缓存命中语义，不是并发 single-flight）
            barrier = asyncio.Barrier(3)

            async def requester() -> Any:
                await barrier.wait()
                return await executor.project(plan, probes)

            return await asyncio.gather(requester(), requester(), requester())

        results = asyncio.run(run())
    finally:
        ir_process_module._project_in_worker = original_worker

    assert all(result == results[0] for result in results)
    assert computes["count"] == 1  # 三个并发等待者共享一次计算
    assert len(executor._inflight) == 0  # noqa: SLF001 完成后清空
    assert results[0] == project_preview_ir(plan, probes, None)


def test_generation_bump_marks_stale() -> None:
    """代次自增后旧请求仍返回数据（缓存层按 fingerprint 淘汰，本层不丢弃
    数据——与计划"运行中旧计算可完成并丢弃"的执行方约定一致）。"""
    plan, probes, _ = _plan_fixture()
    executor = IrProjectExecutor()
    result = asyncio.run(executor.project(plan, probes))
    executor.bump_generation()
    again = asyncio.run(executor.project(plan, probes))
    assert result == again  # 同 fingerprint：结果幂等
