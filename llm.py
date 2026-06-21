"""Optional LLM helpers — text generation via Groq (OpenAI-compatible API).

The whole app runs fine without this: if no API key is set, is_enabled() is False and the
callers degrade gracefully (the "Suggest tags" / "Ask" / "Reflect" features report they're off).

Groq is fast and has a generous free tier. Set GROQ_API_KEY in .env — get a key at
https://console.groq.com/keys . Optionally override GROQ_MODEL (default: llama-3.3-70b-versatile).

Note: Groq does text generation only. Semantic *embeddings* live in embeddings.py and run on a
small local model (fastembed), so they need no API key at all.
"""
import json
import os

import requests

GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
_CHAT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
_CHUNK = 25  # tips per request — keeps the JSON response reliable


class LLMError(Exception):
    pass


def _api_key():
    # Read lazily so it works regardless of .env load order.
    return os.environ.get("GROQ_API_KEY")


def is_enabled():
    return bool(_api_key())


def _complete_json(prompt, temperature=0.2):
    """Send a prompt to Groq in JSON mode and return the parsed JSON (dict or list).

    `temperature` defaults low (0.2) for deterministic tasks like tagging; reflective tasks
    pass a higher value for less generic output. Raises LLMError on any failure.
    """
    key = _api_key()
    if not key:
        raise LLMError("not configured")
    try:
        resp = requests.post(
            _CHAT_ENDPOINT,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            json={
                "model": GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": "You are a careful assistant. Respond with ONLY valid JSON — no prose, no markdown fences."},
                    {"role": "user", "content": prompt},
                ],
                "response_format": {"type": "json_object"},
                "temperature": temperature,
            },
            timeout=45,
        )
    except requests.RequestException as e:
        raise LLMError("request failed: %s" % e)
    if resp.status_code != 200:
        raise LLMError("API %s: %s" % (resp.status_code, resp.text[:300]))
    try:
        content = resp.json()["choices"][0]["message"]["content"]
        return json.loads(content)
    except (KeyError, IndexError, ValueError, TypeError) as e:
        raise LLMError("bad response: %s" % e)


def _as_str_list(items):
    """Normalise a JSON list (of strings or {title/detail/...}-shaped objects) to strings."""
    out = []
    for a in (items or []):
        if isinstance(a, dict):
            title = (a.get("title") or "").strip()
            detail = (a.get("detail") or a.get("text") or a.get("question")
                      or a.get("experiment") or a.get("action") or "").strip()
            text = ((title + " — " + detail) if title and detail else (title or detail)).strip()
        else:
            text = str(a).strip() if a else ""
        if text:
            out.append(text)
    return out


def reflect_on_favorites(tips, library_size=None):
    """Turn a user's *selection* of favourite tips into something genuinely useful.

    `tips` is a list of {"content", "tags"}; `library_size` is how many tips exist in total
    (so the model knows these were chosen out of many). Returns
    {"pattern": str, "questions": [str, ...], "experiments": [str, ...]}.

    The whole point is the selection: out of a large library, the user picked THESE. So the
    output is targeted and concrete — a specific (non-obvious) throughline, penetrating
    self-questions, and small testable experiments — not generic affirmation. Raises LLMError.
    """
    lines = []
    for i, t in enumerate(tips):
        tags = t.get("tags") or []
        suffix = (" [" + ", ".join(tags) + "]") if tags else ""
        lines.append("%d. %s%s" % (i + 1, t["content"], suffix))
    out_of = ("a library of %d tips" % library_size) if library_size else "a large library"
    prompt = (
        "A person has hand-picked the tips below as their favourites, out of %s. The specific "
        "selection is the signal — treat it as evidence of what they are actually grappling with "
        "right now, not a personality test.\n\n"
        "Do NOT flatter, summarise, or state the obvious. NEVER say things like 'you value growth' "
        "or 'you're on a journey of self-improvement' — they're using a self-improvement app, so "
        "that adds nothing. Avoid generic affirmations and therapy-speak. Look hard at the SPECIFIC "
        "content of these particular picks.\n\n"
        "Produce a JSON object with:\n"
        '  "pattern": 1-2 sentences naming the specific, NON-OBVIOUS throughline that connects '
        "THESE choices — concrete enough that it could not be said of a random set of tips. If "
        "there's a tension or contradiction across the picks, name it. (Good: 'Almost every pick "
        "is about lowering the friction to START, not discipline once underway.' Bad: 'you value "
        "productivity.')\n"
        '  "questions": 3-4 penetrating questions, each specific to their actual picks, that make '
        "them think or expose an assumption — not questions designed to make them feel good.\n"
        '  "experiments": 3-4 small, concrete, testable things to try this week, each tied to the '
        "real content of a specific tip (reference the idea concretely, not vaguely).\n\n"
        "Be direct and a little challenging. Specific beats kind. Plain strings, no markdown.\n\n"
        "Favourite tips:\n%s"
    ) % (out_of, "\n".join(lines))
    parsed = _complete_json(prompt, temperature=0.7)
    if not isinstance(parsed, dict):
        raise LLMError("unexpected response shape")
    return {
        "pattern": (parsed.get("pattern") or "").strip(),
        "questions": _as_str_list(parsed.get("questions")),
        "experiments": _as_str_list(parsed.get("experiments")),
    }


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
        'Return a JSON object: {"answer": "<advice>", "used": [<tip numbers>]}\n\n'
        "Situation:\n%s\n\nTips:\n%s"
    ) % (situation.strip(), numbered)
    parsed = _complete_json(prompt)
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


