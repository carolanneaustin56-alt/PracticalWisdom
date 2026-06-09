-- Community tip submissions with a moderation queue.
--
-- Pending submissions live in their OWN table, deliberately separate from `tips`, so unreviewed
-- content can never appear in search / FTS / the network / embeddings / advice. A submission only
-- becomes a real tip when an admin approves it (which inserts into `tips`, firing the FTS trigger
-- and the embedding hook). `tip_id` links an approved submission to the tip it created.
CREATE TABLE IF NOT EXISTS tip_submissions (
    id          INTEGER PRIMARY KEY,
    content     TEXT      NOT NULL,
    anecdote    TEXT      NOT NULL DEFAULT '',
    tags        TEXT      NOT NULL DEFAULT '',   -- comma-separated suggested tags (first = primary)
    user_id     INTEGER   REFERENCES users(id) ON DELETE SET NULL,
    status      TEXT      NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP,
    tip_id      INTEGER   REFERENCES tips(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON tip_submissions(status);
