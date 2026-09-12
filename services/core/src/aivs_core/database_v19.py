from __future__ import annotations

V19_VERSION = "v19"

# C22：渲染/校验细分阶段。旧 stage 文本保持不变（旧 UI 兼容），phase/
# phase_progress 为可选扩展列——未知 phase 的旧客户端忽略即可。
V19_SQL = """
ALTER TABLE jobs ADD COLUMN phase TEXT;
ALTER TABLE jobs ADD COLUMN phase_progress REAL;
"""
