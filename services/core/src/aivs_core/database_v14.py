from __future__ import annotations

V14_SQL = """
DROP TRIGGER provider_image_request_profiles_no_update;
DROP TRIGGER provider_image_request_profiles_no_delete;
DROP TRIGGER generated_asset_provenance_no_update;
DROP TRIGGER generated_asset_provenance_no_delete;
DROP INDEX idx_image_provider_configs_project;
DROP INDEX idx_provider_image_invocations_status;
DROP INDEX idx_provider_image_invocations_cleanup;
DROP INDEX idx_generated_asset_provenance_request;
CREATE TABLE image_provider_configs_v14 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider_kind TEXT NOT NULL CHECK(provider_kind IN ('openai_images','apikey_fun_images')),
  adapter_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability='image_text_to_image'),
  protocol_version TEXT NOT NULL CHECK(protocol_version='1'),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  price_per_image REAL NULL CHECK(price_per_image IS NULL OR price_per_image >= 0),
  price_2k_per_image REAL NULL CHECK(price_2k_per_image IS NULL OR price_2k_per_image >= 0),
  price_currency TEXT NULL CHECK(price_currency IS NULL OR price_currency='CNY'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,provider_kind),
  CHECK(
    (provider_kind='openai_images' AND adapter_id='openai_images_generations_v1' AND model='gpt-image-1' AND price_2k_per_image IS NULL AND price_currency IS NULL) OR
    (provider_kind='apikey_fun_images' AND adapter_id='apikey_fun_images_sse_v1' AND model='gpt-image-2' AND price_per_image=0.1 AND price_2k_per_image=0.15 AND price_currency='CNY')
  )
);
INSERT INTO image_provider_configs_v14(
  id,project_id,provider_kind,adapter_id,capability,protocol_version,display_name,model,
  enabled,price_per_image,price_2k_per_image,price_currency,created_at,updated_at
) SELECT id,project_id,provider_kind,adapter_id,capability,protocol_version,display_name,model,
         enabled,price_per_image,NULL,NULL,created_at,updated_at FROM image_provider_configs;
CREATE TABLE provider_image_request_profiles_v14 (
  request_id TEXT PRIMARY KEY REFERENCES media_generation_requests(id),
  provider_config_id TEXT NOT NULL REFERENCES image_provider_configs_v14(id),
  provider_kind TEXT NOT NULL CHECK(provider_kind IN ('openai_images','apikey_fun_images')),
  adapter_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability='image_text_to_image'),
  protocol_version TEXT NOT NULL CHECK(protocol_version='1'),
  model TEXT NOT NULL,
  endpoint_identity TEXT NOT NULL,
  size TEXT NOT NULL CHECK(size IN ('1024x1024','1024x1536','1536x1024')),
  output_format TEXT NOT NULL CHECK(output_format='png'),
  provider_profile_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(
    (provider_kind='openai_images' AND adapter_id='openai_images_generations_v1' AND model='gpt-image-1' AND endpoint_identity='openai_images_generations') OR
    (provider_kind='apikey_fun_images' AND adapter_id='apikey_fun_images_sse_v1' AND model='gpt-image-2' AND endpoint_identity='apikey_fun_images_generations' AND size='1024x1024')
  )
);
INSERT INTO provider_image_request_profiles_v14 SELECT * FROM provider_image_request_profiles;
CREATE TABLE provider_image_invocations_v14 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES media_generation_tasks(id),
  provider_config_id TEXT NOT NULL REFERENCES image_provider_configs_v14(id),
  status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','cancelled','interrupted')),
  provider_call_count INTEGER NOT NULL DEFAULT 0 CHECK(provider_call_count IN (0,1)),
  provider_may_have_processed INTEGER NOT NULL DEFAULT 0 CHECK(provider_may_have_processed IN (0,1)),
  provider_request_id TEXT NULL,
  usage_json TEXT NULL,
  estimated_cost REAL NULL CHECK(estimated_cost IS NULL OR estimated_cost >= 0),
  estimated_cost_currency TEXT NULL CHECK(estimated_cost_currency IS NULL OR estimated_cost_currency='CNY'),
  price_tier TEXT NULL CHECK(price_tier IS NULL OR price_tier IN ('1K','2K')),
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
  CHECK((cleanup_required=0 AND output_relative_path IS NULL) OR (cleanup_required=1 AND output_relative_path IS NOT NULL)),
  CHECK(cleanup_required=0 OR status<>'succeeded'),
  CHECK(status<>'succeeded' OR (
    provider_call_count=1 AND provider_may_have_processed=1 AND validated_format='png' AND
    validated_width IS NOT NULL AND validated_height IS NOT NULL AND validated_size_bytes IS NOT NULL AND
    output_sha256 IS NOT NULL AND error_code IS NULL AND cleanup_required=0
  ))
);
INSERT INTO provider_image_invocations_v14(
  id,task_id,provider_config_id,status,provider_call_count,provider_may_have_processed,
  provider_request_id,usage_json,estimated_cost,estimated_cost_currency,price_tier,
  provider_response_sha256,validated_format,validated_width,validated_height,
  validated_size_bytes,output_sha256,error_code,error_message,cleanup_required,
  output_relative_path,created_at,started_at,finished_at,updated_at
) SELECT id,task_id,provider_config_id,status,provider_call_count,provider_may_have_processed,
         provider_request_id,usage_json,estimated_cost,NULL,NULL,provider_response_sha256,
         validated_format,validated_width,validated_height,validated_size_bytes,output_sha256,
         error_code,error_message,cleanup_required,output_relative_path,created_at,started_at,
         finished_at,updated_at FROM provider_image_invocations;
CREATE TABLE generated_asset_provenance_v14 (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id),
  request_id TEXT NOT NULL REFERENCES media_generation_requests(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES media_generation_tasks(id),
  invocation_id TEXT NOT NULL UNIQUE REFERENCES provider_image_invocations_v14(id),
  prompt_sha256 TEXT NOT NULL,
  provider_kind TEXT NOT NULL CHECK(provider_kind IN ('openai_images','apikey_fun_images')),
  adapter_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK(protocol_version='1'),
  model TEXT NOT NULL,
  provider_profile_sha256 TEXT NOT NULL,
  provider_response_sha256 TEXT NULL,
  output_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(
    (provider_kind='openai_images' AND adapter_id='openai_images_generations_v1' AND model='gpt-image-1') OR
    (provider_kind='apikey_fun_images' AND adapter_id='apikey_fun_images_sse_v1' AND model='gpt-image-2')
  )
);
INSERT INTO generated_asset_provenance_v14 SELECT * FROM generated_asset_provenance;
DROP TABLE generated_asset_provenance;
DROP TABLE provider_image_invocations;
DROP TABLE provider_image_request_profiles;
DROP TABLE image_provider_configs;
ALTER TABLE image_provider_configs_v14 RENAME TO image_provider_configs;
ALTER TABLE provider_image_request_profiles_v14 RENAME TO provider_image_request_profiles;
ALTER TABLE provider_image_invocations_v14 RENAME TO provider_image_invocations;
ALTER TABLE generated_asset_provenance_v14 RENAME TO generated_asset_provenance;
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
