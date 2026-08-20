from __future__ import annotations

V15_SQL = """
CREATE TABLE shot_requirement_image_generation_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  request_id TEXT NOT NULL REFERENCES media_generation_requests(id),
  requirement_sha256 TEXT NOT NULL CHECK(requirement_sha256 GLOB 'sha256:*'),
  created_at TEXT NOT NULL,
  UNIQUE(shot_requirement_id, request_id)
);
CREATE TABLE shot_requirement_image_adoptions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  generation_link_id TEXT NOT NULL REFERENCES shot_requirement_image_generation_links(id),
  task_id TEXT NOT NULL REFERENCES media_generation_tasks(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  adoption_ordinal INTEGER NOT NULL CHECK(adoption_ordinal >= 1),
  previous_adoption_id TEXT NULL REFERENCES shot_requirement_image_adoptions(id),
  created_at TEXT NOT NULL,
  UNIQUE(shot_requirement_id, adoption_ordinal)
);
CREATE INDEX idx_shot_requirement_image_links_requirement_created
  ON shot_requirement_image_generation_links(shot_requirement_id, created_at DESC, id DESC);
CREATE INDEX idx_shot_requirement_image_links_request
  ON shot_requirement_image_generation_links(request_id, created_at DESC, id DESC);
CREATE INDEX idx_shot_requirement_image_adoptions_current
  ON shot_requirement_image_adoptions(shot_requirement_id, adoption_ordinal DESC);
CREATE TRIGGER shot_requirement_image_links_validate_insert
BEFORE INSERT ON shot_requirement_image_generation_links
WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN shot_lists sl ON sl.project_id=p.id
  JOIN shot_list_revisions sr ON sr.id=NEW.shot_list_revision_id
    AND sr.shot_list_id=sl.id AND sr.project_id=p.id
  JOIN shot_requirements req ON req.id=NEW.shot_requirement_id
    AND req.shot_list_revision_id=sr.id
  JOIN media_generation_requests request ON request.id=NEW.request_id
    AND request.project_id=p.id
  JOIN provider_image_request_profiles profile ON profile.request_id=request.id
  WHERE p.id=NEW.project_id
    AND p.status='active'
    AND sl.confirmed_revision_id=sr.id
    AND req.visual_kind='image'
    AND req.visual_source_asset_id IS NULL
    AND request.generation_kind='image'
    AND request.execution_mode='provider_image_v1'
    AND profile.provider_kind='apikey_fun_images'
    AND profile.adapter_id='apikey_fun_images_sse_v1'
    AND profile.capability='image_text_to_image'
    AND profile.protocol_version='1'
    AND profile.model='gpt-image-2'
)
BEGIN SELECT RAISE(ABORT,'invalid shot requirement image generation link'); END;
CREATE TRIGGER shot_requirement_image_links_no_update
BEFORE UPDATE ON shot_requirement_image_generation_links
BEGIN SELECT RAISE(ABORT,'shot requirement image generation links are immutable'); END;
CREATE TRIGGER shot_requirement_image_links_no_delete
BEFORE DELETE ON shot_requirement_image_generation_links
BEGIN SELECT RAISE(ABORT,'shot requirement image generation links are immutable'); END;
CREATE TRIGGER shot_requirement_image_adoptions_validate_insert
BEFORE INSERT ON shot_requirement_image_adoptions
WHEN NOT EXISTS (
  SELECT 1
  FROM shot_requirement_image_generation_links link
  JOIN shot_list_revisions revision ON revision.id=link.shot_list_revision_id
    AND revision.project_id=link.project_id
  JOIN shot_lists shot_list ON shot_list.id=revision.shot_list_id
    AND shot_list.project_id=link.project_id
  JOIN media_generation_tasks task ON task.id=NEW.task_id
    AND task.request_id=link.request_id
  JOIN assets asset ON asset.id=NEW.asset_id
    AND asset.id=task.output_asset_id
  JOIN generated_asset_provenance provenance ON provenance.asset_id=asset.id
    AND provenance.request_id=link.request_id
    AND provenance.task_id=task.id
  WHERE link.id=NEW.generation_link_id
    AND link.project_id=NEW.project_id
    AND link.shot_list_revision_id=NEW.shot_list_revision_id
    AND link.shot_requirement_id=NEW.shot_requirement_id
    AND shot_list.confirmed_revision_id=revision.id
    AND task.status='succeeded'
    AND asset.project_id=NEW.project_id
    AND asset.kind='image'
    AND asset.storage_mode='managed'
    AND asset.availability='available'
    AND (
      (NEW.adoption_ordinal=1 AND NEW.previous_adoption_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM shot_requirement_image_adoptions existing
         WHERE existing.shot_requirement_id=NEW.shot_requirement_id
       ))
      OR
      (NEW.adoption_ordinal>1 AND NEW.previous_adoption_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM shot_requirement_image_adoptions previous
         WHERE previous.id=NEW.previous_adoption_id
           AND previous.shot_requirement_id=NEW.shot_requirement_id
           AND previous.adoption_ordinal=NEW.adoption_ordinal-1
           AND previous.adoption_ordinal=(
             SELECT MAX(current.adoption_ordinal)
             FROM shot_requirement_image_adoptions current
             WHERE current.shot_requirement_id=NEW.shot_requirement_id
           )
       ))
    )
)
BEGIN SELECT RAISE(ABORT,'invalid shot requirement image adoption'); END;
CREATE TRIGGER shot_requirement_image_adoptions_no_update
BEFORE UPDATE ON shot_requirement_image_adoptions
BEGIN SELECT RAISE(ABORT,'shot requirement image adoptions are immutable'); END;
CREATE TRIGGER shot_requirement_image_adoptions_no_delete
BEFORE DELETE ON shot_requirement_image_adoptions
BEGIN SELECT RAISE(ABORT,'shot requirement image adoptions are immutable'); END;
"""  # noqa: E501
