from __future__ import annotations

V13_SQL = """
DROP TRIGGER media_generation_requests_no_update;
DROP TRIGGER media_generation_requests_no_delete;
CREATE TABLE media_generation_requests_v13 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  generation_kind TEXT NOT NULL CHECK(generation_kind IN ('image','tts')),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('simulation_only','provider_image_v1')),
  prompt_sha256 TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_sha256)
);
INSERT INTO media_generation_requests_v13 SELECT * FROM media_generation_requests;
DROP TABLE media_generation_requests;
ALTER TABLE media_generation_requests_v13 RENAME TO media_generation_requests;
CREATE INDEX idx_media_generation_requests_project
  ON media_generation_requests(project_id, created_at DESC, id DESC);
CREATE TRIGGER media_generation_requests_no_update
BEFORE UPDATE ON media_generation_requests
BEGIN SELECT RAISE(ABORT,'media generation requests are immutable'); END;
CREATE TRIGGER media_generation_requests_no_delete
BEFORE DELETE ON media_generation_requests
BEGIN SELECT RAISE(ABORT,'media generation requests are immutable'); END;
CREATE TABLE image_provider_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider_kind TEXT NOT NULL CHECK(provider_kind='openai_images'),
  adapter_id TEXT NOT NULL CHECK(adapter_id='openai_images_generations_v1'),
  capability TEXT NOT NULL CHECK(capability='image_text_to_image'),
  protocol_version TEXT NOT NULL CHECK(protocol_version='1'),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
  model TEXT NOT NULL CHECK(model='gpt-image-1'),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  price_per_image REAL NULL CHECK(price_per_image IS NULL OR price_per_image >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,provider_kind)
);
CREATE TABLE provider_image_request_profiles (
  request_id TEXT PRIMARY KEY REFERENCES media_generation_requests(id),
  provider_config_id TEXT NOT NULL REFERENCES image_provider_configs(id),
  provider_kind TEXT NOT NULL CHECK(provider_kind='openai_images'),
  adapter_id TEXT NOT NULL CHECK(adapter_id='openai_images_generations_v1'),
  capability TEXT NOT NULL CHECK(capability='image_text_to_image'),
  protocol_version TEXT NOT NULL CHECK(protocol_version='1'),
  model TEXT NOT NULL CHECK(model='gpt-image-1'),
  endpoint_identity TEXT NOT NULL CHECK(endpoint_identity='openai_images_generations'),
  size TEXT NOT NULL CHECK(size IN ('1024x1024','1024x1536','1536x1024')),
  output_format TEXT NOT NULL CHECK(output_format='png'),
  provider_profile_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE provider_image_invocations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES media_generation_tasks(id),
  provider_config_id TEXT NOT NULL REFERENCES image_provider_configs(id),
  status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','cancelled','interrupted')),
  provider_call_count INTEGER NOT NULL DEFAULT 0 CHECK(provider_call_count IN (0,1)),
  provider_may_have_processed INTEGER NOT NULL DEFAULT 0 CHECK(provider_may_have_processed IN (0,1)),
  provider_request_id TEXT NULL,
  usage_json TEXT NULL,
  estimated_cost REAL NULL CHECK(estimated_cost IS NULL OR estimated_cost >= 0),
  provider_response_sha256 TEXT NULL,
  validated_format TEXT NULL CHECK(validated_format IS NULL OR validated_format='png'),
  validated_width INTEGER NULL,
  validated_height INTEGER NULL,
  validated_size_bytes INTEGER NULL,
  output_sha256 TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  cleanup_required INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_required IN (0,1)),
  output_relative_path TEXT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  updated_at TEXT NOT NULL,
  CHECK(provider_may_have_processed <= provider_call_count),
  CHECK((cleanup_required=0 AND output_relative_path IS NULL) OR
        (cleanup_required=1 AND output_relative_path IS NOT NULL)),
  CHECK(cleanup_required=0 OR status<>'succeeded'),
  CHECK(status<>'succeeded' OR (
    provider_call_count=1 AND provider_may_have_processed=1 AND
    validated_format='png' AND validated_width IS NOT NULL AND
    validated_height IS NOT NULL AND validated_size_bytes IS NOT NULL AND
    output_sha256 IS NOT NULL AND error_code IS NULL AND cleanup_required=0
  ))
);
CREATE TABLE generated_asset_provenance (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id),
  request_id TEXT NOT NULL REFERENCES media_generation_requests(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES media_generation_tasks(id),
  invocation_id TEXT NOT NULL UNIQUE REFERENCES provider_image_invocations(id),
  prompt_sha256 TEXT NOT NULL,
  provider_kind TEXT NOT NULL CHECK(provider_kind='openai_images'),
  adapter_id TEXT NOT NULL CHECK(adapter_id='openai_images_generations_v1'),
  protocol_version TEXT NOT NULL CHECK(protocol_version='1'),
  model TEXT NOT NULL CHECK(model='gpt-image-1'),
  provider_profile_sha256 TEXT NOT NULL,
  provider_response_sha256 TEXT NULL,
  output_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_image_provider_configs_project ON image_provider_configs(project_id,created_at DESC,id DESC);
CREATE INDEX idx_provider_image_invocations_status ON provider_image_invocations(status,created_at,id);
CREATE INDEX idx_provider_image_invocations_cleanup ON provider_image_invocations(cleanup_required,updated_at) WHERE cleanup_required=1;
CREATE INDEX idx_generated_asset_provenance_request ON generated_asset_provenance(request_id,created_at DESC,id DESC);
CREATE TRIGGER provider_image_request_profiles_no_update BEFORE UPDATE ON provider_image_request_profiles
BEGIN SELECT RAISE(ABORT,'provider image request profiles are immutable'); END;
CREATE TRIGGER provider_image_request_profiles_no_delete BEFORE DELETE ON provider_image_request_profiles
BEGIN SELECT RAISE(ABORT,'provider image request profiles are immutable'); END;
CREATE TRIGGER generated_asset_provenance_no_update BEFORE UPDATE ON generated_asset_provenance
BEGIN SELECT RAISE(ABORT,'generated asset provenance is immutable'); END;
CREATE TRIGGER generated_asset_provenance_no_delete BEFORE DELETE ON generated_asset_provenance
BEGIN SELECT RAISE(ABORT,'generated asset provenance is immutable'); END;
"""  # noqa: E501
