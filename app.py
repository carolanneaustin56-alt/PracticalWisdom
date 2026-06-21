from flask import Flask, request, jsonify, render_template, send_file
import sqlite3
import os

app = Flask(__name__)
DB = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "tips.db"))


def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript("""
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
        """)
        # Migration: add anecdote column to pre-existing tips tables.
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(tips)").fetchall()]
        if "anecdote" not in cols:
            conn.execute("ALTER TABLE tips ADD COLUMN anecdote TEXT DEFAULT ''")
        # Migration: add tier column to pre-existing tags tables (default primary).
        tag_cols = [r["name"] for r in conn.execute("PRAGMA table_info(tags)").fetchall()]
        if "tier" not in tag_cols:
            conn.execute("ALTER TABLE tags ADD COLUMN tier TEXT NOT NULL DEFAULT 'primary'")


def get_or_create_tag(conn, name, tier=None):
    """Return the tag id, creating it if needed.

    New tags default to 'primary'. If a tier is explicitly given, it is applied
    (also reclassifying an existing tag).
    """
    name = name.strip().lower()
    row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
    if row:
        if tier in ("primary", "secondary"):
            conn.execute("UPDATE tags SET tier = ? WHERE id = ?", (tier, row["id"]))
        return row["id"]
    cur = conn.execute(
        "INSERT INTO tags (name, tier) VALUES (?, ?)", (name, tier or "primary")
    )
    return cur.lastrowid


def will_have_primary(conn, tag_names):
    """True if attaching these tags would give the tip at least one primary tag.

    A name that doesn't exist yet counts as primary (new tags default to primary).
    Safe to call before any writes — it does not mutate.
    """
    for name in tag_names:
        name = name.strip().lower()
        if not name:
            continue
        row = conn.execute("SELECT tier FROM tags WHERE name = ?", (name,)).fetchone()
        if row is None or row["tier"] == "primary":
            return True
    return False


def tip_with_tags(conn, tip_id):
    tip = conn.execute("SELECT * FROM tips WHERE id = ?", (tip_id,)).fetchone()
    if not tip:
        return None
    tags = conn.execute(
        "SELECT t.name FROM tags t JOIN tip_tags tt ON t.id = tt.tag_id WHERE tt.tip_id = ?",
        (tip_id,),
    ).fetchall()
    return {
        "id": tip["id"],
        "content": tip["content"],
        "anecdote": tip["anecdote"] or "",
        "tags": [r["name"] for r in tags],
    }


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/tips")
def search_tips():
    tags_param = request.args.get("tags", "").strip()
    with get_db() as conn:
        if tags_param:
            tag_list = [t.strip().lower() for t in tags_param.split(",") if t.strip()]
            placeholders = ",".join("?" * len(tag_list))
            # tips that have ALL the requested tags
            rows = conn.execute(
                f"""
                SELECT t.id FROM tips t
                JOIN tip_tags tt ON t.id = tt.tip_id
                JOIN tags tg ON tt.tag_id = tg.id
                WHERE tg.name IN ({placeholders})
                GROUP BY t.id
                HAVING COUNT(DISTINCT tg.name) = ?
                ORDER BY t.created_at DESC
                """,
                (*tag_list, len(tag_list)),
            ).fetchall()
        else:
            rows = conn.execute("SELECT id FROM tips ORDER BY created_at DESC").fetchall()

        return jsonify([tip_with_tags(conn, r["id"]) for r in rows])


@app.post("/api/tips")
def create_tip():
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content is required"}), 400
    anecdote = (data.get("anecdote") or "").strip()
    tag_names = [t for t in data.get("tags", []) if t.strip()]

    with get_db() as conn:
        if not will_have_primary(conn, tag_names):
            return jsonify({"error": "Each tip needs at least one primary tag."}), 400
        cur = conn.execute(
            "INSERT INTO tips (content, anecdote) VALUES (?, ?)", (content, anecdote)
        )
        tip_id = cur.lastrowid
        for name in tag_names:
            tag_id = get_or_create_tag(conn, name)
            conn.execute(
                "INSERT OR IGNORE INTO tip_tags (tip_id, tag_id) VALUES (?, ?)", (tip_id, tag_id)
            )
        conn.commit()
        return jsonify(tip_with_tags(conn, tip_id)), 201


@app.put("/api/tips/<int:tip_id>")
def update_tip(tip_id):
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content is required"}), 400
    anecdote = (data.get("anecdote") or "").strip()

    with get_db() as conn:
        if not conn.execute("SELECT id FROM tips WHERE id = ?", (tip_id,)).fetchone():
            return jsonify({"error": "tip not found"}), 404
        conn.execute(
            "UPDATE tips SET content = ?, anecdote = ? WHERE id = ?",
            (content, anecdote, tip_id),
        )
        conn.commit()
        return jsonify(tip_with_tags(conn, tip_id))


