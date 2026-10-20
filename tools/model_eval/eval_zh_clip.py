"""中文 CLIP 效果评测：双塔（vision+text 分离）与单塔（融合）同条件对照。

为什么需要它：P151/P152 的中文 CLIP 读数全部来自 190MB 的 quantized **单塔**
（model_quantized.onnx），而真正要交付的是 754MB 的 **fp32 双塔**
（vision_model.onnx + text_model.onnx）——后者的效果从未被测过。
本脚本让两种权重在同一批图、同一批查询、同一套预处理下产出可比读数。

**与生产同源**（services/core/src/aivs_core/media/semantic_service.py）：
- 尺寸 CLIP_IMAGE_SIZE(:69)、归一化 preprocess_image(:118-123)、
  CLIP_MEAN/CLIP_STD(:71-72) —— 直接 import，不重写；
- 像素来源 ffmpeg rawvideo rgb24 + scale=224:224（rgb_frames_args:99-115）—— 同一条表达式；
- 分词 wordpiece_tokenizer.WordPieceTokenizer + context_len=52（ZH_CONTEXT_LEN:46）—— 直接 import；
- 相似度 semantic.l2_normalize(:31) 后点积（等价 cosine）—— 直接 import。

零新增依赖：只用 numpy + onnxruntime（均已在 pyproject.toml）+ 仓库自带 ffmpeg。

用法
----
单塔（A/C 组）::

    python tools/model_eval/eval_zh_clip.py \
        --images .tmp/zh-eval/img \
        --catalog evidence/2026-10-19-w31-zh-query-eval/catalog.json \
        --tokenizer .tmp/cc-probe/tokenizer.json \
        --merged .tmp/cc-model/model_quantized.onnx \
        --queries zh --name A_quantized_zh

双塔（B/D 组）::

    ... --vision .tmp/cc-export/out/vision_model.onnx \
        --text   .tmp/cc-export/out/text_model.onnx --queries zh

四组一次跑完（图只解码一次）::

    ... --merged <m> --vision <v> --text <t> --suite --out result.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

from aivs_core.media.semantic import l2_normalize  # noqa: E402
from aivs_core.media.semantic_service import (  # noqa: E402
    CLIP_IMAGE_SIZE,
    ZH_CONTEXT_LEN,
    preprocess_image,
)
from aivs_core.media.wordpiece_tokenizer import load_wordpiece_tokenizer  # noqa: E402

DEFAULT_FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"

# 中文品类词：预登记指定的 10 个品类，与 P151 完全相同的一组直译。
# 为什么用一张 dict 驱动中英两组、而不是两张独立词表：P151 自曝的 bug 正是拿中文
# 字面量与英文 topic 做相等比较 => 中文三组被静默清零。命中判定必须与查询来源同表。
ZH_WORDS: dict[str, str] = {
    "cat": "猫",
    "dog": "狗",
    "horse": "马",
    "bicycle": "自行车",
    "airplane": "飞机",
    "sailboat": "帆船",
    "sunflower": "向日葵",
    "mushroom": "蘑菇",
    "lighthouse": "灯塔",
    "windmill": "风车",
}


# --------------------------------------------------------------------- 图像


def decode_frame(ffmpeg: Path, path: Path) -> np.ndarray:
    """jpg -> (224,224,3) uint8 rgb24。

    与生产抽帧同一条 ffmpeg 表达式（rgb_frames_args 的 scale=224:224）：
    **不做**保持长宽比的 letterbox —— 生产也不做，评测要跟生产一致而不是更漂亮。
    """
    result = subprocess.run(
        [
            str(ffmpeg), "-hide_banner", "-nostdin",
            "-i", str(path),
            "-vf", f"scale={CLIP_IMAGE_SIZE}:{CLIP_IMAGE_SIZE}",
            "-frames:v", "1",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    expected = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE * 3
    if result.returncode != 0 or len(result.stdout) != expected:
        raise SystemExit(
            f"解码失败 {path}：returncode={result.returncode} "
            f"bytes={len(result.stdout)}（期望 {expected}）"
            f" {result.stderr.decode('utf-8', 'replace')[-300:]}"
        )
    return np.frombuffer(result.stdout, dtype=np.uint8).reshape(
        CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE, 3
    )


def load_frames(ffmpeg: Path, files: list[Path]) -> np.ndarray:
    """N 张图 -> (N,3,224,224) float32（逐张走生产的 preprocess_image）。"""
    stacked = [preprocess_image(decode_frame(ffmpeg, p))[0] for p in files]
    return np.stack(stacked).astype(np.float32)


# --------------------------------------------------------------------- 编码器


class Encoder:
    """两个模型形态的统一入口：图像 -> (N,dim)，文本 -> (M,dim)，均 L2 归一化 float64。"""

    label = "?"

    def __init__(self, *, batch: int = 16) -> None:
        import onnxruntime as ort

        self._batch = max(1, int(batch))
        self._options = ort.SessionOptions()
        self._options.log_severity_level = 3
        self._options.intra_op_num_threads = 1
        self._options.inter_op_num_threads = 1
        self._sessions: dict[str, Any] = {}

    def _session(self, key: str, path: Path) -> Any:
        import onnxruntime as ort

        if key not in self._sessions:
            self._sessions[key] = ort.InferenceSession(
                str(path), self._options, providers=["CPUExecutionProvider"]
            )
        return self._sessions[key]

    def encode_images(self, frames: np.ndarray) -> np.ndarray:  # pragma: no cover - 抽象
        raise NotImplementedError

    def encode_texts(self, texts: list[str]) -> np.ndarray:  # pragma: no cover - 抽象
        raise NotImplementedError


class TwoTowerEncoder(Encoder):
    """fp32 双塔：vision_model.onnx（pixel_values→image_embeds）
    + text_model.onnx（input_ids→text_embeds）。

    text 塔的 sequence 维在导出时固定为 52（ZH_CONTEXT_LEN），传错长度直接抛 shape 错误。
    """

    def __init__(self, vision: Path, text: Path, tokenizer: Path, *, batch: int = 16) -> None:
        super().__init__(batch=batch)
        self.label = f"two-tower vision={vision.name} text={text.name}"
        self._vision_path = vision
        self._text_path = text
        self._tokenizer = load_wordpiece_tokenizer(str(tokenizer))

    def encode_images(self, frames: np.ndarray) -> np.ndarray:
        session = self._session("vision", self._vision_path)
        name = session.get_inputs()[0].name
        out_name = session.get_outputs()[0].name
        chunks = []
        for start in range(0, frames.shape[0], self._batch):
            batch = frames[start : start + self._batch]
            chunks.append(np.asarray(session.run([out_name], {name: batch})[0], dtype=np.float64))
        out = np.concatenate(chunks, axis=0)
        return np.stack([l2_normalize(row) for row in out])

    def encode_texts(self, texts: list[str]) -> np.ndarray:
        session = self._session("text", self._text_path)
        inputs = {i.name for i in session.get_inputs()}
        name = session.get_inputs()[0].name
        out_name = session.get_outputs()[0].name
        rows: list[np.ndarray] = []
        for text in texts:
            ids, mask = self._tokenizer.encode(text, ZH_CONTEXT_LEN)
            feeds: dict[str, np.ndarray] = {name: ids}
            if "attention_mask" in inputs:
                feeds["attention_mask"] = mask
            rows.append(np.asarray(session.run([out_name], feeds)[0], dtype=np.float64))
        return np.stack([l2_normalize(row) for row in rows])


class MergedEncoder(Encoder):
    """quantized 融合单塔：一次前向同时吃 pixel_values / input_ids / attention_mask。

    只取 image_embeds / text_embeds 两个输出（融合模型一并导出 logits_*，那是
    exp(t)*cos 的单调变换，对 top1/top3 排名无影响，故不使用）。
    """

    def __init__(self, merged: Path, tokenizer: Path, *, batch: int = 16) -> None:
        super().__init__(batch=batch)
        self.label = f"merged {merged.name}"
        self._merged_path = merged
        self._tokenizer = load_wordpiece_tokenizer(str(tokenizer))

    def _dummy_text(self) -> tuple[np.ndarray, np.ndarray]:
        # 只跑图像时必须喂一组合法但无关的 text 输入。用 [CLS][SEP]（mask=[1,1,...0]）
        # 而不是全零 attention_mask —— 后者会让注意力分母为 0 得到 NaN，污染 image_embeds。
        return self._tokenizer.encode("", ZH_CONTEXT_LEN)

    def encode_images(self, frames: np.ndarray) -> np.ndarray:
        session = self._session("merged", self._merged_path)
        names = {i.name for i in session.get_inputs()}
        outputs = {o.name for o in session.get_outputs()}
        if "image_embeds" not in outputs:
            raise SystemExit("融合模型缺少 image_embeds 输出，无法做双模式对照")
        ids, mask = self._dummy_text()
        chunks = []
        for start in range(0, frames.shape[0], self._batch):
            feeds: dict[str, np.ndarray] = {"pixel_values": frames[start : start + self._batch]}
            if "input_ids" in names:
                feeds["input_ids"] = ids
            if "attention_mask" in names:
                feeds["attention_mask"] = mask
            chunks.append(np.asarray(session.run(["image_embeds"], feeds)[0], dtype=np.float64))
        out = np.concatenate(chunks, axis=0)
        return np.stack([l2_normalize(row) for row in out])

    def encode_texts(self, texts: list[str]) -> np.ndarray:
        session = self._session("merged", self._merged_path)
        names = {i.name for i in session.get_inputs()}
        if "text_embeds" not in {o.name for o in session.get_outputs()}:
            raise SystemExit("融合模型缺少 text_embeds 输出，无法做双模式对照")
        pixel = np.zeros((1, 3, CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE), dtype=np.float32)
        rows: list[np.ndarray] = []
        for text in texts:
            ids, mask = self._tokenizer.encode(text, ZH_CONTEXT_LEN)
            feeds: dict[str, np.ndarray] = {"input_ids": ids}
            if "attention_mask" in names:
                feeds["attention_mask"] = mask
            if "pixel_values" in names:
                feeds["pixel_values"] = pixel
            rows.append(np.asarray(session.run(["text_embeds"], feeds)[0], dtype=np.float64))
        return np.stack([l2_normalize(row) for row in rows])


# ---------------------------------------------------------------------- 评测


@dataclass(frozen=True)
class Query:
    key: str  # 真值 topic（判命中用）
    text: str  # 送进分词器的查询串
    language: str


def build_queries(language: str) -> list[Query]:
    if language == "zh":
        return [Query(key=topic, text=ZH_WORDS[topic], language="zh") for topic in ZH_WORDS]
    if language == "en":
        return [Query(key=topic, text=topic, language="en") for topic in ZH_WORDS]
    raise SystemExit(f"未知查询语言：{language}（只支持 zh / en）")


def rank(
    query_vec: np.ndarray, image_vecs: np.ndarray, names: list[str]
) -> list[tuple[str, float]]:
    """余弦降序；同分按文件名升序 => 排名与数组顺序无关、可复现。"""
    scores = image_vecs @ query_vec
    order = sorted(range(len(names)), key=lambda i: (-float(scores[i]), names[i]))
    return [(names[i], float(scores[i])) for i in order]


def evaluate(
    encoder: Encoder,
    frames: np.ndarray,
    names: list[str],
    image_topics: dict[str, str],
    queries: list[Query],
) -> dict[str, Any]:
    """跑一组读数。

    **判据是 top1/top3**（见 PRE_REGISTRATION.md §2）。`diagnostics` 里的连续量是
    **为天花板情形准备的诊断**，不是判据：当多组 top1 都打满 1.00 时，离散指标没有
    方差、无法区分模型，此时 margin / rank 仍能显示排序质量。它们只在 RESULT 中
    作为探索性证据出现，不参与 F1–F5 判定，也不得单独当作「更好/更差」的结论。
    """
    image_vecs = encoder.encode_images(frames)
    text_vecs = encoder.encode_texts([q.text for q in queries])
    per_query = []
    for query, query_vec in zip(queries, text_vecs):
        ranked = rank(query_vec, image_vecs, names)
        top1_name, top1_score = ranked[0]
        top3 = ranked[:3]
        top1_topic = image_topics[top1_name]
        # 诊断量（非判据，见 evaluate 文档）：top1 是离散的 0/1，57 图 10 查询样本上
        # 极易打满而没有方差。两个连续量在同样的数据上保留区分度：
        #   margin = 最佳同 topic 分 − 最佳异 topic 分（越大越分得开，cosine 可直接跨模型比）
        #   rank   = 同 topic 全部图的名次（随机期望约 29/57，越小越好）
        same = [score for name, score in ranked if image_topics[name] == query.key]
        other = [score for name, score in ranked if image_topics[name] != query.key]
        same_ranks = [
            i + 1 for i, (name, _) in enumerate(ranked) if image_topics[name] == query.key
        ]
        per_query.append(
            {
                "query": query.text,
                "expected_topic": query.key,
                "top1_file": top1_name,
                "top1_topic": top1_topic,
                "top1_score": round(top1_score, 6),
                "top3": [
                    {"file": name, "topic": image_topics[name], "score": round(score, 6)}
                    for name, score in top3
                ],
                "hit1": top1_topic == query.key,
                "hit3": any(image_topics[name] == query.key for name, _ in top3),
                "n_same": len(same),
                "margin": round(max(same) - max(other), 6) if same and other else None,
                "mean_rank_same_topic": (
                    round(float(np.mean(same_ranks)), 4) if same_ranks else None
                ),
                "worst_rank_same_topic": max(same_ranks) if same_ranks else None,
            }
        )
    hits1 = sum(1 for row in per_query if row["hit1"])
    hits3 = sum(1 for row in per_query if row["hit3"])
    n = len(per_query)
    margins = [row["margin"] for row in per_query if row["margin"] is not None]
    mean_ranks = [row["mean_rank_same_topic"] for row in per_query
                  if row["mean_rank_same_topic"] is not None]
    return {
        "model": encoder.label,
        "language": queries[0].language if queries else "?",
        "n_queries": n,
        "n_images": len(names),
        "top1": round(hits1 / n, 4) if n else 0.0,
        "top3": round(hits3 / n, 4) if n else 0.0,
        "hits_top1": hits1,
        "hits_top3": hits3,
        "diagnostics": {
            "mean_margin": round(float(np.mean(margins)), 4) if margins else None,
            "min_margin": round(float(np.min(margins)), 4) if margins else None,
            "mean_rank_same_topic": round(float(np.mean(mean_ranks)), 3) if mean_ranks else None,
            # 每 query 的同 topic 图片数并不相等（catalog 里 mushroom 4、lighthouse 5、其余 6），
            # 用均值而不是 len(names)//n_queries —— 后者会把 57//10 报成 5，与真值不符。
            "mean_images_per_query": round(
                float(np.mean([row["n_same"] for row in per_query])), 3
            )
            if per_query
            else None,
        },
        "per_query": per_query,
        "_embeddings": (image_vecs, text_vecs),
    }


def check_determinism(
    encoder: Encoder,
    frames: np.ndarray,
    names: list[str],
    queries: list[Query],
    reference: tuple[np.ndarray, np.ndarray],
) -> dict[str, Any]:
    """同组第二次跑：embedding 逐位比对 + 排名逐条比对。"""
    image_vecs = encoder.encode_images(frames)
    text_vecs = encoder.encode_texts([q.text for q in queries])
    ref_images, ref_texts = reference
    same_shape_images = image_vecs.shape == ref_images.shape
    same_shape_texts = text_vecs.shape == ref_texts.shape
    images_equal = bool(
        same_shape_images and np.allclose(image_vecs, ref_images, atol=1e-9, rtol=0.0)
    )
    texts_equal = bool(same_shape_texts and np.allclose(text_vecs, ref_texts, atol=1e-9, rtol=0.0))
    rankings = [[n for n, _ in rank(v, image_vecs, names)] for v in text_vecs]
    ref_rankings = [[n for n, _ in rank(v, ref_images, names)] for v in ref_texts]
    rankings_equal = rankings == ref_rankings
    return {
        "images_allclose_atol_1e-9": images_equal,
        "texts_allclose_atol_1e-9": texts_equal,
        "rankings_identical": rankings_equal,
        "max_abs_image_diff": (
            float(np.max(np.abs(image_vecs - ref_images))) if same_shape_images else None
        ),
        "max_abs_text_diff": (
            float(np.max(np.abs(text_vecs - ref_texts))) if same_shape_texts else None
        ),
        "pass": bool(images_equal and texts_equal and rankings_equal),
    }


# ---------------------------------------------------------------------- main


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="中文 CLIP 双塔 / 单塔同条件效果评测")
    parser.add_argument("--images", required=True, help="图片目录")
    parser.add_argument("--catalog", required=True, help="真值 catalog.json（file/topic/title）")
    parser.add_argument("--tokenizer", required=True, help="中文 WordPiece tokenizer.json")
    parser.add_argument("--merged", help="融合单塔 onnx（190MB quantized）")
    parser.add_argument("--vision", help="双塔视觉塔 onnx")
    parser.add_argument("--text", help="双塔文本塔 onnx")
    parser.add_argument("--queries", default="zh", help="zh / en / zh,en")
    parser.add_argument("--suite", action="store_true", help="按 A/B/C/D 四组一次跑完")
    parser.add_argument(
        "--shuffle-truth", type=int, metavar="SEED", help="负向对照：固定种子打乱图-真值配对"
    )
    parser.add_argument("--repeat", type=int, default=1, help="同组重复次数（2 = 做确定性核查）")
    parser.add_argument("--batch", type=int, default=16, help="图像批大小")
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG), help="ffmpeg 可执行文件")
    parser.add_argument("--out", help="写入 JSON 的路径")
    return parser.parse_args(argv)


def load_catalog(catalog_path: Path, images_dir: Path) -> tuple[list[Path], list[str], list[str]]:
    entries = json.loads(catalog_path.read_text(encoding="utf-8"))
    files: list[Path] = []
    names: list[str] = []
    topics: list[str] = []
    for entry in entries:
        name = Path(str(entry["file"])).name
        files.append(images_dir / name)
        names.append(name)
        topics.append(str(entry["topic"]))
    missing = [str(p) for p in files if not p.is_file()]
    if missing:
        raise SystemExit(f"catalog 里有 {len(missing)} 张图不在 {images_dir}：{missing[:3]}")
    return files, names, topics


def shuffled_topics(topics: list[str], seed: int) -> list[str]:
    """固定种子打乱 topic：图不变、真值错位 => 命中应回落到随机水平（指标不是恒真）。"""
    rng = np.random.default_rng(seed)
    permutation = rng.permutation(len(topics))
    shuffled = [topics[int(i)] for i in permutation]
    if shuffled == topics:  # 恒等排列会让负向对照静默失效，换种子重排
        return shuffled_topics(topics, seed + 1)
    return shuffled


def make_encoder(kind: str, args: argparse.Namespace) -> Encoder:
    if kind == "merged":
        return MergedEncoder(Path(args.merged), Path(args.tokenizer), batch=args.batch)
    return TwoTowerEncoder(
        Path(args.vision), Path(args.text), Path(args.tokenizer), batch=args.batch
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ffmpeg = Path(args.ffmpeg)
    if not ffmpeg.is_file():
        raise SystemExit(f"ffmpeg 不存在：{ffmpeg}（用 --ffmpeg 指定）")
    has_merged = bool(args.merged)
    has_towers = bool(args.vision and args.text)
    if args.suite:
        if not (has_merged and has_towers):
            raise SystemExit("--suite 需要同时给出 --merged 与 --vision/--text")
    elif has_merged == has_towers:
        raise SystemExit("必须且只能给出 --merged（单塔）或 --vision + --text（双塔）")

    catalog_path = Path(args.catalog)
    images_dir = Path(args.images)
    files, names, topics = load_catalog(catalog_path, images_dir)
    truth = dict(zip(names, topics))
    if args.shuffle_truth is not None:
        truth = dict(zip(names, shuffled_topics(topics, args.shuffle_truth)))
        print(f"⚠ 负向对照：真值已按种子 {args.shuffle_truth} 打乱（图未变）")

    print(f"图片 {len(names)} 张 / 真值 {len(set(topics))} 个 topic（{catalog_path}）")
    print("解码中（ffmpeg rawvideo rgb24 → preprocess_image）…")
    frames = load_frames(ffmpeg, files)
    print(f"帧张量 {frames.shape} {frames.dtype} 范围 [{frames.min():.3f}, {frames.max():.3f}]")

    if args.suite:
        plan = [
            ("A_quantized_zh", "merged", ["zh"]),
            ("B_fp32_zh", "two-tower", ["zh"]),
            ("C_quantized_en", "merged", ["en"]),
            ("D_fp32_en", "two-tower", ["en"]),
        ]
    else:
        plan = [
            (
                "run",
                "merged" if has_merged else "two-tower",
                [q.strip() for q in args.queries.split(",") if q.strip()],
            )
        ]

    groups: dict[str, Any] = {}
    for group_name, kind, languages in plan:
        encoder = make_encoder(kind, args)
        for language in languages:
            queries = build_queries(language)
            label = group_name if len(languages) == 1 else f"{group_name}_{language}"
            print(f"\n=== {label} | {encoder.label} | 查询 {language}×{len(queries)} ===")
            result = evaluate(encoder, frames, names, truth, queries)
            reference = result.pop("_embeddings")
            if args.repeat > 1:
                det = check_determinism(encoder, frames, names, queries, reference)
                result["determinism"] = det
                print(f"确定性第 2 次：{json.dumps(det, ensure_ascii=False)}")
                second = evaluate(encoder, frames, names, truth, queries)
                second.pop("_embeddings")
                result["second_run"] = {
                    "top1": second["top1"],
                    "top3": second["top3"],
                    "hits_top1": second["hits_top1"],
                    "hits_top3": second["hits_top3"],
                    "identical_to_first": (
                        second["hits_top1"] == result["hits_top1"]
                        and second["hits_top3"] == result["hits_top3"]
                        and second["per_query"] == result["per_query"]
                    ),
                }
                print(f"确定性第 2 次读数：top1 {second['hits_top1']}/{second['n_queries']} "
                      f"top3 {second['hits_top3']}/{second['n_queries']} "
                      f"逐条相同={result['second_run']['identical_to_first']}")
            groups[label] = result
            print(f"top1 {result['hits_top1']}/{result['n_queries']} = {result['top1']:.2f} | "
                  f"top3 {result['hits_top3']}/{result['n_queries']} = {result['top3']:.2f}")
            for row in result["per_query"]:
                if not row["hit1"]:
                    print(f"  MISS {row['query']}({row['expected_topic']}) → "
                          f"{row['top1_file']} [{row['top1_topic']}] {row['top1_score']:.4f}")

    payload = {
        "meta": {
            "images_dir": str(images_dir),
            "catalog": str(catalog_path),
            "tokenizer": str(Path(args.tokenizer)),
            "merged": str(Path(args.merged)) if args.merged else None,
            "vision": str(Path(args.vision)) if args.vision else None,
            "text": str(Path(args.text)) if args.text else None,
            "shuffle_truth_seed": args.shuffle_truth,
            "repeat": args.repeat,
            "batch": args.batch,
            "n_images": len(names),
            "context_len": ZH_CONTEXT_LEN,
            "image_size": CLIP_IMAGE_SIZE,
            "image_topics": truth,
        },
        "groups": groups,
    }
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n已写入 {out_path}")

    print("\n| 组 | 模型 | 查询 | top1 | top3 | 命中 |")
    print("|---|---|---|---|---|---|")
    for label, result in groups.items():
        print(f"| {label} | {result['model']} | {result['language']} | "
              f"**{result['top1']:.2f}** | {result['top3']:.2f} | "
              f"{result['hits_top1']}/{result['n_queries']}, "
              f"{result['hits_top3']}/{result['n_queries']} |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
