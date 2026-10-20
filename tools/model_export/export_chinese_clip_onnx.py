"""导出中文 CLIP ViT-B/16 双塔 ONNX —— 本仓自用产物生成器。

产物（3 个文件，共约 754MB）**不入库**：它们由本脚本在每台机器上就地生成，
清单通过 file://${AIVS_MODEL_SOURCE_ROOT}/chinese-clip-vit-base-patch16/<path>
指过来。因此清单里的 size_bytes / 每文件 sha256 / 聚合 sha256 必须由本脚本
实算，不得手抄——见 --update-manifest。

为什么 torch / onnx / cn-clip **不进** pyproject.toml：它们只在本脚本运行时
需要，且体积与平台绑定性极强（torch CPU wheel 约 200MB 起，cn-clip 还固定
依赖特定 transformers 版本）。Core 运行时只依赖 onnxruntime（见清单的
runtime_version），把导出依赖塞进运行时依赖会让每一次安装都为一次性的离线
产物生成付出代价。跑本脚本前在同一个 venv 里手工装：

    .venv/Scripts/python.exe -m pip install torch onnx cn-clip

两种模式：

    # 只校验已有产物并打印哈希（不需要 torch/onnx/cn_clip）
    .venv/Scripts/python.exe tools/model_export/export_chinese_clip_onnx.py \
        --dry-run --out .tmp/cc-export/out --tokenizer .tmp/cc-probe/tokenizer.json

    # 全量导出（需要 --checkpoint 指向上游融合 .pt）
    .venv/Scripts/python.exe tools/model_export/export_chinese_clip_onnx.py \
        --out .tmp/cc-export/out --checkpoint /path/to/clip_cn_vit-b-16.pt \
        --update-manifest resources/model-manifests/chinese-clip-vit-base-patch16.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

# 与 services/core/src/aivs_core/media/semantic_service.py 保持一致：
# ZH_CONTEXT_LEN = 52，CLIP_IMAGE_SIZE = 224。text 塔的 sequence 维在导出时
# 就被烘死成固定值，导错了运行时直接抛 shape 错误（P151 实测），故写常量。
CONTEXT_LEN = 52
IMAGE_SIZE = 224
EMBED_DIM = 512

MODEL_ID = "chinese-clip-vit-base-patch16"
SOURCE_ROOT_VAR = "AIVS_MODEL_SOURCE_ROOT"

VISION_FILE = "vision_model.onnx"
TEXT_FILE = "text_model.onnx"
TOKENIZER_FILE = "tokenizer.json"
# 顺序即清单 files[] 顺序，也是聚合 sha256 的串接顺序。
FILE_ORDER = (VISION_FILE, TEXT_FILE, TOKENIZER_FILE)

# cn_clip 的模型名格式：<vision>@<text>。
CN_CLIP_MODEL_NAME = "ViT-B-16@RoBERTa-wwm-ext-base-chinese"
ONNX_OPSET = 17


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def aggregate_sha256(paths: list[Path]) -> str:
    """按给定顺序串接文件字节取 sha256。

    与 aivs_core.model_registry._manifest_files_sha256 完全同算法：一个
    hashlib 对象顺序喂入每个文件的全部字节。顺序必须等于清单 files[] 顺序，
    否则算出来的值必然对不上（这正是本仓中文清单历史上的错法）。
    """
    digest = hashlib.sha256()
    for path in paths:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def describe(directory: Path, tokenizer_path: Path | None = None) -> dict[str, Any]:
    """算出清单所需的全部数值（不容忍缺失：缺文件直接报可操作的错）。"""
    locations = {name: directory / name for name in FILE_ORDER}
    if tokenizer_path is not None:
        locations[TOKENIZER_FILE] = tokenizer_path
    missing = [name for name, path in locations.items() if not path.is_file()]
    if missing:
        raise SystemExit(
            "缺少产物：" + "、".join(missing) + "\n"
            f"产物目录：{directory}\n"
            "请先不带 --dry-run 跑一次本脚本完成导出（需要 --checkpoint）。"
        )
    ordered = [locations[name] for name in FILE_ORDER]
    files = [
        {
            "path": name,
            "size_bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
        for name, path in zip(FILE_ORDER, ordered)
    ]
    return {
        "model_id": MODEL_ID,
        "source_root_var": SOURCE_ROOT_VAR,
        "files": files,
        "size_bytes": sum(item["size_bytes"] for item in files),
        "sha256": aggregate_sha256(ordered),
    }


def build_tokenizer_json(vocab_file: Path) -> dict[str, Any]:
    """由 BERT 词表直接生成 tokenizer.json（零第三方依赖）。

    不调 tokenizers 库：库会把 post_processor 归一成 BertProcessing、并把
    词表里的空串/U+2028 行改写，生成物与上游逐字节不同。这里直接按 HF 的
    tokenizer.json 结构写出（indent=2、ensure_ascii=False、无尾换行），
    可复现、可审计，且本仓 wordpiece_tokenizer.py 只读 model.type 与 vocab。
    """
    raw = vocab_file.read_bytes().split(b"\n")
    if raw and raw[-1] == b"":
        raw = raw[:-1]
    lines = [line[:-1] if line.endswith(b"\r") else line for line in raw]
    vocab = {token.decode("utf-8"): index for index, token in enumerate(lines)}
    if not vocab:
        raise SystemExit(f"词表为空：{vocab_file}")

    def special(content: str, index: int) -> dict[str, Any]:
        return {
            "id": index,
            "content": content,
            "single_word": False,
            "lstrip": False,
            "rstrip": False,
            "normalized": False,
            "special": True,
        }

    return {
        "version": "1.0",
        "truncation": None,
        "padding": None,
        "added_tokens": [
            special("[PAD]", 0),
            special("[UNK]", 100),
            special("[CLS]", 101),
            special("[SEP]", 102),
            special("[MASK]", 103),
        ],
        "normalizer": {
            "type": "BertNormalizer",
            "clean_text": True,
            "handle_chinese_chars": True,
            "strip_accents": None,
            "lowercase": True,
        },
        "pre_tokenizer": {"type": "BertPreTokenizer"},
        "post_processor": {
            "type": "TemplateProcessing",
            "single": [
                {"SpecialToken": {"id": "[CLS]", "type_id": 0}},
                {"Sequence": {"id": "A", "type_id": 0}},
                {"SpecialToken": {"id": "[SEP]", "type_id": 0}},
            ],
            "pair": [
                {"SpecialToken": {"id": "[CLS]", "type_id": 0}},
                {"Sequence": {"id": "A", "type_id": 0}},
                {"SpecialToken": {"id": "[SEP]", "type_id": 0}},
                {"Sequence": {"id": "B", "type_id": 1}},
                {"SpecialToken": {"id": "[SEP]", "type_id": 1}},
            ],
            "special_tokens": {
                "[CLS]": {"id": "[CLS]", "ids": [101], "tokens": ["[CLS]"]},
                "[SEP]": {"id": "[SEP]", "ids": [102], "tokens": ["[SEP]"]},
            },
        },
        "decoder": {"type": "WordPiece", "prefix": "##", "cleanup": True},
        "model": {
            "type": "WordPiece",
            "unk_token": "[UNK]",
            "continuing_subword_prefix": "##",
            "max_input_chars_per_word": 100,
            "vocab": vocab,
        },
    }


def write_tokenizer_json(vocab_file: Path, destination: Path) -> None:
    payload = build_tokenizer_json(vocab_file)
    destination.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def default_vocab_file() -> Path:
    """cn_clip 自带词表（21128 行 BERT WordPiece）。"""
    import cn_clip.clip  # noqa: PLC0415  (可选依赖：延迟到真正需要时)

    return Path(cn_clip.clip.__file__).parent / "vocab.txt"


def export_towers(out_dir: Path, checkpoint: Path) -> None:
    """把融合 .pt 装载成双塔并各导出一个 ONNX（需要 torch/onnx/cn_clip）。"""
    import torch  # noqa: PLC0415
    from cn_clip.clip.model import CLIP  # noqa: PLC0415
    from cn_clip.clip.utils import create_model  # noqa: PLC0415

    if not checkpoint.is_file():
        raise SystemExit(f"检查点不存在：{checkpoint}")

    model = create_model(CN_CLIP_MODEL_NAME)
    state = torch.load(checkpoint, map_location="cpu")
    if "state_dict" in state:
        state = state["state_dict"]
    if next(iter(state))[0:7] == "module.":
        state = {key[len("module.") :]: value for key, value in state.items()}
    missing, unexpected = model.load_state_dict(state, strict=False)
    model = model.eval().float()
    print(f"装载检查点：缺 {len(missing)} 键、多 {len(unexpected)} 键")

    class VisionTower(torch.nn.Module):
        def __init__(self, inner: CLIP) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, pixel_values):  # noqa: ANN001, ANN202
            return self.inner.encode_image(pixel_values)

    class TextTower(torch.nn.Module):
        def __init__(self, inner: CLIP) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, input_ids):  # noqa: ANN001, ANN202
            return self.inner.encode_text(input_ids)

    jobs = (
        (
            VISION_FILE,
            VisionTower(model),
            torch.zeros(1, 3, IMAGE_SIZE, IMAGE_SIZE),
            "pixel_values",
            "image_embeds",
        ),
        (
            TEXT_FILE,
            TextTower(model),
            torch.zeros(1, CONTEXT_LEN, dtype=torch.long),
            "input_ids",
            "text_embeds",
        ),
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, tower, sample, input_name, output_name in jobs:
        tower.eval()
        destination = out_dir / name
        with torch.no_grad():
            torch.onnx.export(
                tower,
                (sample,),
                str(destination),
                opset_version=ONNX_OPSET,
                input_names=[input_name],
                output_names=[output_name],
                dynamic_axes={input_name: {0: "batch"}, output_name: {0: "batch"}},
                do_constant_folding=True,
            )
        print(f"已导出 {destination}")


def check_onnx_shapes(out_dir: Path) -> None:
    """导出后立刻核对固定维（52 / 224），错在这里比错在运行时便宜。"""
    import onnx  # noqa: PLC0415

    expected = {
        VISION_FILE: (3, IMAGE_SIZE, IMAGE_SIZE),
        TEXT_FILE: (CONTEXT_LEN,),
    }
    for name, tails in expected.items():
        graph = onnx.load(str(out_dir / name), load_external_data=False).graph
        dims = tuple(
            dim.dim_value or dim.dim_param
            for dim in graph.input[0].type.tensor_type.shape.dim
        )[1:]
        if dims != tails:
            raise SystemExit(f"{name} 输入尾维 {dims} != 期望 {tails}")
        print(f"{name} 输入 {graph.input[0].name} 形状 {dims} 已核对")


def update_manifest(manifest_path: Path, summary: dict[str, Any]) -> None:
    """把实算值写回清单，只动 size/sha 字段，其余（含 license）逐字节保留。"""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    by_path = {item["path"]: item for item in summary["files"]}
    for entry in manifest["files"]:
        computed = by_path.get(entry["path"])
        if computed is None:
            raise SystemExit(f"清单声明了未知文件：{entry['path']}")
        entry["size_bytes"] = computed["size_bytes"]
        entry["sha256"] = computed["sha256"]
    manifest["size_bytes"] = summary["size_bytes"]
    manifest["installed_size_bytes"] = summary["size_bytes"]
    manifest["sha256"] = summary["sha256"]
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"已更新清单：{manifest_path}")


def print_summary(summary: dict[str, Any], manifest: Path | None) -> None:
    for item in summary["files"]:
        print(f"  {item['path']:<20} size={item['size_bytes']:>12}  sha256={item['sha256']}")
    print(f"  {'合计':<20} size={summary['size_bytes']:>12}")
    print(f"  聚合 sha256（清单 sha256）= {summary['sha256']}")
    if manifest is not None:
        declared = json.loads(manifest.read_text(encoding="utf-8")).get("sha256")
        verdict = "一致" if declared == summary["sha256"] else "不一致"
        print(f"  清单当前声明 = {declared} → {verdict}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导出/校验中文 CLIP 双塔 ONNX")
    parser.add_argument("--out", required=True, type=Path, help="产物目录")
    parser.add_argument(
        "--tokenizer",
        type=Path,
        default=None,
        help="已有 tokenizer.json 的位置（默认取 --out/tokenizer.json）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只校验并打印已有产物的 size/sha256/聚合值，不重新导出",
    )
    parser.add_argument("--checkpoint", type=Path, default=None, help="上游融合 .pt 检查点")
    parser.add_argument("--vocab", type=Path, default=None, help="BERT 词表（默认取 cn_clip 自带）")
    parser.add_argument(
        "--update-manifest",
        type=Path,
        default=None,
        help="把实算值写回指定清单（只动 size/sha 字段）",
    )
    args = parser.parse_args(argv)

    if not args.dry_run:
        if args.checkpoint is None:
            parser.error("全量导出需要 --checkpoint（或改用 --dry-run 只校验）")
        export_towers(args.out, args.checkpoint)
        check_onnx_shapes(args.out)
        write_tokenizer_json(args.vocab or default_vocab_file(), args.out / TOKENIZER_FILE)
        print(f"已生成 {args.out / TOKENIZER_FILE}")

    summary = describe(args.out, args.tokenizer)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print_summary(summary, args.update_manifest)
    if args.update_manifest is not None:
        update_manifest(args.update_manifest, summary)
    print(
        "\n下一步：把这些文件放到 "
        f"${{{SOURCE_ROOT_VAR}}}/{MODEL_ID}/ 下，"
        "再在客户端接受许可并安装。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
