# C21 实施进度与自检报告(2026-09-10)

## 1. 状态与范围

**C21(导出输入深定位,C21a + C21b)代码完成 + 功能验证完成。**
独立验收:**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 7 节 C21,在
C20 第一阶段(`1dd727f`)之上实施。C21 计划分 a(规划器+等价性实验)/
b(接入和扩展)两步:

- **C21a**(提交 `d76280f`):input_window.py 规划器 + 最小放行集(普通
  主轨 1x 正向视频段)+ `-ss` 粗定位/坐标回移 + 正确性对拍。
- **C21b**(本轮):eligibility 扩展——**正向变速、转场借用、PiP 覆盖轨
  段**逐项补真实 FFmpeg 帧对拍 golden 后放行;修复转场分支 stale shift
  隐患;音频对拍引入形状量纲门(时长逐样本一致 + 过零率 + 秒窗局部
  对齐残差)。

提交(本地,未 push):
- (提交 1)C21a:input_window.py 规划器 + ffmpeg.py 深定位接入 +
  service 贯通 + 单测/对拍集成 + 报告
- (提交 2)C21b:eligibility 扩展(变速/转场/PiP)+ stale shift 修复 +
  PiP 链 seek_shift + golden 对拍扩展 + 报告更新

## 2. 修改单(模板)

