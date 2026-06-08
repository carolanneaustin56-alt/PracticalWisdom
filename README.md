# Practical Wisdom

A small Flask app for collecting short tips, each tagged with primary/secondary tags.
Signed-in users can up/down-vote tips (an upvote also saves a favourite), and explore
them in three views: a **List** (admin), a **Network** graph, and a sequential **Cards**
feed driven by a "next suggested tip" recommender.

## Run it locally

```bash
pip install -r requirements.txt
python3 app.py            # serves http://localhost:5001
```

On first run the app creates an empty `tips.db`. To load the bundled starter content:

```bash
python3 import_tips.py seed_tips.json
```

## Configuration (.env)

Create a `.env` file (it is git-ignored — never commit it):

```ini
# Sign the session cookie — generate one with:
#   python3 -c "import secrets; print(secrets.token_hex(32))"
SECRET_KEY=your-random-hex

# Google OAuth (optional — login is disabled until both are set).
# Create credentials at https://console.cloud.google.com and add the redirect URI
#   http://localhost:5001/auth/callback
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Admin login. In dev the default is admin/admin. For anything real, set a HASH
# (never a plaintext password in the repo). Generate one with:
#   python3 -c "from werkzeug.security import generate_password_hash as h; print(h('YOUR_PASSWORD', method='pbkdf2:sha256'))"
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=pbkdf2:sha256:...

# Set to 1 in production (HTTPS) so the session cookie is sent only over HTTPS.
COOKIE_SECURE=

# Optional: AI tag suggestions in the batch importer (Google AI Studio / Gemini, free tier).
# Get a free key at https://aistudio.google.com/apikey . Without it the "Suggest tags"
# button just says it's not configured; everything else works as normal.
GEMINI_API_KEY=
# GEMINI_MODEL=gemini-2.5-flash            # optional: text-generation model (tag suggestions)
# GEMINI_EMBED_MODEL=gemini-embedding-001  # optional: embedding model (semantic search)
# GEMINI_EMBED_DIM=768                     # optional: embedding vector size
```

## Project layout

```
app.py                 Flask app: routes, auth, CSRF, migrations runner
llm.py                 optional Gemini helpers (tag suggestions + text embeddings)
embeddings.py          semantic-embeddings foundation (search / similarity)
templates/index.html   page structure only (links to the static files)
static/styles.css      all styles
static/app.js          all front-end logic
migrations/            schema migrations (NNN_name.sql), applied in order
tests/                 pytest suite
import_tips.py         CLI to bulk-load tips from a .txt/.json file
seed_tips.json         starter content (no user data)
```

## Database migrations

The schema lives in `migrations/` as numbered SQL files. On startup the app applies any
not yet recorded in the `schema_migrations` table, in filename order — so it's safe to run
repeatedly and against an existing database. To change the schema, add the next file:

```
migrations/002_add_something.sql
```

## Semantic embeddings (foundation for meaning-based features)

When a Gemini key is set, each tip can be turned into an *embedding* — a vector that captures
its meaning — stored in the `tip_embeddings` table. This powers features that tag-matching
can't: searching by meaning, a smarter "next suggested tip", and "related tips" links.

- **Self-maintaining:** adding/editing a tip (or a batch import) embeds it automatically,
  best-effort — an API hiccup never blocks the write; the tip is just picked up on the next rebuild.
- **Backfill / repair:** an admin can rebuild the whole index. It only (re)embeds tips that are
  missing or whose text changed, so it's cheap to re-run.

  ```bash
  # check coverage  → {"enabled": true, "total": 206, "embedded": 206, "stale": 0, ...}
  curl http://localhost:5001/api/embeddings/status        # admin session required

  # (re)embed anything missing/stale
  curl -X POST http://localhost:5001/api/embeddings/rebuild
  ```

The math lives in `embeddings.py`: vectors are L2-normalised, so cosine similarity is a plain
dot product, and a brute-force scan over a few hundred tips is microseconds (no vector database
needed). That one file is the place to add semantic search, the recommender, or similarity edges.

### Features built on the embeddings layer

| Feature | Where | Endpoint |
|---|---|---|
| **Semantic search** — find tips by meaning, not matching tags (`✨ Meaning` button) | search bar | `GET /api/tips/search?q=` |
| **Semantic recommender** — Cards/Network "next suggested tip" by meaning (`Suggest: Meaning` toggle) | Cards + Network | `GET /api/tips/<id>/related` |
| **Related-tip links** — a selected node links to its nearest tips by meaning (`Links by: Meaning`) | Network | `GET /api/tips/<id>/related` |
| **Ask for advice** (RAG) — describe a situation, get advice grounded in the most relevant tips, with citations | `Ask` view | `POST /api/advise` |

All four are open to every visitor (no admin needed) and only appear when a Gemini key is set
(`/api/me` exposes `embeddings_enabled`). `related` uses the stored vectors only — no model call;
`search` and `advise` embed the query/situation, and `advise` also generates the written answer.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Each test runs against a fresh temporary database (your real `tips.db` is never touched).

## Security notes

- The admin password is compared as a **hash** (constant-time), and the login endpoint
  is **rate-limited** (5 attempts / 5 minutes per IP).
- All state-changing requests require a **CSRF token** (issued via `/api/me`, sent back
  in the `X-CSRF-Token` header).
- Content-changing API endpoints (add/edit/delete tips & tags, imports) require the admin
  session; voting/favourites require a signed-in Google user.
- `tips.db` and `.env` are git-ignored — they hold user data and secrets.
