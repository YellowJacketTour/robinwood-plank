-- Extend existing custody receipts; a pin consumes an owned Oran, never mints one.
ALTER TABLE charmville_receipts DROP CONSTRAINT IF EXISTS charmville_receipts_face_id_check;
ALTER TABLE charmville_receipts ADD CONSTRAINT charmville_receipts_face_id_check
 CHECK (face_id IN ('stalk','splinter','knock','hum','pith','gleam','knot','oran-berry'));
ALTER TABLE charmville_stamps DROP CONSTRAINT IF EXISTS charmville_stamps_face_id_check;
ALTER TABLE charmville_stamps ADD CONSTRAINT charmville_stamps_face_id_check
 CHECK (face_id IN ('stalk','splinter','oran-berry'));
