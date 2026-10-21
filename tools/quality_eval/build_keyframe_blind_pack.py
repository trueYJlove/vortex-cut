"""W3.3 关键帧打标人工盲评包生成器（S5b）。

依据：evidence/2026-10-21-w33-keyframe-blind-eval/PRE_REGISTRATION.md
（判据先于看数入库，评审 M4 要求）。

产出可独立运行的盲评包：frames/ + score-sheet.md + manifest.json。

盲的要求：包内不含模型名、Provider 名、相似度分数、生成时间；
评分表里也不出现素材名，否则评分者会先入为主。
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

# 预登记 §1 冻结的抽样规则——不得因结果调整。
ASSETS_LIMIT = 5
FRAMES_PER_ASSET = 3


def sample_frames(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """素材按 id 升序取前 5，每个取其前 3 帧（frame_index 升序）。"""
    by_asset: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_asset.setdefault(str(row["asset_id"]), []).append(row)
    picked: list[dict[str, Any]] = []
    for asset_id in sorted(by_asset)[:ASSETS_LIMIT]:
        frames = sorted(by_asset[asset_id], key=lambda r: int(r["frame_index"]))
        picked.extend(frames[:FRAMES_PER_ASSET])
    return picked


def blind_label(index: int) -> str:
    """样张编号；刻意不含素材名与时间。"""
    return f"sample-{index:02d}"


def build_score_sheet(samples: list[dict[str, Any]]) -> str:
    """逐帧评分表；三档强制选择（预登记 §2）。"""
    lines = [
        "# W3.3 关键帧打标盲评 · 评分表",
        "",
        "评分规则见 PRE_REGISTRATION.md §2。要点：",
        "- 合理：标签正确描述画面主要内容；或空标签且 notes 明确且属实。",
        "- 部分合理：沾边但不准确，或漏掉最显眼主体。",
        "- 不合理：与画面矛盾；或把明显可归类的画面判成空标签。",
        "- 空标签不是自动失败：看 notes 是否如实说明无可匹配类目。",
        "",
        "在每行末尾三个方框中勾选一个。",
        "",
        "| 编号 | 帧标签 | notes | 合理 | 部分合理 | 不合理 |",
        "|---|---|---|---|---|---|",
    ]
    for sample in samples:
        labels = "、".join(sample["labels"]) or "（空）"
        notes = (sample["notes"] or "").replace("|", "·").replace(chr(10), " ")
        lines.append(
            f"| {sample['sample_id']} | {labels} | {notes} | ☐ | ☐ | ☐ |"
        )
    lines += [
        "",
        "## 评分者签名与日期",
        "",
        "签名：____________  日期：____________",
        "",
        "## 完成后",
        "",
        "1. 另存为 score-sheet-done.md（保留勾选）。",
        "2. 运行 python summarize.py score-sheet-done.md。",
        "3. 结论文表述受 PRE_REGISTRATION.md §6 限制（不得写准确率 N%）。",
    ]
    return chr(10).join(lines) + chr(10)


def build_manifest(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """编号与素材/帧的映射；评分完成后再看。"""
    return {
        "note": "评分完成前不要查看本文件（会破坏盲评）。",
        "samples": [
            {
                "sample_id": sample["sample_id"],
                "asset_id": sample["asset_id"],
                "frame_index": sample["frame_index"],
                "timestamp_us": sample["timestamp_us"],
            }
            for sample in samples
        ],
    }


def assemble(
    rows: list[dict[str, Any]],
    payload_loader: Any,
    out_dir: Path,
) -> dict[str, Any]:
    """把行与图片字节拼成盲评包。

    payload_loader(preview_id, frame_index) -> bytes 由调用方提供：
    生产路径取 KeyframeEgressService.load_payload，测试可传内存字典。
    """
    samples = sample_frames(rows)
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    enriched: list[dict[str, Any]] = []
    for index, row in enumerate(samples, start=1):
        sample_id = blind_label(index)
        data = payload_loader(row["preview_id"], int(row["frame_index"]))
        (frames_dir / f"{sample_id}.jpg").write_bytes(data)
        enriched.append(
            {
                **row,
                "sample_id": sample_id,
                "labels": list(row["labels"]),
                "notes": row["notes"],
            }
        )

    (out_dir / "score-sheet.md").write_text(
        build_score_sheet(enriched), encoding="utf-8"
    )
    (out_dir / "manifest.json").write_text(
        json.dumps(build_manifest(enriched), ensure_ascii=False, indent=2) + chr(10),
        encoding="utf-8",
    )
    summarize = Path(__file__).with_name("summarize_keyframe_blind.py")
    if summarize.exists():
        shutil.copy2(summarize, out_dir / "summarize.py")

    return {"sample_count": len(enriched), "out_dir": str(out_dir)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建 W3.3 关键帧盲评包")
    parser.add_argument("--out", required=True, help="输出目录")
    args = parser.parse_args(argv)
    print(f"本工具由 Core 侧调用；out={args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
