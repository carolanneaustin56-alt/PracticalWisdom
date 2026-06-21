"""Semantic embeddings for tips — the shared foundation for meaning-based features.

An *embedding* is a list of numbers (a vector) that captures the meaning of a piece of
text: two tips that say similar things get vectors that point in similar directions. Once
every tip has one, we can do things tag-matching can't — semantic search ("find tips about
staying calm"), a smarter "next suggested tip", and "these two tips are related" links.

Embeddings run on a small model **locally** via `fastembed` (no API key, no quota, fully
private). This is deliberately separate from llm.py (text generation, which uses Groq): the
two capabilities have different providers, so each degrades on its own.

Design notes:
  * Vectors are stored in the `tip_embeddings` table as packed float32 BLOBs, L2-normalised so
    cosine similarity is just a dot product (fast, no extra maths).
  * With a few hundred tips, a brute-force scan in pure Python is microseconds — no vector
    database needed. If the collection grows into the tens of thousands, this is the one spot
    to swap in an approximate-nearest-neighbour index.
  * If fastembed isn't installed, is_enabled() is False and the callers simply don't offer the
    semantic features.
"""
import array
import hashlib
import math
import os

import llm  # only for the shared LLMError type (keeps app.py's error handling uniform)

# A compact, good-quality sentence-embedding model (384 dims). Downloaded once (~130MB) and
# cached; the loaded model stays resident in the server process.
EMBED_MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-en-v1.5")
EMBED_DIM = 384

_model = None  # lazily loaded TextEmbedding instance


def _get_model():
    global _model
    if _model is None:
        try:
            from fastembed import TextEmbedding
        except ImportError as e:
            raise llm.LLMError("fastembed not installed (%s) — run: pip install fastembed" % e)
        _model = TextEmbedding(model_name=EMBED_MODEL)
    return _model


def is_enabled():
    """True when embeddings can be produced (i.e. fastembed is importable)."""
    try:
        import fastembed  # noqa: F401
        return True
    except ImportError:
        return False


def embed_texts(texts):
    """Embed a list of texts locally, returning a list of float vectors aligned with the input.

    Raises llm.LLMError on failure (so callers can handle it the same way as a remote call).
    """
    texts = list(texts)
    if not texts:
        return []
    try:
        model = _get_model()
        return [list(map(float, v)) for v in model.embed(texts)]
    except llm.LLMError:
        raise
    except Exception as e:  # fastembed / onnx runtime errors
        raise llm.LLMError("embedding failed: %s" % e)


# ── text → stored vector ────────────────────────────────────────────────────
def _text_for(content, anecdote):
    """The text we actually embed for a tip: its content, plus the anecdote if present."""
    parts = [(content or "").strip()]
    if anecdote and anecdote.strip():
        parts.append(anecdote.strip())
    return "\n".join(p for p in parts if p)


def content_hash(content, anecdote):
    """A fingerprint of a tip's text, so we can tell when an embedding has gone stale."""
    return hashlib.sha256(_text_for(content, anecdote).encode("utf-8")).hexdigest()


def _normalize(vec):
    """Scale a vector to unit length so that dot product == cosine similarity."""
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        return list(vec)
    return [x / norm for x in vec]


def _pack(vec):
    """Vector (list of floats) -> compact BLOB of float32s for storage."""
    return array.array("f", vec).tobytes()


def _unpack(blob):
    """BLOB -> list of floats."""
    a = array.array("f")
    a.frombytes(blob)
    return a.tolist()


def _upsert(conn, tip_id, content, anecdote, vector):
    """Store (or replace) one tip's normalised embedding. Does not commit."""
    norm = _normalize(vector)
    conn.execute(
        """INSERT INTO tip_embeddings (tip_id, model, dim, content_hash, vector, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(tip_id) DO UPDATE SET
             model=excluded.model, dim=excluded.dim, content_hash=excluded.content_hash,
             vector=excluded.vector, updated_at=CURRENT_TIMESTAMP""",
        (tip_id, EMBED_MODEL, len(norm), content_hash(content, anecdote), _pack(norm)),
    )


# ── populating / keeping fresh ───────────────────────────────────────────────
def store_one(conn, tip_id, content, anecdote=""):
    """Embed and store a single tip immediately. Raises llm.LLMError on failure.

    The embedding is computed first, so if it fails nothing is written (and the caller's own
    transaction is unaffected). Does not commit — the caller owns the transaction.
    """
    vec = embed_texts([_text_for(content, anecdote)])[0]
    _upsert(conn, tip_id, content, anecdote, vec)


