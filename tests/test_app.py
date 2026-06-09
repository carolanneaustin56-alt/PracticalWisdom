"""End-to-end tests for the Practical Wisdom API.

These formalise the checks done by hand throughout development: auth, CSRF, admin
gating, voting/favourites, the batch preview→commit flow, visited memory, and tags.
"""


# ── helpers ────────────────────────────────────────────────────────────────
def get_csrf(client):
    return client.get("/api/me").get_json()["csrf_token"]


def login_admin(client):
    token = get_csrf(client)
    r = client.post("/api/admin/login", json={"username": "admin", "password": "admin"},
                    headers={"X-CSRF-Token": token})
    assert r.status_code == 200
    return token


def make_user(app_module, sub="u1", email="u@example.com", name="User"):
    with app_module.get_db() as conn:
        conn.execute("INSERT OR IGNORE INTO users (google_sub, email, name) VALUES (?,?,?)",
                     (sub, email, name))
        conn.commit()
        return conn.execute("SELECT id FROM users WHERE google_sub=?", (sub,)).fetchone()["id"]


def login_user(client, uid):
    with client.session_transaction() as s:
        s["uid"] = uid
    return get_csrf(client)


def add_tip(app_module, content="A tip", tags=("moral",)):
    with app_module.get_db() as conn:
        tid = conn.execute("INSERT INTO tips (content) VALUES (?)", (content,)).lastrowid
        for i, name in enumerate(tags):
            tag_id = app_module.get_or_create_tag(conn, name, tier="primary" if i == 0 else "secondary")
            conn.execute("INSERT OR IGNORE INTO tip_tags (tip_id, tag_id) VALUES (?,?)", (tid, tag_id))
        conn.commit()
        return tid


# ── tests ──────────────────────────────────────────────────────────────────
def test_index_serves_static(client):
    r = client.get("/")
    assert r.status_code == 200
    assert b"/static/app.js" in r.data
    assert b"/static/styles.css" in r.data


def test_parse_batch_unit(app_module):
    parsed = app_module.parse_batch("Drink water #health #morning Write goals #focus")
    assert parsed == [("Drink water", ["health", "morning"]), ("Write goals", ["focus"])]


def test_parse_batch_one_tip_per_line(app_module):
    # plain (untagged) tips split one-per-line; inline tags still work
    parsed = app_module.parse_batch("Tip one\nTip two #focus\nTip three")
    assert parsed == [("Tip one", []), ("Tip two", ["focus"]), ("Tip three", [])]


def test_migrations_recorded(app_module):
    with app_module.get_db() as conn:
        applied = [r["filename"] for r in conn.execute("SELECT filename FROM schema_migrations")]
    assert "001_initial_schema.sql" in applied


def test_api_me_anonymous(client):
    data = client.get("/api/me").get_json()
    assert data["user"] is None
    assert data["is_admin"] is False
    assert data["auth_enabled"] is False
    assert data["csrf_token"]


def test_csrf_required(client):
    # POST without the token is rejected
    assert client.post("/api/admin/login",
                       json={"username": "admin", "password": "admin"}).status_code == 400


def test_admin_login_logout(client):
    token = get_csrf(client)
    assert client.post("/api/admin/login", json={"username": "admin", "password": "nope"},
                       headers={"X-CSRF-Token": token}).status_code == 401
    assert client.post("/api/admin/login", json={"username": "admin", "password": "admin"},
                       headers={"X-CSRF-Token": token}).status_code == 200
    assert client.get("/api/me").get_json()["is_admin"] is True
    client.post("/api/admin/logout", json={}, headers={"X-CSRF-Token": token})
    assert client.get("/api/me").get_json()["is_admin"] is False


def test_admin_rate_limit(client):
    token = get_csrf(client)
    codes = [client.post("/api/admin/login", json={"username": "admin", "password": "x"},
                         headers={"X-CSRF-Token": token}).status_code for _ in range(6)]
    assert codes == [401, 401, 401, 401, 401, 429]


def test_mutations_require_admin(client):
    token = get_csrf(client)
    r = client.post("/api/tips", json={"content": "x", "tags": ["moral"]},
                    headers={"X-CSRF-Token": token})
    assert r.status_code == 403


