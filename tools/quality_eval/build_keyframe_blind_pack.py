"""W3.3 关键帧打标人工盲评包生成器（S5b）。

依据：evidence/2026-10-21-w33-keyframe-blind-eval/PRE_REGISTRATION.md
（判据先于看数入库，评审 M4 要求）。

产出可独立运行的盲评包：frames/ + score-sheet.md + manifest.json。

盲的要求：包内不含模型名、Provider 名、相似度分数、生成时间；
评分表里也不出现素材名，否则评分者会先入为主。

---

## 为什么建包要「重抽帧」，而不是从载荷目录里取现成的图

P163④ 上线后，打标收尾（run_tagging_job）会**立即删除载荷字节**
（KeyframeEgressService.purge_preview）。所以建包时刻，图上早就不在盘上了。
本模块因此不依赖旧载荷目录，而是：

1. 从 asset_frame_tags 读**真实落库**的标签行；
2. 沿 generation_id → keyframe_generations.egress_preview_id →
   keyframe_egress_previews.frames_json 取该帧当初外传时的
   timestamp_us 与 payload_sha256；
3. 用**同一个** media/keyframe_encode.encode_frames 按同一个
   timestamp_us 重新编码一帧；
4. **逐帧比对 sha256**：一致才写进包。

第 4 步是这套方案的全部价值所在：重抽若与当初外传的字节不一致，
盲评看的就**不是**模型当时看的那张图，结论无意义。因此不一致时
本模块**如实报错、在报告里点名该帧，且不写进 frames/**——不静默跳过、
也不降级为「用别的图凑数」。可复算性已实测：同一素材同一 timestamp_us
两次编码字节完全相同（端到端用例锁住这条前提）。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]

# 预登记 §1 冻结的抽样规则——不得因结果调整。
ASSETS_LIMIT = 5
FRAMES_PER_ASSET = 3

# 只认可与写侧同算法版本的标签行；混版本会让「评的是哪套算法」不可判定。
FRAME_TAGS_ALGORITHM_VERSION = 1

# 随包 ffmpeg（electron-builder.yml 打包位置）。
DEFAULT_FFMPEG = REPO / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"

# 排除原因（写进 manifest 的 excluded 列表，供复算；不是 UI 文案）。
REASON_SHA_MISMATCH = "payload_sha256_mismatch"
REASON_ENCODE_FAILED = "reencode_failed"
REASON_ASSET_MISSING = "asset_file_missing"
REASON_FRAME_UNMAPPED = "frame_not_in_preview"
REASON_FRAME_EXCLUDED = "frame_excluded_by_user"
REASON_DUPLICATE_CONTENT = "duplicate_asset_content"


def sample_frames(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """素材按 id 升序取前 5，每个取其前 3 帧（frame_index 升序）。

    **同一物理内容只计一次**（2026-10-22 收口补充）：素材行按 asset_id 计，
    而同一个文件可以被导入两次得到两个 asset 行（用户库里实测存在：
    asset_20f89c8cf050 与 asset_34c928546b82 指向同一个 mp4）。不去重时
    盲评包里会出现逐字节相同的图——这既稀释评分者的独立判断力，也**虚增
    样本量**（12 张说成 12 个独立观测，实际只有 9 个）。

    去重判据用 **asset.fingerprint**（内容指纹）而不是 URI：同一文件的 URI
    可能因搬迁不同（previous_uri / relocated_at），指纹才是内容身份。
    取 id 最小的那个 asset 行（与「按 id 升序」的既有口径一致），其余计为
    排除项并如实报告。
    """
    by_asset: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_asset.setdefault(str(row["asset_id"]), []).append(row)

    kept: list[tuple[str, list[dict[str, Any]]]] = []
    seen_fingerprints: dict[str, str] = {}
    for asset_id in sorted(by_asset):
        frames = sorted(by_asset[asset_id], key=lambda r: int(r["frame_index"]))
        fingerprint = str(frames[0].get("asset_fingerprint") or "")
        if fingerprint and fingerprint in seen_fingerprints:
            continue  # 同一物理内容的后续 asset 行：已在 duplicate_assets 里可查
        if fingerprint:
            seen_fingerprints[fingerprint] = asset_id
        kept.append((asset_id, frames))

    picked: list[dict[str, Any]] = []
    for _asset_id, frames in kept[:ASSETS_LIMIT]:
        picked.extend(frames[:FRAMES_PER_ASSET])
    return picked


def duplicate_assets(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """被指纹去重跳过的素材（供调用方如实计入排除项，不静默丢）。

    单独成函数而不是让 sample_frames 返回元组：sample_frames 的签名被既有
    测试与 assemble 路径共用，改签名会牵动与去重无关的代码。
    """
    by_asset: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_asset.setdefault(str(row["asset_id"]), []).append(row)
    seen: dict[str, str] = {}
    duplicates: list[dict[str, Any]] = []
    for asset_id in sorted(by_asset):
        frames = by_asset[asset_id]
        fingerprint = str(frames[0].get("asset_fingerprint") or "")
        if not fingerprint:
            continue
        if fingerprint in seen:
            duplicates.append(
                {
                    "asset_id": asset_id,
                    "duplicate_of": seen[fingerprint],
                    "frames_skipped": len(frames),
                    "reason": REASON_DUPLICATE_CONTENT,
                }
            )
        else:
            seen[fingerprint] = asset_id
    return duplicates


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


def build_manifest(
    samples: list[dict[str, Any]], failures: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """编号与素材/帧的映射；评分完成后再看。

    被排除的帧与被评样张同属「映射侧」信息（含素材 id），因此也放本文件
    而不是评分表：预登记 §1 要求被排除的帧**如实列出**，§4 要求评分表
    本身不含素材名。
    """
    excluded = list(failures or [])
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
        "excluded": excluded,
        "excluded_count": len(excluded),
    }


def assemble(
    rows: list[dict[str, Any]],
    payload_loader: Any,
    out_dir: Path,
    *,
    failures: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """把行与图片字节拼成盲评包。

    payload_loader(preview_id, frame_index) -> bytes 由调用方提供：
    生产路径（build_pack）只放行**已通过 sha256 自证**的帧，测试可传内存字典。
    """
    samples = sample_frames(rows)
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    # 清掉上一轮的样张：否则本次只产出 9 张时，上一轮的第 10..15 张会
    # 残留在包里冒充样本。只删本函数自己写过的文件名。
    for stale in frames_dir.glob("sample-*.jpg"):
        stale.unlink()

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
        json.dumps(build_manifest(enriched, failures), ensure_ascii=False, indent=2)
        + chr(10),
        encoding="utf-8",
    )
    summarize = Path(__file__).with_name("summarize_keyframe_blind.py")
    if summarize.exists():
        shutil.copy2(summarize, out_dir / "summarize.py")

    return {
        "sample_count": len(enriched),
        "out_dir": str(out_dir),
        "failures": list(failures or []),
    }


# ── 真实落库读取（只读，不改任何表） ──


def _connect(db_path: Path):
    """只读连接：建包**绝不写库**（盲评包是派生物，改库会把证据变成副作用）。"""
    import sqlite3

    uri = "file:" + Path(db_path).as_posix() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def load_tagged_rows(
    db_path: Path, *, project_id: str | None = None,
) -> list[dict[str, Any]]:
    """读**真实落库**的标签行（预登记 §1 的抽样口径在此体现）。

    只取满足下列全部条件的行：
      - status='ready'（打标失败的帧不进盲评包）；
      - 素材是视频且 availability='available'（不可用素材不进包）；
      - 行指纹与素材当前指纹一致（stale 行描述的是旧内容，评它无意义）；
      - 有 generation_id 且其预览行存在（否则无法定位当初那帧的哈希与时刻）。

    「按素材 ID 升序取前 N 个**可用**视频素材」是预登记原文——先过滤可用性
    再排序截断，而不是先取前 5 再丢掉不可用的（后者会少给素材）。
    """
    sql = (
        "SELECT t.asset_id, t.frame_index, t.timestamp_us, t.labels_json, t.notes,"
        " t.generation_id, t.created_at, g.egress_preview_id, a.project_id,"
        " a.fingerprint AS asset_fingerprint "
        "FROM asset_frame_tags t "
        "JOIN assets a ON a.id = t.asset_id "
        "LEFT JOIN keyframe_generations g ON g.id = t.generation_id "
        "WHERE t.algorithm_version = ? AND t.status = 'ready' "
        "AND a.kind = 'video' AND a.availability = 'available' "
        "AND t.source_fingerprint = a.fingerprint "
        "AND t.generation_id IS NOT NULL "
        "ORDER BY t.asset_id, t.frame_index, t.created_at DESC"
    )
    params: list[Any] = [FRAME_TAGS_ALGORITHM_VERSION]
    if project_id is not None:
        sql = sql.replace("ORDER BY", "AND a.project_id = ? ORDER BY")
        params.append(project_id)
    connection = _connect(db_path)
    try:
        rows = connection.execute(sql, params).fetchall()
    finally:
        connection.close()

    # 同一 (素材, 帧) 可能因重跑打标而有多行：取最新一批，避免重复计样张。
    seen: dict[tuple[str, int], dict[str, Any]] = {}
    for row in rows:
        key = (str(row["asset_id"]), int(row["frame_index"]))
        if key in seen:
            continue
        try:
            parsed = json.loads(row["labels_json"]) if row["labels_json"] else []
        except json.JSONDecodeError:
            parsed = []
        seen[key] = {
            "preview_id": row["egress_preview_id"],
            "asset_id": str(row["asset_id"]),
            "frame_index": int(row["frame_index"]),
            "timestamp_us": int(row["timestamp_us"]),
            "labels": [str(label) for label in parsed] if isinstance(parsed, list) else [],
            "notes": row["notes"],
            "generation_id": str(row["generation_id"]),
            "project_id": str(row["project_id"]),
            # 指纹用于「同一物理内容只计一次」：同一文件被导入两次会得到两个
            # asset 行（实测 user 库就有），不去重的话盲评包里会出现逐字节
            # 相同的图，评分者独立判断力被稀释、样本量也被虚增。
            "asset_fingerprint": str(row["asset_fingerprint"]),
        }
    return list(seen.values())


def expected_payload_sha256(
    db_path: Path, generation_id: str, frame_index: int,
) -> dict[str, Any]:
    """取该帧当初**实际外传**的哈希与时刻（沿 generation → preview 两跳）。

    返回 {preview_id, timestamp_us, payload_sha256}；定位不到时返回
    {"reason": ...} 而不是抛异常——调用方要把「哪一帧、为什么」记进报告，
    抛异常会让一次建包在第 7 帧中止，前 6 帧的自证结果也读不到。
    """
    connection = _connect(db_path)
    try:
        row = connection.execute(
            "SELECT p.id AS preview_id, p.frames_json, p.excluded_frames_json "
            "FROM keyframe_generations g "
            "JOIN keyframe_egress_previews p ON p.id = g.egress_preview_id "
            "WHERE g.id = ?",
            (generation_id,),
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        return {"reason": REASON_FRAME_UNMAPPED}
    try:
        metas = json.loads(row["frames_json"] or "[]")
        excluded = {int(i) for i in json.loads(row["excluded_frames_json"] or "[]")}
    except (json.JSONDecodeError, TypeError, ValueError):
        return {"reason": REASON_FRAME_UNMAPPED}
    if frame_index in excluded:
        return {"reason": REASON_FRAME_EXCLUDED}
    for meta in metas:
        if int(meta.get("frame_index", -1)) == frame_index:
            return {
                "preview_id": str(row["preview_id"]),
                "timestamp_us": int(meta["timestamp_us"]),
                "payload_sha256": str(meta["payload_sha256"]),
            }
    return {"reason": REASON_FRAME_UNMAPPED}


def asset_file_path(db_path: Path, asset_id: str) -> Path | None:
    """素材在盘上的路径；不在盘上返回 None（如实计入失败，不静默跳过）。"""
    from aivs_core.projects import _path_from_uri  # 复用既有 URI 解码，不写第二份

    connection = _connect(db_path)
    try:
        row = connection.execute(
            "SELECT uri FROM asset_locations WHERE asset_id=?", (asset_id,)
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        return None
    path = _path_from_uri(str(row["uri"]))
    return path if path.is_file() else None


async def _encode_one_frame(ffmpeg: Path, path: Path, timestamp_us: int) -> bytes:
    """按同一 timestamp 重抽一帧——走生产的 encode_frames，不复制它的 argv。

    复制一份 ffmpeg 参数会让「重抽」与「当初外传」在两套参数上跑，
    sha256 永远对不上，自证就退化成必然失败。
    """
    from aivs_core.media.keyframe_encode import encode_frames

    frames = await encode_frames(ffmpeg, path, [(timestamp_us, "blind_pack_rebuild")])
    return frames[0].payload_bytes


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def build_pack(
    db_path: Path,
    out_dir: Path,
    ffmpeg: Path,
    *,
    project_id: str | None = None,
    encoder: Any = None,
) -> dict[str, Any]:
    """读落库标签 → 重抽帧 → 逐帧 sha256 自证 → 出包。

    encoder(ffmpeg, path, timestamp_us) -> bytes 可注入：测试用假编码器
    构造「重抽结果与记录不一致」，以证明自证逻辑真的会拦（不是装饰）。
    """
    encode = encoder or _encode_one_frame
    rows = load_tagged_rows(db_path, project_id=project_id)
    samples = sample_frames(rows)

    payloads: dict[tuple[str, int], bytes] = {}
    verified: list[dict[str, Any]] = []
    # 被指纹去重跳过的素材要先记进排除项：否则「12 张里有 6 张重复」这件事
    # 在报告里完全看不见，读者会以为 12 个都是独立观测。
    failures: list[dict[str, Any]] = [
        {
            "asset_id": duplicate["asset_id"],
            "frame_index": -1,
            "timestamp_us": 0,
            "reason": duplicate["reason"],
            "duplicate_of": duplicate["duplicate_of"],
            "frames_skipped": duplicate["frames_skipped"],
        }
        for duplicate in duplicate_assets(rows)
    ]

    for row in samples:
        asset_id, frame_index = str(row["asset_id"]), int(row["frame_index"])

        def fail(reason: str, **extra: Any) -> None:
            failures.append(
                {
                    "asset_id": asset_id,
                    "frame_index": frame_index,
                    "timestamp_us": int(row["timestamp_us"]),
                    "reason": reason,
                    **extra,
                }
            )

        path = asset_file_path(db_path, asset_id)
        if path is None:
            fail(REASON_ASSET_MISSING)
            continue
        expected = expected_payload_sha256(
            db_path, str(row["generation_id"]), frame_index
        )
        if "payload_sha256" not in expected:
            fail(str(expected.get("reason") or REASON_FRAME_UNMAPPED))
            continue
        # 以预览行里冻结的时刻为准：盲评要复算的是**当初外传**的那一帧。
        timestamp_us = int(expected["timestamp_us"])
        try:
            data = await encode(ffmpeg, path, timestamp_us)
        except Exception as exc:  # noqa: BLE001 单帧失败必须计名，不能中断整包
            fail(REASON_ENCODE_FAILED, detail=type(exc).__name__)
            continue
        actual = sha256_hex(data)
        if actual != expected["payload_sha256"]:
            # 自证失败：这一帧**不进包**。盲评若看的是另一张图，结论无意义。
            fail(
                REASON_SHA_MISMATCH,
                expected_sha256=expected["payload_sha256"],
                actual_sha256=actual,
            )
            continue
        payloads[(str(row["preview_id"]), frame_index)] = data
        verified.append({**row, "timestamp_us": timestamp_us})

    def loader(preview_id: str, frame_index: int) -> bytes:
        return payloads[(str(preview_id), int(frame_index))]

    result = assemble(verified, loader, out_dir, failures=failures)
    result["rows_read"] = len(rows)
    result["sampled"] = len(samples)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建 W3.3 关键帧盲评包")
    parser.add_argument("--db", required=True, help="app.db 路径（只读打开）")
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument(
        "--project", default=None,
        help="项目 id；省略则跨全部项目按素材 id 升序取样",
    )
    parser.add_argument(
        "--ffmpeg", default=None, help=f"ffmpeg 可执行文件；默认 {DEFAULT_FFMPEG}"
    )
    args = parser.parse_args(argv)

    ffmpeg = Path(args.ffmpeg) if args.ffmpeg else DEFAULT_FFMPEG
    if not ffmpeg.exists():
        print(f"ffmpeg 不存在：{ffmpeg}", file=sys.stderr)
        return 2

    result = asyncio.run(
        build_pack(Path(args.db), Path(args.out), ffmpeg, project_id=args.project)
    )
    print(
        f"落库标签行 {result['rows_read']}；抽样 {result['sampled']}；"
        f"入包 {result['sample_count']}；排除 {len(result['failures'])}"
    )
    for failure in result["failures"]:
        # 报告里点名是哪一帧——不静默跳过。
        print(
            f"  排除 {failure['asset_id']} frame_index={failure['frame_index']} "
            f"t={failure['timestamp_us']}us 原因={failure['reason']}"
        )
    print(f"输出：{result['out_dir']}")
    return 0 if result["sample_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
