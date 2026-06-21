-- Semantic embeddings for tips (the foundation for semantic search, the recommender,
-- and similarity links in the network view).
--
-- One row per tip. The vector is stored as a BLOB of packed float32s, already L2-normalised
-- so cosine similarity is just a dot product. `content_hash` lets us detect when a tip's text
-- changed and the embedding needs refreshing. ON DELETE CASCADE cleans up when a tip is
-- removed (the app opens connections with PRAGMA foreign_keys = ON, so this is enforced).
CREATE TABLE IF NOT EXISTS tip_embeddings (
    tip_id       INTEGER PRIMARY KEY REFERENCES tips(id) ON DELETE CASCADE,
    model        TEXT      NOT NULL,
    dim          INTEGER   NOT NULL,
    content_hash TEXT      NOT NULL,
    vector       BLOB      NOT NULL,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