def test_create_and_list_tip(client):
    token = login_admin(client)
    r = client.post("/api/tips", json={"content": "Be kind", "tags": ["moral", "gratitude"]},
                    headers={"X-CSRF-Token": token})
    assert r.status_code == 201
    tip = r.get_json()
    assert tip["content"] == "Be kind"
    assert set(tip["tags"]) == {"moral", "gratitude"}
    assert tip["score"] == 0 and tip["my_vote"] == 0
    assert any(t["content"] == "Be kind" for t in client.get("/api/tips").get_json())


def test_create_tip_requires_primary(client):
    token = login_admin(client)
    # make 'focus' an existing SECONDARY tag, then a tip with only it must be rejected
    client.post("/api/tags/batch", json={"text": "focus", "tier": "secondary"},
                headers={"X-CSRF-Token": token})
    r = client.post("/api/tips", json={"content": "x", "tags": ["focus"]},
                    headers={"X-CSRF-Token": token})
    assert r.status_code == 400


def test_vote_and_favorite(client, app_module):
    tid = add_tip(app_module, "Tip", ["moral"])
    uid = make_user(app_module)
    token = login_user(client, uid)
    # voting needs the CSRF token too
    assert client.post(f"/api/tips/{tid}/vote", json={"value": 1}).status_code == 400
    up = client.post(f"/api/tips/{tid}/vote", json={"value": 1},
                     headers={"X-CSRF-Token": token}).get_json()
    assert up["score"] == 1 and up["my_vote"] == 1 and up["favorited"] is True
    # favourites filter == upvoted tips
    favs = client.get("/api/tips?favorites=1").get_json()
    assert [t["id"] for t in favs] == [tid]
    # clearing the vote removes the favourite
    cleared = client.post(f"/api/tips/{tid}/vote", json={"value": 0},
                          headers={"X-CSRF-Token": token}).get_json()
    assert cleared["score"] == 0 and cleared["favorited"] is False
    assert client.get("/api/tips?favorites=1").get_json() == []


def test_batch_preview_then_commit(client):
    token = login_admin(client)
    before = len(client.get("/api/tips").get_json())
    prev = client.post("/api/tips/batch/preview", json={"text": "Walk daily #physical #habit"},
                       headers={"X-CSRF-Token": token}).get_json()
    assert prev["tips"] == [{"content": "Walk daily", "tags": ["physical", "habit"]}]
    assert len(client.get("/api/tips").get_json()) == before   # preview inserts nothing
    res = client.post("/api/tips/batch/commit",
                      json={"tips": [{"content": "Walk daily", "tags": ["physical", "habit"]}]},
                      headers={"X-CSRF-Token": token}).get_json()
    assert res["imported"] == 1
    assert len(client.get("/api/tips").get_json()) == before + 1


def test_seen_persistence(client, app_module):
    tid = add_tip(app_module, "T", ["moral"])
    uid = make_user(app_module)
    token = login_user(client, uid)
    assert client.get("/api/seen").get_json()["seen"] == []
    client.post(f"/api/tips/{tid}/seen", json={}, headers={"X-CSRF-Token": token})
    assert tid in client.get("/api/seen").get_json()["seen"]
    client.post("/api/seen/reset", json={}, headers={"X-CSRF-Token": token})
    assert client.get("/api/seen").get_json()["seen"] == []


def test_tags_import_and_delete(client):
    token = login_admin(client)
    client.post("/api/tags/batch", json={"text": "focus, clarity", "tier": "secondary"},
                headers={"X-CSRF-Token": token})
    names = {t["name"] for t in client.get("/api/tags").get_json()}
    assert {"focus", "clarity"} <= names
    client.delete("/api/tags/focus", headers={"X-CSRF-Token": token})
    assert "focus" not in {t["name"] for t in client.get("/api/tags").get_json()}


def test_tag_filter(client, app_module):
    add_tip(app_module, "Money tip", ["financial", "discipline"])
    add_tip(app_module, "Body tip", ["physical", "rest"])
    only_financial = client.get("/api/tips?tags=financial").get_json()
    assert [t["content"] for t in only_financial] == ["Money tip"]


# ── LLM tag suggestions (no real network calls — Gemini is mocked) ──
def test_llm_disabled_by_default(client):
    assert client.get("/api/me").get_json()["llm_enabled"] is False


