ALTER TABLE runs ADD COLUMN details TEXT;
ALTER TABLE runs ADD COLUMN requested_human_input TEXT;
ALTER TABLE runs ADD COLUMN review_outcome TEXT CHECK (review_outcome IN ('changes_requested', 'approved'));
ALTER TABLE runs ADD COLUMN artifact_markdown TEXT;
