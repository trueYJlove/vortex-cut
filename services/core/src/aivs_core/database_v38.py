from __future__ import annotations

# W2.2 降级交付（Design Gate 2026-10-14，D3）：给 speaker_diarizations 加**机器可读的质量标注**。
#
# 背景：S3 在生产链路上判精度门三项全不过（门 §5.20），且 §5.21 实测否决了「只交付高置信区间」。
# 采纳的 D3 形态是：**输出不变，只标注**——用字段而不是文案，因为下游（W2.3 机位切换）
# 必须在**代码里**拒绝，靠读文档的约束会腐烂。
#
# 三列语义：
#   quality_status   'unvalidated' = 未通过精度门（本门交付态）；另有 'validated' 供将来精度门通过后升级
#   quality_basis     判定所依据的门（含阈值文本），便于回溯「当时按哪条线判的」
#   usable_for        JSON 数组；'reference' 恒在，'multicam_switch' **不在其中**
#                     （下游检查**按取值**而非版本号，故将来升级无需改下游代码）
#
# **回填默认安全侧**：历史行一律 'unvalidated' —— 新增字段若静默缺省，
# 下游会把「未验证」当成「已验证」，那是比精度不过更严重的事故。
V38_VERSION = "v38"

V38_SQL = """
ALTER TABLE speaker_diarizations ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'unvalidated'
  CHECK(quality_status IN ('validated','unvalidated'));
ALTER TABLE speaker_diarizations ADD COLUMN quality_basis TEXT;
ALTER TABLE speaker_diarizations ADD COLUMN usable_for TEXT NOT NULL DEFAULT '["reference"]';

-- 历史行显式回填（ADD COLUMN 的 DEFAULT 已覆盖，此处只固化 basis 文案以便追溯）
UPDATE speaker_diarizations
   SET quality_basis = 'gate:mean_le_0.40,worst_en_le_0.60,worst_cn_le_0.55'
 WHERE quality_basis IS NULL;
"""