def test_suggest_tags_503_when_not_configured(client):
    token = login_admin(client)
    r = client.post("/api/llm/suggest-tags", json={"contents": ["Drink water"]},
                    headers={"X-CSRF-Token": token})
    assert r.status_code == 503


def test_suggest_tags_batch_filters_to_allowed(monkeypatch):
    import llm
    monkeypatch.setattr(llm, "_complete_json", lambda prompt: {"tips": [
        {"primary": "physical", "secondary": ["habit", "notatag", "morning"]},
        {"primary": "notreal", "secondary": ["focus"]},
    ]})
    out = llm.suggest_tags_batch(
        ["Drink water", "Plan your day"],
        primary_tags=["physical", "achievement"],
        secondary_tags=["habit", "morning", "focus"],
    )
    assert out[0] == {"primary": "physical", "secondary": ["habit", "morning"]}  # dropped 'notatag'
    assert out[1] == {"primary": None, "secondary": ["focus"]}                    # dropped invalid primary


def test_suggest_tags_endpoint_with_mock(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module.llm, "is_enabled", lambda: True)
    monkeypatch.setattr(app_module.llm, "suggest_tags_batch",
                        lambda contents, p, s, **k: [{"primary": "moral", "secondary": ["courage"]}
                                                     for _ in contents])
    with app_module.get_db() as conn:
        conn.execute("INSERT OR IGNORE INTO tags (name, tier) VALUES ('moral', 'primary')")
        conn.execute("INSERT OR IGNORE INTO tags (name, tier) VALUES ('courage', 'secondary')")
        conn.commit()
    token = login_admin(client)
    r = client.post("/api/llm/suggest-tags", json={"contents": ["Be brave"]},
                    headers={"X-CSRF-Token": token})
    assert r.status_code == 200
    assert r.get_json()["suggestions"] == [{"primary": "moral", "secondary": ["courage"]}]


# ── Favourites insights (AI reflection on saved tips) ──
def _favorite(client, app_module, token, n, uid):
    """Create n tips and have the logged-in user upvote (favourite) each. Returns their ids."""
    ids = []
    for i in range(n):
        tid = add_tip(app_module, "Fav tip %d" % i, ["moral"])
        client.post(f"/api/tips/{tid}/vote", json={"value": 1}, headers={"X-CSRF-Token": token})
        ids.append(tid)
    return ids


def test_reflect_on_favorites_parsing(monkeypatch):
    import llm
    monkeypatch.setattr(llm, "_complete_json", lambda p, temperature=0.2: {
        "pattern": "  Most picks are about starting, not finishing.  ",
        "questions": ["What actually stops you starting?", "", None],
        "experiments": ["Try a 2-minute start", {"title": "Mornings", "detail": "do it first"}],
    })
    out = llm.reflect_on_favorites([{"content": "c", "tags": ["t"]}], library_size=200)
    assert out["pattern"] == "Most picks are about starting, not finishing."
    assert out["questions"] == ["What actually stops you starting?"]              # blanks/None dropped
    assert out["experiments"] == ["Try a 2-minute start", "Mornings — do it first"]  # dict normalised


def test_favorites_insights_requires_login(client):
    r = client.post("/api/favorites/insights", json={}, headers={"X-CSRF-Token": get_csrf(client)})
    assert r.status_code == 401


def test_favorites_insights_503_without_key(client, app_module):
    uid = make_user(app_module)
    token = login_user(client, uid)
    r = client.post("/api/favorites/insights", json={}, headers={"X-CSRF-Token": token})
    assert r.status_code == 503  # no key configured in tests


def test_favorites_insights_needs_three(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module.llm, "is_enabled", lambda: True)
    uid = make_user(app_module)
    token = login_user(client, uid)
    _favorite(client, app_module, token, 2, uid)   # only two favourites
    r = client.post("/api/favorites/insights", json={}, headers={"X-CSRF-Token": token})
    assert r.status_code == 400


