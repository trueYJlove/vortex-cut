# Phase 2 交接（合成预览默认化 → 手势迁移 → 完全体）

## 当前状态（2026-09-06，HEAD 含 OffscreenCanvas worker 化）

### 已完成（Phase 2 全部主体，含完全体）
1. **合成预览默认化**（0357c98）：打开项目即所见即所得；IR 不支持/环境不可用
   自动回退交互预览 + 内联提示（synthetic-note，可"重试合成预览"）。测试基建：
   `tests/fixtures/preview-ir.ts` 夹具 IR（jsdom 无 WebGL2，回退路径确定化）。
2. **手势迁移完成**（e142a87/e0678e6）：合成画布 PiP 选中/移动/8 向缩放
   （对侧锚定+宽高比锁定+镜像翻转）/旋转（方位角，±2° 回正）/蒙版边界
   （平移+角点缩放，实时仅边界示意）；主轨 sel-box 模式无关天然覆盖。
3. **模式切换移除**（d3b91e2）：合成预览为唯一主预览；权威预览收敛为
   导出前核验（生成请求 → 当前 Revision 预览就绪 → 自动切换观看 →
   播完自动回合成）；导出/重构图回放经渲染面板。
4. **WebAudio 精确调度**（5430781）：段音频迁 AudioBufferSourceNode（音频线程
   时钟）——1.25x 段音频抖动被架构性根治；gainDb>0dB 不再被钳制；
   漂移校正阈值 0.25s→0.08s（仅时钟重锚触达）；音频跟随轨道 muted/solo。
5. **A1 纯音频轨进 IR**（7f45193，IR v0.3）：白名单放行 audio；纯音频时间线
   黑场帧表；段表新增 output_start_us/output_end_us（转场借用重映射后的
   输出时间轴窗口，音频调度消费）；音频长于画面黑场延长输出。
6. **新建项目暴露画布比例**（83452f0）：16:9/9:16/1:1/4:3/3:4 预设，
   core 校验（PROJECT_CANVAS_INVALID），缺省回退 1080x1920@30。
7. **主轨模糊垫底**（2de3527）：blurred_background 进 IR 白名单（main 携带
   layout），合成器两级降采样（÷4→÷16 + 线性放大）近似 gblur sigma=20，
   转场两侧按各自 alpha 垫底。
8. **OffscreenCanvas worker 化（完全体收官，本次提交）**：GL 全部状态
   （环形/影子纹理、字幕层、垫底 FBO）迁入 `compositor-worker.worker.ts`
   （OffscreenCanvas + WebGL2），会话保留编排（时钟/pump/就绪判定/IR），
   下发绘制命令列表（fill/draw/captions）。上传优先 **direct texImage2D
   (VideoFrame) GPU-GPU 路径**（copyTo 的 GPU→CPU 回读 p95 ~42ms 是 scrub
   延迟大头——实测消除），失败自愈回退 copyTo；generateMipmap(R8/RG8) 在
   OffscreenCanvas 上下文 INVALID_ENUM → 首次失败整会话自愈降级 LINEAR-only。
   会话侧 seek 纪元作废过期预取上传 + 拖拽快速档跳过预热。
   画布元素由会话自建/随会话销毁（transferControlToOffscreen 每元素仅一次，
   StrictMode 双挂载安全）；探针回读走 worker convertToBlob→ArrayBuffer transfer。

### 验证证据（evidence/m3_2/playback-repro/，均为 worker 架构）
- `m3p5-worker`（fit）：composed 319/320、丢帧 0、复播 ✓、**合成间隔 p95
  34ms（主线程版 44.5）**；回读帧与主线程版逐字节一致（sha256 同）。
- `m3p5-worker-blur`（blurred）：同上全绿，回读帧确认垫底+前景。
- `m3p4-worker`（seek）：**p50 31.3ms（基线 47.65）**、step p95 0.65ms
  （基线 35.6——±1 步进 50 倍提升）；**p95 ~103-110ms（基线 67.4，门限
  100）——尾部为深 GOP 解码固有成本+单跳开销，scrub 观感仍即时的已知
  回退项**（见下"已知限制"）。
