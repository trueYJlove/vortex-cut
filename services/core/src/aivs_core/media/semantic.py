"""W3.1 素材池语义检索——纯算法层（零 I/O、零数据库）。

规划门：`docs/requirements/W3_1_SEMANTIC_SEARCH_PLANNING_GATE_2026-10-18.md` §2.3 / §2.4。

分工：本模块只做**可单测的纯函数**（向量归一、场景聚合、余弦排序），
解码/ONNX/落库均在 `semantic_index_service.py`——与 `beat_grid.py` /
`speaker.py` 同一分层纪律。

**为什么存 embedding 而不存"检索结果"**：换 K、换聚合策略、换相似度口径时
只需重排、不必重跑 ONNX（沿用 v37 已实测的 8–15× 收益理由）。
"""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np

# 改值 = 索引与语义变化，新行不与旧行互撞（与 CV_ALGORITHM_VERSION 同一纪律）。
INDEX_ALGORITHM_VERSION = 1

# 单次检索返回上限（门 §5 D5 待裁决；此处取保守值并作为**硬上限**，
# 调用方传更大值一律钳制——避免把整个素材池一次性倒给 Renderer）。
DEFAULT_SEARCH_K = 20
MAX_SEARCH_K = 100

# 帧数上限：长素材关键帧可能上万，BLOB 会线性膨胀（门 §4 R4）。
# 超限时按**等间隔抽稀**保留，而不是截断尾部——保持整段素材的时间覆盖。
MAX_FRAMES_PER_ASSET = 512


def l2_normalize(vec: np.ndarray) -> np.ndarray:
    """L2 归一化；(0,) 向量原样返回（不产生 NaN）。

    归一化是所有相似度的前提：余弦相似度在未归一化向量上与点积不等价，
    混用会让跨素材分数不可比。
    """
    arr = np.asarray(vec, dtype=np.float64).reshape(-1)
    norm = float(np.linalg.norm(arr))
    if norm <= 0.0:
        return arr
    return arr / norm


def aggregate_embeddings(vectors: Sequence[np.ndarray]) -> np.ndarray | None:
    """场景级聚合：逐维均值后重新归一化。

    为什么用均值而非取单帧代表：单帧代表对运动/转场极敏感（一个坏帧即
    主导整段），均值对单帧噪声稳健；聚合后再归一化保证与查询向量同域。
    """
    if not vectors:
        return None
    stacked = np.stack([np.asarray(v, dtype=np.float64).reshape(-1) for v in vectors])
    if stacked.ndim != 2 or stacked.shape[1] == 0:
        return None
    return l2_normalize(stacked.mean(axis=0))


def thin_frames(count: int, limit: int = MAX_FRAMES_PER_ASSET) -> list[int]:
    """超限时返回**等间隔**保留的下标（保持时间覆盖，不截尾）。

    返回空列表表示无需抽稀。用整数步长 floor(i*count/limit) 保证首尾都能
    命中且不产生重复下标。
    """
    if count <= 0 or limit <= 0:
        return []
    if count <= limit:
        return []
    # 用 (count-1)/(limit-1) 的等距步长，保证**首尾都命中**：
    # i*count//limit 的最末项是 count - count/limit，永远够不到 count-1。
    if limit == 1:
        return [0]
    picked: list[int] = []
    seen: set[int] = set()
    for i in range(limit):
        idx = (i * (count - 1)) // (limit - 1)
        if idx not in seen:
            seen.add(idx)
            picked.append(idx)
    return picked


def cosine_rank(
    query: np.ndarray,
    candidates: Sequence[tuple[str, np.ndarray]],
    k: int = DEFAULT_SEARCH_K,
) -> list[dict[str, Any]]:
    """查询向量对候选集做余弦排序。

    `candidates` 为 (asset_id, 聚合向量) 序列。返回按分数降序的前 k 项。
    分数为**余弦相似度**（两向量均已 L2 归一化 ⇒ 等价点积），取值 [-1, 1]。

    k 一律钳制到 [1, MAX_SEARCH_K]：调用方传 0/负数/超大值都不应导致
    空结果或整池外泄。
    """
    try:
        limit = int(k)
    except (TypeError, ValueError):
        limit = DEFAULT_SEARCH_K
    limit = max(1, min(MAX_SEARCH_K, limit))

    q = l2_normalize(query)
    if q.size == 0:
        return []

    scored: list[dict[str, Any]] = []
    for asset_id, vec in candidates:
        cand = l2_normalize(vec)
        # 维度不一致的候选直接跳过：宁可少返回，也不返回不可比的分数。
        if cand.size != q.size:
            continue
        scored.append({"asset_id": asset_id, "score": float(np.dot(q, cand))})

    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:limit]


def pack_embeddings(matrix: np.ndarray) -> bytes:
    """float32 小端连续内存 → BLOB（门 §5 D4 待实测，先按 float32）。"""
    arr = np.ascontiguousarray(np.asarray(matrix, dtype=np.float32))
    return arr.tobytes()


def unpack_embeddings(blob: bytes | None, dim: int) -> np.ndarray:
    """BLOB → (n, dim) float64 矩阵；空/不整除返回空矩阵。"""
    if not blob or dim <= 0:
        return np.zeros((0, dim), dtype=np.float64)
    # 半截/损坏的 BLOB 可能连 float32 边界都不齐——frombuffer 会直接抛错，
    # 而索引行来自中断的写入，读侧必须容错而不是让整个检索崩掉。
    usable = len(blob) - (len(blob) % 4)
    if usable <= 0:
        return np.zeros((0, dim), dtype=np.float64)
    arr = np.frombuffer(blob[:usable], dtype=np.float32)
    if arr.size % dim != 0:
        return np.zeros((0, dim), dtype=np.float64)
    return arr.reshape(-1, dim).astype(np.float64)