def test_favorites_insights_success(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module.llm, "is_enabled", lambda: True)
    monkeypatch.setattr(app_module.llm, "reflect_on_favorites",
                        lambda tips, library_size=None: {"pattern": "You start but rarely finish.",
                                      "questions": ["Why?"], "experiments": ["Finish one thing"]})
    uid = make_user(app_module)
    token = login_user(client, uid)
    _favorite(client, app_module, token, 3, uid)
    r = client.post("/api/favorites/insights", json={}, headers={"X-CSRF-Token": token})
    assert r.status_code == 200
    data = r.get_json()
    assert data["count"] == 3
    assert data["insight"]["pattern"] == "You start but rarely finish."


# ── Full-text search (SQLite FTS5) ──
def test_fts_migration_applied(app_module):
    with app_module.get_db() as conn:
        applied = [r["filename"] for r in conn.execute("SELECT filename FROM schema_migrations")]
        tbl = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tips_fts'").fetchone()
    assert "003_fts.sql" in applied and tbl is not None


def test_fts_matches_content_words(client, app_module):
    add_tip(app_module, "Drink water in the morning", ["physical"])
    add_tip(app_module, "Save money every week", ["financial"])
    contents = [t["content"] for t in client.get("/api/tips/fts?q=water").get_json()["results"]]
    assert "Drink water in the morning" in contents
    assert "Save money every week" not in contents


def test_fts_prefix_and_stemming(client, app_module):
    add_tip(app_module, "Protect your mornings", ["physical"])
    # prefix: "morn" -> "mornings"
    assert any("mornings" in t["content"] for t in client.get("/api/tips/fts?q=morn").get_json()["results"])


def test_fts_indexes_new_tip_via_api(client):
    token = login_admin(client)
    client.post("/api/tips", json={"content": "Stretch every hour", "tags": ["physical"]},
                headers={"X-CSRF-Token": token})
    assert any(t["content"] == "Stretch every hour"
               for t in client.get("/api/tips/fts?q=stretch").get_json()["results"])


def test_fts_reflects_edit_and_delete(client, app_module):
    tid = add_tip(app_module, "alpha unique zebra", ["moral"])
    token = login_admin(client)
    assert client.get("/api/tips/fts?q=zebra").get_json()["results"]
    client.put(f"/api/tips/{tid}", json={"content": "beta unique giraffe"},
               headers={"X-CSRF-Token": token})
    assert client.get("/api/tips/fts?q=giraffe").get_json()["results"]    # new word indexed
    assert client.get("/api/tips/fts?q=zebra").get_json()["results"] == []  # old word gone
    client.delete(f"/api/tips/{tid}", headers={"X-CSRF-Token": token})
    assert client.get("/api/tips/fts?q=giraffe").get_json()["results"] == []


def test_fts_empty_query(client):
    assert client.get("/api/tips/fts?q=").get_json() == {"results": []}


def test_fts_handles_punctuation_safely(client, app_module):
    add_tip(app_module, "Don't overthink it", ["moral"])
    r = client.get("/api/tips/fts", query_string={"q": "don't!! @#$%"})
    assert r.status_code == 200
    assert any("overthink" in t["content"] for t in r.get_json()["results"])


# ── Community submissions + moderation queue ──
def test_submission_requires_login(client):
    r = client.post("/api/submissions", json={"content": "x"}, headers={"X-CSRF-Token": get_csrf(client)})
    assert r.status_code == 401


def test_submit_creates_pending_and_lists_for_admin(client, app_module):
    uid = make_user(app_module)
    token = login_user(client, uid)
    r = client.post("/api/submissions", json={"content": "Walk after meals", "tags": ["physical"]},
                    headers={"X-CSRF-Token": token})
    assert r.status_code == 201 and r.get_json()["status"] == "pending"
    login_admin(client)
    subs = client.get("/api/submissions").get_json()["submissions"]
    assert any(s["content"] == "Walk after meals" for s in subs)


def test_list_submissions_requires_admin(client, app_module):
    uid = make_user(app_module)
    login_user(client, uid)
    assert client.get("/api/submissions").status_code == 403


def test_pending_submission_not_in_corpus(client, app_module):
    uid = make_user(app_module)
    token = login_user(client, uid)
    client.post("/api/submissions", json={"content": "Zorptastic unique phrase", "tags": ["moral"]},
                headers={"X-CSRF-Token": token})
    # pending content must NOT leak into the live corpus or full-text search
    assert client.get("/api/tips/fts?q=zorptastic").get_json()["results"] == []
    assert not any(t["content"] == "Zorptastic unique phrase" for t in client.get("/api/tips").get_json())


