-- Committed scenery is separate from crop revisions and balances.
-- Unsaved layout edits remain client drafts; conflicting commits are rejected.
ALTER TABLE charmville_yards ADD COLUMN IF NOT EXISTS layout_revision BIGINT NOT NULL DEFAULT 0 CHECK (layout_revision>=0);
ALTER TABLE charmville_yards ADD COLUMN IF NOT EXISTS decorations JSONB;
ALTER TABLE charmville_receipts DROP CONSTRAINT IF EXISTS charmville_receipts_action_check;
ALTER TABLE charmville_receipts ADD CONSTRAINT charmville_receipts_action_check
  CHECK (action IN ('claim','plant','harvest','compost','stamp','tend','layout'));
