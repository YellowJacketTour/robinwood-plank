-- Additive defaults preserve beds and pending actions from the previous release.
-- Crop selection remains server-owned. Only Oran Berry is live; new crops require
-- an explicit future migration plus complete inventory, art and social support.
ALTER TABLE charmville_native_resources
 ADD COLUMN crop_id text NOT NULL DEFAULT 'oran-berry'
 CHECK (crop_id IN ('oran-berry'));
ALTER TABLE charmville_native_actions
 ADD COLUMN crop_id text NOT NULL DEFAULT 'oran-berry'
 CHECK (crop_id IN ('oran-berry'));
-- Do not rewrite payload_hash or result: legacy retries must remain identical.
