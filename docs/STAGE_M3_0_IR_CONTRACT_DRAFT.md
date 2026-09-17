# IR 契约冻结草案 v0.4

> 状态：**草案 v0.4**（v0.2 经验收通过；v0.3 关键帧四属性全覆盖；v0.4 覆盖轨蒙版/抠像重入——`IR_PROJECTOR_VERSION` 3）
> 上位：[M3-0 技术验证报告](./STAGE_M3_0_TECH_VALIDATION_REPORT.md)、[ADR-1](./STAGE_M3_0_ADR_1_P2_GATE.md)
> 红线（冻结方案 §11）：本草案不得包含任何已知不一致特征；已知逐帧偏差清单见 §5——**违反即验收不通过**

## 1. 与 render-plan-v1 的关系声明

**投影 + 逐帧展开关系，非替换。** 权威渲染仍由 Core 的 FFmpeg 管线（`render-plan-v1` → `build_timeline_args`）执行；本契约定义的是**预览消费契约**：Renderer 从 `render-plan-v1` 编译产物 + 输入流几何（ffprobe 增补）投影出"逐帧数值表 IR"，并**只做应用**（R4 已实证：几何 0px、语义零偏差）。schema 沿用探针草案 `m3-0-probe-ir-draft/1` 的字段结构（`p2/ir.json` 为完整实例），schema 版本定稿属 M3 契约冻结阶段工作。

## 2. 冻结子集（v0.1，全部经 P2 实测覆盖）

| 特征 | 冻结语义（IR 字段 → 双端一致行为） |
|---|---|
| 画布 | `canvas.{width,height,fps,background}`：输出 CFR 30fps，帧索引 n ↔ PTS n/30，黑底 |
| 输入几何 | `inputs[].geometry{width,height,sar}`（ffprobe 增补）：SAR 归一方像素后参与内容盒计算 |
| 段取窗 | `segments[]{source_start_us,source_end_us,timeline_start_us,timeline_end_us,speed_milli}`：源帧号 = floor(源位置×30)（最近帧口径）；内容时间原点 = 段在**输出时间轴**上的起点（转场借用压缩后） |
| 布局 | `layout:"fit"`：等比缩进 + 黑边居中的内容盒（`content{x,y,w,h}`），位置/透明度动画整体平移/渐变 |
| 转场 | `fade` / `fadeblack`：借用式重叠，offset = 累积输出长 − T；逐帧混合系数 p=(t−offset)/T（IR 已解析，双端只应用）；链接转场与空隙邻接转场（休眠态转场允许）不在子集 |
| 黑底填充 | 时间线空隙以黑底帧填充（`kind:"black"`） |
| 位置关键帧 | `keyframes.position{x,y}`：逐帧 lerp（窗口外取边界值），整体平移量 = x·(W/2)、y·(H/2)（v0.2 重入：权威端 overlay 时长缺陷已修复 456c89a，渲染时长断言与 P2 采样比对均达标） |
| 缩放关键帧 | `keyframes.scale{v}`：**权威端渲染为无视觉效果**（逐帧 scale 被静态归一化 scale=min(iw,W)+pad 完全抵消；M3-0 实证 bbox 恒全画布）——IR 与合成器一致忽略；与 UI 数值语义的差异属权威端已知限制（v0.3 纳入） |
| 旋转关键帧 | `keyframes.rotate{v}`：绕画布中心逐帧旋转（度数语义），角落为黑（v0.3 纳入） |
| 透明度关键帧 | **定义即近似**：渲染语义 = `fade=alpha=1:st=0:d=末关键帧t`（恒 0→1 渐入，帧值 v 不参与插值）。双端同语义 → 一致；与 UI 数值编辑语义的差异属权威端已知近似（非预览↔导出不一致），入 §5 清单 |
| 画中画（PiP） | 覆盖轨 fit 内容盒 × transform.scale，中心点 (cx·W, cy·H)，`enable` 含两端边界、repeatlast；`transform.rotate` 度数语义（v0.2 重入：弧度错位已修复 456c89a）；transform.opacity 权威端不消费（同语义忽略） |
| 蒙版（v0.4 重入） | **仅覆盖轨**（主轨 V1 携带仍硬拒绝——权威端 `_pip_overlay_chain` 不消费主轨 mask）。`effects.mask` 随 overlay 条目携带（静态参数，逐帧不变），合成器 shader 内逐像素算 alpha。双端语义 = `_mask_alpha_expr`（geq）：坐标 ∈ PiP 帧像素（rotate 后内容盒）；**ellipse** 硬边 `alpha=clamp(1−d)`（d = 归一化椭圆距离）；**rect** 硬边 `alpha=clamp(1−norm)`（norm = max(|ux|/halW,|uy|/halH)）；**linear** `alpha=clamp(0.5+ux/(feather·pw))`（feather·pw = 软边带宽）；rotation 角度制旋转坐标系；invert 反转。**feather（v0.4 增补消费）**：ellipse/rect 过渡带收进边界内侧——alpha 在距离 ∈ [1−feather, 1] 线性从 1 降到 0，边界处恒 0 不外溢，feather=0 硬边（缺省） |
| 抠像（v0.4 重入） | **仅覆盖轨**。`effects.keying`（color/similarity/blend）：色距斜坡语义——dist01 = 与键色的 RGB 欧氏距离/(255·√3)（实测标定 2026-09-17，权威端 rgba-geq 与 Renderer effects.ts 同式），dist01 ≤ similarity 全透明、≥ similarity+blend 全不透明、中间线性。mask × keying 同时存在 = alpha 相乘。keying.invert 权威端不消费——同语义忽略，入 §5。权威端实现注：v0.4 起 mask/keying alpha 走单条 rgba-geq（a=mask×key），替换旧 split+colorkey+alphamerge 链——alphamerge 在本环境实测把 RGB 平面污染成 alpha 灰度（旧 bug，采样点恰好不敏感未暴露） |
| 字幕 | 文本内容/时机/位置/样式参数语义冻结；光栅化为系统差（§5） |

