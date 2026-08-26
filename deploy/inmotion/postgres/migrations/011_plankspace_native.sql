-- Native PlankSpace storage. Append-only migration; safe to rerun.
CREATE TABLE IF NOT EXISTS plankspace_profiles (id bigserial PRIMARY KEY,wallet text NOT NULL UNIQUE,handle text NOT NULL UNIQUE,display_name text NOT NULL,bio text NOT NULL DEFAULT '',hobbies text NOT NULL DEFAULT '',interests text NOT NULL DEFAULT '',music text NOT NULL DEFAULT '',heroes text NOT NULL DEFAULT '',looking_to_meet text NOT NULL DEFAULT '',avatar_url text NOT NULL DEFAULT '',mood text NOT NULL DEFAULT 'feeling board',mood_text text NOT NULL DEFAULT 'holding down the lumberyard.',custom_html text NOT NULL DEFAULT '',theme_json text NOT NULL DEFAULT '{}',layout_json text NOT NULL DEFAULT '[]',featured_video text NOT NULL DEFAULT '',moderation_status text NOT NULL DEFAULT 'pending',moderation_note text NOT NULL DEFAULT '',created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_posts (id bigserial PRIMARY KEY,author text NOT NULL DEFAULT 'PLANK',author_wallet text NOT NULL DEFAULT '',body text NOT NULL,likes integer NOT NULL DEFAULT 0,moderation_status text NOT NULL DEFAULT 'approved',created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_comments (id bigserial PRIMARY KEY,post_id integer NOT NULL,author text NOT NULL DEFAULT 'Anonymous Board',body text NOT NULL,created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_profile_comments (id bigserial PRIMARY KEY,profile_handle text NOT NULL,author text NOT NULL DEFAULT 'Anonymous Board',author_wallet text NOT NULL DEFAULT '',body text NOT NULL,moderation_status text NOT NULL DEFAULT 'approved',created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_profile_relations (id bigserial PRIMARY KEY,owner_wallet text NOT NULL,target_handle text NOT NULL,kind text NOT NULL,rank integer NOT NULL DEFAULT 0,created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_wallet,target_handle,kind));
CREATE TABLE IF NOT EXISTS plankspace_friend_requests (id bigserial PRIMARY KEY,requester_wallet text NOT NULL,requester_handle text NOT NULL,recipient_wallet text NOT NULL,recipient_handle text NOT NULL,status text NOT NULL DEFAULT 'pending',created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(requester_wallet,recipient_wallet));
CREATE TABLE IF NOT EXISTS plankspace_post_likes (id bigserial PRIMARY KEY,post_id integer NOT NULL,wallet text NOT NULL,created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(post_id,wallet));
CREATE TABLE IF NOT EXISTS plankspace_moderation_logs (id bigserial PRIMARY KEY,profile_wallet text NOT NULL,status text NOT NULL,note text NOT NULL DEFAULT '',moderator_wallet text NOT NULL,created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_site_settings (key text PRIMARY KEY,value text NOT NULL,updated_by text NOT NULL DEFAULT '',updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_auth_challenges (nonce text PRIMARY KEY,wallet text NOT NULL,action text NOT NULL,resource text NOT NULL,payload_hash text NOT NULL,expires_at text NOT NULL);
CREATE TABLE IF NOT EXISTS plankspace_wallet_sessions (token_hash text PRIMARY KEY,wallet text NOT NULL,expires_at text NOT NULL,created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_notifications (id bigserial PRIMARY KEY,recipient_wallet text NOT NULL,actor_wallet text NOT NULL DEFAULT '',actor_handle text NOT NULL DEFAULT '',kind text NOT NULL,body text NOT NULL DEFAULT '',href text NOT NULL DEFAULT '/',read_at text,created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_board_messages (id bigserial PRIMARY KEY,sender_wallet text NOT NULL,sender_handle text NOT NULL,recipient_wallet text NOT NULL,recipient_handle text NOT NULL,subject text NOT NULL DEFAULT 'Board Mail',body text NOT NULL,read_at text,deleted_by_sender boolean NOT NULL DEFAULT false,deleted_by_recipient boolean NOT NULL DEFAULT false,created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_reports (id bigserial PRIMARY KEY,reporter_wallet text NOT NULL,target_type text NOT NULL,target_id text NOT NULL,reason text NOT NULL,status text NOT NULL DEFAULT 'open',resolution text NOT NULL DEFAULT '',created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_game_scores (id bigserial PRIMARY KEY,wallet text NOT NULL,handle text NOT NULL,score integer NOT NULL,created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plankspace_owner_access_attempts (fingerprint text PRIMARY KEY,attempts integer NOT NULL DEFAULT 0,window_started_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS plankspace_profiles_status_idx ON plankspace_profiles(moderation_status,updated_at);
CREATE INDEX IF NOT EXISTS plankspace_sessions_wallet_idx ON plankspace_wallet_sessions(wallet);
CREATE INDEX IF NOT EXISTS plankspace_notifications_wallet_idx ON plankspace_notifications(recipient_wallet,created_at);
INSERT INTO plankspace_site_settings(key,value) VALUES ('auto_approve_profiles','false') ON CONFLICT(key) DO NOTHING;

INSERT INTO plankspace_profiles(wallet,handle,display_name,bio,moderation_status) VALUES
('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','degenwaffle','DegenWaffle','All Things NeckBeard Punk, Plank, Planking, and making dope shit.','approved'),
('0x7304b78e28370f45fdf77ca67bdbbf550c3aac34','sawtoshiknotamoto','Sawtoshi Knotamoto','Life on the Planktation','approved'),
('0x725b9c03d07450a5d66fe5266a9a50dcccfa590f','bfl','BFL🍊','"What if I told you, it''s all just a meme?"','approved'),
('0x2bb7e2184b2dfc2595d6a8a557507bb763c4eb44','byronstyles','ByronStyles',E'$RTRD on Cronos | Sonic is, $DUMB on $S | XCH / Chia | PLANK''R on RH\nDoer of things and stuff on the intah-webs | Part-time shit poster','approved'),
('0x7558cd06f3f53391e50d093ee000266b685fc875','illl_umin8','illL_umiN8',E'shine in the dark so that they may see the light💡\n\nplacebo yourself appropriately👁️\n\npart builder, part dreamer, full TangTard - wandering somewhere in-between the space and time of the grove🍊\n\nhere to create, learn, build, experiment, laugh at the absurdity of it all, and hopefully leave this place a little better than I found it👊\n\nseeds in the dirt. code in the ether.\nchia growing. planks stacking. flame always lit❤️‍🔥\n\nstay curious. stay phunky. stay planked.🪵','approved'),
('0x8439bf8e1fdd160da268a89c397d0921a17043b4','generaldeez','GeneralDeez',E'Based ass OG! Ya betta axe somebody!\n\nRemember when you could do a little recreational cocain without the dear of dying?','approved'),
('0x471601f3071ce057b0ddd539dc0e0c78450e73f0','bullish0x','Bullish 0x','#TangGang | Opinions my own,  nothing here is financial advice.','approved'),
('0xf899f549aaf979d8e451d42c31c48a4e39ac59c9','aster_cast','aster_cast',E'lovecaster3000 | 🏠: @awizardxch |\n@aster0x | Comics, Cards, Seeds, Fish and Wood','approved'),
('0x70d50867373331acda3513fd353ec4d394f2331c','nazkhan','Naz Khan',E'The message has always been PLANK.LOVE\n#TangGang\n#9mmPro','approved'),
('0x72d0fd2f9cdd52905f8db816efba9cce8abf684d','imirowav','Imiro.wav','Tang Gang - The Grove','approved'),
('0x7a354040b3aeff974b7be38259d923fa0969ee1a','ibenpharmin','IbenPharmin',E'GenX | Content Creator | Decentralized Generation @OnTheBlokkchain #EnTRAPreneur\n@aWizardxch #HighCouncil #TangGang\nMeme what you say & Say what you meme..','approved')
ON CONFLICT(wallet) DO UPDATE SET handle=EXCLUDED.handle,display_name=EXCLUDED.display_name,bio=EXCLUDED.bio,moderation_status='approved',updated_at=CURRENT_TIMESTAMP;

UPDATE plankspace_profiles SET
  hobbies='Music, Gaming, Coding, Creating',
  interests='Music, Art, Family',
  music='Sturgill Simpson, Zach Bryan, Charles Wesley Godwin, Metallica',
  heroes='Orange Gooey, Jony 2x4, Plank',
  looking_to_meet='The 60 year old me.',
  avatar_url='/images/plank-logo.webp',
  mood='chillin''',
  mood_text='update mood',
  featured_video='https://www.youtube.com/watch?v=OklSZmIx9-o',
  theme_json='{"template":"lounge","pageBackground":"#24130b","panelBackground":"#f2dfbe","textColor":"#2b160d","linkColor":"#6e2b0e","headingColor":"#fff0cf","accentColor":"#e4862a","fontFamily":"Verdana","showTop8":true}',
  layout_json='["custom","mood","blurbs","video","feed","friends","comments","game"]',
  updated_at=CURRENT_TIMESTAMP
WHERE wallet='0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d';

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
ON CONFLICT(owner_wallet,target_handle,kind) DO UPDATE SET rank=EXCLUDED.rank;
