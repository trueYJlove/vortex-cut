# 字幕气泡与花字(B4 收官)——设计定案

> 起草:LiuWei,2026-09-18。收尾 M2-B4 属性面板预留的"气泡/花字"两个 soon Tab
> (PropertyPanels.tsx SubTabs)。实施:ZhangSan(Core)/YeJing(Desktop)。

## 0. 设计原则

沿用 B4 既有范式:**per-caption style_override 部分覆盖 + 服务端校验 + ASS
行内标签渲染**——不引入第二类文字实体、不新增操作,只扩展 `style_override`
的字段集与渲染映射。UI Tab 从 `soon` 翻正。

ASS 能力边界(决定模板形态):
- 气泡(文字底衬块)= ASS BorderStyle 3/4(不透明底块,颜色取 BackColour,
  尺寸随文本自适应)+ 可调 back_color 与阴影偏移。**真圆角气泡(带尾巴)非
  ASS 原生能力**,第一版以"底衬块"形态交付(与剪映基础气泡观感一致),
  尾巴造型留后续(需绘制矢量,成本高)。
- 花字 = 行内标签组合(渐变色 `\c`+`\2c`、多层描边模拟发光 `\bord`+`\blur`、
  阴影 `\shad`、旋转 `\frz`)——以**预设模板集**交付(模板 = 一组预校验的
  标签参数),不开放任意自由组合(UI 上是模板选择,不是参数编辑)。

## 1. 数据模型(style_override 扩展)

```jsonc
{
  // …既有 B4 字段不变…
  "back_color": "&H80000000",   // 底衬/阴影色(ASS &Haabbggrr;含 alpha)
  "border_style": 1 | 3,        // 1=描边+阴影(现预设) 3=不透明底衬块
  "shadow": 0–10,               // 阴影深度(BorderStyle=3 时即底衬偏移感)
  "fx_preset": "none" | "gold-gradient" | "neon-glow" | "sticker-outline" | "soft-shadow"
}
```

- `back_color`/`border_style`/`shadow`:复用 ASS 原生字段(预设 JSON 里已有
  同名字段,per-caption 覆盖补齐同一语义)——**气泡 = border_style 3 +
  back_color + outline(决定底衬留白)**。
- `fx_preset`:花字模板枚举,服务端按枚举展开为固定标签序列(见 §3),
  用户不可自定参数——避免自由组合的注入面与渲染组合爆炸。
- 互斥裁决:`fx_preset` 与 `primary_color`/`outline_color` 同时存在时,
  fx 模板的颜色标签**后置覆盖**(fx 是"整包样式",基础色是它的组成部分);
  UI 上选中 fx 模板时禁用基础色控件并提示。

## 2. 校验(core `_validate_caption_style` + contracts)

- `border_style`:枚举 {1,3};`shadow`:0–10;`back_color`:&Haabbggrr 格式
  (同既有颜色校验);
- `fx_preset`:枚举白名单(上列 5 值);
- contracts `isCaptionStyleOverride` 同步 onlyKeys + 类型/范围。

## 3. 渲染映射(ass.py `caption_override_tags`)

| override 字段 | ASS 映射 |
|---|---|
| border_style=3 | Style 域外无法逐行改 BorderStyle → **用行内 `\bord`+`\shad`+`\3a`/BackColour 模拟底衬块**实际上 ASS 行内无 BorderStyle 切换;定案:**BorderStyle 走 Style 行**,Style 行按 preset 生成时已含 border_style/back_color——per-caption 需要独立 Style 变体。实现:`build_ass` 为含 border_style=3 覆盖的字幕生成**派生 Style 行**(`{preset_id}__b3`,继承预设 + 覆盖 back_color/border_style/shadow),该字幕 Dialogue 引用派生 Style;行内其余标签逻辑不变。派生 Style 命名确定性(同参数同名),去重后追加到 [V4+ Styles]。 |
| back_color | 派生 Style 的 BackColour(气泡底色,alpha 位生效) |
| shadow | 派生 Style 的 Shadow(BorderStyle=3 下= 底衬外扩感) |
| fx_preset | Dialogue 行内标签序列(见下) |

花字模板 → 标签序列(全部为值固定的服务端生成,无用户输入注入):

| fx_preset | 标签序列(示意) |
|---|---|
| gold-gradient | `\c&H20C0FF&\3c&H402000&\bord6\blur1` (金橙主体+深棕描边+微模糊柔化) |
| neon-glow | `\c&H00FFFF&\3c&H804000&\bord8\blur3\shad2` (青色主体+暖光晕) |
| sticker-outline | `\c&HFFFFFF&\3c&H101010&\bord10\blur0\shad0` (贴纸白字+粗黑边) |
| soft-shadow | `\c&HFFFFFF&\bord2\shad4\4a&H60000000&` (软阴影) |
| none | 无标签(清除) |

`\4a`(BackColour alpha)等扩展标签按 libass 支持面实测;不支持即从模板剔除,
模板以实测可用为准(实施时逐一真渲染验证)。

## 4. UI(PropertyPanels)

- SubTabs "气泡"/"花字" 去 `soon`:
  - 气泡 Tab:开关(border_style 3 ↔ 1)+ 底衬颜色(picker)+ 底衬深度
    (shadow 滑杆)+ 恢复(删除三字段);
  - 花字 Tab:模板卡片列表(none + 4 模板,选中态高亮),选择即
    `set_caption_style {fx_preset}`;选中后基础 Tab 颜色控件禁用并提示
    "花字模板控制颜色";
  - 两 Tab 均落既有 `set_caption_style`/`clear_caption_style`,无新 op。

## 5. 验收

1. 单测:core 校验(新字段范围/枚举/互斥)、ass 生成(派生 Style 行去重、
   fx 标签序列逐字符断言)、contracts 校验;
2. 真渲染集成:`test_b4_bubble_fx_render_real.py`——气泡底衬可见(像素采样
   BorderStyle=3 区域色= back_color)、fx 模板改变字面色;
3. 预览侧:libass 即渲染端,预览=导出天然一致,零改动;
4. 全量回归 + UI 手测(两 Tab 交互、模板切换、禁用提示)。

## 6. 明确不做

- 气泡尾巴造型(矢量绘制,后续评估);
- 花字自由参数编辑(仅模板集);
- 字幕动画 Tab(仍是 soon,需关键帧体系扩展,独立评估);
- 渐变填充clip 级 `\clip` 矩形渐变(复杂度高,模板已含观感近似)。