@app.delete("/api/tips/<int:tip_id>")
def delete_tip(tip_id):
    with get_db() as conn:
        if not conn.execute("SELECT id FROM tips WHERE id = ?", (tip_id,)).fetchone():
            return jsonify({"error": "tip not found"}), 404
        conn.execute("DELETE FROM tips WHERE id = ?", (tip_id,))
        conn.commit()
        return jsonify({"deleted": tip_id})


@app.put("/api/tips/<int:tip_id>/tags")
def update_tags(tip_id):
    data = request.get_json(force=True)
    tag_names = [t.strip().lower() for t in data.get("tags", []) if t.strip()]

    with get_db() as conn:
        if not conn.execute("SELECT id FROM tips WHERE id = ?", (tip_id,)).fetchone():
            return jsonify({"error": "tip not found"}), 404
        if not will_have_primary(conn, tag_names):
            return jsonify({"error": "Each tip needs at least one primary tag."}), 400
        conn.execute("DELETE FROM tip_tags WHERE tip_id = ?", (tip_id,))
        for name in tag_names:
            tag_id = get_or_create_tag(conn, name)
            conn.execute(
                "INSERT OR IGNORE INTO tip_tags (tip_id, tag_id) VALUES (?, ?)", (tip_id, tag_id)
            )
        conn.commit()
        return jsonify(tip_with_tags(conn, tip_id))


def parse_batch(text):
    """Parse a stream of words into tips.

    Content words build up a tip; #tags attach to it. The first content word
    seen *after* a tag begins the next tip. Newlines are treated as spaces.

    e.g. "Drink water #health #morning Write goals #productivity" ->
         [("Drink water", ["health", "morning"]), ("Write goals", ["productivity"])]
    """
    tips = []
    content_words = []
    tags = []
    for word in text.split():
        if word.startswith("#"):
            if len(word) > 1:
                tags.append(word[1:].lower())
        else:
            if tags:  # a content word after tags starts a new tip
                tips.append((" ".join(content_words).strip(), tags))
                content_words, tags = [], []
            content_words.append(word)
    if content_words or tags:
        tips.append((" ".join(content_words).strip(), tags))
    return [(c, t) for c, t in tips if c]


@app.post("/api/tips/batch")
def batch_import():
    data = request.get_json(force=True)
    text = data.get("text", "")
    inserted = []
    skipped = 0

    with get_db() as conn:
        for content, tags in parse_batch(text):
            if not tags:
                skipped += 1  # no tags means no primary tag
                continue
            cur = conn.execute("INSERT INTO tips (content) VALUES (?)", (content,))
            tip_id = cur.lastrowid
            # First tag of a tip is primary; the rest are secondary.
            for i, name in enumerate(tags):
                tag_id = get_or_create_tag(conn, name, tier="primary" if i == 0 else "secondary")
                conn.execute(
                    "INSERT OR IGNORE INTO tip_tags (tip_id, tag_id) VALUES (?, ?)", (tip_id, tag_id)
                )
            inserted.append(tip_with_tags(conn, tip_id))
        conn.commit()

    return jsonify({"imported": len(inserted), "skipped": skipped, "tips": inserted}), 201


@app.get("/api/tags")
def list_tags():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT t.name, t.tier, COUNT(tt.tip_id) as count FROM tags t LEFT JOIN tip_tags tt ON t.id = tt.tag_id GROUP BY t.id ORDER BY t.name"
        ).fetchall()
        return jsonify(
            [{"name": r["name"], "tier": r["tier"], "count": r["count"]} for r in rows]
        )


@app.post("/api/tags/batch")
def import_tags():
    """Add tags to the allowed list from comma-separated text (no tip attached).

    Accepts an optional "tier" ('primary' or 'secondary', default 'primary').
    Existing tags are reclassified to the chosen tier.
    """
    data = request.get_json(force=True)
    text = data.get("text", "")
    tier = data.get("tier", "primary")
    if tier not in ("primary", "secondary"):
        tier = "primary"
    names = [t.replace("#", "").strip().lower() for t in text.split(",")]
    names = [n for n in names if n]

    added = 0
    with get_db() as conn:
        for name in names:
            existed = conn.execute("SELECT 1 FROM tags WHERE name = ?", (name,)).fetchone()
            get_or_create_tag(conn, name, tier=tier)
            if not existed:
                added += 1
        conn.commit()

    return jsonify({"added": added, "submitted": len(names), "tier": tier}), 201


_DOWNLOAD_TOKEN = os.environ.get("DOWNLOAD_TOKEN", "")


@app.get("/admin/download-db")
def download_db():
    token = request.args.get("token", "")
    if not _DOWNLOAD_TOKEN or token != _DOWNLOAD_TOKEN:
        return jsonify({"error": "forbidden"}), 403
    return send_file(DB, as_attachment=True, download_name="tips.db")


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5001)