```text
修改单:C21 导出输入深定位(C21a 规划器 + C21b eligibility 扩展)
基线HEAD / 工作树标识:1dd727f(C20)起;两个本地提交(C21a=d76280f,
  C21b=本轮)
目标与不修改范围:
  目标(C21a)——每个实际 FFmpeg 输入生成 InputWindow(整数微秒域:
  input_index/eligible/reason/seek_us/shift_us);初时仅放行**普通
  主轨视频段**(V1、1x 正向、无转场借用/倒放/关键帧/transform/reframe/
  mask/keying、probe 可解释、源起点 ≥1s);组合语义实证定案:
  input `-ss`(-i 前,准确 seek)+ 精裁 trim/atrim 坐标回移 seek 量
  与旧图输出帧序列逐位一致(开发实验 + 集成对拍双证);不合格段
  legacy(参数图与旧实现完全一致);`input_windows=None` = 完整旧图
  (oracle/回退)。
  目标(C21b)——按计划"正向变速、转场和 PiP 分别扩展 eligibility,
  并分别补 golden"逐项放行:
  - 正向变速:speed_milli≠1000(非倒放);trim 坐标回移在源坐标域
    (setpts 变速之前),head/tail 借用×速度换算原语义不变;
  - 转场借用:transition_in 激活段(锚点)与右段;xfade 双路取窗的
    trim 坐标各自回移——右段用右段自己的窗口(修复 stale shift);
  - PiP 覆盖轨:track_id≠V1 的视频段;_pip_overlay_chain 源精裁坐标
    同语义回移;PiP 段的 transform 是浮层元素语义的一部分(链内建),
    不按主轨 transform 挡 legacy;
  - 主轨 transform/关键帧动画/倒放/reframe/mask/keying 仍 legacy。
  不修改——输出全局时间线/黑场/字幕 ASS/fps/音频 padding 语义;
  编码器候选重试链;validate_rendered_media;倒放/关键帧动画的深定位
  (C23 分块倒放范畴);不对失败输出无条件重跑。
实际修改文件(绝对路径):
  services/core/src/aivs_core/rendering/input_window.py(新增:
    InputWindow/plan_input_windows/append_input_seek_args/MIN_SEEK_US;
    C21b 放行集扩展)
  services/core/src/aivs_core/rendering/ffmpeg.py(build_timeline_args
    +input_windows 参数:输入段 -ss 插入;visual_chain seek_shift_us
    精裁回移;音频 atrim 同窗口回移;C21b——转场分支右段独立取窗口
    (stale shift 修复)、_pip_overlay_chain +seek_shift_us)
  services/core/src/aivs_core/rendering/service.py(run 内组装
    plan_input_windows 并传入 build_timeline_args)
  services/core/tests/unit/test_render_input_window.py(新增,16 项;
    C21b 更新预期)
  services/core/tests/integration/test_render_seek_parity.py(新增,8 项;
    C21b +4 项 golden:变速/变速+借用/双侧深转场/PiP)
前置Gate与接口版本:render-plan-v1/权威渲染链(Stage1a-1c);
  A07 probe 会话缓存(probe 可解释性判定复用归一化 probe 结构)。
算法/状态机变化:
  - eligibility(C21b 放行集):asset_kind=video + 非 hidden + 非
    reverse + 无 keyframes + 主轨段无 transform + 无 reframe/mask/
    keying + probe 有视频流且 duration_us>0 + source_start_us ≥
    MIN_SEEK_US(1s)。变速/转场/覆盖轨不再拦截。
  - 窗口语义:seek_us = shift_us = segment.source_start_us;深定位图
    在该输入的 -i 前插 `-ss <seek>s`;该段 visual_chain 的
    trim=start/end 与音频 atrim 的 start/end 回移 seek 量(绝对源
    坐标 → -ss 后流上相对坐标;下钳 0)。
  - 变速语义:trim 回移在源坐标域(setpts=PTS/speed 在 trim 之后),
    head/tail 借用×speed_milli 换算的原有窗口算术不变——实测帧序列
    逐位一致(TestSpeedParity)。
  - 转场语义:锚点段(左)走普通 visual_chain 回移;右段两路取窗
    (vh 头部借用区 / vr 主体)各自以右段 shift 回移。C21a 中右段
    复用左锚点段 shift 的 stale 值在放行扩展后必然算错坐标——本轮
    修复并以"两侧不同源起点"golden 锁定(TestTransitionParity)。
  - PiP 语义:_pip_overlay_chain 源 trim 回移;overlay 时间窗
    (enable between)基于时间线 t,不随 -ss 改变(输出时间轴语义)。
  - 多段共享输入:各段独立 -i 独立判定(FFmpeg 逐段开输入,无共享
    解码器状态——窗口互不影响)。
  - 输出时间轴零变化:trim 上下界同时回移,段时长/输出窗口/concat
    结构不变;转场 xfade offset/借用窗口不受影响(head/tail 窗口
    参数同时回移同一量)。
授权、取消、资源所有权、缓存失效规则:不涉及新授权面(输入路径
  沿用既有 resolve_asset_path;无新 IPC;取消/进程树回收沿用
  run_timeline_render 既有语义)。
新增/修改测试与命令:
  pytest services/core/tests/unit/test_render_input_window.py(16)
  pytest services/core/tests/integration/test_render_seek_parity.py(8)
功能回归结果(含跳过):Core unit 全量 629 通过(C22 时 628;净+1:
  eligibility 预期更新抵消部分新增);渲染相关集成 real 全过
  (stage1c_render_real/transform/pip/mask/chroma/seek_parity);
  既有渲染路径在新默认(规划器常开、放行集扩展)下零回归。
before / after / 同机环境:
  正确性门(C21a):确定性输入(testsrc2 长 GOP=60 60s 源,尾部
  [50s,60s) 段)上深定位图 vs legacy 图——视频帧序列逐位一致;
  音频逐样本幅值差 mean≈0.012% 满幅(AAC 起点量化噪声,容差 3% 通过)。
  正确性门(C21b,真实 FFmpeg 帧对拍):
  - 变速 2x 段([40s,60s)→10s 时间线):帧序列逐位一致;音频存在
    恒定 0.083ms(输出侧 4 样本@48k)相位差——AAC 非比特精确解码
    起点噪声经 atempo/aresample 传递,对齐后 rms≈0.08% 满幅,远低于
    一帧(33ms),非错帧/错位(平移扫描+确定性实验定案);
  - 变速+头部借用组合:帧序列逐位一致;音频秒窗局部对齐残差达标
    (左 2x 段 -4 样本/右 1x legacy 段 0 样本的段级相位差不影响
    段内波形一致——全局单一平移无解,故验收按秒窗局部对齐);
  - 转场双侧深定位(左 50s/右 45s 不同源起点):帧序列逐位一致
    (stale shift 回归在此锁定——修复前右段坐标会被错移 5s);
  - PiP 深定位(主轨浅 legacy + 覆盖段 40s 深):合成输出帧序列
    逐位一致。
  性能门:计划"F03 末尾片段源解码量减少 ≥80%"的端到端 wall time
  口径首轮实测已完成(2026-09-10,同机交替 5 轮):60s 源编码阶段
  29.2%、300s 源 31.1% 降幅,帧对拍逐位一致——详见
  PERFORMANCE_F03_DEEP_SEEK_MEASUREMENT_2026-09-10.md;帧计数口径
  与 60 分钟源列完整 F 夹具轮。
质量与失败路径验证:
  - 混合时间线(放行段 + 变速放行段)整体输出帧/音频对拍一致;
  - `input_windows=None` 与旧实现参数图逐字符一致(oracle);
  - 浅起点(<1s)/probe 缺失/时长不可解释/倒放/关键帧/主轨 transform/
    reframe/mask/keying → legacy;
  - image 输入不插 -ss(-loop 分支跳过;规划器双保险判 legacy)。
开关、兼容与回退:
  - 新默认 = 规划器常开(放行集 = C21b 扩展集);回退 =
    build_timeline_args 不传 input_windows(完整旧图,单参数回退)
    或 revert 提交。
  - 音频对拍形状门(时长/过零率/秒窗残差)只用于测试验收,不进入
    生产代码。
已知限制、未解决问题:
  - 非零起始 PTS/负 start_time 输入:normalize_probe 未保留 stream
    start_time 字段 → _stream_seekable 保守判 legacy(ffprobe 归一化
    补 start_time 后可扩展,列后续)。
  - VFR/B 帧/旋转元数据输入未进放行集(依赖 probe 归一化扩展);
    既有真实渲染集成(sar/transform/pip/mask/chroma)覆盖的段型在
    新放行集下走深定位路径,集成全过(行为面已对拍锁定)。
  - 主轨 transform/关键帧动画/倒放深定位:保守 legacy;倒放列 C23。
  - 输入 -t 读取终止优化未做(不加比加错安全);planner 失败单次
    legacy 回退接线未做(规划器纯函数不会"运行失败")。
  - 性能门:wall time 口径首轮实测完成(60s 源 29.2%/300s 源 31.1%
    编码降幅,parity 逐位一致——见 F03 实测报告);帧计数口径与
    60 分钟源列完整 F 夹具轮。
开发者自测:通过(见上)。
独立Reviewer结论:待验收
Gate决策与下一步:C21a+C21b 完成(计划 C21 范围内遗留项均为保守
  legacy/实测轮项)。下一步:C23(分块倒放)/C24(GPU 滤镜)按计划
  属条件实验;或先 F 场景夹具实测轮补 G3 证据。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| 规划器单测 | test_render_input_window.py | 16 | eligibility 全因子（普通段/正向变速/转场/PiP 放行；倒放/关键帧/主轨 transform/图片音频/隐藏轨/浅起点阈值边界/probe 缺失/时长不可解释/混合并存）+ -ss 参数图形状（eligible 插入/legacy 零改动/image 双保险） |
| 对拍集成 | test_render_seek_parity.py | 8 | C21a：尾部段帧逐位+音频容差；混合整体一致；None=旧图逐字符；坐标回移正确。C21b：变速 2x 帧逐位+音频形状门；变速+头部借用；转场双侧深定位（stale shift 锁定）；PiP 深定位合成一致 |
| 既有回归 | 渲染集成 real ×5 文件 | 8 | stage1c/transform/pip/mask/chroma——放行集扩展后零回归 |
| 全量 | Core unit | 629 | C22 时 628;净 +1(eligibility 预期更新 + 新增) |

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
  `-t`（读取终止优化列后续；不加比加错安全）。
- C21b 计划"正向变速、转场和 PiP 分别扩展 eligibility,并分别补
  golden"——已逐项交付（帧对拍 golden 各一,组合场景覆盖变速+借用、
  转场双侧深、PiP+主轨混合）；主轨 transform 未放行（计划未列出该
  项,保守与既有约束一致）。
- C21b 音频对拍引入"形状量纲"门（时长逐样本/过零率/秒窗局部对齐
  残差）取代纯幅值容差——计划"音频有效区间和 A/V 偏差保持既有标准,
  新增帧/样本级边界验证"的落地口径：时长逐样本一致即有效区间不变,
  秒窗 1ms 内对齐排除错帧（33ms）;固定 0.083ms 相位差为 AAC 起点量化
  噪声（实验记录:确定性、平移扫描、对齐后 rms 0.08% 满幅）。

## 5. 复现命令

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_render_input_window.py services/core/tests/integration/test_render_seek_parity.py -q
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit -m 'not real_provider' -q
.\.venv\Scripts\python.exe -m pytest services/core/tests/integration/test_stage1c_render_real.py services/core/tests/integration/test_transform_render_real.py services/core/tests/integration/test_pip_render_real.py services/core/tests/integration/test_mask_render_real.py services/core/tests/integration/test_chroma_render_real.py -q
```
