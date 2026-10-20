# tools/model_eval

## `eval_zh_clip.py` —— 中文 CLIP 双塔 / 单塔同条件效果评测

回答的问题：**fp32 双塔（754MB）相对 quantized 单塔（190MB），检索效果差多少。**
（「中文 CLIP 有没有用」已由 P151/P152 回答：有。这里问的是量化代价。）

### 两种模型形态

| 形态 | 参数 | ONNX IO |
|---|---|---|
| 融合单塔（quantized） | `--merged model_quantized.onnx` | `pixel_values`+`input_ids`+`attention_mask` → `image_embeds`/`text_embeds` |
| 双塔（fp32） | `--vision vision_model.onnx --text text_model.onnx` | 各自单入单出；text 的 sequence 维**固定 52** |

单塔跑图像时必须喂一组合法 text 输入。已实测该模型的 `image_embeds` 对 text 输入
不敏感（最大差异 0.0），所以喂 `[CLS][SEP]` 是安全的。

### 用法

```bash
# 单塔 + 中文词
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe tools/model_eval/eval_zh_clip.py \
  --images .tmp/zh-eval/img \
  --catalog evidence/2026-10-19-w31-zh-query-eval/catalog.json \
  --tokenizer .tmp/cc-probe/tokenizer.json \
  --merged .tmp/cc-model/model_quantized.onnx --queries zh

# 双塔 + 中文词
#   …… --vision .tmp/cc-export/out/vision_model.onnx \
#       --text   .tmp/cc-export/out/text_model.onnx --queries zh

# A/B/C/D 四组一次跑完，并与第一次跑做确定性核查
#   …… --merged <m> --vision <v> --text <t> --suite --repeat 2 --out result.json

# 负向对照：固定种子打乱真值（指标应跌到随机水平）
#   …… --suite --shuffle-truth 20261020
```

### 输出

- 控制台：每组 top1 / top3 的**比率 + 命中数 (x/N)**、每条 MISS 的落点与分数、末端的 markdown 表；
- `--out`：JSON（`meta` + `groups`，每组含 `per_query` 逐条明细与 `diagnostics`）。

```jsonc
{
  "meta":  { "n_images": 57, "context_len": 52, "image_size": 224, "image_topics": {...} },
  "groups": {
    "A_quantized_zh": {
      "top1": 1.0, "top3": 1.0, "hits_top1": 10, "hits_top3": 10, "n_queries": 10,
      "diagnostics": { "mean_margin": 0.0674, "mean_rank_same_topic": 3.387, ... },
      "determinism": { "pass": true, "rankings_identical": true, ... },
      "second_run":  { "identical_to_first": true },
      "per_query":   [ { "query": "猫", "hit1": true, "margin": 0.0696, "top3": [...] } ]
    }
  }
}
```

### 指标

- **判据**：`top1` / `top3` —— 排名第 1（或前 3）图的真值 topic 是否等于该查询的 topic。**离散**。
- **诊断**（非判据）：`margin`（最佳同 topic − 最佳异 topic 分数）、
  `mean_rank_same_topic`（同 topic 图名次均值，随机期望 ≈ 29/57）。
  存在的唯一理由：top1 在 10 条查询上极易打满、零方差，**天花板下用它们观察排序质量**。
  它们**不参与判定**，样本小，**不得单独当作「更好/更差」的结论**。

### 与生产一致（`services/core/src/aivs_core/media/semantic_service.py`）

**直接 import，不重写**：`CLIP_IMAGE_SIZE`(:69)、`preprocess_image`(:118-123)、
`CLIP_MEAN/CLIP_STD`(:71-72)、`ZH_CONTEXT_LEN`(:46)、`wordpiece_tokenizer`(:185 分派)、
`semantic.l2_normalize`(:31)。像素经仓库自带 ffmpeg（`resources/ffmpeg/win-x64/ffmpeg.exe`）
按 `rgb_frames_args`(:99-115) 的同一条 `scale=224:224` rawvideo rgb24 取得。

**不做 letterbox**：生产也不做，评测要跟生产一致而不是更漂亮。

### 依赖

零新增：`numpy` + `onnxruntime`（`pyproject.toml:11-12`）+ 仓库自带 ffmpeg。**不用 PIL。**

### 已知边界

单个品类名词查询、57 张 Commons 照片、10 个品类。**不能**外推到真实视频抽帧或口语化查询。