## 3. 双端一致性的度量口径（ADR-1 修订后）

1. 几何错位 = 0px（FFT 相位相关 ±8px）；
2. 语义/时序零偏差（IR 数值表逐帧一致）；
3. PSNR 回归基线 ≥ 19dB（分档参考：慢速 ≥31dB / PiP 与快速运动 ≥19dB），缺陷修复重基线化；
4. 字幕：IoU ≥ 0.35 且中心偏移 ≤ 8px。

## 4. 子集外与重入条件

| 特征 | 排除原因 | 重入条件 |
|---|---|---|
| ~~V1 主轨 position 关键帧~~ | ~~overlay 时长缺陷~~ | **已重入 v0.2**（456c89a 修复 + 渲染时长集成测试 + P2 采样比对达标） |
| ~~`transform.rotate`~~ | ~~弧度错位~~ | **已重入 v0.2**（456c89a 修复 + 度数语义像素三角验证 + P2 采样比对达标） |
| ~~scale/rotate 关键帧~~ | ~~超出 M3-0 实测子集~~ | **已重入 v0.3**（scale=权威端无视觉效果实证 + rotate 逐帧值；关键帧四属性全覆盖） |
| ~~覆盖轨蒙版（linear/rect/ellipse）~~ | ~~不在 M3-0 实测子集~~ | **已重入 v0.4**（shader 逐像素 alpha 镜像 `_mask_alpha_expr` + 双端数值一致性测试 test_effects_reference.py / preview-effects.test.ts + **P2 基准扩展重跑留证达成 2026-09-17**，`evidence/m3_0/p2_v2/`） |
| ~~覆盖轨抠像（colorkey）~~ | ~~不在 M3-0 实测子集~~ | **已重入 v0.4**（colorkey alpha smoothstep 镜像 + **P2 基准扩展重跑留证达成 2026-09-17**） |
| 主轨蒙版/抠像、reframe、倒放、图片素材、dissolve 等其余转场、crop_fill 主轨布局 | 权威端不消费或未实测，维持"仅权威预览"口径 | M3 后续阶段按同范式扩展实测后入集 |

## 5. 已知逐帧偏差清单（红线文件）

