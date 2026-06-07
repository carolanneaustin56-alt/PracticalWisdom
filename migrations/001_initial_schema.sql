-- Baseline schema. Safe to run on an existing database (IF NOT EXISTS).
-- Future schema changes go in new files: 002_*.sql, 003_*.sql, ... (applied in order).

CREATE TABLE IF NOT EXISTS tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    anecdote TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    tier TEXT NOT NULL DEFAULT 'primary'
);

CREATE TABLE IF NOT EXISTS tip_tags (
    tip_id INTEGER NOT NULL REFERENCES tips(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (tip_id, tag_id)
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT,
    name TEXT,
    picture TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- one row per (user, tip); value is +1 or -1
CREATE TABLE IF NOT EXISTS votes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tip_id INTEGER NOT NULL REFERENCES tips(id) ON DELETE CASCADE,
    value INTEGER NOT NULL,
    PRIMARY KEY (user_id, tip_id)
);

CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tip_id INTEGER NOT NULL REFERENCES tips(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, tip_id)
);

-- tips a user has visited in the network, so the "next suggested tip"
-- never re-suggests them (persists across logout/login)
CREATE TABLE IF NOT EXISTS seen_tips (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tip_id INTEGER NOT NULL REFERENCES tips(id) ON DELETE CASCADE,
    seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, tip_id)
);
