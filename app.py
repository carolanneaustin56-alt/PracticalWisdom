from flask import Flask, request, jsonify, render_template, session, redirect, url_for, make_response
from authlib.integrations.flask_client import OAuth
from functools import wraps
import sqlite3
import os

# Load GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SECRET_KEY from a local .env file
# (if present) so they persist across restarts without re-exporting them each time.
# Real environment variables still take precedence over .env values.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = Flask(__name__)
# Signs the session cookie that keeps a user logged in. Set a real value in production.
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")
DB = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "tips.db"))

# ── Google OAuth — only enabled when credentials are present, so the app still
# runs (just without login) until you set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. ──
oauth = OAuth(app)
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
AUTH_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
if AUTH_ENABLED:
    oauth.register(
        name="google",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def current_user_id():
    """The logged-in user's id, or None. Reads the signed session cookie."""
    return session.get("uid")


# ── Administrator login (separate from Google user login) ──
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")


def is_admin():
    return bool(session.get("is_admin"))


def admin_required(fn):
    """Block the endpoint unless the session is an administrator."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not is_admin():
            return jsonify({"error": "Administrator access required."}), 403
        return fn(*args, **kwargs)
    return wrapper


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
    # Vote tally for everyone; the current user's own vote + favorite status if logged in.
    score = conn.execute(
        "SELECT COALESCE(SUM(value), 0) AS s FROM votes WHERE tip_id = ?", (tip_id,)
    ).fetchone()["s"]
    my_vote = 0
    uid = current_user_id()
    if uid:
        v = conn.execute(
            "SELECT value FROM votes WHERE tip_id = ? AND user_id = ?", (tip_id, uid)
        ).fetchone()
        my_vote = v["value"] if v else 0
    favorited = my_vote == 1  # a tip is "favorited" exactly when the user has upvoted it
    return {
        "id": tip["id"],
        "content": tip["content"],
        "anecdote": tip["anecdote"] or "",
        "tags": [r["name"] for r in tags],
        "score": score,
        "my_vote": my_vote,
        "favorited": favorited,
    }


@app.get("/")
def index():
    # Never cache the page itself, so edits show up on a normal refresh.
    resp = make_response(render_template("index.html"))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/tips")
def search_tips():
    tags_param = request.args.get("tags", "").strip()
    favorites_only = request.args.get("favorites") == "1"
    uid = current_user_id()
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

        ids = [r["id"] for r in rows]
        if favorites_only:
            if not uid:
                return jsonify([])  # not signed in → no favorites
            fav = {r["tip_id"] for r in conn.execute(
                "SELECT tip_id FROM votes WHERE user_id = ? AND value = 1", (uid,)
            ).fetchall()}
            ids = [i for i in ids if i in fav]

        return jsonify([tip_with_tags(conn, i) for i in ids])


@app.post("/api/tips")
@admin_required
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
@admin_required
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
@admin_required
def delete_tip(tip_id):
    with get_db() as conn:
        if not conn.execute("SELECT id FROM tips WHERE id = ?", (tip_id,)).fetchone():
            return jsonify({"error": "tip not found"}), 404
        conn.execute("DELETE FROM tips WHERE id = ?", (tip_id,))
        conn.commit()
        return jsonify({"deleted": tip_id})


@app.put("/api/tips/<int:tip_id>/tags")
@admin_required
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
@admin_required
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


@app.delete("/api/tags/<name>")
@admin_required
def delete_tag(name):
    name = name.strip().lower()
    with get_db() as conn:
        row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        if not row:
            return jsonify({"error": "tag not found"}), 404
        affected = conn.execute(
            "SELECT COUNT(*) AS n FROM tip_tags WHERE tag_id = ?", (row["id"],)
        ).fetchone()["n"]
        conn.execute("DELETE FROM tags WHERE id = ?", (row["id"],))
        conn.commit()
        return jsonify({"deleted": name, "tips_affected": affected})


@app.post("/api/tags/batch")
@admin_required
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


# ──────────────────────── Auth & per-user actions ────────────────────────

@app.get("/api/me")
def api_me():
    """Who is logged in (or null), plus whether Google login is configured at all."""
    uid = current_user_id()
    user = None
    if uid:
        with get_db() as conn:
            u = conn.execute(
                "SELECT id, email, name, picture FROM users WHERE id = ?", (uid,)
            ).fetchone()
        if u:
            user = {"id": u["id"], "email": u["email"], "name": u["name"], "picture": u["picture"]}
        else:
            session.pop("uid", None)  # stale session (user row gone)
    return jsonify({"user": user, "auth_enabled": AUTH_ENABLED, "is_admin": is_admin()})


@app.post("/api/admin/login")
def admin_login():
    data = request.get_json(force=True) or {}
    if data.get("username") == ADMIN_USERNAME and data.get("password") == ADMIN_PASSWORD:
        session["is_admin"] = True
        return jsonify({"is_admin": True})
    return jsonify({"error": "Invalid administrator credentials."}), 401


@app.post("/api/admin/logout")
def admin_logout():
    session.pop("is_admin", None)
    return jsonify({"is_admin": False})


@app.get("/login")
def login():
    if not AUTH_ENABLED:
        return "Google login is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).", 503
    return oauth.google.authorize_redirect(url_for("auth_callback", _external=True))


@app.get("/auth/callback")
def auth_callback():
    if not AUTH_ENABLED:
        return redirect("/")
    token = oauth.google.authorize_access_token()  # exchanges code, verifies the ID token
    info = token.get("userinfo") or {}
    sub = info.get("sub")
    if not sub:
        return "Sign-in failed.", 400
    with get_db() as conn:
        row = conn.execute("SELECT id FROM users WHERE google_sub = ?", (sub,)).fetchone()
        if row:
            uid = row["id"]
            conn.execute(
                "UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?",
                (info.get("email"), info.get("name"), info.get("picture"), uid),
            )
        else:
            cur = conn.execute(
                "INSERT INTO users (google_sub, email, name, picture) VALUES (?, ?, ?, ?)",
                (sub, info.get("email"), info.get("name"), info.get("picture")),
            )
            uid = cur.lastrowid
        conn.commit()
    session["uid"] = uid
    return redirect("/")


@app.post("/logout")
def logout():
    session.pop("uid", None)
    return jsonify({"ok": True})


@app.post("/api/tips/<int:tip_id>/vote")
def vote_tip(tip_id):
    """Set the current user's vote to +1, -1, or 0 (0 removes it). Returns the updated tip."""
    uid = current_user_id()
    if not uid:
        return jsonify({"error": "Sign in to vote."}), 401
    value = (request.get_json(force=True) or {}).get("value", 0)
    if value not in (1, -1, 0):
        return jsonify({"error": "value must be 1, -1, or 0"}), 400
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM tips WHERE id = ?", (tip_id,)).fetchone():
            return jsonify({"error": "tip not found"}), 404
        if value == 0:
            conn.execute("DELETE FROM votes WHERE user_id = ? AND tip_id = ?", (uid, tip_id))
        else:
            conn.execute(
                """INSERT INTO votes (user_id, tip_id, value) VALUES (?, ?, ?)
                   ON CONFLICT(user_id, tip_id) DO UPDATE SET value = excluded.value""",
                (uid, tip_id, value),
            )
        conn.commit()
        return jsonify(tip_with_tags(conn, tip_id))


@app.get("/api/seen")
def get_seen():
    """Tip ids the current user has already visited (empty when not signed in)."""
    uid = current_user_id()
    if not uid:
        return jsonify({"seen": []})
    with get_db() as conn:
        rows = conn.execute("SELECT tip_id FROM seen_tips WHERE user_id = ?", (uid,)).fetchall()
    return jsonify({"seen": [r["tip_id"] for r in rows]})


@app.post("/api/tips/<int:tip_id>/seen")
def mark_seen(tip_id):
    """Record that the current user has visited this tip. No-op when not signed in."""
    uid = current_user_id()
    if not uid:
        return jsonify({"ok": False})
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO seen_tips (user_id, tip_id) VALUES (?, ?)", (uid, tip_id)
        )
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/seen/reset")
def reset_seen():
    """Clear the current user's visited history (so they can re-explore from scratch)."""
    uid = current_user_id()
    if uid:
        with get_db() as conn:
            conn.execute("DELETE FROM seen_tips WHERE user_id = ?", (uid,))
            conn.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5001)
