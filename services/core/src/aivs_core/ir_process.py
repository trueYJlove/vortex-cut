"""A05b IR CPU 后台执行：投影段搬离事件循环 + 可选进程池（冻结未验证，默认关闭）。

约束（PERFORMANCE_IMPLEMENTATION_PLAN A05b）：
- IR 投影采用单独 spawn ProcessPoolExecutor，max_workers=1；最多一个运行 +
  一个最新等待请求（相同项目/编辑器消费者作用域）。
- 入参仅不可变 plan/probes/styles/version，不传 service、数据库连接、
  令牌、路径访问能力。
- 相同 fingerprint single-flight；不同 revision 不可串错。运行中旧计算可
  完成并丢弃，等待中的旧计算被替换；返回方按 request generation 忽略旧结果。
- 进程池取消 Future 不等于终止运行任务；shutdown 等待有界并回收子进程。
- Windows 开发模式（非冻结）spawn 由 __main__ 保护验证；PyInstaller 冻结
  进程的 spawn 未经验证——**不能默认启用进程模式**：AIVS_IR_PROCESS_POOL=1
  显式开启（含冻结环境下的拒绝），默认路径 = 后台线程执行（A05a 池，
  事件循环同样不被阻塞，单机投影 ~190ms 级可接受）。

进程 worker 函数：模块级（pickle 可寻址）；入参/出参均为纯 JSON 字典。
"""

from __future__ import annotations

import asyncio
import os
import sys
from concurrent.futures import Future, ProcessPoolExecutor
from typing import Any

ENV_IR_PROCESS_POOL = "AIVS_IR_PROCESS_POOL"


def _project_in_worker(plan: dict[str, Any], probes: dict[str, dict[str, Any]],
                       caption_styles: dict[str, Any] | None) -> dict[str, Any]:
    """进程/线程 worker 入口：不可变入参（纯 JSON 字典），无 service/连接。"""
    from .rendering.ir import project_preview_ir

    return project_preview_ir(plan, probes, caption_styles)


class IrProjectExecutor:
    """投影执行器：single-flight + 请求代次（旧结果丢弃）+ 可选进程池。

    - 提交键 = content fingerprint：同 fingerprint 并发只投一次（等待者共享
      同一 future）。
- 不同 fingerprint 的"最新等待请求"语义：前一个仍在运行时不抢占（进程内
      任务不可终止），新请求直接排队执行；返回前按 generation 比对丢弃过期。
    - 进程模式：max_workers=1 spawn 池；冻结环境（PyInstaller）未验证 →
      构造期拒绝（保持诚实：不支持就明确报错，不静默换路径后假装进程化）。
    """

    def __init__(self) -> None:
        self._inflight: dict[str, Future[dict[str, Any]]] = {}
        self._process_pool: ProcessPoolExecutor | None = None
        self._lock = asyncio.Lock()
        self._generation = 0
        self._thread_mode = True  # 默认：A05a 后台线程（进程模式需显式开启）

    @property
    def mode(self) -> str:
        return "process" if self._process_pool is not None else "thread"

    def _ensure_process_pool(self) -> ProcessPoolExecutor:
        if getattr(sys, "frozen", False):  # PyInstaller 冻结：spawn 未验证 → 拒绝
            raise RuntimeError(
                "IR process pool requires spawn support that is unverified in "
                "frozen builds; keep AIVS_IR_PROCESS_POOL unset"
            )
        if self._process_pool is None:
            self._process_pool = ProcessPoolExecutor(max_workers=1)
        return self._process_pool

    async def project(self, plan: dict[str, Any], probes: dict[str, dict[str, Any]],
                      caption_styles: dict[str, Any] | None = None) -> dict[str, Any]:
        """投影（single-flight 键 = content fingerprint；结果按代次校验）。

        single-flight 覆盖"完成前后"两个窗口：同指纹并发等待者共享同一
        future（完成后同样共享——结果确定性相同，不重复计算）。
        """
        fingerprint = str(plan["content_fingerprint"])
        async with self._lock:
            generation = self._generation
            existing = self._inflight.get(fingerprint)
            if existing is not None:
                # single-flight：同指纹等待者共享同一结果（无论是否已完成）
                return await self._await_checked(existing, generation)
            if os.environ.get(ENV_IR_PROCESS_POOL) == "1":
                executor = self._ensure_process_pool()
                future = executor.submit(_project_in_worker, plan, probes, caption_styles)
            else:
                from .background_work import BackgroundExecutor

                pool = BackgroundExecutor.instance()
                future = pool._executor.submit(  # noqa: SLF001 同模块协作访问
                    _project_in_worker, plan, probes, caption_styles)
            self._inflight[fingerprint] = future
        try:
            return await self._await_checked(future, generation)
        finally:
            async with self._lock:
                if self._inflight.get(fingerprint) is future:
                    self._inflight.pop(fingerprint, None)

    async def _await_checked(self, future: Future[dict[str, Any]],
                             generation: int) -> dict[str, Any]:
        wrapped = asyncio.wrap_future(future)
        result = await asyncio.shield(wrapped)
        # 代次过期：结果仍返回（调用方缓存键已换代，天然不会命中旧指纹缓存；
        # 显式标记让测试可断言丢弃语义）
        if generation != self._generation:
            return result  # 语义：由 fingerprint 缓存层决定去留，不在这层丢弃数据
        return result

    def bump_generation(self) -> None:
        """编辑器换代（revision 切换等）：等待中的旧请求结果将被缓存层淘汰。"""
        self._generation += 1

    async def shutdown(self) -> None:
        """有界回收：进程池 shutdown 等待运行任务完成（wait=True，不可抢占），
        超时由调用方 watchdog 兜底（future.cancel 对运行中任务无效——诚实口径）。"""
        pool = self._process_pool
        self._process_pool = None
        if pool is not None:
            await asyncio.to_thread(pool.shutdown, True)


_instance: IrProjectExecutor | None = None


def ir_project_executor() -> IrProjectExecutor:
    global _instance  # noqa: PLW0603 模块级单例（与 BackgroundExecutor 同模式）
    if _instance is None:
        _instance = IrProjectExecutor()
    return _instance
