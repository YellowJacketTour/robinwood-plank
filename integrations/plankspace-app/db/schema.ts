import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

export const posts = pgTable("plankspace_posts", {
  id: serial("id").primaryKey(),
  author: text("author").notNull().default("PLANK"),
  authorWallet: text("author_wallet").notNull().default(""),
  body: text("body").notNull(),
  likes: integer("likes").notNull().default(0),
  moderationStatus: text("moderation_status").notNull().default("approved"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const comments = pgTable("plankspace_comments", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull(),
  author: text("author").notNull().default("Anonymous Board"),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const profileComments = pgTable("plankspace_profile_comments", {
  id: serial("id").primaryKey(),
  profileHandle: text("profile_handle").notNull(),
  author: text("author").notNull().default("Anonymous Board"),
  authorWallet: text("author_wallet").notNull().default(""),
  body: text("body").notNull(),
  moderationStatus: text("moderation_status").notNull().default("approved"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
},table=>[index("profile_comments_handle_idx").on(table.profileHandle),index("profile_comments_author_time_idx").on(table.authorWallet,table.createdAt)]);

export const profileRelations = pgTable("plankspace_profile_relations", {
  id: serial("id").primaryKey(),
  ownerWallet: text("owner_wallet").notNull(),
  targetHandle: text("target_handle").notNull(),
  kind: text("kind").notNull(),
  rank: integer("rank").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
},table=>[uniqueIndex("profile_relations_unique").on(table.ownerWallet,table.targetHandle,table.kind)]);

export const friendRequests = pgTable("plankspace_friend_requests", {
  id: serial("id").primaryKey(),
  requesterWallet: text("requester_wallet").notNull(),
  requesterHandle: text("requester_handle").notNull(),
  recipientWallet: text("recipient_wallet").notNull(),
  recipientHandle: text("recipient_handle").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
},table=>[
  uniqueIndex("friend_requests_pair_unique").on(table.requesterWallet,table.recipientWallet),
  index("friend_requests_recipient_idx").on(table.recipientWallet,table.status,table.createdAt),
]);

export const postLikes = pgTable("plankspace_post_likes", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull(),
  wallet: text("wallet").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
},table=>[uniqueIndex("post_likes_unique").on(table.postId,table.wallet)]);

export const moderationLogs = pgTable("plankspace_moderation_logs", {
  id: serial("id").primaryKey(),
  profileWallet: text("profile_wallet").notNull(),
  status: text("status").notNull(),
  note: text("note").notNull().default(""),
  moderatorWallet: text("moderator_wallet").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const siteSettings = pgTable("plankspace_site_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const profiles = pgTable("plankspace_profiles", {
  id: serial("id").primaryKey(),
  wallet: text("wallet").notNull().unique(),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  bio: text("bio").notNull().default(""),
  hobbies: text("hobbies").notNull().default(""),
  interests: text("interests").notNull().default(""),
  music: text("music").notNull().default(""),
  heroes: text("heroes").notNull().default(""),
  lookingToMeet: text("looking_to_meet").notNull().default(""),
  avatarUrl: text("avatar_url").notNull().default(""),
  mood: text("mood").notNull().default("feeling board"),
  moodText: text("mood_text").notNull().default("holding down the lumberyard."),
  customHtml: text("custom_html").notNull().default(""),
  themeJson: text("theme_json").notNull().default("{}"),
  layoutJson: text("layout_json").notNull().default("[]"),
  featuredVideo: text("featured_video").notNull().default(""),
  moderationStatus: text("moderation_status").notNull().default("pending"),
  moderationNote: text("moderation_note").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const authChallenges = pgTable("plankspace_auth_challenges", {
  nonce: text("nonce").primaryKey(),
  wallet: text("wallet").notNull(),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  payloadHash: text("payload_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
},table=>[index("auth_challenges_wallet_idx").on(table.wallet),index("auth_challenges_expiry_idx").on(table.expiresAt)]);

export const walletSessions = pgTable("plankspace_wallet_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  wallet: text("wallet").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  index("wallet_sessions_wallet_idx").on(table.wallet),
  index("wallet_sessions_expiry_idx").on(table.expiresAt),
]);

export const notifications = pgTable("plankspace_notifications", {
  id: serial("id").primaryKey(),
  recipientWallet: text("recipient_wallet").notNull(),
  actorWallet: text("actor_wallet").notNull().default(""),
  actorHandle: text("actor_handle").notNull().default(""),
  kind: text("kind").notNull(),
  body: text("body").notNull().default(""),
  href: text("href").notNull().default("/"),
  readAt: text("read_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
},table=>[index("notifications_recipient_idx").on(table.recipientWallet,table.createdAt)]);

export const boardMessages = pgTable("plankspace_board_messages", {
  id: serial("id").primaryKey(),
  senderWallet: text("sender_wallet").notNull(),
  senderHandle: text("sender_handle").notNull(),
  recipientWallet: text("recipient_wallet").notNull(),
  recipientHandle: text("recipient_handle").notNull(),
  subject: text("subject").notNull().default("Board Mail"),
  body: text("body").notNull(),
  readAt: text("read_at"),
  deletedBySender: boolean("deleted_by_sender").notNull().default(false),
  deletedByRecipient: boolean("deleted_by_recipient").notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
},table=>[index("board_messages_recipient_idx").on(table.recipientWallet,table.createdAt),index("board_messages_sender_idx").on(table.senderWallet,table.createdAt)]);

export const reports = pgTable("plankspace_reports", {
  id: serial("id").primaryKey(),
  reporterWallet: text("reporter_wallet").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"),
  resolution: text("resolution").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
},table=>[index("reports_status_idx").on(table.status,table.createdAt)]);

export const gameScores = pgTable("plankspace_game_scores", {
  id: serial("id").primaryKey(),
  wallet: text("wallet").notNull(),
  handle: text("handle").notNull(),
  score: integer("score").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
},table=>[index("game_scores_score_idx").on(table.score)]);

export const ownerAccessAttempts = pgTable("plankspace_owner_access_attempts", {
  fingerprint: text("fingerprint").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  windowStartedAt: text("window_started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
