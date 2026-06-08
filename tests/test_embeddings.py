"""Tests for the semantic-embeddings foundation.

No real network calls: llm.embed_texts is replaced with a deterministic fake so that
identical text always yields the identical vector (cosine 1.0), which is all we need to
exercise storage, staleness detection, rebuild, search, and neighbours.
"""
import hashlib


# ── helpers ──────────────────────────────────────────────────────────────────
def fake_embed(texts, task_type="SEMANTIC_SIMILARITY"):
    """16-dim deterministic 'embedding': same text -> same vector, different text -> different."""
    out = []
    for t in texts:
        digest = hashlib.sha256((t or "").encode("utf-8")).digest()
        out.append([b / 255.0 for b in digest[:16]])
    return out


def enable_embeddings(monkeypatch):
    import llm
    monkeypatch.setattr(llm, "is_enabled", lambda: True)
    monkeypatch.setattr(llm, "embed_texts", fake_embed)


def get_csrf(client):
    return client.get("/api/me").get_json()["csrf_token"]


def login_admin(client):
    token = get_csrf(client)
    client.post("/api/admin/login", json={"username": "admin", "password": "admin"},
                headers={"X-CSRF-Token": token})
    return token


def add_tip(app_module, content, anecdote=""):
    with app_module.get_db() as conn:
        tid = conn.execute("INSERT INTO tips (content, anecdote) VALUES (?, ?)",
                           (content, anecdote)).lastrowid
        conn.commit()
        return tid


# ── migration / table ────────────────────────────────────────────────────────
def test_embeddings_migration_applied(app_module):
    with app_module.get_db() as conn:
        applied = [r["filename"] for r in conn.execute("SELECT filename FROM schema_migrations")]
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(tip_embeddings)")]
    assert "002_tip_embeddings.sql" in applied
    assert {"tip_id", "model", "dim", "content_hash", "vector"} <= set(cols)


# ── status + rebuild endpoints ───────────────────────────────────────────────
def test_status_requires_admin(client):
    assert client.get("/api/embeddings/status").status_code == 403


def test_rebuild_503_when_disabled(client):
    token = login_admin(client)
    r = client.post("/api/embeddings/rebuild", json={}, headers={"X-CSRF-Token": token})
    assert r.status_code == 503  # no API key in tests by default


