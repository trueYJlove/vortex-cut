# 中文 CLIP 可行性探测（中文优先决策的前置）

> **性质**：**只读探测**，未改任何生产代码，未立项。
> **背景**：用户 2026-10-19 裁决「**中文优先**」（不是英文优先）⇒
> 现役 `clip-vit-base-patch32`（`supported_languages: ["en"]`）对主市场不可用 ⇒ W3.1 需换中文模型。
> **本文件回答一个问题**：中文 CLIP **能不能**接进现行架构？

---

## 0. 结论（先看这个）

| 问题 | 结论 |
|---|---|
| 中文分词是否走语义路径？ | ✅ **是**（决定性证据见 §2） |
| 双塔 ONNX 可得吗？ | ✅ **可得**（官方脚本有 `--convert-text` / `--convert-vision` 独立开关，§3） |
| 能直接替换吗？ | ❌ **不能**——现成镜像只有**合并模型**，且分词器**族不同**（§4） |
| 许可证清楚吗？ | ❌ **不清楚**——上游仓库**无 LICENSE 文件**，README 全文无许可声明（§5） |

**总判定**：**技术可行，许可不明 ⇒ 现在不能立项**。
**阻塞优先级**：**许可证 > 双塔导出 > 分词器重写**。前两者解决后才值得投入工程量。

---

## 1. 探测方法

全部为只读网络探测 + 本地分词器实测。**零生产代码改动、零 API key 使用**。

- ModelScope API：`/api/v1/models/{owner}/{repo}/repo/files?Recursive=true`
- 下载并实测 `tokenizer.json`（439 KB），**已核 sha256**
- 官方导出脚本源码审阅

---

## 2. 决定性证据：中文分词走语义路径

**中文 CLIP 的 tokenizer `sha256 = 7dfbf1966ebf99d471c3796e9b457329d2b2182b817e144f1e904b957745c839`**
（439,124 B，与 ModelScope 清单逐字节一致）

| 项 | 英文 CLIP ViT-B/32（现生产） | 中文 CLIP ViT-B/16 |
|---|---|---|
| Tokenizer 类型 | BPE + **ByteLevel** | **WordPiece** |
| 词表大小 | 49,408 | 21,128 |
| **CJK 词表条目** | **0** | **7,321 单字**（含 CJK 条目共 14,642） |
| normalizer | NFC → 小写 | `BertNormalizer` + **`handle_chinese_chars: true`** |
| 特殊 token | `<|startoftext|>` | `[CLS]` / `[SEP]` |
| 英文词表条目 | 完整 | 2,058（中英混排可用） |

**实测**（中文单字是否作为真实词表 id 存在）：

```
猫 -> True (id=4344)      人 -> True (id=782)       海 -> True (id=3862)
落日 -> False          说话 -> False          一 -> True (id=671)
个 -> True (id=702)       画 -> True (id=4514)      面 -> True (id=7481)
```

**含义**：中文单字是**有语义的真实 token**，而非 P143 记录的那种 UTF-8 字节回退。
词组（`落日`/`说话`）不在词表，由 WordPiece 切成单字——**这是正常且可接受的行为**。

**与 P143 的关系**：P143 证的是**现役英文 CLIP** 对中文的失效（字节回退、静默、11–12× token 膨胀）。
本文件证的是**换模型可以消除该失效**。

---

## 3. 双塔可得（解决现成镜像的不足）

现成镜像 `Xenova/chinese-clip-vit-base-patch16` 的 ONNX **只有合并模型**：

```
onnx/model.onnx            753,665,706   ← 只有这个，无 vision_/text_ 分离
onnx/model_fp16.onnx       377,377,730
onnx/model_quantized.onnx  190,842,404
```

而生产代码硬性要求双塔（`semantic_service.py`:35-36）：
```python
VISION_FILE = "vision_model.onnx"
TEXT_FILE   = "text_model.onnx"
```

