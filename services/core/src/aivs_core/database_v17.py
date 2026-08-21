from __future__ import annotations

V17_SQL = """
CREATE TABLE shot_requirement_timeline_batch_assembly_previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  base_timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL CHECK(base_document_sha256 GLOB 'sha256:*'),
  at_index INTEGER NOT NULL CHECK(at_index >= 0),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 2 AND 24),
  proposed_document_sha256 TEXT NOT NULL CHECK(proposed_document_sha256 GLOB 'sha256:*'),
  preview_sha256 TEXT NOT NULL CHECK(preview_sha256 GLOB 'sha256:*'),
  clip_count_before INTEGER NOT NULL CHECK(clip_count_before >= 0),
  clip_count_after INTEGER NOT NULL CHECK(clip_count_after >= clip_count_before),
  shifted_clip_count INTEGER NOT NULL CHECK(shifted_clip_count >= 0),
  shifted_caption_count INTEGER NOT NULL CHECK(shifted_caption_count >= 0),
  duration_before_us INTEGER NOT NULL CHECK(duration_before_us >= 0),
  duration_after_us INTEGER NOT NULL CHECK(duration_after_us >= duration_before_us),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE shot_requirement_timeline_batch_assembly_preview_items (
  id TEXT PRIMARY KEY,
  batch_preview_id TEXT NOT NULL REFERENCES shot_requirement_timeline_batch_assembly_previews(id),
  item_index INTEGER NOT NULL CHECK(item_index BETWEEN 0 AND 23),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  adoption_id TEXT NOT NULL REFERENCES shot_requirement_image_adoptions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  proposed_clip_id TEXT NOT NULL UNIQUE,
  duration_us INTEGER NOT NULL CHECK(duration_us BETWEEN 500000 AND 30000000),
  layout TEXT NOT NULL CHECK(layout IN ('blurred_background','crop_fill','fit')),
  item_sha256 TEXT NOT NULL CHECK(item_sha256 GLOB 'sha256:*'),
  created_at TEXT NOT NULL,
  UNIQUE(batch_preview_id, item_index),
  UNIQUE(batch_preview_id, shot_requirement_id)
);
CREATE TABLE shot_requirement_timeline_batch_assemblies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  batch_preview_id TEXT NOT NULL UNIQUE
    REFERENCES shot_requirement_timeline_batch_assembly_previews(id),
  base_timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  output_timeline_revision_id TEXT NOT NULL UNIQUE REFERENCES timeline_revisions(id),
  proposed_document_sha256 TEXT NOT NULL CHECK(proposed_document_sha256 GLOB 'sha256:*'),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 2 AND 24),
  created_at TEXT NOT NULL
);
CREATE TABLE shot_requirement_timeline_batch_assembly_items (
  id TEXT PRIMARY KEY,
  batch_assembly_id TEXT NOT NULL REFERENCES shot_requirement_timeline_batch_assemblies(id),
  item_index INTEGER NOT NULL CHECK(item_index BETWEEN 0 AND 23),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  adoption_id TEXT NOT NULL REFERENCES shot_requirement_image_adoptions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  proposed_clip_id TEXT NOT NULL UNIQUE,
  duration_us INTEGER NOT NULL CHECK(duration_us BETWEEN 500000 AND 30000000),
  layout TEXT NOT NULL CHECK(layout IN ('blurred_background','crop_fill','fit')),
  created_at TEXT NOT NULL,
  UNIQUE(batch_assembly_id, item_index),
  UNIQUE(batch_assembly_id, shot_requirement_id),
  UNIQUE(batch_assembly_id, proposed_clip_id)
);
CREATE INDEX idx_stage6r_previews_project_created
  ON shot_requirement_timeline_batch_assembly_previews(project_id,created_at DESC,id DESC);
CREATE INDEX idx_stage6r_previews_timeline
  ON shot_requirement_timeline_batch_assembly_previews(base_timeline_revision_id,created_at DESC,id DESC);
CREATE INDEX idx_stage6r_preview_items_preview_index
  ON shot_requirement_timeline_batch_assembly_preview_items(batch_preview_id,item_index);
CREATE INDEX idx_stage6r_assemblies_project_created
  ON shot_requirement_timeline_batch_assemblies(project_id,created_at DESC,id DESC);
CREATE INDEX idx_stage6r_assembly_items_assembly_index
  ON shot_requirement_timeline_batch_assembly_items(batch_assembly_id,item_index);
CREATE TRIGGER stage6r_previews_validate_insert
BEFORE INSERT ON shot_requirement_timeline_batch_assembly_previews
WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN shot_list_revisions sr ON sr.id=NEW.shot_list_revision_id AND sr.project_id=p.id
  JOIN shot_lists sl ON sl.id=sr.shot_list_id AND sl.project_id=p.id
  JOIN timeline_revisions base ON base.id=NEW.base_timeline_revision_id
    AND base.project_id=p.id AND base.document_sha256=NEW.base_document_sha256
  WHERE p.id=NEW.project_id
    AND p.status='active'
    AND sl.confirmed_revision_id=sr.id
    AND p.current_timeline_revision_id=NEW.base_timeline_revision_id
    AND NOT EXISTS (SELECT 1 FROM timeline_drafts draft WHERE draft.project_id=p.id)
)
BEGIN SELECT RAISE(ABORT,'invalid stage6r batch preview'); END;
CREATE TRIGGER stage6r_previews_no_update
BEFORE UPDATE ON shot_requirement_timeline_batch_assembly_previews
BEGIN SELECT RAISE(ABORT,'stage6r batch previews are immutable'); END;
CREATE TRIGGER stage6r_previews_no_delete
BEFORE DELETE ON shot_requirement_timeline_batch_assembly_previews
BEGIN SELECT RAISE(ABORT,'stage6r batch previews are immutable'); END;
CREATE TRIGGER stage6r_preview_items_validate_insert
BEFORE INSERT ON shot_requirement_timeline_batch_assembly_preview_items
WHEN NOT EXISTS (
  SELECT 1
  FROM shot_requirement_timeline_batch_assembly_previews preview
  JOIN projects p ON p.id=preview.project_id
  JOIN shot_list_revisions sr ON sr.id=preview.shot_list_revision_id AND sr.project_id=p.id
  JOIN shot_lists sl ON sl.id=sr.shot_list_id AND sl.project_id=p.id
  JOIN shot_requirements req ON req.id=NEW.shot_requirement_id
    AND req.shot_list_revision_id=sr.id
  JOIN shot_requirement_image_adoptions adoption ON adoption.id=NEW.adoption_id
    AND adoption.project_id=p.id
    AND adoption.shot_list_revision_id=sr.id
    AND adoption.shot_requirement_id=req.id
    AND adoption.asset_id=NEW.asset_id
  JOIN assets asset ON asset.id=NEW.asset_id AND asset.project_id=p.id
  WHERE preview.id=NEW.batch_preview_id
    AND NEW.item_index=(
      SELECT COUNT(*) FROM shot_requirement_timeline_batch_assembly_preview_items existing
      WHERE existing.batch_preview_id=preview.id
    )
    AND NEW.item_index<preview.item_count
    AND p.status='active'
    AND sl.confirmed_revision_id=sr.id
    AND req.visual_kind='image'
    AND req.visual_source_asset_id IS NULL
    AND asset.kind='image'
    AND asset.storage_mode='managed'
    AND asset.availability='available'
)
BEGIN SELECT RAISE(ABORT,'invalid stage6r batch preview item'); END;
CREATE TRIGGER stage6r_preview_items_no_update
BEFORE UPDATE ON shot_requirement_timeline_batch_assembly_preview_items
BEGIN SELECT RAISE(ABORT,'stage6r batch preview items are immutable'); END;
CREATE TRIGGER stage6r_preview_items_no_delete
BEFORE DELETE ON shot_requirement_timeline_batch_assembly_preview_items
BEGIN SELECT RAISE(ABORT,'stage6r batch preview items are immutable'); END;
CREATE TRIGGER stage6r_assemblies_validate_insert
BEFORE INSERT ON shot_requirement_timeline_batch_assemblies
WHEN NOT EXISTS (
  SELECT 1
  FROM shot_requirement_timeline_batch_assembly_previews preview
  JOIN projects p ON p.id=preview.project_id
  JOIN shot_list_revisions sr ON sr.id=preview.shot_list_revision_id AND sr.project_id=p.id
  JOIN shot_lists sl ON sl.id=sr.shot_list_id AND sl.project_id=p.id
  JOIN timeline_revisions output ON output.id=NEW.output_timeline_revision_id
    AND output.project_id=p.id
    AND output.parent_revision_id=preview.base_timeline_revision_id
    AND output.document_sha256=preview.proposed_document_sha256
  WHERE preview.id=NEW.batch_preview_id
    AND NEW.project_id=preview.project_id
    AND NEW.shot_list_revision_id=preview.shot_list_revision_id
    AND NEW.base_timeline_revision_id=preview.base_timeline_revision_id
    AND NEW.proposed_document_sha256=preview.proposed_document_sha256
    AND NEW.item_count=preview.item_count
    AND preview.item_count=(
      SELECT COUNT(*) FROM shot_requirement_timeline_batch_assembly_preview_items item
      WHERE item.batch_preview_id=preview.id
    )
    AND p.status='active'
    AND sl.confirmed_revision_id=sr.id
    AND p.current_timeline_revision_id=output.id
    AND NOT EXISTS (SELECT 1 FROM timeline_drafts draft WHERE draft.project_id=p.id)
)
BEGIN SELECT RAISE(ABORT,'invalid stage6r batch assembly'); END;
CREATE TRIGGER stage6r_assemblies_no_update
BEFORE UPDATE ON shot_requirement_timeline_batch_assemblies
BEGIN SELECT RAISE(ABORT,'stage6r batch assemblies are immutable'); END;
CREATE TRIGGER stage6r_assemblies_no_delete
BEFORE DELETE ON shot_requirement_timeline_batch_assemblies
BEGIN SELECT RAISE(ABORT,'stage6r batch assemblies are immutable'); END;
CREATE TRIGGER stage6r_assembly_items_validate_insert
BEFORE INSERT ON shot_requirement_timeline_batch_assembly_items
WHEN NOT EXISTS (
  SELECT 1
  FROM shot_requirement_timeline_batch_assemblies batch
  JOIN shot_requirement_timeline_batch_assembly_previews preview
    ON preview.id=batch.batch_preview_id
  JOIN shot_requirement_timeline_batch_assembly_preview_items preview_item
    ON preview_item.batch_preview_id=preview.id
    AND preview_item.item_index=NEW.item_index
    AND preview_item.shot_requirement_id=NEW.shot_requirement_id
    AND preview_item.adoption_id=NEW.adoption_id
    AND preview_item.asset_id=NEW.asset_id
    AND preview_item.proposed_clip_id=NEW.proposed_clip_id
    AND preview_item.duration_us=NEW.duration_us
    AND preview_item.layout=NEW.layout
  WHERE batch.id=NEW.batch_assembly_id
    AND NEW.item_index=(
      SELECT COUNT(*) FROM shot_requirement_timeline_batch_assembly_items existing
      WHERE existing.batch_assembly_id=batch.id
    )
    AND NEW.item_index<batch.item_count
)
BEGIN SELECT RAISE(ABORT,'invalid stage6r batch assembly item'); END;
CREATE TRIGGER stage6r_assembly_items_no_update
BEFORE UPDATE ON shot_requirement_timeline_batch_assembly_items
BEGIN SELECT RAISE(ABORT,'stage6r batch assembly items are immutable'); END;
CREATE TRIGGER stage6r_assembly_items_no_delete
BEFORE DELETE ON shot_requirement_timeline_batch_assembly_items
BEGIN SELECT RAISE(ABORT,'stage6r batch assembly items are immutable'); END;
"""  # noqa: E501