# Lenses for "explore this tip": each maps to a specific instruction. The user picks one.
ANALYSIS_LENSES = {
    "apply": "Describe 3-5 concrete, everyday situations where this tip genuinely helps. Each point: "
             "name the situation and the specific move to make. No vague platitudes.",
    "avoid": "Describe 3-5 situations where following this tip would be a mistake or backfire. Each "
             "point: name the situation and why the tip fails there.",
    "opposing": "Name 3-5 pieces of opposing wisdom — principles, proverbs, or schools of thought "
                "that genuinely push the other way. Each point: state the opposing idea and its tension with this tip.",
    "misreadings": "Describe 3-5 common ways people misread or misapply this tip. Each point: state "
                   "the misreading, then the correction.",
    "figures": "Name 3-5 specific, real, well-known people (historical or modern) who notably embodied "
               "this idea, each as 'Name — the concrete thing they did that shows it'. Only include "
               "genuine, well-attested examples; include fewer rather than invent.",
}


def analyze_tip(content, lens):
    """Analyse a tip through one chosen lens (see ANALYSIS_LENSES).

    Returns {"points": [str, ...]}. Raises LLMError on an unknown lens or any API failure.
    """
    instruction = ANALYSIS_LENSES.get(lens)
    if not instruction:
        raise LLMError("unknown analysis lens: %s" % lens)
    prompt = (
        "Help someone think more deeply about this piece of practical wisdom:\n\n"
        '"%s"\n\n%s\n\n'
        "Be specific and grounded — avoid generic, obvious, or sycophantic statements. "
        'Return a JSON object {"points": ["...", ...]}.'
    ) % (content.strip(), instruction)
    parsed = _complete_json(prompt, temperature=0.6)
    if not isinstance(parsed, dict):
        raise LLMError("unexpected response shape")
    return {"points": _as_str_list(parsed.get("points"))}


def _build_prompt(contents, primary_tags, secondary_tags, max_secondary):
    numbered = "\n".join("%d. %s" % (i + 1, c) for i, c in enumerate(contents))
    return (
        "You are tagging short 'practical wisdom' tips for an app with a fixed tag taxonomy.\n"
        "For EACH tip choose exactly ONE primary tag (its main theme) and up to %d secondary tags.\n"
        "Use ONLY tags from the lists below — never invent new ones.\n\n"
        "PRIMARY tags: %s\n"
        "SECONDARY tags: %s\n\n"
        'Return a JSON object {"tips": [...]} with one entry per tip, IN THE SAME ORDER, each like:\n'
        '{"primary": "physical", "secondary": ["habit", "morning"]}\n\n'
        "Tips:\n%s"
    ) % (max_secondary, ", ".join(primary_tags), ", ".join(secondary_tags), numbered)


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
        parsed = _complete_json(_build_prompt(chunk, primary_tags, secondary_tags, max_secondary))
        items = parsed.get("tips") if isinstance(parsed, dict) else (parsed if isinstance(parsed, list) else [])
        items = items or []
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
