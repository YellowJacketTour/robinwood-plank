-- Custody compatibility only. Does not grant stock or enable any social route.
ALTER TABLE charmville_receipts DROP CONSTRAINT IF EXISTS charmville_receipts_face_id_check;
ALTER TABLE charmville_receipts ADD CONSTRAINT charmville_receipts_face_id_check
 CHECK (face_id IN ('stalk','splinter','knock','hum','pith','gleam','knot','oran-berry','burning-heart'));
ALTER TABLE charmville_stamps DROP CONSTRAINT IF EXISTS charmville_stamps_face_id_check;
ALTER TABLE charmville_stamps ADD CONSTRAINT charmville_stamps_face_id_check
 CHECK (face_id IN ('stalk','splinter','oran-berry','burning-heart'));
