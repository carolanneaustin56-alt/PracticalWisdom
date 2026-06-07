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
```

## Project layout

```
app.py                 Flask app: routes, auth, CSRF, migrations runner
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
