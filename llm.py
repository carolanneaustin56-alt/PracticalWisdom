"""Optional LLM helpers — Google AI Studio (Gemini), free tier.

The whole app runs fine without this: if no API key is set, is_enabled() is False and
the callers degrade gracefully (the "Suggest tags" button just reports it's not configured).

Set GEMINI_API_KEY in .env. Get a key at https://aistudio.google.com/apikey
Optionally override GEMINI_MODEL (default: gemini-2.5-flash).
"""
import json
import os

import requests

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_CHUNK = 25  # tips per request — keeps the JSON response reliable and within free-tier limits

# Embeddings: turn text into a vector so we can measure semantic similarity. A separate model
# from GEMINI_MODEL (which generates text). 768 dims is a good size/quality trade-off.
EMBED_MODEL = os.environ.get("GEMINI_EMBED_MODEL", "gemini-embedding-001")
EMBED_DIM = int(os.environ.get("GEMINI_EMBED_DIM", "768"))
_EMBED_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents"
_EMBED_CHUNK = 100  # texts per request — well within the API's batch limit


class LLMError(Exception):
    pass


def _api_key():
    # Read lazily so it works regardless of .env load order.
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")


def is_enabled():
    return bool(_api_key())


def _call_gemini(prompt):
    key = _api_key()
    if not key:
        raise LLMError("not configured")
    try:
        resp = requests.post(
            _ENDPOINT.format(model=GEMINI_MODEL),
            params={"key": key},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2},
            },
            timeout=30,
        )
    except requests.RequestException as e:
        raise LLMError("request failed: %s" % e)
    if resp.status_code != 200:
        raise LLMError("API %s: %s" % (resp.status_code, resp.text[:300]))
    try:
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except (KeyError, IndexError, ValueError, TypeError) as e:
        raise LLMError("bad response: %s" % e)


def embed_texts(texts, task_type="SEMANTIC_SIMILARITY"):
    """Embed a list of texts, returning a list of float vectors aligned with the input.

    Uses the batch endpoint (chunked) so embedding hundreds of tips is a handful of requests.
    `task_type` SEMANTIC_SIMILARITY suits both "find similar tips" and "search by meaning".
    Raises LLMError on failure.
    """
    key = _api_key()
    if not key:
        raise LLMError("not configured")
    vectors = []
    for start in range(0, len(texts), _EMBED_CHUNK):
        chunk = texts[start:start + _EMBED_CHUNK]
        body = {"requests": [
            {
                "model": "models/%s" % EMBED_MODEL,
                "content": {"parts": [{"text": t or ""}]},
                "taskType": task_type,
                "outputDimensionality": EMBED_DIM,
            }
            for t in chunk
        ]}
        try:
            resp = requests.post(
                _EMBED_ENDPOINT.format(model=EMBED_MODEL),
                params={"key": key}, json=body, timeout=60,
            )
        except requests.RequestException as e:
            raise LLMError("request failed: %s" % e)
        if resp.status_code != 200:
            raise LLMError("API %s: %s" % (resp.status_code, resp.text[:300]))
        try:
            for emb in resp.json()["embeddings"]:
                vectors.append([float(x) for x in emb["values"]])
        except (KeyError, IndexError, ValueError, TypeError) as e:
            raise LLMError("bad response: %s" % e)
    return vectors


def _build_prompt(contents, primary_tags, secondary_tags, max_secondary):
    numbered = "\n".join("%d. %s" % (i + 1, c) for i, c in enumerate(contents))
    return (
        "You are tagging short 'practical wisdom' tips for an app with a fixed tag taxonomy.\n"
        "For EACH tip choose exactly ONE primary tag (its main theme) and up to %d secondary tags.\n"
        "Use ONLY tags from the lists below — never invent new ones.\n\n"
        "PRIMARY tags: %s\n"
        "SECONDARY tags: %s\n\n"
        "Return a JSON array with one object per tip, in the same order, e.g.:\n"
        '[{"primary": "physical", "secondary": ["habit", "morning"]}]\n\n'
        "Tips:\n%s"
    ) % (max_secondary, ", ".join(primary_tags), ", ".join(secondary_tags), numbered)


def advise(situation, tips):
    """Generate advice for a user's situation, grounded ONLY in the supplied tips (RAG).

    `tips` is a list of {"id", "content"} already retrieved by semantic similarity. Returns
    {"answer": str, "used": [tip_id, ...]} where `used` are the tips the model says it drew on.
    Raises LLMError on failure.
    """
    numbered = "\n".join("%d. %s" % (i + 1, t["content"]) for i, t in enumerate(tips))
    prompt = (
        "You are a warm, practical mentor. A person describes their situation. Using ONLY the "
        "numbered tips below as your source of wisdom, write brief, encouraging, actionable advice "
        "(2-3 short paragraphs, plain language, no preamble or sign-off). Weave the relevant ideas "
        "in naturally — don't just list them. If the tips don't really fit the situation, say so "
        "gently rather than inventing advice.\n"
        "Then list the numbers of the tips you actually drew on.\n\n"
        'Return JSON: {"answer": "<advice>", "used": [<tip numbers>]}\n\n'
        "Situation:\n%s\n\nTips:\n%s"
    ) % (situation.strip(), numbered)
    parsed = _call_gemini(prompt)
    if not isinstance(parsed, dict):
        raise LLMError("unexpected response shape")
    answer = (parsed.get("answer") or "").strip()
    used_ids = []
    for n in (parsed.get("used") or []):
        try:
            idx = int(n) - 1
        except (ValueError, TypeError):
            continue
        if 0 <= idx < len(tips) and tips[idx]["id"] not in used_ids:
            used_ids.append(tips[idx]["id"])
    return {"answer": answer, "used": used_ids}


def suggest_tags_batch(contents, primary_tags, secondary_tags, max_secondary=3):
    """Suggest tags for each tip, chosen ONLY from the allowed lists.

    Returns a list aligned with `contents`, each item {"primary": str|None, "secondary": [...]}.
    Anything the model returns that isn't an allowed tag is dropped. Raises LLMError on failure.
    """
    prim_set = {t.lower() for t in primary_tags}
    sec_set = {t.lower() for t in secondary_tags}
    out = []
    for start in range(0, len(contents), _CHUNK):
        chunk = contents[start:start + _CHUNK]
        parsed = _call_gemini(_build_prompt(chunk, primary_tags, secondary_tags, max_secondary))
        items = parsed if isinstance(parsed, list) else (parsed.get("tips") or [])
        for i in range(len(chunk)):
            item = items[i] if i < len(items) and isinstance(items[i], dict) else {}
            primary = (item.get("primary") or "").strip().lower()
            if primary not in prim_set:
                primary = None
            secondary = []
            for t in (item.get("secondary") or []):
                t = (t or "").strip().lower()
                if t in sec_set and t not in secondary:
                    secondary.append(t)
            out.append({"primary": primary, "secondary": secondary[:max_secondary]})
    return out