- vitest 369/369；typecheck ✓。

### 待用户 dev 视觉验证
- 画中画拖拽松手无黑屏（replaceIr）、缩放/旋转/蒙版手感、模糊垫底观感、
  1.25x 段音频是否仍有可闻抖动、worker 化后 scrub 手感（p50 快 34%）。

## 关键设计决定（不要回退）
- **`replaceIr` 就地换表**：revision 变更且 IR inputs 签名一致时原地换帧表
  （worker/GL 保留，拖拽提交零黑屏）。不要用"cleanup dispose+重建"模式。
- **worker 架构边界**：会话=编排（IR/时钟/pump/就绪判定），GL worker=执行器
  （无时间轴语义，绘制命令驱动）。**不要把 IR/帧表搬进 worker**（会话手势
  就地补丁依赖单源 IR）。
- **direct 帧上传 > copyTo**：copyTo 的 GPU→CPU 回读是 scrub 延迟大头；
  direct 失败自愈回退（per-worker 标志）。**mipmap 在 OffscreenCanvas 上下文
  对 R8/RG8 INVALID_ENUM** → LINEAR-only 降级（textureLod 钳 base，历史
  mipmap=0 A/B 已验证）。
- **seek 纪元作废过期预取上传 + dragMode 跳过预热**：scrub 风暴中预热解码与
  目标解码争抢解码器（实测 p95 翻倍）。
- **Blob 不可 transfer**（worker→主线程回读用 ArrayBuffer transfer）；
  **克隆后的 Blob 丢原型方法**（Electron 跨边界——回读一律转 ArrayBuffer）。
- **FBO pass 的 u_canvas 必须用 rect 所属坐标空间**（垫底黑底根因，实测）。
- **合成 tick 以墙钟目标时间驱动音频节拍**；**RTL 模拟 change 与回退重渲
  相撞会被去重**（测试先 settle）；**backgroundThrottling=false**；
  后备缓冲 ≤2048；比例真源 = 项目画布（新建项目可选）。

## 已知限制
- **seek p95 ~103-110ms（门限 100，主线程基线 67）**：尾部=深 GOP 解码
  （驱动级，播放路径已规避但 scrub 无法规避）+ worker 单跳。p50/step 大幅
  优于基线；若要进一步压尾部：解码 worker 内嵌进 GL worker（消 transfer，
  代价：解码器挂死需整 worker 重建——与已知驱动限制的隔离策略冲突）。
- 本机 Intel D3D11 WebCodecs：暂停态 seek 进深 GOP 可能花屏；播放路径已规避。
- 跨越主轨转场借用点的 A1 音频段不做分段重映射（known_approximations）。
- 蒙版/抠像合成器不渲染：实时仅边界/徽标示意。
- direct 帧上传为 RGBA（Chromium 色彩转换），与 YUV shader 路径存在理论
  色差（同矩阵同范围，实测回读帧与主线程版逐字节一致）。

## 下一步
0. **用户 dev 验证**：上面清单（重启 pnpm dev；core 不用更新，改 core 时重启即生效）。
1. 若 scrub 尾部需压回 100ms 内：尝试"解码内嵌 GL worker"或 seek 路径
   copyTo 前置解码分级（先行实测 decode 尾部分布）。
2. 顺路产品项（未做）：A1 音频波形/粗剪时间轴展示、C1 字幕在合成画布的
   选中编辑手势。

## 验证工具
```bash
python tools/m3_0/run_electron_probe.py m3p5 \
  --ir evidence/m3_2/playback-repro/ir_user_project.json \
  --assets evidence/m3_2/playback-repro/assets.manifest.json \
  --evidence evidence/m3_2/playback-repro/<name>
# 模糊垫底夹具：--ir evidence/m3_2/playback-repro/ir_user_project_blurred.json
# m3p4 = seek 基准；m3p5 = 播放态（门限 丢帧≈0）
```

完整历史与根因：docs/STAGE_M3_2_PLAYBACK_REFACTOR_2026-09-06.md

