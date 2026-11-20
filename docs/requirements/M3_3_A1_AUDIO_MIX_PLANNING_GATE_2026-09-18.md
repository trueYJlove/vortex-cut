# A1 音频混音(增量三第一段)——Planning Gate

> 起草:LiuWei,2026-09-18。承接 M3-1 设计 §7-O4("音频增量二/三单独立项")与
> M2 多轨设计的"A1 混音为后续工作"遗留;并合入 W4 复跑登记的相邻能力缺口
> (A1 不收视频素材)。实施:ZhangSan(Core)/YeJing(Desktop)。验收:LiuKeAi。

## 0. 现状走读结论(2026-09-18 代码级)

**权威端(ffmpeg.py)**:
- V1 视频段音频已完整进 concat 链(atrim/aresample/atempo/volume/apad,
  倒放段静音占位;mute/solo 已并入 audio_enabled——plan.py:337);
- **A1 纯音频段被完全跳过**:不进视觉 concat(正确),也**不进任何音频图**
  (:169 注释"音频混音为后续工作"——旧实现 audio 段缺视频流会让整图失败,
  当时显式跳过),用户在 A1 轨铺的音乐**导出成片无声**;
- 覆盖轨(V2+)的音频同样不消费(`_pip_overlay_chain` 无音频链)。

**预览侧(preview-session.ts)**:
- `syncAudio` 按 ir.segments 全量扫描,**A1 纯音频段与 V1 视频段音频都能
  出声**(各自独立 rig 并存 = 天然 sum 混音);gain/mute/solo/变速不变调/
  B15 流式全部在位;音频长于画面时 IR 输出黑场延长(ir.py:436)已支持。

**缺口即不对称**:同一时间线,预览 A1 有声、导出无声——预览≠导出(违反
M3 立项的根本承诺)。这不是"新功能"而是**既有预览能力的权威端补齐**。

## 1. 范围

### 必须实现(Core 权威端)

1. **A1 纯音频段进混音图**:每段构造独立音频链(atrim/aresample/atempo/
   volume——与 V1 视频段音频链同构,复用 atempo 跨级拆分;倒放段静音占位),
   经 `adelay` 平移到 timeline_start_us 后全部 `amix=normalize=0` 汇入
   `[aout]`。
2. **混音语义裁决**:`amix=normalize=0`(直接相加,可能削波)而非
   normalize(平均,多轨同时出声时整体变轻)——与预览侧 WebAudio 多 rig
   并存的 sum 语义一致(双端同构优先);削波预防交由素材级 gain_db,
   文档登记。
3. **`[aout]` 分派改造**:现图为"V1 concat 链尾 = [aout]"。改为:
   concat 尾标签改 `[acat]`;A1 段集非空时 `[acat]` + 各 A1 链
   `amix=inputs=N:normalize=0:duration=longest[aout]`,A1 为空时
   `[acat]anull[aout]`(零 A1 改动 = 旧图逐字节不变,回归面最小)。
4. **A1 收视频素材的音频**(能力缺口合并):`insert_asset_clip` 对 video
   素材增加 `as_audio: true` 变体(目标轨强制 A1、asset_kind 标 audio、
   audio.enabled=true)——放行路径最小化;不做 UI(素材面板已有音频类
   过滤,入口走既有"音频"类别判断放开)。

### 明确不做(边界)

- 覆盖轨(V2+)音频:预览同样未消费(见 §0),双端一致地"无声",不属于
  本次不对称;放开属独立工作单(需先裁决 ducking/ gain 交互);
- 音频转场/淡入淡出(acrossfade 仅服务 V1 视频段既有语义);
- 音量包络/关键帧、 ducks、e Q(产品无此数据模型);
- 预览侧改动:零(A1 混音预览已正确;`asset_fingerprint`/IR 音频窗口
  语义已支持黑场延长)。

## 2. 设计要点

- **adelay 时基**:A1 段 `adelay=ms|ms`(立体声双通道)+ apad 到 amix
  域;`amix duration=longest` 保证音频尾超画面时成片音频完整(ir.py:436
  的"音频长于画面以黑场延长"在导出端由此对齐——输出时长取 max 已是
  `_rendered_duration_us` 既有语义?**待核**:若成片时长只按视觉最大终点,
  A1 音频尾需 `-shortest` 移除/时长重定,实施时以测试钉死)。
- **转场休眠语义保持**:A1 段不参与视觉 graph_items,concat/acrossfade
  路径零触碰。
- **深定位(C21a)**:A1 音频段不走 input_windows(eligibility 只对视觉
  段判定)——保持 trim 全窗口精裁,行为与旧 A1 视频音频链一致。
- **A1→amix 输入数上限**:FFmpeg amix inputs 上限 32767,实测瓶颈是
  滤镜图长度;不设软限(同轨不重叠已由契约保证,同窗 A1 段数天然有限)。

## 3. 验收

1. **单测**(Core,graph 断言路径):
   - 无 A1:图与旧图逐字节一致(回归锁);
   - 单 A1 段:`adelay`+`amix=inputs=2`(acat + 1 A1);
   - 两 A1 段同窗:`amix=inputs=3`,各自 adelay 正确;
   - A1 段倒放:静音占位;mute/solo:`audio_enabled=false` → 不进 amix;
   - 音频尾超视觉终点:输出时长语义(按 §2 核对结果钉死);
   - `as_audio` 插入视频素材:clip 落 A1、asset_kind=audio、audio.enabled。
2. **集成**(真渲染):A1 配乐 + V1 视频导出,ffprobe 验证音轨存在且
   时长正确;无 A1 项目与旧产物 hash 一致(音频域无回归)。
3. **对齐验收**(M3 口径):同一 A1 时间线,预览出声与导出出声同曲同段
   (人工听测 + 电平抽样),记入独立验收。
4. **全量回归**:Core + Desktop 全量。

## 4. 风险

| 风险 | 对策 |
|---|---|
| amix 削波(sum 语义) | 与预览同构优先;素材 gain_db 可控;文档登记 |
| 输出时长口径(音频尾 vs 视觉尾) | 实施首日以测试钉死;若需改 `_rendered_duration_us` 同步对齐 IR(已按音频尾) |
| 旧图逐字节不变承诺被破坏 | A1 空 = 旧图;单测锁 |
| as_audio 放行引入非法 clip | 契约校验复用既有 clip 白名单(仅 source 范围/速度分支),单测覆盖 |
