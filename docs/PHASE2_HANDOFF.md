# Phase 2 交接（合成预览默认化 → 手势迁移 → 完全体）

## 当前状态（2026-09-06，HEAD 含 e3c76a2）

### 已完成
- **播放架构重写**：每输入顺序解码链 + 环形纹理池(8) + 就绪即合成 + 时钟重锚。
  真实项目实测：丢帧 0（基线 550）、合成间隔 p95 22ms（基线 2.6s）。
- **音频**：片段音轨跟随时钟（HTMLAudioElement + playbackRate + gain），
  eager 预热、校正阈值 0.25s。已知近似：gain>0dB 被钳制、A1 纯音频轨未进 IR。
- **手势层第一片**：`SyntheticPipLayer`——合成画布上画中画选中/拖拽移动，
  复用 draft/commit（set_clip_transform）链路，gestureHold 冻结时钟。
- **默认预览仍为交互**（默认翻转为合成引发测试级联，见"下一步 0"）。

### 关键设计决定（不要回退）
- **`replaceIr` 就地换表**：revision 变更时若 IR inputs 签名一致（transform/
  关键帧/时间编辑），会话原地换帧表保留 worker/GL——拖拽提交零黑屏。
  不要再用"cleanup dispose + 重建"模式（React cleanup 先于新 body 执行，
  任何吸收/时序方案都会被它打穿——这是实测教训，见 8642f7f/e3c76a2）。
- **比例真源 = 项目画布**（App.tsx autoRatio/syntheticRatio）；下拉框仅预览覆盖。
- **backgroundThrottling=false**（electron/main/index.ts）：截图遮罩不得冻结预览。
- **后备缓冲 ≤2048**：全屏超采样是卡顿主因。
- **`setPipCenter`**：画中画几何就地补丁（静态 transform 作用于片段全区间帧）。

### 已知限制（驱动级，勿反复尝试修复）
- 本机 Intel D3D11 WebCodecs：暂停态 seek 进深 GOP（该素材 keyframe@300 后）
  可能花屏；ffmpeg/新 Worker 均干净；播放路径已通过连续采样规避。
  reset()/重建解码器实例均无法清除（Worker 全局残留），彻底解需 Worker 级重建。

## 下一步（优先级序）

0. **测试基建**：desktopApi mock 增加可用的 getPreviewIr（夹具 IR），然后
   `previewMode` 默认翻转为 "synthetic"（当前回退为 interactive，8565761 前车之鉴：
   直接翻转引发 8 个测试级联）。
1. **手势迁移（继续）**：PiP 旋转/缩放手柄 → 主轨选中框 → 蒙版/抠像手势。
   框架已就位：session.pipBoxes()/pipView()/setPipCenter + SyntheticPipLayer。
2. **模式切换移除**：权威预览收敛为导出前核验。
3. **丝滑完全体**：合成搬 OffscreenCanvas worker（主线程解放）+
   WebAudio AudioBufferSourceNode 精确调度（根治 1.25x 段音频抖动——
   当前抖动 = 深 GOP 解码尖峰 → 时钟抖 → currentTime 硬校正）。
4. **产品待办**：新建项目暴露画布比例（当前隐式默认）、A1 纯音频轨进 IR
   白名单、主轨 blurred_background 垫底（对齐剪映）。

## 验证工具

```bash
python tools/m3_0/run_electron_probe.py m3p5 \
  --ir evidence/m3_2/playback-repro/ir_user_project.json \
  --assets evidence/m3_2/playback-repro/assets.manifest.json \
  --evidence evidence/m3_2/playback-repro/<name>
# m3p4 = seek 基准（门限 p95 ≤ 100ms）；m3p5 = 播放态（门限 丢帧≈0）
```

完整历史与根因：docs/STAGE_M3_2_PLAYBACK_REFACTOR_2026-09-06.md
