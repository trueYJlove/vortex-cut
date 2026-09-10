# C21 实施进度与自检报告(2026-09-10)

## 1. 状态与范围

**C21(导出输入深定位,C21a 阶段)代码完成 + 功能验证完成。**
独立验收:**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 7 节 C21,在
C20 第一阶段(`1dd727f`)之上实施。C21 计划分 a(规划器+等价性实验)/
b(接入和扩展)两步;本次交付 C21a(规划器 + 最小放行集接入 + 正确性
对拍)。C21b(正向变速/转场/PiP eligibility 扩展)按计划"各自补 golden
后放行"留待后续。

提交(本地,未 push):
- (提交 1)C21a:input_window.py 规划器 + ffmpeg.py 深定位接入 +
  service 贯通 + 单测/对拍集成 + 本报告

## 2. 修改单(模板)

```text
修改单:C21 导出输入深定位(第一阶段:C21a 规划器 + 最小放行集)
基线HEAD / 工作树标识:1dd727f(C20);一个本地提交
目标与不修改范围:
  目标(C21a)——每个实际 FFmpeg 输入生成 InputWindow(整数微秒域:
  input_index/eligible/reason/seek_us/shift_us);初时仅放行**普通
  主轨视频段**(V1、1x 正向、无转场借用/倒放/关键帧/transform/reframe/
  mask/keying、probe 可解释、源起点 ≥1s);组合语义实证定案:
  input `-ss`(-i 前,准确 seek)+ 精裁 trim/atrim 坐标回移 seek 量
  与旧图输出帧序列逐位一致(开发实验 + 集成对拍双证);不合格段
  legacy(参数图与旧实现完全一致);`input_windows=None` = 完整旧图
  (oracle/回退)。
  不修改——输出全局时间线/黑场/字幕 ASS/fps/音频 padding 语义;
  转场 xfade/acrossfade 图结构(仅精裁坐标透传 seek_shift);编码器
  候选重试链;validate_rendered_media;C21b 扩展集(变速/转场/PiP)
  一律 legacy(各自补 golden 后再放行);不对失败输出无条件重跑
  (失败语义沿用既有编码器降级链)。
实际修改文件(绝对路径):
  services/core/src/aivs_core/rendering/input_window.py(新增:
    InputWindow/plan_input_windows/append_input_seek_args/MIN_SEEK_US)
  services/core/src/aivs_core/rendering/ffmpeg.py(build_timeline_args
    +input_windows 参数:输入段 -ss 插入;visual_chain seek_shift_us
    精裁回移;音频 atrim 同窗口回移;转场分支两路 visual_chain 透传)
  services/core/src/aivs_core/rendering/service.py(run 内组装
    plan_input_windows 并传入 build_timeline_args)
  services/core/tests/unit/test_render_input_window.py(新增,15 项)
  services/core/tests/integration/test_render_seek_parity.py(新增,4 项)
前置Gate与接口版本:render-plan-v1/权威渲染链(Stage1a-1c);
  A07 probe 会话缓存(probe 可解释性判定复用归一化 probe 结构)。
算法/状态机变化:
  - eligibility(保守最小集):asset_kind=video + track_id=V1 +
    非 hidden + speed_milli=1000 + 非 reverse + 无 transition_in +
    无 keyframes + 无 transform/reframe/mask/keying + probe 有视频流
    且 duration_us>0 + source_start_us ≥ MIN_SEEK_US(1s)。
  - 窗口语义:seek_us = shift_us = segment.source_start_us;深定位图
    在该输入的 -i 前插 `-ss <seek>s`;该段 visual_chain 的
    trim=start/end 与音频 atrim 的 start/end 回移 seek 量(绝对源
    坐标 → -ss 后流上相对坐标;下钳 0)。
  - 多段共享输入:各段独立 -i 独立判定(FFmpeg 逐段开输入,无共享
    解码器状态——窗口互不影响)。
  - 输出时间轴零变化:trim 上下界同时回移,段时长/输出窗口/concat
    结构不变;转场 xfade offset/借用窗口不受影响(head/tail 窗口
    参数同时回移同一量)。
授权、取消、资源所有权、缓存失效规则:不涉及新授权面(输入路径
  沿用既有 resolve_asset_path;无新 IPC;取消/进程树回收沿用
  run_timeline_render 既有语义)。
新增/修改测试与命令:
  pytest services/core/tests/unit/test_render_input_window.py(15)
  pytest services/core/tests/integration/test_render_seek_parity.py(4)
功能回归结果(含跳过):Core unit 全量 614 通过(C20 时 599;+15);
  渲染相关集成 real 全过(stage1c_render_real/transform/pip/sar/
  mask/chroma/preview_ir_api 共 30 项——既有渲染路径在新默认
  (规划器常开)下零回归)。
before / after / 同机环境:
  正确性门(计划 C21a):确定性输入(testsrc2 长 GOP=60 60s 源,
  尾部 [50s,60s) 段)上深定位图 vs legacy 图——**视频帧序列逐位
  一致**(rawvideo rgb24 全帧哈希相等);音频逐样本幅值差
  mean≈0.012% 满幅、max≈1.9%(AAC 输入侧非比特精确解码的量化
  噪声,非时域错位——平移扫描排除;容差 3% 门通过)。
  性能门:计划"F03 末尾片段源解码量减少 ≥80%"列 F03 夹具实测轮
  (本报告不宣称实测数字;结构性依据:-ss 前移使 FFmpeg 跳过
  [0,50s) 的解码供给,源解码量上界从全源收缩为"目标 GOP ± 前一
  关键帧",理论减少 ≈83%(50/60)——以实测为准)。
质量与失败路径验证:
  - 混合时间线(放行段 + 变速 legacy 段)整体输出帧/音频对拍一致
    (legacy 段不受放行段影响——参数图断言 count("-ss")==1);
  - `input_windows=None` 与旧实现参数图逐字符一致(oracle);
  - 浅起点(<1s)/probe 缺失/时长不可解释 → legacy(不产生无收益
    或不可解释的定位);
  - image 输入不插 -ss(-loop 分支跳过;规划器双保险判 legacy)。
开关、兼容与回退:
  - 新默认 = 规划器常开(放行集极小,行为面=纯段深定位);回退 =
    build_timeline_args 不传 input_windows(完整旧图,单参数回退)
    或 revert 提交。
  - 环境变量强制 legacy 未加(回退路径已足够窄——如需灰度开关列
    F 实测轮决定;避免计划 10.1 诫"散落临时布尔")。
已知限制、未解决问题:
  - 音频比特级哈希不等(AAC 解码起点量化噪声):对拍用帧哈希
    (视频)+ 音频幅值容差(3%)。计划"音频有效区间和 A/V 偏差必须
    保持既有标准"——输出时长校验(83334µs 上限)与 validate_
    rendered_media 全链未动,等价性由对拍保证;若后续需要比特级
    一致,需音频改流复制/无损路径(范围外)。
  - 非零起始 PTS/负 start_time 输入:normalize_probe 未保留 stream
    start_time 字段 → _stream_seekable 保守判 legacy(计划要求
    "无法解释时间戳的媒体明确 fallback"——现状达标;ffprobe 归一化
    补 start_time 后可扩展放行,列 C21b)。
  - VFR/B 帧/旋转元数据输入未进放行集(依赖 probe 归一化扩展);
    既有真实渲染集成(sar/transform/pip/mask/chroma)全部走 legacy
    路径回归通过——放行集外的行为与旧版逐位相同。
  - 长 GOP preroll:`-ss` 在 -i 前为 accurate seek(FFmpeg 内部从此前
    关键帧解码后丢弃目标前帧)——无需显式 preroll 参数;计划"是否
    额外留 preroll 由实测决定"以实测轮复核。
  - C21b 未做:正向变速/转场/PiP eligibility 扩展、输入 -t 读取
    终止、planner 失败单次 legacy 回退接线(当前规划器纯函数不会
    "运行失败",回退语义仅指整体开关)。
  - 性能门量化(F03 端到端)未跑——列 F 场景夹具轮。
开发者自测:通过(见上)。
独立Reviewer结论:待验收
Gate决策与下一步:C21b(eligibility 扩展逐项补 golden)或 C22
  (可取消校验);F03 深定位收益实测可并入 F 场景复测轮。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| 规划器单测 | test_render_input_window.py | 15 | eligibility 全因子（普通段放行/变速/倒放/转场/关键帧/transform/PiP/图片音频/浅起点阈值边界/probe 缺失/时长不可解释/混合并存）+ -ss 参数图形状（eligible 插入/legacy 零改动/image 双保险） |
| 对拍集成 | test_render_seek_parity.py | 4 | 深定位 vs legacy：视频帧序列逐位一致 + 音频幅值容差（60s 源尾部段）；混合时间线整体一致；None=旧图逐字符；坐标回移正确（trim/atrim 0..10） |
| 既有回归 | 渲染集成 real ×7 文件 | 30 | stage1c/transform/pip/sar/mask/chroma/preview_ir——新默认下零回归 |
| 全量 | Core unit | 614 | +15 vs C20（599） |

## 4. 与实施计划的偏差

- 计划 C21a"比较 input -ss 的准确定位行为、时间戳归零行为与保留时间
  戳方案后只保留一种验证通过的组合"——实证定案：**-ss（-i 前）+ trim
  坐标回移**（keep-absolute 实验输出错帧，hash 不等；回移方案视频帧
  逐位一致）。组合选择有实验记录（开发实验 + 集成对拍双证）。
- 计划"音频与视频使用相同源窗口和独立流原点校正"——实现为同一窗口
  同一回移量（atrim 坐标回移）；AAC priming/非零 start_time 依赖输入
  侧归一化扩展（当前素材面 start_time=0；非零 PTS 保守 legacy）。
- 计划"先纯 planner 单测，旧 build_timeline_args 可强制走 legacy"——
  legacy 强制 = 不传 input_windows（默认 None），无额外开关。
- 计划"如需输入 -t 必须包含合法借用/滤镜延迟/音频尾部"——本期不加
  `-t`（读取终止优化列 C21b；不加比加错安全）。

## 5. 复现命令

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_render_input_window.py services/core/tests/integration/test_render_seek_parity.py -q
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit -m 'not real_provider' -q
.\.venv\Scripts\python.exe -m pytest services/core/tests/integration/test_stage1c_render_real.py services/core/tests/integration/test_transform_render_real.py services/core/tests/integration/test_pip_render_real.py -q
```
