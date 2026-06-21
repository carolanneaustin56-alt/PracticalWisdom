-- Full-text search over tip content + anecdote, using SQLite's built-in FTS5 (no dependency).
--
-- This is an "external content" index (content='tips'): it doesn't duplicate the tip text, it
-- just indexes it and references tips by rowid (= tips.id). Triggers keep it in sync on every
-- insert / update / delete. The `porter` tokenizer adds light English stemming, so a search for
-- "running" also matches "run". Queries: SELECT rowid FROM tips_fts WHERE tips_fts MATCH ?.
CREATE VIRTUAL TABLE IF NOT EXISTS tips_fts USING fts5(
    content,
    anecdote,
    content='tips',
    content_rowid='id',
    tokenize='porter unicode61'
);

-- Backfill any tips that already exist (this migration runs once, recorded in schema_migrations).
INSERT INTO tips_fts(rowid, content, anecdote)
    SELECT id, content, COALESCE(anecdote, '') FROM tips;

-- Keep the index in sync with the tips table.
CREATE TRIGGER IF NOT EXISTS tips_fts_ai AFTER INSERT ON tips BEGIN
    INSERT INTO tips_fts(rowid, content, anecdote)
        VALUES (new.id, new.content, COALESCE(new.anecdote, ''));
END;
CREATE TRIGGER IF NOT EXISTS tips_fts_ad AFTER DELETE ON tips BEGIN
    INSERT INTO tips_fts(tips_fts, rowid, content, anecdote)
        VALUES ('delete', old.id, old.content, COALESCE(old.anecdote, ''));
END;
CREATE TRIGGER IF NOT EXISTS tips_fts_au AFTER UPDATE ON tips BEGIN
    INSERT INTO tips_fts(tips_fts, rowid, content, anecdote)
        VALUES ('delete', old.id, old.content, COALESCE(old.anecdote, ''));
    INSERT INTO tips_fts(rowid, content, anecdote)
        VALUES (new.id, new.content, COALESCE(new.anecdote, ''));
END;