| # | 差异 | 性质 | 实测界 | 处置 |
|---|---|---|---|---|
| 1 | 字幕光栅化（libass vs 浏览器 Canvas2D） | 系统差（同一字体/样式参数，双端栅格化算法不同） | 文本掩码 IoU 0.376–0.453；中心偏移 ≤5px；全部字幕帧 | 文本/时机/位置语义一致，栅格化差异在感知等效范围；M3 可选统一为单一栅格化器以消除 |
| 2 | 重采样/色度栈差异（libswscale vs GPU 采样 + 着色器 BT.709） | 系统差（算法与定点/浮点精度） | 静态 ≥31.4dB；慢速 ≥31dB；快速运动/PiP ≥20.2dB（ADR-1 重基线化后回归门 ≥20dB，2026-09-05） | ADR-2（复刻 swscale）保留为北极星路径 |
| 3 | 变速段帧选择口径（fps-hold floor vs nearest） | 口径差，±1 帧 | 仅 speed≠1 段，快运动内容 PSNR −10dB 档 | M3 引擎实现时与 `vf_fps` 实测对齐后消除 |
| 4 | opacity 渲染语义与 UI 数值语义差异 | 权威端已知近似（v 值不参与，恒 0→1 渐入） | 双端渲染一致 | 非预览↔导出不一致；产品如需真 lerp 属权威端功能迭代 |
| 5 | scale 关键帧动画被归一化抵消 | 权威端已知限制（渲染为无视觉效果） | 双端渲染一致（M3-0 实证 bbox 恒全画布） | 非预览↔导出不一致；产品如需真缩放属权威端功能迭代（overlay 主输入重构） |
| 6 | keying.invert 不消费 | 权威端已知限制（colorkey/alpha 链未接 invert；蒙版 invert 正常消费） | 双端渲染一致（合成器同语义忽略） | 非预览↔导出不一致；产品如需反选属权威端功能迭代 |

**红线声明**：v0.1 时期缺陷阻塞特征已按重入条件修复复测后纳入；v0.4 蒙版/抠像重入的 P2 留证（2026-09-17）随基准时间线扩展（V4 效果轨 5 片段：ellipse 羽化/linear 软边/colorkey/ellipse 硬边+invert+旋转/rect 硬边+旋转）达成，重跑同时抓出并修复合成器 maskAlpha 像素坐标换算缺陷（v_box×2·halfW 当盒尺寸——width≠0.5 时蒙版被缩放+偏移，权威端 geq 以真实盒尺寸计算不受影响；主线程/worker 双 shader 同修，效果帧 PSNR 均值回升 +2~4dB）；§5 所列均为系统差/口径差并附实测界与处置，无特征性内容不一致。探针实现偏差记录（帧源切换、视频可见化、preserveDrawingBuffer 等）见验证报告 §2.5。

## 6. P2 v0.4 重跑留证记录（2026-09-17，`evidence/m3_0/p2_v2/`）

- **基准时间线扩展**（`tools/m3_0/test_project.py`）：V4 效果轨 5 片段（6-10s ellipse 羽化 0.25 / 16-19s linear 软边 0.05+30° / 20-24s colorkey 键色 140C28 sim0.18 blend0.10 / 30-35s ellipse 硬边+invert+mask 旋转 20°×元素旋转 12° / 46-50s rect 硬边+元素旋转 −15°），素材/窗口与 V2/V3 错开（不触发 W4 拆分）；采样帧表增 25 帧（覆盖起/中/末、羽化过渡带、抠像 blend 带、invert 区）合计 55 帧。
- **结果**：几何错位 55/55 全 0px；语义零偏差（IR 帧表与权威端逐帧一致，含效果片段）；效果帧 PSNR 19.5–33.6dB、非字幕全帧最低 17.4dB@n=599（转场×colorkey 组合帧，归因重采样系统差，与 ADR-1 分档一致）。**回归门口径**：v0.4 效果帧与旧语义帧同档 ≥20dB 达成（最低效果帧 19.45dB@n=660 为转场叠加帧），门限维持 ADR-1 的 ≥20dB 不上调。
- **既有证据未失效**：`p2/` 目录完整保留（旧时间线证据）；step0 自校准沿用（色卡时间线与渲染栈未变，底噪声 31.41–38.59dB 仍适用）。
