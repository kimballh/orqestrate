ALTER TABLE runs ADD COLUMN assigned_branch TEXT;
ALTER TABLE runs ADD COLUMN pull_request_url TEXT;
ALTER TABLE runs ADD COLUMN pull_request_mode TEXT;
ALTER TABLE runs ADD COLUMN write_scope TEXT;
ALTER TABLE runs ADD COLUMN granted_capabilities_json TEXT;
