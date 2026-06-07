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