def test_rebuild_embeds_all_tips(client, app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    add_tip(app_module, "Drink water in the morning")
    add_tip(app_module, "Save a little money each week")
    token = login_admin(client)

    before = client.get("/api/embeddings/status").get_json()
    assert before["enabled"] is True and before["embedded"] == 0 and before["stale"] == 2

    res = client.post("/api/embeddings/rebuild", json={}, headers={"X-CSRF-Token": token}).get_json()
    assert res["embedded"] == 2 and res["total"] == 2

    after = client.get("/api/embeddings/status").get_json()
    assert after["embedded"] == 2 and after["stale"] == 0
    # re-running is a no-op (nothing stale)
    again = client.post("/api/embeddings/rebuild", json={}, headers={"X-CSRF-Token": token}).get_json()
    assert again["embedded"] == 0


# ── similarity queries ───────────────────────────────────────────────────────
def test_search_ranks_exact_match_first(app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    import embeddings
    t1 = add_tip(app_module, "Drink water in the morning")
    add_tip(app_module, "Save a little money each week")
    add_tip(app_module, "Take the stairs not the lift")
    with app_module.get_db() as conn:
        embeddings.sync_all(conn)
        hits = embeddings.search(conn, "Drink water in the morning", k=3)
    assert hits[0]["tip_id"] == t1
    assert hits[0]["score"] == 1.0          # identical text -> cosine 1.0
    assert len(hits) == 3


def test_search_endpoint_disabled(client):
    # no API key in tests by default -> feature reports itself off, no results
    res = client.get("/api/tips/search?q=anything").get_json()
    assert res == {"enabled": False, "results": []}


def test_search_endpoint_ranks_and_scores(client, app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    import embeddings
    t1 = add_tip(app_module, "Drink water in the morning")
    add_tip(app_module, "Save a little money each week")
    with app_module.get_db() as conn:
        embeddings.sync_all(conn)
    res = client.get("/api/tips/search?q=Drink%20water%20in%20the%20morning").get_json()
    assert res["enabled"] is True
    assert res["results"][0]["id"] == t1
    assert res["results"][0]["similarity"] == 1.0
    assert "content" in res["results"][0] and "tags" in res["results"][0]


def test_neighbors_excludes_self(app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    import embeddings
    t1 = add_tip(app_module, "Drink water in the morning")
    add_tip(app_module, "Save a little money each week")
    with app_module.get_db() as conn:
        embeddings.sync_all(conn)
        nbrs = embeddings.neighbors(conn, t1, k=5)
    ids = [n["tip_id"] for n in nbrs]
    assert t1 not in ids and len(ids) == 1


# ── staleness + lifecycle ────────────────────────────────────────────────────
def test_related_endpoint(client, app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    import embeddings
    t1 = add_tip(app_module, "Drink water in the morning")
    t2 = add_tip(app_module, "Save a little money each week")
    with app_module.get_db() as conn:
        embeddings.sync_all(conn)
    res = client.get(f"/api/tips/{t1}/related").get_json()
    assert res["enabled"] is True
    ids = [r["tip_id"] for r in res["related"]]
    assert t1 not in ids and t2 in ids


def test_related_disabled(client, app_module):
    t1 = add_tip(app_module, "x")
    res = client.get(f"/api/tips/{t1}/related").get_json()
    assert res == {"enabled": False, "related": []}


def test_edit_marks_embedding_stale(app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    import embeddings
    tid = add_tip(app_module, "Original text")
    with app_module.get_db() as conn:
        embeddings.sync_all(conn)
        assert embeddings.status(conn)["stale"] == 0
        conn.execute("UPDATE tips SET content = ? WHERE id = ?", ("Changed text", tid))
        conn.commit()
        assert embeddings.status(conn)["stale"] == 1   # hash no longer matches


def test_deleting_tip_cascades_embedding(client, app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    import embeddings
    tid = add_tip(app_module, "Some tip to delete")
    with app_module.get_db() as conn:
        embeddings.sync_all(conn)
    token = login_admin(client)
    client.delete(f"/api/tips/{tid}", headers={"X-CSRF-Token": token})
    with app_module.get_db() as conn:
        row = conn.execute("SELECT 1 FROM tip_embeddings WHERE tip_id = ?", (tid,)).fetchone()
    assert row is None  # ON DELETE CASCADE removed the embedding too


# ── Ask-for-advice (RAG) ─────────────────────────────────────────────────────
def test_llm_advise_maps_used_numbers(monkeypatch):
    import llm
    monkeypatch.setattr(llm, "_call_gemini", lambda prompt: {"answer": "do it", "used": [1, 3, 99]})
    out = llm.advise("help me", [{"id": 10, "content": "a"}, {"id": 20, "content": "b"}, {"id": 30, "content": "c"}])
    assert out["answer"] == "do it"
    assert out["used"] == [10, 30]   # 1->10, 3->30; out-of-range 99 dropped


def test_advise_disabled(client):
    r = client.post("/api/advise", json={"situation": "x"}, headers={"X-CSRF-Token": get_csrf(client)})
    assert r.status_code == 503


def test_advise_requires_situation(client, monkeypatch):
    enable_embeddings(monkeypatch)
    r = client.post("/api/advise", json={"situation": "  "}, headers={"X-CSRF-Token": get_csrf(client)})
    assert r.status_code == 400


def test_advise_returns_grounded_answer(client, app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    import embeddings, llm
    add_tip(app_module, "Break big tasks into tiny steps")
    add_tip(app_module, "Drink water in the morning")
    with app_module.get_db() as conn:
        embeddings.sync_all(conn)
    monkeypatch.setattr(llm, "advise",
                        lambda situation, tips: {"answer": "Start small.", "used": [tips[0]["id"]]})
    r = client.post("/api/advise", json={"situation": "I feel overwhelmed by a big project"},
                    headers={"X-CSRF-Token": get_csrf(client)})
    assert r.status_code == 200
    data = r.get_json()
    assert data["answer"] == "Start small."
    assert data["used"] and len(data["used"]) == 1
    assert isinstance(data["tips"], list) and data["tips"]            # retrieved context returned
    assert "similarity" in data["tips"][0]


def test_create_tip_embeds_when_enabled(client, app_module, monkeypatch):
    enable_embeddings(monkeypatch)
    token = login_admin(client)
    r = client.post("/api/tips", json={"content": "Be kind to yourself", "tags": ["moral"]},
                    headers={"X-CSRF-Token": token})
    tip_id = r.get_json()["id"]
    with app_module.get_db() as conn:
        row = conn.execute("SELECT dim FROM tip_embeddings WHERE tip_id = ?", (tip_id,)).fetchone()
    assert row is not None and row["dim"] == 16   # embedded inline on create
