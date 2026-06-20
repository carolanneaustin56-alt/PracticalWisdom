-- Optional video attached to a tip, shown in the "further information" of a favourited tip.
-- Stores the raw URL an admin pastes (YouTube / Vimeo / Cloudflare Stream); the app derives the
-- embeddable player URL from it. FTS and embeddings don't index this column, so no trigger changes.
ALTER TABLE tips ADD COLUMN video_url TEXT NOT NULL DEFAULT '';