def store_many(conn, rows):
    """Embed and store a specific list of tips in one batch. Does not commit.

    `rows` is an iterable of (tip_id, content, anecdote). Used after a batch import so the new
    tips are embedded together. Raises llm.LLMError on failure (callers wanting best-effort
    behaviour should catch it).
    """
    rows = list(rows)
    if not rows:
        return 0
    vectors = embed_texts([_text_for(c, a) for (_id, c, a) in rows])
    for (tip_id, content, anecdote), vec in zip(rows, vectors):
        _upsert(conn, tip_id, content, anecdote, vec)
    return len(rows)


def _stale_tips(conn):
    """Tips whose embedding is missing, out of date, or made by a different model."""
    have = {
        r["tip_id"]: (r["content_hash"], r["model"])
        for r in conn.execute("SELECT tip_id, content_hash, model FROM tip_embeddings")
    }
    todo = []
    for t in conn.execute("SELECT id, content, anecdote FROM tips"):
        current = content_hash(t["content"], t["anecdote"])
        existing = have.get(t["id"])
        if existing is None or existing[0] != current or existing[1] != EMBED_MODEL:
            todo.append((t["id"], t["content"], t["anecdote"] or ""))
    return todo


def sync_all(conn):
    """Embed every tip that needs it (missing/stale), in one batch. Commits when done.

    Returns a summary dict: {"embedded": n, "total": N, "model": ...}. Safe to call
    repeatedly — already-current tips are skipped, so re-running is cheap.
    """
    todo = _stale_tips(conn)
    total = conn.execute("SELECT COUNT(*) AS n FROM tips").fetchone()["n"]
    if not todo:
        return {"embedded": 0, "total": total, "model": EMBED_MODEL}
    vectors = embed_texts([_text_for(c, a) for (_id, c, a) in todo])
    for (tip_id, content, anecdote), vec in zip(todo, vectors):
        _upsert(conn, tip_id, content, anecdote, vec)
    conn.commit()
    return {"embedded": len(todo), "total": total, "model": EMBED_MODEL}


def remove(conn, tip_id):
    """Drop a tip's embedding. (Deleting the tip also cascades to this row.)"""
    conn.execute("DELETE FROM tip_embeddings WHERE tip_id = ?", (tip_id,))


def status(conn):
    """How populated the index is — for the admin 'rebuild embeddings' UI."""
    total = conn.execute("SELECT COUNT(*) AS n FROM tips").fetchone()["n"]
    embedded = conn.execute("SELECT COUNT(*) AS n FROM tip_embeddings").fetchone()["n"]
    return {
        "enabled": is_enabled(),
        "model": EMBED_MODEL,
        "dim": EMBED_DIM,
        "total": total,
        "embedded": embedded,
        "stale": len(_stale_tips(conn)) if is_enabled() else None,
    }


# ── similarity queries (no API call — embeddings are local) ──────────────────
def _load_vectors(conn, exclude_ids=()):
    """All stored (tip_id, normalised vector) pairs, minus any excluded ids."""
    exclude = set(exclude_ids)
    out = []
    for r in conn.execute("SELECT tip_id, vector FROM tip_embeddings"):
        if r["tip_id"] in exclude:
            continue
        out.append((r["tip_id"], _unpack(r["vector"])))
    return out


def _rank(query_vec, vectors, k):
    """Top-k (tip_id, score) by cosine similarity (= dot product, vectors are normalised)."""
    q = _normalize(query_vec)
    scored = [(tid, sum(a * b for a, b in zip(q, vec))) for tid, vec in vectors]
    scored.sort(key=lambda p: p[1], reverse=True)
    return [{"tip_id": tid, "score": round(score, 4)} for tid, score in scored[:k]]


def search(conn, query, k=10, exclude_ids=()):
    """Find the k tips most semantically similar to a free-text query.

    Embeds the query, then ranks stored tips by cosine similarity. Returns a list of
    {"tip_id", "score"}. Raises llm.LLMError if embedding the query fails.
    """
    if not (query or "").strip():
        return []
    query_vec = embed_texts([query])[0]
    return _rank(query_vec, _load_vectors(conn, exclude_ids), k)


def neighbors(conn, tip_id, k=10):
    """The k tips most similar to a given tip — using its stored vector (no embedding call)."""
    row = conn.execute("SELECT vector FROM tip_embeddings WHERE tip_id = ?", (tip_id,)).fetchone()
    if not row:
        return []
    return _rank(_unpack(row["vector"]), _load_vectors(conn, exclude_ids=(tip_id,)), k)
