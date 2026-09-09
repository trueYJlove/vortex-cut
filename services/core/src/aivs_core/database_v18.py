from __future__ import annotations

V18_VERSION = "v18"

V18_SQL = """
CREATE TABLE derived_media_cache (
  cache_key TEXT PRIMARY KEY CHECK(cache_key GLOB 'sha256:*'),
  asset_fingerprint TEXT NOT NULL CHECK(asset_fingerprint GLOB 'sha256:*'),
  kind TEXT NOT NULL CHECK(kind IN ('video_proxy','waveform','audio_pcm_chunk','reverse_chunk')),
  params_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  toolchain_fingerprint TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  status TEXT NOT NULL CHECK(status IN ('building','ready','failed')),
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);
CREATE INDEX idx_derived_media_cache_fingerprint_kind
  ON derived_media_cache(asset_fingerprint, kind);
CREATE INDEX idx_derived_media_cache_lru
  ON derived_media_cache(last_accessed_at, cache_key);

CREATE TABLE derived_media_cache_refs (
  cache_key TEXT NOT NULL REFERENCES derived_media_cache(cache_key) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  PRIMARY KEY (cache_key, project_id, asset_id)
);
CREATE INDEX idx_derived_media_cache_refs_asset
  ON derived_media_cache_refs(asset_id, cache_key);
CREATE TRIGGER derived_media_cache_refs_validate_insert
BEFORE INSERT ON derived_media_cache_refs
WHEN NOT EXISTS (
  SELECT 1 FROM assets a JOIN projects p ON p.id = a.project_id
  WHERE a.id = NEW.asset_id AND a.project_id = NEW.project_id AND p.status = 'active'
)
BEGIN SELECT RAISE(ABORT,'derived cache ref requires asset within active project'); END;
"""
