from __future__ import annotations

V16_SQL = """
CREATE TABLE shot_requirement_timeline_assembly_previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  adoption_id TEXT NOT NULL REFERENCES shot_requirement_image_adoptions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  base_timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL CHECK(base_document_sha256 GLOB 'sha256:*'),
  proposed_clip_id TEXT NOT NULL UNIQUE,
  at_index INTEGER NOT NULL CHECK(at_index >= 0),
  duration_us INTEGER NOT NULL CHECK(duration_us BETWEEN 500000 AND 30000000),
  layout TEXT NOT NULL CHECK(layout IN ('blurred_background','crop_fill','fit')),
  proposed_document_sha256 TEXT NOT NULL CHECK(proposed_document_sha256 GLOB 'sha256:*'),
  preview_sha256 TEXT NOT NULL CHECK(preview_sha256 GLOB 'sha256:*'),
  clip_count_before INTEGER NOT NULL CHECK(clip_count_before >= 0),
  shifted_clip_count INTEGER NOT NULL CHECK(shifted_clip_count >= 0),
  shifted_caption_count INTEGER NOT NULL CHECK(shifted_caption_count >= 0),
  duration_before_us INTEGER NOT NULL CHECK(duration_before_us >= 0),
  duration_after_us INTEGER NOT NULL CHECK(duration_after_us >= duration_before_us),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE shot_requirement_timeline_assemblies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  adoption_id TEXT NOT NULL REFERENCES shot_requirement_image_adoptions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  assembly_preview_id TEXT NOT NULL UNIQUE
    REFERENCES shot_requirement_timeline_assembly_previews(id),
  base_timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  output_timeline_revision_id TEXT NOT NULL UNIQUE REFERENCES timeline_revisions(id),
  proposed_clip_id TEXT NOT NULL UNIQUE,
  proposed_document_sha256 TEXT NOT NULL CHECK(proposed_document_sha256 GLOB 'sha256:*'),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_stage5_previews_requirement_created
  ON shot_requirement_timeline_assembly_previews(shot_requirement_id,created_at DESC,id DESC);
CREATE INDEX idx_stage5_previews_timeline
  ON shot_requirement_timeline_assembly_previews(base_timeline_revision_id,created_at DESC,id DESC);
CREATE INDEX idx_stage5_assemblies_requirement_created
  ON shot_requirement_timeline_assemblies(shot_requirement_id,created_at DESC,id DESC);
CREATE INDEX idx_stage5_assemblies_output_revision
  ON shot_requirement_timeline_assemblies(output_timeline_revision_id);
CREATE TRIGGER stage5_previews_validate_insert
BEFORE INSERT ON shot_requirement_timeline_assembly_previews
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  JOIN shot_list_revisions sr ON sr.id=NEW.shot_list_revision_id AND sr.project_id=p.id
  JOIN shot_lists sl ON sl.id=sr.shot_list_id AND sl.project_id=p.id
  JOIN shot_requirements req ON req.id=NEW.shot_requirement_id AND req.shot_list_revision_id=sr.id
  JOIN shot_requirement_image_adoptions adoption ON adoption.id=NEW.adoption_id
    AND adoption.project_id=p.id AND adoption.shot_list_revision_id=sr.id
    AND adoption.shot_requirement_id=req.id AND adoption.asset_id=NEW.asset_id
  JOIN assets asset ON asset.id=NEW.asset_id AND asset.project_id=p.id
  JOIN timeline_revisions base ON base.id=NEW.base_timeline_revision_id
    AND base.project_id=p.id AND base.document_sha256=NEW.base_document_sha256
  WHERE p.id=NEW.project_id AND p.status='active' AND sl.confirmed_revision_id=sr.id
    AND req.visual_kind='image' AND req.visual_source_asset_id IS NULL
    AND asset.kind='image' AND asset.storage_mode='managed' AND asset.availability='available'
)
BEGIN SELECT RAISE(ABORT,'invalid stage5 assembly preview'); END;
CREATE TRIGGER stage5_previews_no_update
BEFORE UPDATE ON shot_requirement_timeline_assembly_previews
BEGIN SELECT RAISE(ABORT,'stage5 assembly previews are immutable'); END;
CREATE TRIGGER stage5_previews_no_delete
BEFORE DELETE ON shot_requirement_timeline_assembly_previews
BEGIN SELECT RAISE(ABORT,'stage5 assembly previews are immutable'); END;
CREATE TRIGGER stage5_assemblies_validate_insert
BEFORE INSERT ON shot_requirement_timeline_assemblies
WHEN NOT EXISTS (
  SELECT 1 FROM shot_requirement_timeline_assembly_previews preview
  JOIN timeline_revisions output ON output.id=NEW.output_timeline_revision_id
    AND output.project_id=preview.project_id
    AND output.parent_revision_id=preview.base_timeline_revision_id
    AND output.document_sha256=preview.proposed_document_sha256
  WHERE preview.id=NEW.assembly_preview_id
    AND NEW.project_id=preview.project_id
    AND NEW.shot_list_revision_id=preview.shot_list_revision_id
    AND NEW.shot_requirement_id=preview.shot_requirement_id
    AND NEW.adoption_id=preview.adoption_id AND NEW.asset_id=preview.asset_id
    AND NEW.base_timeline_revision_id=preview.base_timeline_revision_id
    AND NEW.proposed_clip_id=preview.proposed_clip_id
    AND NEW.proposed_document_sha256=preview.proposed_document_sha256
)
BEGIN SELECT RAISE(ABORT,'invalid stage5 assembly'); END;
CREATE TRIGGER stage5_assemblies_no_update
BEFORE UPDATE ON shot_requirement_timeline_assemblies
BEGIN SELECT RAISE(ABORT,'stage5 assemblies are immutable'); END;
CREATE TRIGGER stage5_assemblies_no_delete
BEFORE DELETE ON shot_requirement_timeline_assemblies
BEGIN SELECT RAISE(ABORT,'stage5 assemblies are immutable'); END;
"""
