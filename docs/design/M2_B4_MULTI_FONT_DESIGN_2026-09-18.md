# 字幕多字体支持——设计定案

> 起草:LiuWei,2026-09-18。开放 B4 设计登记的"仅内置字体"限制。
> 实施:ZhangSan(Core)/YeJing(Desktop)。

## 0. 字体链路现状(走读结论)

| 环节 | 现状 | 位置 |
|---|---|---|
| 字体资产 | 单字体目录 `resources/fonts/noto-sans-sc/`(Variable TTF,约 20MB)+ 根 `bundle.json` 注册(family/file/license/sha256) | resources/fonts |
| Core 权威端 | `CaptionResources` 读 bundle → `build_ass` Style 行 Fontname=family;libass 经 `fontsdir` 加载目录内全部字体文件 | ass.py:111、ffmpeg.py:651 |
| IR | `resolved_caption_styles` 数值化预设(不含字体名);override 的 `font_name` 仅在 ASS 行内 `\fn` | ir.py:218 |
| 预览合成器 | 探针 IPC `media:caption-font-url` 只注册 noto 单文件;FontFace 注册名硬编码 `AppCaptionCJK`;Canvas `ctx.font` 用注册名而非 IR 字体名 | index.ts:661、compositor.ts:834/867 |
| 打包 | sidecar 脚本整目录拷贝 `resources/`;打包产物字体随 resources 分发 | build-sidecar.ps1 |

**关键结论**:`ctx.font` 用的是"预注册 FontFace 的 family 名"而不是 IR 的
字体名——多字体下,若字幕的 override 字体未注册 FontFace,Canvas 回退
sans-serif,预览↔导出不一致。多字体的核心工作 = **字体注册表 + 双端按名
取用**。

## 1. 设计

### 1.1 字体包(bundle 数组)

`resources/fonts/bundle.json` 升 v2:`fonts: [ {...单字体元数据...} ]`
(family/file/license/license_file/sha256/role: "default"|"extra")。
旧 v1 单对象保留兼容读取(CaptionResources 归一化 v1 → 单元素数组)。

第一版新增字体(开源 OFL,中文覆盖完整、体积可控):
- **思源黑体 Noto Sans CJK SC**(已有,default);
- **思源宋体 Noto Serif CJK SC**(extra,标题/文艺场景);
- **霞鹜文楷 LXGW WenKai**(extra,手写风格,OFL,约 18MB)。

### 1.2 Core(权威端)

- `CaptionResources.load()` 返回 fonts 数组;`build_ass` 为**每个注册字体**
  生成对应 Style?不——Style 行 Fontname 只需预设族名;override `\fn` 引用
  任意注册字体名,libass 经 fontsdir 自动匹配(fontsdir 已整目录加载,
  零改动)。校验:`font_name` 白名单 = 注册表 family 集合(防注入 + 防
  未注册字体静默回退)。
- 新增端点?不需要——字体**文件**经既有 `aivideo://` 机制下发;新增
  `GET /api/v1/caption-fonts`(元数据列表,无路径字段)供 Desktop 枚举。

### 1.3 Desktop(预览)

- `media:caption-font-url` → `media:caption-font-urls`:返回
  `[{ family, media_url }]`(全注册字体注册为 restricted media);
- SyntheticPreview:并行 fetch 全部字体 buffer → 逐个 `FontFace(family)`
  注册(注册名 = 真实 family,与 Core `\fn` / Canvas 取名一致);
- compositor `ctx.font`:`this.ir.caption_styles[preset].font_name` →
  override.font_name 优先,否则预设族名;FontFace 未就绪时回退 default
  family(与导出端 libass 回退一致)。

### 1.4 校验与契约

- core `_validate_caption_style.font_name`:白名单改为注册表 family 集合
  (运行时注入校验集;非法名保持拒绝——修复"任意字符串可过校验但渲染回退"
  的旧敞口);
- contracts `CaptionStyleOverride.font_name` 注释更新(长度/字符校验不变);
- `caption-fonts` 列表契约:`{ fonts: [{ family, role }] }`。

## 2. 验收

1. 单测:bundle v2 归一化(数组/旧单对象)、font_name 白名单拒绝未注册名;
2. 真渲染:override `\fn<宋体>` 渲染像素与默认黑体显著不同(色块面积/字形
   差异抽样);
3. UI:字体下拉列出全部注册字体;选未安装系统字体不影响(仅用注册字体);
4. 全量回归;打包验证 `_itest` 冒烟含新字体文件。

## 3. 明确不做

- 用户自装系统字体(分发/版权/度量三重问题,登记为长期不支持);
- 字体市场/在线下载;
- 字重选择(Variable TTF 已含全字重,经 bold 标签表达)。
