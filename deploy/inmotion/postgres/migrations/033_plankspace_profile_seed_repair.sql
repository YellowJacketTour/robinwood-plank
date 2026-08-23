-- Repair/seed the canonical PlankSpace profiles without overwriting owner edits.
-- This new migration is required because already-applied migration files are
-- never rerun when their contents change.
INSERT INTO plankspace_profiles(wallet,handle,display_name,bio,moderation_status) VALUES
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','degenwaffle','DegenWaffle','All Things NeckBeard Punk, Plank, Planking, and making dope shit.','approved'),
('0x7304b78e28370f45fdf77ca67bdbbf550c3aac34','sawtoshiknotamoto','Sawtoshi Knotamoto','Life on the Planktation','approved'),
('0x725b9c03d07450a5d66fe5266a9a50dcccfa590f','bfl','BFL🍊','"What if I told you, it''s all just a meme?"','approved'),
('0x2bb7e2184b2dfc2595d6a8a557507bb763c4eb44','byronstyles','ByronStyles',E'$RTRD on Cronos | Sonic is, $DUMB on $S | XCH / Chia | PLANK''R on RH\nDoer of things and stuff on the intah-webs | Part-time shit poster','approved'),
('0x7558cd06f3f53391e50d093ee000266b685fc875','illl_umin8','illL_umiN8',E'shine in the dark so that they may see the light💡\n\nplacebo yourself appropriately👁️\n\npart builder, part dreamer, full TangTard - wandering somewhere in-between the space and time of the grove🍊\n\nhere to create, learn, build, experiment, laugh at the absurdity of it all, and hopefully leave this place a little better than I found it👊\n\nseeds in the dirt. code in the ether.\nchia growing. planks stacking. flame always lit❤️‍🔥\n\nstay curious. stay phunky. stay planked.🪵','approved'),
('0x8439bf8e1fdd160da268a89c397d0921a17043b4','generaldeez','GeneralDeez',E'Based ass OG! Ya betta axe somebody!\n\nRemember when you could do a little recreational cocain without the dear of dying?','approved'),
('0x471601f3071ce057b0ddd539dc0e0c78450e73f0','bullish0x','Bullish 0x','#TangGang | Opinions my own, nothing here is financial advice.','approved'),
('0xf899f549aaf979d8e451d42c31c48a4e39ac59c9','aster_cast','aster_cast',E'lovecaster3000 | 🏠: @awizardxch |\n@aster0x | Comics, Cards, Seeds, Fish and Wood','approved'),
('0x70d50867373331acda3513fd353ec4d394f2331c','nazkhan','Naz Khan',E'The message has always been PLANK.LOVE\n#TangGang\n#9mmPro','approved'),
('0x72d0fd2f9cdd52905f8db816efba9cce8abf684d','imirowav','Imiro.wav','Tang Gang - The Grove','approved'),
('0x7a354040b3aeff974b7be38259d923fa0969ee1a','ibenpharmin','IbenPharmin',E'GenX | Content Creator | Decentralized Generation @OnTheBlokkchain #EnTRAPreneur\n@aWizardxch #HighCouncil #TangGang\nMeme what you say & Say what you meme..','approved')
ON CONFLICT DO NOTHING;

-- Only fill untouched/default fields. Never replace a profile owner's work.
UPDATE plankspace_profiles SET
  hobbies=CASE WHEN hobbies='' THEN 'Music, Gaming, Coding, Creating' ELSE hobbies END,
  interests=CASE WHEN interests='' THEN 'Music, Art, Family' ELSE interests END,
  music=CASE WHEN music='' THEN 'Sturgill Simpson, Zach Bryan, Charles Wesley Godwin, Metallica' ELSE music END,
  heroes=CASE WHEN heroes='' THEN 'Orange Gooey, Jony 2x4, Plank' ELSE heroes END,
  looking_to_meet=CASE WHEN looking_to_meet='' THEN 'The 60 year old me.' ELSE looking_to_meet END,
  avatar_url=CASE WHEN avatar_url='' OR avatar_url='/images/plank-logo.webp' THEN '/images/plankspace/degenwaffle.png' ELSE avatar_url END,
  featured_video=CASE WHEN featured_video='' THEN 'https://www.youtube.com/watch?v=OklSZmIx9-o' ELSE featured_video END,
  theme_json=CASE WHEN theme_json='{}' THEN '{"template":"lounge","pageBackground":"#24130b","panelBackground":"#f2dfbe","textColor":"#2b160d","linkColor":"#6e2b0e","headingColor":"#fff0cf","accentColor":"#e4862a","fontFamily":"Verdana","showTop8":true}' ELSE theme_json END,
  layout_json=CASE WHEN layout_json='[]' THEN '["custom","status","video","feed","friends","comments","game","about"]' ELSE layout_json END,
  moderation_status='approved'
WHERE wallet='0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d';

UPDATE plankspace_profiles SET moderation_status='approved'
WHERE wallet='0x7304b78e28370f45fdf77ca67bdbbf550c3aac34';

INSERT INTO plankspace_profile_relations(owner_wallet,target_handle,kind,rank)
SELECT p.wallet,'degenwaffle','friend',0 FROM plankspace_profiles p WHERE p.handle<>'degenwaffle' ON CONFLICT DO NOTHING;
INSERT INTO plankspace_profile_relations(owner_wallet,target_handle,kind,rank)
SELECT '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d',p.handle,'friend',0 FROM plankspace_profiles p WHERE p.handle<>'degenwaffle' ON CONFLICT DO NOTHING;
INSERT INTO plankspace_profile_relations(owner_wallet,target_handle,kind,rank)
SELECT p.wallet,'sawtoshiknotamoto','friend',0 FROM plankspace_profiles p WHERE p.handle<>'sawtoshiknotamoto' ON CONFLICT DO NOTHING;
INSERT INTO plankspace_profile_relations(owner_wallet,target_handle,kind,rank)
SELECT '0x7304b78e28370f45fdf77ca67bdbbf550c3aac34',p.handle,'friend',0 FROM plankspace_profiles p WHERE p.handle<>'sawtoshiknotamoto' ON CONFLICT DO NOTHING;

INSERT INTO plankspace_profile_relations(owner_wallet,target_handle,kind,rank) VALUES
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','sawtoshiknotamoto','top8',1),
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','bfl','top8',2),
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','byronstyles','top8',3),
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','illl_umin8','top8',4),
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','generaldeez','top8',5),
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','bullish0x','top8',6),
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','aster_cast','top8',7),
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','nazkhan','top8',8)
ON CONFLICT DO NOTHING;
