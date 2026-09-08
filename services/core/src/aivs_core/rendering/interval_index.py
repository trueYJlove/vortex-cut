"""A04 区间扫线索引：把"每帧全表扫描"改为"排序事件 + 活跃集游标推进"。

语义约束（PERFORMANCE_IMPLEMENTATION_PLAN A04）：
- 主轨 region 命中 = 倒序遍历首个命中（regions 允许 overlap：blend 与 body
  相邻但锚段 full 可前移覆盖）。扫线 active 集必须选**原 regions 顺序最大
  的有效项**，不能只看 start 最大值。
- 主轨端点半开 [t0, t1)；overlay/字幕保留包含 end 的行为（≤ end）——
  这些区间端点差异是兼容要求，不在优化中修正。
- 帧时刻按原算法的 t_exact_us（n * 1e6 / FPS 浮点）比较。
- 索引在单次投影开始时建一次；不每帧重建。
- 稳定性：overlays/captions 输出保持原始顺序（IR v1 协议不变）。
"""
from __future__ import annotations

from bisect import insort
from typing import Any


class IntervalLookup:
    """通用区间查找集合：一次构造，任意时刻查询（非单调也可回退重置）。

    适用于 overlays/captions（含 end 语义：start ≤ t ≤ end）。帧循环单调时
    next_batch 用事件游标 + 有序活跃集推进（均摊 O(活跃变化)）；active_at
    为任意时刻接口（回退后 reset 再单调推进）。
    输出保持构造时给定的原顺序（v1 协议稳定性）。
    """

    def __init__(self, intervals: list[tuple[float, float, tuple[int, Any]]]) -> None:
        # owner = (原序号, 值)：保持 v1 协议的原始顺序输出
        events: list[tuple[float, int, int]] = []  # (时刻, 0=enter/1=exit, order)
        for t0, t1, (order, _value) in intervals:
            t0f, t1f = float(t0), float(t1)
            if t1f < t0f:
                continue  # 空区间永不活跃（t0 == t1 时含端语义仍可活跃一瞬）
            events.append((t0f, 0, order))
            events.append((t1f, 1, order))
        # 同刻 enter(0) 先于 exit(1)——含端语义：end 时刻仍活跃
        events.sort(key=lambda event: (event[0], event[1], event[2]))
        self._events = events
        self._intervals = intervals
        self._cursor = 0
        # 有序活跃集（enter 时 bisect 插入 → 输出天然按原序）
        self._active_orders: list[int] = []

    def next_batch(self, t_exact_us: float) -> list[Any]:
        """推进到 t（单调）并返回全部活跃值，按构造原顺序。

        含端语义：enter 在 t == start 生效；exit 在 t == end 仍活跃，
        t > end 才退场——enter/exit 的处理条件不同（enter ≤ t，exit < t）。
        """
        events = self._events
        orders = self._active_orders
        while self._cursor < len(events):
            moment, kind, order = events[self._cursor]
            if kind == 0:
                # enter：start ≤ t 时生效
                if moment > t_exact_us:
                    break
                self._cursor += 1
                insort(orders, order)
            else:
                # exit：end < t 时才退场（end == t 仍活跃，含端）
                if moment >= t_exact_us:
                    break
                self._cursor += 1
                try:
                    orders.remove(order)
                except ValueError:
                    pass
        return [self._intervals[order][2][1] for order in orders]

    def active_at(self, t_exact_us: float) -> list[Any]:
        """任意时刻查询（重置游标后从零推进；帧循环单调路径用 next_batch）。"""
        self._cursor = 0
        self._active_orders = []
        return self.next_batch(t_exact_us)


class RegionSweep:
    """主轨 region 扫线（半开 [t0, t1)、倒序命中语义、锚点预映射）。

    next_region(t) 单调推进，事件游标 + 活跃集均摊 O(区域变化)；命中 =
    active 集中原顺序最大者（与 ir.py 原"倒序遍历首个命中"逐帧等价，
    见 test_render_ir_index 的 oracle 对比）。
    """

    def __init__(self, regions: list[dict[str, Any]]) -> None:
        self._regions = regions
        events: list[tuple[float, int, int]] = []
        for order, region in enumerate(regions):
            t0 = float(region["t0"])
            t1 = float(region["t1"])
            if t1 <= t0:
                continue  # 空区间永不活跃
            events.append((t0, 0, order))  # enter
            events.append((t1, 1, order))  # exit
        # 排序键：时刻升序；同刻 exit(1) 先于 enter(0)——半开区间在 t1 时刻
        # 已不活跃；同型同刻按 order 升序（活跃集按 order 取 max，与构造序等价）
        events.sort(key=lambda event: (event[0], event[1], event[2]))
        self._events = events
        self._cursor = 0
        self._active: dict[int, None] = {}
        # 转场锚点预映射（blend region order → 锚段 region order）：
        # ir.py _anchor_of 的倒序扫描语义在投影开始时一次算完，不每帧扫描。
        self._anchor_by_order: dict[int, int] = {}
        for order, region in enumerate(regions):
            if region.get("phase") != "blend":
                continue
            self._anchor_by_order[order] = self._find_anchor_order(regions, region, order)

    @staticmethod
    def _find_anchor_order(regions: list[dict[str, Any]], blend_region: dict[str, Any],
                           blend_order: int) -> int:
        """转场锚 = blend 之前、t0 ≤ blend t0 的最近 segment 区段。"""
        for candidate_order in range(blend_order - 1, -1, -1):
            candidate = regions[candidate_order]
            if candidate["item"]["kind"] == "segment" and candidate["t0"] <= blend_region["t0"]:
                return candidate_order
        from ..projects import DomainError

        raise DomainError("PREVIEW_IR_UNSUPPORTED", "转场锚点段缺失")

    def next_region(self, t_exact_us: float) -> dict[str, Any] | None:
        """推进到 t 并返回命中 region（active 中 order 最大者）。"""
        events = self._events
        while self._cursor < len(events):
            moment, kind, order = events[self._cursor]
            if moment > t_exact_us:
                break
            self._cursor += 1
            if kind == 0:
                self._active[order] = None
            else:
                self._active.pop(order, None)
        if not self._active:
            return None
        return self._regions[max(self._active)]

    def anchor_region(self, blend_region: dict[str, Any]) -> dict[str, Any]:
        """blend region 的锚段（构造期预映射；锚缺失在构造期已抛）。"""
        order = self._regions.index(blend_region)
        return self._regions[self._anchor_by_order[order]]

    def reset(self) -> None:
        """时间回退重置（帧循环单调，通常不需要；测试用）。"""
        self._cursor = 0
        self._active.clear()
