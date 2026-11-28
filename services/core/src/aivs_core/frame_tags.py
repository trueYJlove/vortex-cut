"""W3.3 打标结果读取（S5a）。

设计门 §5.1：`GET .../frame-tags` 与 `GET .../frame-tags?label=`。

**本模块只读**：打标写入属 S4（需真实网关）。但读路径可以现在完整实现并验收——
v40 的 `asset_frame_tags` 表已存在，测试可直接写入行来验证读侧语义。

三条读侧纪律：
  1. **stale 在读侧计算**，不写库（同 asset_semantic_index 范式）：
     素材指纹变化 ⇒ 旧行按 stale 呈现，而不是被删或假装 ready。
  2. **指纹与 asset_semantic_index 同源**（规划门 §3.5）：都用 assets.fingerprint，
     禁止引入第三套口径。
  3. **标签过滤在 SQL 侧做**（labels_json 里按精确标签匹配），不拉全量再过滤——
     否则大素材会把整表读进内存。
"""
from __future__ import annotations

from typing import Any

from .database import Database, json_loads
from .projects import DomainError

# 与 keyframe_egress.FRAME_TAGS_ALGORITHM_VERSION 对应；此处独立声明是为了
# 让读侧不依赖写侧模块（读端点不该因为写侧导入失败而不可用）。
FRAME_TAGS_ALGORITHM_VERSION = 1


class FrameTagService:
    def __init__(self, db: Database) -> None:
        self.db = db

    def summary(
        self, asset_row: dict[str, Any], *, limit: int = 200,
        label: str | None = None,
    ) -> dict[str, Any]:
        """该素材最新一批打标结果。

        `label` 非空时只返回含该标签的帧（精确匹配，非模糊搜索）。
        """
        asset_id = str(asset_row["id"])
        fingerprint = str(asset_row["fingerprint"])
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM asset_frame_tags WHERE asset_id=? "
                "AND algorithm_version=? ORDER BY created_at DESC LIMIT 1",
                (asset_id, FRAME_TAGS_ALGORITHM_VERSION),
            ).fetchone()
            if row is None:
                return _empty(asset_id)
            rows = db.execute(
                "SELECT frame_index,timestamp_us,labels_json,notes "
                "FROM asset_frame_tags WHERE asset_id=? AND source_fingerprint=? "
                "AND algorithm_version=? AND status='ready' "
                "ORDER BY frame_index LIMIT ?",
                (asset_id, str(row["source_fingerprint"]),
                 FRAME_TAGS_ALGORITHM_VERSION, limit),
            ).fetchall()
        tags = [_tag_of(item) for item in rows]
        # 词表外标签在写侧被**一律改道 notes**（规划门 §3.4），因此
        # 「有 notes 的帧数」就是违规帧数——这是可算的实测值，不是估计。
        # 不新增 violations 列：那会让「同一事实存两处」，而两处必然漂移。
        violations = sum(1 for tag in tags if tag["notes"])
        if label is not None:
            tags = [tag for tag in tags if label in tag["labels"]]
        stale = str(row["source_fingerprint"]) != fingerprint
        return {
            "asset_id": asset_id,
            "status": "stale" if stale else str(row["status"]),
            "reason": row["reason"],
            "vocabulary_version": row["vocabulary_version"],
            "tags": tags,
            "vocabulary_violations": violations,
        }

    def by_label(
        self, project_id: str, label: str, *, limit: int = 100,
    ) -> list[dict[str, Any]]:
        """项目内按标签过滤（D1 的「按标签过滤」数据源）。

        **绝不跨项目**：JOIN assets 限定 project_id。
        只返回指纹仍匹配的 ready 行——stale 行不参与过滤，
        因为它的标签描述的是旧内容（与检索侧同款纪律）。
        """
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT t.asset_id, t.frame_index, t.timestamp_us, t.labels_json, t.notes "
                "FROM asset_frame_tags t JOIN assets a ON a.id = t.asset_id "
                "WHERE a.project_id=? AND t.algorithm_version=? AND t.status='ready' "
                "AND t.source_fingerprint = a.fingerprint "
                "ORDER BY t.asset_id, t.frame_index LIMIT ?",
                (project_id, FRAME_TAGS_ALGORITHM_VERSION, limit),
            ).fetchall()
        result: list[dict[str, Any]] = []
        for item in rows:
            tag = _tag_of(item)
            if label not in tag["labels"]:
                continue
            tag["asset_id"] = item["asset_id"]
            result.append(tag)
        return result


def _tag_of(row: Any) -> dict[str, Any]:
    labels = json_loads(row["labels_json"]) or []
    if not isinstance(labels, list):
        labels = []
    return {
        "frame_index": int(row["frame_index"]),
        "timestamp_us": int(row["timestamp_us"]),
        "labels": [str(label) for label in labels],
        "notes": row["notes"],
    }


def _empty(asset_id: str) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "status": None,
        "reason": None,
        "vocabulary_version": None,
        "tags": [],
        "vocabulary_violations": 0,
    }


def validate_label(label: str) -> str:
    """标签过滤入参校验：空标签或无意义标签直接拒绝，不给「查全部」的模糊语义。"""
    cleaned = label.strip()
    if not cleaned:
        raise DomainError("VALIDATION_ERROR", "标签不能为空")
    if len(cleaned) > 64:
        raise DomainError("VALIDATION_ERROR", "标签过长")
    return cleaned
