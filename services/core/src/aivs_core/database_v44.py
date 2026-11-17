"""v44 迁移：derived_media_cache 的 kind 白名单加 "filmstrip"（WP-P232）。

**为什么是重建表而不是 ALTER**：SQLite 的 CHECK 约束写死在建表语句里，
无法 ALTER 放宽；B10 派生缓存表的既有数据是纯缓存（可再生的派生产物索引，
status='ready' 的文件在缓存目录里按 cache_key 命名）——重建表保留全部行，
kind 校验放宽后旧条目原样有效。

**做法**：旧表改名 → 按新 CHECK（+filmstrip）重建 → 原行拷回 → 删旧表。
索引/触发器随表重建（derived_media_cache 无触发器；引用表 derived_media_refs
以 cache_key 外键指向本表——SQLite 外键默认 OFF，运行期 PRAGMA 打开时
要求本表 cache_key 保持主键不变，拷回保 key 即安全）。
"""
from __future__ import annotations

V44_VERSION = "v44"

V44_SQL = """
ALTER TABLE derived_media_cache RENAME TO derived_media_cache_v44_old;

-- refs 表外键指向本表：RENAME 旧表会把 refs 的外键定义改写到 _v44_old
-- （foreign_keys=OFF 下的 legacy 行为），DROP 后引用悬空——refs 一并重建。

CREATE TABLE derived_media_cache (
  cache_key TEXT PRIMARY KEY CHECK(cache_key GLOB 'sha256:*'),
  asset_fingerprint TEXT NOT NULL CHECK(asset_fingerprint GLOB 'sha256:*'),
  kind TEXT NOT NULL CHECK(kind IN ('video_proxy','waveform','audio_pcm_chunk','reverse_chunk','filmstrip')),
  params_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  toolchain_fingerprint TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('building','ready','failed')),
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

INSERT INTO derived_media_cache
  (cache_key,asset_fingerprint,kind,params_json,schema_version,
   toolchain_fingerprint,relative_path,size_bytes,status,created_at,last_accessed_at)
SELECT
  cache_key,asset_fingerprint,kind,params_json,schema_version,
  toolchain_fingerprint,relative_path,size_bytes,status,created_at,last_accessed_at
FROM derived_media_cache_v44_old;

DROP TABLE derived_media_cache_v44_old;

DROP TRIGGER IF EXISTS derived_media_cache_refs_validate_insert;
DROP INDEX IF EXISTS idx_derived_media_cache_refs_asset;
ALTER TABLE derived_media_cache_refs RENAME TO derived_media_cache_refs_v44_old;

CREATE TABLE derived_media_cache_refs (
  cache_key TEXT NOT NULL REFERENCES derived_media_cache(cache_key) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
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

INSERT INTO derived_media_cache_refs
  (cache_key,project_id,asset_id,created_at,last_accessed_at)
SELECT cache_key,project_id,asset_id,created_at,last_accessed_at
FROM derived_media_cache_refs_v44_old;

DROP TABLE derived_media_cache_refs_v44_old;
"""
