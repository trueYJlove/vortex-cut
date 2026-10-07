from __future__ import annotations

V29_VERSION = "v29"
V29_SQL = """
ALTER TABLE captions_provider_egress_previews ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
"""
