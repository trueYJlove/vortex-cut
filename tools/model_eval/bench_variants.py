"""修正版：用真实视频抽帧（不是随机噪声），并说明"门限口径"的问题。

关键：D2 的 10.04 s/源分钟 是用什么口径测的？我不知道它是否含抽帧。
因此本脚本分开报：编码耗时（纯模型）与抽帧耗时（FFmpeg），不混算。
换算按「60 秒视频 / 每 2 秒 1 帧 = 30 帧」。
"""
import sys, time, subprocess
from pathlib import Path
import numpy as np

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / "tools" / "model_eval"))
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
from eval_zh_clip import TwoTowerEncoder, MergedEncoder, DEFAULT_FFMPEG, CLIP_IMAGE_SIZE, preprocess_image
from aivs_core.media.semantic_service import rgb_frames_args

TOK = ROOT / ".tmp" / "cc-probe" / "tokenizer.json"
VIS = ROOT / ".tmp" / "cc-export" / "out" / "vision_model.onnx"
TXT = ROOT / ".tmp" / "cc-export" / "out" / "text_model.onnx"
MER = ROOT / ".tmp" / "cc-model" / "model_quantized.onnx"
if len(sys.argv) < 2:
    raise SystemExit("用法: bench_variants.py <任意一段真实视频路径>（建议 30s~3min）")
VIDEO = Path(sys.argv[1])

# 1) 真实抽帧（生产表达式，2s 间隔）
t0 = time.perf_counter()
p = subprocess.run([str(DEFAULT_FFMPEG), *rgb_frames_args(str(VIDEO), 2.0)], capture_output=True)
decode_s = time.perf_counter() - t0
size = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE * 3
n = len(p.stdout) // size
frames = [np.frombuffer(p.stdout[i*size:(i+1)*size], dtype=np.uint8).reshape(CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE, 3) for i in range(n)]
duration = 59.233
print(f"真实视频：{duration:.1f}s，抽到 {n} 帧，FFmpeg 耗时 {decode_s:.2f}s")
print(f"  → 抽帧成本 {decode_s/duration*60:.1f} s/源分钟")

batch = np.stack([preprocess_image(f)[0] for f in frames]).astype(np.float32)
per_min_frames = n / duration * 60  # 每分钟应编码多少帧

def bench(make, label, mb):
    t0 = time.perf_counter(); enc = make(); load = time.perf_counter() - t0
    enc.encode_images(batch[:4])  # warmup
    t0 = time.perf_counter(); enc.encode_images(batch); img = time.perf_counter() - t0
    enc.encode_texts(["warm"])  # warmup
    t0 = time.perf_counter()
    for _ in range(3):
        enc.encode_texts(["有一个小朋友在荡秋千"])
    q = (time.perf_counter() - t0) / 3
    print(f"\n[{label}] {mb:.0f} MB")
    print(f"  加载            {load:>7.3f} s")
    print(f"  编码 {n} 帧({duration:.0f}s) {img:>7.2f} s")
    print(f"  → 编码成本      {img/duration*60:>7.1f} s/源分钟")
    print(f"  → 含抽帧合计    {(img+decode_s)/duration*60:>7.1f} s/源分钟")
    print(f"  查询(1 句编码)  {q*1000:>7.1f} ms")
    return img, q

iq, qq = bench(lambda: MergedEncoder(MER, TOK), "quantized 单塔", MER.stat().st_size/1048576)
iF, qF = bench(lambda: TwoTowerEncoder(VIS, TXT, TOK), "fp32 双塔", (VIS.stat().st_size+TXT.stat().st_size)/1048576)

print("\n" + "="*60)
print("对比")
print("="*60)
print(f"体积      : 182 MB vs 719 MB   (fp32 是 {719/182:.1f}x)")
print(f"索引编码  : {iq:.2f}s vs {iF:.2f}s  (fp32 是 {iF/iq:.2f}x)")
print(f"查询      : {qq*1000:.0f}ms vs {qF*1000:.0f}ms  (fp32 是 {qF/qq:.2f}x)")
print(f"\nD2 检索门 p95<=500ms:")
print(f"  quantized {qq*1000:.0f}ms  {'PASS' if qq*1000<=500 else 'FAIL'}")
print(f"  fp32      {qF*1000:.0f}ms  {'PASS' if qF*1000<=500 else 'FAIL'}")