"""两段真实视频 × 口语化中文句子。

目的：不只测"认不认得"，而是测**两段视频能否被区分**。
这是素材池检索的最小单元（2 选 1）——但 1/2 的随机基线很高，读数须谨慎读。
"""
import sys, subprocess
from pathlib import Path
import numpy as np

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / "tools" / "model_eval"))
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

from eval_zh_clip import TwoTowerEncoder, MergedEncoder, DEFAULT_FFMPEG, CLIP_IMAGE_SIZE, preprocess_image
from aivs_core.media.semantic_service import rgb_frames_args, aggregate_embeddings

TOK = ROOT / ".tmp" / "cc-probe" / "tokenizer.json"
VIS = ROOT / ".tmp" / "cc-export" / "out" / "vision_model.onnx"
TXT = ROOT / ".tmp" / "cc-export" / "out" / "text_model.onnx"
MER = ROOT / ".tmp" / "cc-model" / "model_quantized.onnx"

VIDEOS = {
    "荡秋千": Path(r"C:\Users\trueY\Videos\fdf0f0e269126269ed686f208b3063e3.mp4"),
    "花丛": Path(r"C:\Users\trueY\Videos\a33ec6e6fe7e88b650a25d9facb714d7.mp4"),
}

def frames_of(path, interval):
    p = subprocess.run([str(DEFAULT_FFMPEG), *rgb_frames_args(str(path), interval)], capture_output=True)
    size = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE * 3
    n = len(p.stdout) // size
    return [np.frombuffer(p.stdout[i*size:(i+1)*size], dtype=np.uint8).reshape(CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE, 3) for i in range(n)]

# 两句"用户真实说法" + 若干干扰
QUERIES = [
    ("有一个小朋友在荡秋千", "荡秋千"),
    ("在花丛中拍照", "花丛"),
    ("一只猫在睡觉", None),
    ("一辆汽车在路上行驶", None),
]

print("抽帧…")
stacks, counts = {}, {}
for name, path in VIDEOS.items():
    interval = 6.0 if name == "荡秋千" else 0.8
    fr = frames_of(path, interval)
    counts[name] = len(fr)
    stacks[name] = np.stack([preprocess_image(f)[0] for f in fr]).astype(np.float32)
    print(f"  {name}: {len(fr)} 帧")

def run(label, enc):
    print(f"\n===== {label} =====")
    agg = {}
    for name, st in stacks.items():
        emb = enc.encode_images(st)
        agg[name] = aggregate_embeddings(list(emb))
    texts = [q for q, _ in QUERIES]
    tvec = enc.encode_texts(texts)
    print(f"{'查询':<22} {'荡秋千(agg)':>12} {'花丛(agg)':>12}  第一")
    for i, (q, expect) in enumerate(QUERIES):
        s1 = float(agg["荡秋千"] @ tvec[i])
        s2 = float(agg["花丛"] @ tvec[i])
        win = "荡秋千" if s1 > s2 else "花丛"
        mark = "" if expect is None else ("  ✅" if win == expect else "  ❌")
        print(f"{q:<22} {s1:>12.4f} {s2:>12.4f}  {win}{mark}")

run("fp32 双塔（754MB）", TwoTowerEncoder(VIS, TXT, TOK))
run("quantized 单塔（190MB）", MergedEncoder(MER, TOK))