def test_approve_creates_indexed_tip(client, app_module):
    uid = make_user(app_module)
    token = login_user(client, uid)
    sub = client.post("/api/submissions", json={"content": "Zorptastic unique phrase", "tags": ["moral"]},
                      headers={"X-CSRF-Token": token}).get_json()
    admin_token = login_admin(client)
    r = client.post(f"/api/submissions/{sub['id']}/approve", json={}, headers={"X-CSRF-Token": admin_token})
    assert r.status_code == 201
    tip = r.get_json()["tip"]
    assert tip["content"] == "Zorptastic unique phrase" and "moral" in tip["tags"]
    # now it's a real tip: in the corpus and full-text searchable
    assert any(t["id"] == tip["id"] for t in client.get("/api/tips").get_json())
    assert any(t["id"] == tip["id"] for t in client.get("/api/tips/fts?q=zorptastic").get_json()["results"])
    # submission marked approved
    approved = client.get("/api/submissions?status=approved").get_json()["submissions"]
    assert any(s["id"] == sub["id"] for s in approved)


def test_approve_requires_a_tag(client, app_module):
    uid = make_user(app_module)
    token = login_user(client, uid)
    sub = client.post("/api/submissions", json={"content": "No tags here"},
                      headers={"X-CSRF-Token": token}).get_json()
    admin_token = login_admin(client)
    r = client.post(f"/api/submissions/{sub['id']}/approve", json={}, headers={"X-CSRF-Token": admin_token})
    assert r.status_code == 400


def test_reject_does_not_create_tip(client, app_module):
    uid = make_user(app_module)
    token = login_user(client, uid)
    sub = client.post("/api/submissions", json={"content": "Reject me please", "tags": ["moral"]},
                      headers={"X-CSRF-Token": token}).get_json()
    admin_token = login_admin(client)
    assert client.post(f"/api/submissions/{sub['id']}/reject", json={},
                       headers={"X-CSRF-Token": admin_token}).status_code == 200
    assert not any(t["content"] == "Reject me please" for t in client.get("/api/tips").get_json())
    # re-approving a non-pending submission is rejected
    assert client.post(f"/api/submissions/{sub['id']}/approve", json={},
                       headers={"X-CSRF-Token": admin_token}).status_code == 409


def test_my_submissions_anonymous_is_empty(client):
    assert client.get("/api/submissions/mine").get_json() == {"submissions": []}


def test_my_submissions_lists_only_own_with_status(client, app_module):
    a = make_user(app_module, sub="a", email="a@e.com", name="A")
    b = make_user(app_module, sub="b", email="b@e.com", name="B")
    tok_a = login_user(client, a)
    sub = client.post("/api/submissions", json={"content": "From A", "tags": ["moral"]},
                      headers={"X-CSRF-Token": tok_a}).get_json()
    tok_b = login_user(client, b)
    client.post("/api/submissions", json={"content": "From B", "tags": ["moral"]},
                headers={"X-CSRF-Token": tok_b})
    # B sees only their own
    mine_b = client.get("/api/submissions/mine").get_json()["submissions"]
    assert [s["content"] for s in mine_b] == ["From B"]
    # A sees their own; after approval its status flips to 'approved'
    login_user(client, a)
    assert client.get("/api/submissions/mine").get_json()["submissions"][0]["status"] == "pending"
    admin_token = login_admin(client)
    client.post(f"/api/submissions/{sub['id']}/approve", json={}, headers={"X-CSRF-Token": admin_token})
    login_user(client, a)
    assert client.get("/api/submissions/mine").get_json()["submissions"][0]["status"] == "approved"


def test_me_reports_pending_count_for_admin(client, app_module):
    uid = make_user(app_module)
    token = login_user(client, uid)
    client.post("/api/submissions", json={"content": "Count me", "tags": ["moral"]},
                headers={"X-CSRF-Token": token})
    assert client.get("/api/me").get_json()["pending_submissions"] == 0   # not admin yet
    login_admin(client)
    assert client.get("/api/me").get_json()["pending_submissions"] == 1
