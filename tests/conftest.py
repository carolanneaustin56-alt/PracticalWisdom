"""Pytest fixtures: a fresh, isolated app + temp database per test."""
import importlib
import os
import sys

import pytest

# Make `import app` work no matter how pytest is invoked.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def app_module(tmp_path, monkeypatch):
    # A throwaway DB per test, and a hermetic config (ignore any real .env values).
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SECRET_KEY", "test-secret")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "")      # disable Google OAuth in tests
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "")
    monkeypatch.setenv("ADMIN_PASSWORD", "admin")
    monkeypatch.setenv("ADMIN_PASSWORD_HASH", "")   # force hashing of ADMIN_PASSWORD above
    import app
    importlib.reload(app)   # re-read env, reset module state (rate limiter, hash, routes)
    app.init_db()
    return app


@pytest.fixture
def client(app_module):
    app_module.app.testing = True
    return app_module.app.test_client()