**但官方导出脚本支持分离导出**（`cn_clip/deploy/pytorch_to_onnx.py`，7,585 B，已审源码）：

```
--convert-text      Whether to convert the text encoder into ONNX
--convert-vision    Whether to convert the vision encoder into ONNX
--context-length    default 52 (include [CLS] & [SEP])
```

⇒ **双塔可自行导出**，不是死路。代价：需 PyTorch + onnx 工具链，产出需入可信清单（逐文件 sha256）。

---

## 4. 为什么不能直接替换（两处真实改动）

1. **分词器族不同**：现 `clip_tokenizer.py` 是**手写 BPE**（`end_of_word_suffix="</w>"`、GPT-2 字节映射）。
   中文 CLIP 是 **WordPiece**（`[CLS]/[SEP]`、`##` 续接、21,128 词表）。
   ⇒ 要么**新写 WordPiece 分词器**，要么引入 `tokenizers` 库（**与现「零第三方依赖」决策冲突，需裁决**）。
2. **输入形状不同**：现模型 224×224 / context 77；中文版 ViT-B/**16**（patch 16）且官方 context-length **默认 52**。
   ⇒ 预处理常量和 `DEFAULT_CONTEXT_LEN` 都要跟着改，且**会影响已通过的性能门**（D2：检索 ≈70ms、索引 10.04 s/源分钟）。

---

## 5. ⚠️ 许可证：本次探测最重要的负面结论

| 检查项 | 结果 |
|---|---|
| ModelScope `Xenova/chinese-clip-vit-base-patch16` 的 `License` 字段 | **空** |
| ModelScope `AI-ModelScope/chinese-clip-vit-base-patch16` | 存在（9 文件），但**无 LICENSE 文件** |
| 上游 `OFA-Sys/Chinese-CLIP` GitHub **LICENSE** | **HTTP 404（直连与代理均为 404）** |
| 上游 README（**35,601 B 全文**） | **零 license / 商用 声明** |
| hf-mirror 模型卡 | 未取到有效 license 字段 |

**这不等于「没有许可」**，也不等于「不可商用」。它只说明一件事：

> **本仓无法从可信来源确证该模型的使用许可。**

对一个要**随产品分发权重**的项目，这是硬阻塞——比双塔导出严重得多。
（对比：现役 CLIP 的 manifest 明确写了 `"license": {"id": "mit", ...}`。）

**本文件不替用户裁决许可问题**；需由用户/法务从官方渠道确证，或换一个有明确许可的中文图文模型。

---

## 6. 未做的事（如实登记）

- **未下载任何权重**（合模型 753 MB / 双塔需自行导出），只下了 439 KB tokenizer + config。
- **未跑中文端到端检索**——没有中文评测语料（与 P142/P143 同因）。
- **未验证分词器实现**——只验证了词表结构，未写 WordPiece 实现，故**没有中文 token 读数**（P143 那种 token/字符比值对中文版尚未测）。
- **未评估替代模型**（如明确 Apache-2.0 的中文图文模型）。
- **未改任何生产代码**。

---

## 7. 复现命令

```bash
# 列仓库文件
curl -s "https://www.modelscope.cn/api/v1/models/Xenova/chinese-clip-vit-base-patch16/repo/files?Recursive=true"

# 取 tokenizer 并核 sha256（应为 7dfbf1966e...）
curl -sL "https://www.modelscope.cn/models/Xenova/chinese-clip-vit-base-patch16/resolve/master/tokenizer.json" -o tokenizer.json
sha256sum tokenizer.json

# 词表结构
.venv/Scripts/python.exe -c "
import json; d=json.load(open('tokenizer.json',encoding='utf-8'))
print(d['model']['type'], len(d['model']['vocab']))
print('CJK single-char:', sum(1 for k in d['model']['vocab'] if len(k)==1 and '\u4e00'<=k<='\u9fff'))
"
```
