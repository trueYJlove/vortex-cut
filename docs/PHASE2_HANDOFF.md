# Phase 2 交接（合成预览默认化 → 手势迁移 → 完全体）

## 当前状态（2026-09-06，HEAD 含 83452f0 之后的 blur 工作）

### 已完成（Phase 2 全部主体，除 OffscreenCanvas 专项外）
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
   黑场帧表；**段表新增 output_start_us/output_end_us**（转场借用重映射后的
   输出时间轴窗口，音频调度消费）；音频长于画面黑场延长输出。
6. **新建项目暴露画布比例**（83452f0）：16:9/9:16/1:1/4:3/3:4 预设，
   core 校验（PROJECT_CANVAS_INVALID），缺省回退 1080x1920@30。
7. **主轨模糊垫底**（本次提交）：blurred_background 进 IR 白名单（main 携带
   layout），合成器两级降采样（÷4→÷16 + 线性放大）近似 gblur sigma=20，
   转场两侧按各自 alpha 垫底——转录追加时间线（默认 blurred_background）
   的合成预览不再是黑底+回退。

### 验证证据（evidence/m3_2/playback-repro/）
- `m3p5-phase2-gestures`（fit 夹具）：composed 319/320、丢帧 0、复播 ✓、
  合成间隔 p95 45.4ms——与 e3c76a2 时的 fixed34（44.5）持平。
- `m3p5-phase2-blur`（blurred 夹具 ir_user_project_blurred.json）：同上全绿，
  回读帧确认模糊垫底+清晰前景（剪映观感）。
- vitest 368+（desktop 全量绿）；python IR 单测 29 例 / 集成 8 例绿。
- **待用户 dev 视觉验证**：画中画拖拽松手无黑屏（replaceIr，e3c76a2）、
  缩放/旋转/蒙版手感、模糊垫底观感、1.25x 段音频是否仍有可闻抖动。

## 关键设计决定（不要回退）
- **`replaceIr` 就地换表**：revision 变更且 IR inputs 签名一致时原地换帧表
  （worker/GL 保留，拖拽提交零黑屏）。不要用"cleanup dispose+重建"模式
  （React cleanup 先于新 body 执行，任何吸收方案都会被打穿——8642f7f/e3c76a2 实测）。
- **比例真源 = 项目画布**；下拉框仅预览覆盖。新建项目可选画布。
- **垫底 FBO 的 u_canvas 必须用 rect 所属坐标空间**（pass1=IR 画布、
  pass2=small 纹理、pass3=画布路径），viewport 决定降采样分辨率——
  u_canvas 用 FBO 尺寸只会画出画布左上角小块（垫底黑底根因，本次实测）。
- **合成 tick 以墙钟目标时间驱动音频节拍**（非合成帧时间）——合成滞后不拖累音频。
- **RTL 模拟 change 与回退重渲相撞会被 React change 去重丢弃**（丢第一次模拟
  输入）：测试先等内联回退提示出现（settle）再交互；真实键入不受影响。
- **backgroundThrottling=false**（electron/main/index.ts）；后备缓冲 ≤2048。

## 已知限制（驱动级，勿反复尝试修复）
- 本机 Intel D3D11 WebCodecs：暂停态 seek 进深 GOP 可能花屏；播放路径已规避。
- 跨越主轨转场借用点的 A1 音频段不做分段重映射（known_approximations）。
- 蒙版/抠像合成器不渲染：实时仅边界/徽标示意，效果以权威预览为准。

## 下一步（优先级序）
0. **用户 dev 验证**：上面"待用户 dev 视觉验证"清单（先重启 pnpm dev）。
1. **OffscreenCanvas worker 专项（唯一剩余大项）**：动机=把 upload（copyTo+
   texImage2D+mipmap）挪出主线程。**实测数据**：compose p95 0.4ms（非瓶颈），
   decode 已在 worker，**upload p95 14~25ms 在主线程**（拖帧元凶）。
   方案：`canvas.transferControlToOffscreen` + compositor worker 化
   （ring/shadow/纹理状态随 GL 迁入 worker，session 保留编排与时间轴）；
   连带改造：probe 的 canvas.toBlob readback（transfer 后主线程不可用，
   改 worker convertToBlob）、resize 通道、context loss 恢复。
   建议**新开会话**做（净上下文；播放路径当前三探针全绿，勿在半状态提交）。
2. 顺路产品项（未做）：A1 音频波形/粗剪时间轴展示、C1 字幕在合成画布的
   选中编辑手势。

## 验证工具
```bash
python tools/m3_0/run_electron_probe.py m3p5 \
  --ir evidence/m3_2/playback-repro/ir_user_project.json \
  --assets evidence/m3_2/playback-repro/assets.manifest.json \
  --evidence evidence/m3_2/playback-repro/<name>
# 模糊垫底夹具：--ir evidence/m3_2/playback-repro/ir_user_project_blurred.json
# m3p4 = seek 基准（门限 p95 ≤ 100ms）；m3p5 = 播放态（门限 丢帧≈0）
```

完整历史与根因：docs/STAGE_M3_2_PLAYBACK_REFACTOR_2026-09-06.md
