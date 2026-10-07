from __future__ import annotations

V30_VERSION = "v30"
V30_SQL = """
ALTER TABLE provider_configs ADD COLUMN captions_provider_capability_status TEXT NOT NULL DEFAULT 'untested' CHECK(captions_provider_capability_status IN ('untested','supported','unsupported'));
ALTER TABLE provider_configs ADD COLUMN captions_provider_capability_tested_at TEXT NULL;
"""
