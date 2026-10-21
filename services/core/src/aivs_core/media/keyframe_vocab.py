"""W3.3 Layer 2：受控词表加载与校验（D5）。

计划门 §3.4 / Design Gate §6。

两条纪律：
  1. **版本化**：`vocabulary_id` + `vocabulary_version` 单调递增，**禁止原地修改已发布版本**——
     否则历史行的标签语义会漂移，而库里只存了标签文本，无法事后分辨。
  2. **违规不阻断**：词表外标签改道 `notes` 并计数（与 vision_adapter 的解析一致），
     **不丢弃整帧结果**——一次违规丢一帧的代价远大于多留一句描述。

词表是**数据文件**而不是代码常量：换词表不应改代码，也不该触发迁移。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..projects import DomainError

VOCABULARY_DIR = Path("resources/keyframe-vocab")


@dataclass(frozen=True)
class Vocabulary:
    vocabulary_id: str
    vocabulary_version: int
    labels: tuple[str, ...]
    verified: bool

    def allows(self, label: str) -> bool:
        return label in self.labels


def find_vocabulary_dir(root: Path | None = None) -> Path:
    """由本文件位置向上找 `resources/keyframe-vocab`。

    不用 cwd 相对路径：本仓已有「必须从仓库根运行」的隐藏假设坑（P66），
    且测试可能从 services/core 启动。
    """
    if root is not None:
        return root
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / VOCABULARY_DIR
        if candidate.is_dir():
            return candidate
    raise DomainError("VISION_VOCABULARY_VIOLATION", "找不到受控词表目录")


def load_vocabulary(version: int = 1, *, root: Path | None = None) -> Vocabulary:
    directory = find_vocabulary_dir(root)
    path = directory / f"v{version}.json"
    if not path.exists():
        raise DomainError("VISION_VOCABULARY_VIOLATION", f"词表版本不存在: v{version}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DomainError("VISION_VOCABULARY_VIOLATION", "词表不是合法 JSON") from exc
    labels = data.get("labels")
    if not isinstance(labels, list) or not labels:
        raise DomainError("VISION_VOCABULARY_VIOLATION", "词表标签为空")
    deduped: list[str] = []
    for label in labels:
        text = str(label).strip()
        if not text:
            continue
        if text in deduped:
            # 重复标签本身是词表维护错误，但不阻断运行；去重即可。
            continue
        deduped.append(text)
    return Vocabulary(
        vocabulary_id=str(data.get("vocabulary_id") or f"keyframe-v{version}"),
        vocabulary_version=int(data.get("vocabulary_version") or version),
        labels=tuple(deduped),
        verified=bool(data.get("verified", False)),
    )
