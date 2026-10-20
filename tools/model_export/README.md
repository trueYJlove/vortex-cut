# tools/model_export —— 本仓自行导出的模型产物

中文 CLIP ViT-B/16 的双塔 ONNX **由本仓自己导出**：上游只提供融合 `.pt`，
而运行时需要 vision + text 两个独立 ONNX 加一个分词器。三个文件共约 754MB，
体积远超仓库该承载的量（`.tmp/` 在 `.gitignore:45` 里，就是为此），所以
**产物不入库**，每台机器就地生成，清单通过 `file://` 指过来。

## 一条命令的职责划分

| 脚本 | 职责 |
|---|---|
| `export_chinese_clip_onnx.py` | 导出双塔 ONNX + 生成 tokenizer.json，并**实算**清单所需的 size/sha256/聚合值 |
| `verify_manifest_files.py` | 拿一份清单校验一份产物目录，逐文件 size/sha256 + 聚合 sha256，失败非零退出 |

## 依赖（刻意不进 pyproject.toml）

导出需要 `torch` / `onnx` / `cn-clip`。它们**不进运行时依赖**，因为只有
生成产物时用得到，而体积与平台绑定极重（torch CPU wheel 起价约 200MB，
cn-clip 还钉死特定 transformers 版本）。Core 运行时只依赖 `onnxruntime`
（见清单的 `runtime_version`）。需要导出时手工装到同一个 venv：

```bash
.venv/Scripts/python.exe -m pip install torch onnx cn-clip
```

`--dry-run` 与 `verify_manifest_files.py` **不需要**这些依赖。

## 1. 导出（或只校验已有产物）

```bash
# 只校验已有产物并打印哈希（推荐先跑这个确认现状）
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe tools/model_export/export_chinese_clip_onnx.py \\
    --dry-run --out .tmp/cc-export/out \\
    --tokenizer .tmp/cc-probe/tokenizer.json

# 全量导出
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe tools/model_export/export_chinese_clip_onnx.py \\
    --out .tmp/cc-export/out \\
    --checkpoint /path/to/clip_cn_vit-b-16.pt \\
    --update-manifest resources/model-manifests/chinese-clip-vit-base-patch16.json
```

`--update-manifest` 只改清单里的 `size_bytes` / `installed_size_bytes` /
`sha256` / `files[].size_bytes` / `files[].sha256`，其它字段（尤其 `license`）
原样保留。**清单里的哈希一律由脚本实算写出，不要手抄。**

> Windows 控制台默认 GBK，中文会成乱码：加 `PYTHONIOENCODING=utf-8`。

## 2. 校验

```bash
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe tools/model_export/verify_manifest_files.py \\
    --manifest resources/model-manifests/chinese-clip-vit-base-patch16.json \\
    --source .tmp/cc-export/out \\
    --file tokenizer.json=.tmp/cc-probe/tokenizer.json   # 文件分散时逐项覆盖
echo "exit=$?"   # 0 通过 / 1 不一致或缺失 / 2 清单无法解析
```

聚合 sha256 的算法与顺序**必须**等于
`aivs_core.model_registry._manifest_files_sha256`：一个 sha256 对象按清单
`files[]` 顺序串接每个文件的全部字节。顺序错了，逐文件全对聚合也一定不等。

## 3. 让 Core 找到产物

清单里三个 `url` 形如：

```text
file://${AIVS_MODEL_SOURCE_ROOT}/chinese-clip-vit-base-patch16/vision_model.onnx
```

把环境变量指到**产物目录的上一级**即可（即目录里要有
`chinese-clip-vit-base-patch16/` 这一层）：

```bash
export AIVS_MODEL_SOURCE_ROOT=C:/DataFolder/codes/AI-Vidio/.tmp/cc-export
```

`ModelManager._file_url` 会先做 `expandvars` + `expanduser`，再校验源文件
确实存在；变量没设或文件缺失时报 `MODEL_DOWNLOAD_FAILED`，message 里直接
写明缺哪个变量、缺哪个文件、要跑哪个脚本。

## 已知边界

- `--checkpoint` 需要上游融合 `.pt`（约 1.5GB）；本仓不入库，也不代下载。
- 导出是 CPU 上的一次性长任务，磁盘需预留约 1.6GB（产物 754MB + 中间态）。
- 全量重导出**会改变** `vision_model.onnx` / `text_model.onnx` 的字节（取决于
  torch/onnx 版本），因此重导后必须重跑 `--update-manifest`，否则清单立刻失真。
- `tokenizer.json` 生成是逐字节确定的（只依赖 cn_clip 自带 `vocab.txt`）。
