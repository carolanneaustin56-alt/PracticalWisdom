  let selectedTip = null;
  let pendingTags = [];
  let activeTags = [];
  let editingId = null;  // null = creating a new tip; otherwise the tip id being edited
  let currentView = "list";  // "list" | "network" | "cards"
  let cardCurrent = null;    // card view: the tip currently shown
  let cardNextId = null;     // card view: the suggested next tip
  let cardBackStack = [];    // card view: previously shown tips (for Back)
  let currentUser = null;    // {id,name,email,picture} when signed in, else null
  let authEnabled = false;   // whether Google login is configured on the server
  let isAdmin = false;       // administrator session (unlocks List view + management)
  let embeddingsEnabled = false; // whether semantic features (search/recommender) are available
  let llmEnabled = false;    // whether text-generation features (tags/advice) are available
  let pendingCount = 0;      // submissions awaiting review (admins only)
  let searchActive = false;  // showing semantic-search results instead of the current view
  let lastSearch = { q: "", results: [] };
  // How the search field interprets the query: "keyword" (full-text) or "meaning" (semantic).
  let searchMode = (() => { try { return localStorage.getItem("searchMode") || "keyword"; } catch (e) { return "keyword"; } })();
  // How the "next suggested tip" is chosen: "tags" (shared secondary tags) or "meaning"
  // (semantic similarity via embeddings). Persisted; only effective when embeddings are on.
  let suggestMode = (() => { try { return localStorage.getItem("suggestMode") || "meaning"; } catch (e) { return "meaning"; } })();
  const relatedCache = {};   // tip id -> [{tip_id, score}] from /api/tips/<id>/related

  const $ = id => document.getElementById(id);

  const SPINNER = '<div class="loading-wrap"><div class="spinner"></div></div>';
  const ERR = msg => `<div class="load-error">${msg}</div>`;

  let csrfToken = "";  // set from /api/me; sent back on every state-changing request
  async function api(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    try {
      const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.error) data.error = `Request failed (${res.status}).`;
      return data;
    } catch (e) {
      toast("Couldn't reach the server — check it's running and try again.");
      return { error: "network", _network: true };
    }
  }

  let allTags = [];  // [{name, tier}] — every tag that exists (the allowed list)
  const tierOf = name => (allTags.find(t => t.name === name) || {}).tier || "primary";

  // ── Auth & per-user actions (votes / favorites) ──────────────
  async function loadMe() {
    const data = await api("GET", "/api/me");
    csrfToken = data.csrf_token || csrfToken;
    currentUser = data.user;
    authEnabled = data.auth_enabled;
    isAdmin = data.is_admin;
    embeddingsEnabled = !!data.embeddings_enabled;
    llmEnabled = !!data.llm_enabled;
    pendingCount = data.pending_submissions || 0;
    updateSearchModeUI();
    const ab = $("view-advise");
    if (ab) ab.style.display = embeddingsEnabled ? "" : "none";
    updateSuggestModeButtons();
    updateReviewBtn();
    renderAuth();
  }

  function updateReviewBtn() {
    const b = $("review-subs-btn");
    if (b) b.textContent = "Review submissions" + (pendingCount ? ` (${pendingCount})` : "");
  }

  // ── Suggestion engine: tag-overlap vs semantic "meaning" (shared by Cards + Network) ──
  function updateSuggestModeButtons() {
    const show = embeddingsEnabled;
    const nb = $("net-suggest-mode"), cb = $("cv-suggest-mode");
    const meaning = suggestMode === "meaning";
    if (nb) { nb.style.display = show ? "" : "none"; nb.textContent = meaning ? "Suggest: Meaning ✨" : "Suggest: Tags"; }
    if (cb) { cb.style.display = show ? "" : "none"; cb.textContent = meaning ? "Suggestions: Meaning ✨" : "Suggestions: Tags"; }
  }

  function setSuggestMode(mode) {
    suggestMode = mode;
    try { localStorage.setItem("suggestMode", mode); } catch (e) {}
    updateSuggestModeButtons();
    if (currentView === "cards" && cardCurrent != null) computeCardNext();
    if (currentView === "network" && NET.selected != null) {
      const id = NET.selected;
      if (mode === "meaning" && embeddingsEnabled && !relatedCache[id]) {
        fetchRelated(id).then(() => { if (NET.selected === id) { applySelectionHighlight(); updateExprHint(); } });
      } else { applySelectionHighlight(); updateExprHint(); }
    }
  }
  const flipSuggestMode = () => setSuggestMode(suggestMode === "meaning" ? "tags" : "meaning");

  function renderAuth() {
    const el = $("auth-area");
    const parts = [];
    if (currentUser) {
      parts.push(
        (currentUser.picture ? `<img class="avatar" src="${currentUser.picture}" alt="" referrerpolicy="no-referrer">` : "") +
        `<span class="auth-name">${escHtml(currentUser.name || currentUser.email || "Account")}</span>` +
        `<button class="btn secondary" id="logout-btn">Sign out</button>`);
    } else if (authEnabled) {
      parts.push(`<a class="btn google-btn" href="/login">Sign in with Google</a>`);
    }
    if (currentUser) {   // a signed-in user can suggest a tip — sits next to Admin, top right
      parts.push(`<button class="btn secondary" id="suggest-tip-btn" title="Suggest a tip for review">✍ Suggest a tip</button>`);
    }
    if (isAdmin) {
      parts.push(`<span class="admin-badge" title="Administrator">ADMIN</span>` +
        `<button class="btn secondary" id="admin-logout-btn">Exit admin</button>`);
    } else {
      parts.push(`<button class="btn secondary" id="admin-open-btn">Admin</button>`);
    }
    el.innerHTML = parts.join("");
    if (currentUser) {
      $("logout-btn").onclick = googleSignOut;
      $("suggest-tip-btn").onclick = openSuggest;
    }
    if (isAdmin) $("admin-logout-btn").onclick = adminSignOut;
    else $("admin-open-btn").onclick = openAdminModal;
    const favTab = $("view-favorites");
    if (favTab) favTab.style.display = currentUser ? "" : "none";   // Favorites is a main view, signed-in only
  }

  // Show/hide List view + management based on role, then render the right view.
  function applyRolePermissions() {
    $("view-toggle").style.display = "flex";              // Network + Cards + Ask for everyone
    $("view-list").style.display = isAdmin ? "" : "none"; // List is admin-only
    $("mgmt-wrap").style.display = isAdmin ? "" : "none";
    if (!isAdmin) { activeTags = []; selectedTip = null; } // no sidebar to manage a tag filter
    closeMgmtMenu();
    loadSidebar();                                        // still populates allTags (network tiers)
    let v = currentView;
    if (!isAdmin && v === "list") v = "network";          // non-admins can't use List
    if (!currentUser && v === "favorites") v = "network"; // Favorites needs a signed-in user
    setView(v);
  }

  async function googleSignOut() {
    await api("POST", "/logout");
    currentUser = null;
    NET.visited = new Set(); NET.prevSelected = null;  // don't carry memory to the next user
    await loadMe();
    applyRolePermissions();   // drops the Favorites view if it was active (see applyRolePermissions)
  }

  async function adminSignOut() {
    await api("POST", "/api/admin/logout");
    await loadMe();
    applyRolePermissions();
  }

  function openAdminModal() {
    $("admin-username").value = "";
    $("admin-password").value = "";
    $("admin-status").textContent = "";
    $("admin-overlay").classList.remove("hidden");
    $("admin-username").focus();
  }

  async function adminLoginSubmit() {
    const r = await api("POST", "/api/admin/login", {
      username: $("admin-username").value.trim(),
      password: $("admin-password").value,
    });
    if (r.error) { $("admin-status").textContent = r.error; return; }
    $("admin-overlay").classList.add("hidden");
    await loadMe();
    applyRolePermissions();
  }

  function closeMgmtMenu() { const m = $("mgmt-menu"); if (m) m.classList.add("hidden"); }

  function requireLogin() {
    if (currentUser) return true;
    toast(authEnabled ? "Sign in with Google to vote and save favorites." : "Login isn't configured yet.");
    return false;
  }

  async function doVote(tip, dir) {
    if (!requireLogin()) return false;
    const value = tip.my_vote === dir ? 0 : dir;  // clicking your current vote again clears it
    const u = await api("POST", `/api/tips/${tip.id}/vote`, { value });
    if (!u || u.error) { toast((u && u.error) || "Vote failed."); return false; }
    Object.assign(tip, u);
    return true;
  }

  // Wire the up/score/down controls found inside `scope` to `tip`. An upvote also
  // marks the tip as a favorite (favorited is derived from the vote server-side).
  // `after` runs after a successful change (e.g. to drop a card from the favorites view).
  function bindTipControls(scope, tip, after) {
    const up = scope.querySelector(".vote-btn.up");
    const down = scope.querySelector(".vote-btn.down");
    const score = scope.querySelector(".vote-score");
    const paint = () => {
      if (score) score.textContent = tip.score;
      if (up) up.classList.toggle("on", tip.my_vote === 1);
      if (down) down.classList.toggle("on", tip.my_vote === -1);
    };
    if (up) up.onclick = async e => { e.stopPropagation(); if (await doVote(tip, 1)) { paint(); after && after(); } };
    if (down) down.onclick = async e => { e.stopPropagation(); if (await doVote(tip, -1)) { paint(); after && after(); } };
  }

  // Horizontal up/score/down markup (used by the network card).
  function tipControlsHTML(tip) {
    return `<button class="vote-btn up${tip.my_vote === 1 ? " on" : ""}" title="Upvote (saves to favorites)" aria-label="Upvote">▲</button>` +
           `<span class="vote-score">${tip.score}</span>` +
           `<button class="vote-btn down${tip.my_vote === -1 ? " on" : ""}" title="Downvote" aria-label="Downvote">▼</button>`;
  }


  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    // In fullscreen, only descendants of the fullscreen element render — host the
    // toast there so messages still appear; otherwise keep it on <body>.
    const host = document.fullscreenElement || document.body;
    if (t.parentNode !== host) host.appendChild(t);
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ── Tags sidebar ──────────────────────────────────────────────
  // Remember which groups the user collapsed so re-renders don't reset it.
  const sidebarGroupOpen = { primary: true, secondary: true };

  async function loadSidebar() {
    const tags = await api("GET", "/api/tags");
    allTags = tags.map(t => ({ name: t.name, tier: t.tier }));
    const list = $("tag-list");
    list.innerHTML = "";

    const renderGroup = (label, tier) => {
      const group = tags.filter(t => t.tier === tier);
      if (!group.length) return;
      const details = document.createElement("details");
      details.className = "tag-group";
      details.open = sidebarGroupOpen[tier];
      details.addEventListener("toggle", () => { sidebarGroupOpen[tier] = details.open; });
      const summary = document.createElement("summary");
      summary.innerHTML = `${label} <span class="group-count">${group.length}</span>`;
      details.appendChild(summary);
      const items = document.createElement("div");
      items.className = "tag-group-items";
      group.forEach(t => {
        const btn = document.createElement("button");
        btn.className = "tag-btn tier-" + t.tier + (activeTags.includes(t.name) ? " active" : "");
        btn.innerHTML = `${t.name} <span class="count">${t.count}</span>`;
        btn.onclick = () => toggleTag(t.name);
        items.appendChild(btn);
      });
      details.appendChild(items);
      list.appendChild(details);
    };

    renderGroup("Primary", "primary");
    renderGroup("Secondary", "secondary");

    $("clear-tags-btn").style.display = activeTags.length ? "block" : "none";
    renderTagPalette();
  }

  // ── Tag palette (click an existing tag to append it to the current tip) ──
  function renderTagPalette() {
    const palette = $("tag-palette");
    palette.innerHTML = "";
    if (!selectedTip) return;  // only relevant when a tip is open
    if (!allTags.length) {
      palette.innerHTML = '<span id="tag-palette-empty">No tags exist yet.</span>';
      return;
    }
    ["primary", "secondary"].forEach(tier => {
      const group = allTags.filter(t => t.tier === tier);
      if (!group.length) return;
      const label = document.createElement("div");
      label.className = "palette-group-label";
      label.textContent = tier === "primary" ? "Primary" : "Secondary";
      palette.appendChild(label);
      const row = document.createElement("div");
      row.className = "palette-row";
      group.forEach(({ name }) => {
        const btn = document.createElement("button");
        btn.className = "chip-add tier-" + tier;
        btn.textContent = name;
        const already = pendingTags.includes(name);
        btn.disabled = already;
        btn.title = already ? "Already added" : `Add this ${tier} tag`;
        btn.onclick = () => {
          if (!pendingTags.includes(name)) {
            pendingTags.push(name);
            renderPendingTags();
            renderTagPalette();
          }
        };
        row.appendChild(btn);
      });
      palette.appendChild(row);
    });
  }

  function toggleTag(name) {
    if (activeTags.includes(name)) {
      activeTags = activeTags.filter(t => t !== name);
    } else {
      activeTags.push(name);
    }
    loadSidebar();
    renderCurrentView();
  }

  $("clear-tags-btn").onclick = () => {
    activeTags = [];
    loadSidebar();
    renderCurrentView();
  };

  // ── Tip list ──────────────────────────────────────────────────
  async function loadTips(tags = "") {
    const params = [];
    if (tags) params.push("tags=" + encodeURIComponent(tags));
    const url = "/api/tips" + (params.length ? "?" + params.join("&") : "");
    $("tip-list").innerHTML = SPINNER;
    const tips = await api("GET", url);
    if (!Array.isArray(tips)) { $("tip-list").innerHTML = ERR("Couldn't load tips."); return; }
    renderTips(tips);
  }

  function renderTips(tips) {
    const list = $("tip-list");
    list.innerHTML = "";
    if (!tips.length) {
      list.innerHTML = `<div id="empty-state">No tips match these filters.</div>`;
      return;
    }
    tips.forEach(tip => {
      const card = document.createElement("div");
      card.className = "tip-card" + (selectedTip?.id === tip.id ? " selected" : "");
      card.dataset.id = tip.id;
      card.innerHTML = `
        <div class="vote-col">
          <button class="vote-btn up${tip.my_vote === 1 ? " on" : ""}" title="Upvote (saves to favorites)" aria-label="Upvote">▲</button>
          <span class="vote-score">${tip.score}</span>
          <button class="vote-btn down${tip.my_vote === -1 ? " on" : ""}" title="Downvote" aria-label="Downvote">▼</button>
        </div>
        <div class="tip-main"><div class="tip-content">${escHtml(tip.content)}</div></div>`;
      card.onclick = () => selectTip(tip);
      bindTipControls(card, tip);
      list.appendChild(card);
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // ── Detail pane ───────────────────────────────────────────────
  function selectTip(tip) {
    selectedTip = tip;
    pendingTags = [...tip.tags];
    $("detail-pane").classList.remove("hidden");
    $("detail-content").value = tip.content;
    $("detail-anecdote").value = tip.anecdote || "";
    renderPendingTags();
    renderTagPalette();
    $("save-status").textContent = "";
    renderVideoEditor(tip);   // the admin's attach-a-video field + preview
    // highlight the matching card in the list (works for clicks and programmatic calls)
    document.querySelectorAll(".tip-card").forEach(c => {
      c.classList.toggle("selected", Number(c.dataset.id) === tip.id);
    });
  }

  // ── Video: a responsive 16:9 embed, and the admin attach field in the detail pane ──
  function videoEmbedHtml(src) {
    return `<div class="video-embed"><iframe src="${src}" title="Video" frameborder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen></iframe></div>`;
  }
  function renderVideoEditor(tip) {
    $("video-url-input").value = tip.video_url || "";
    $("video-status").textContent = "";
    $("video-status").style.color = "var(--accent)";
    $("video-preview").innerHTML = tip.video_embed ? videoEmbedHtml(tip.video_embed) : "";
    $("video-remove-btn").style.display = tip.video_url ? "" : "none";
  }
  $("video-save-btn").onclick = async () => {
    if (!selectedTip) return;
    const url = $("video-url-input").value.trim();
    const r = await api("POST", `/api/tips/${selectedTip.id}/video`, { video_url: url });
    if (r.error) { $("video-status").style.color = "var(--danger)"; $("video-status").textContent = r.error; return; }
    selectedTip = r;
    renderVideoEditor(r);
    $("video-status").textContent = url ? "Video attached." : "Video removed.";
  };
  $("video-remove-btn").onclick = async () => {
    $("video-url-input").value = "";
    $("video-save-btn").click();
  };

  function renderPendingTags() {
    const container = $("current-tags");
    container.innerHTML = "";
    pendingTags.forEach(t => {
      const btn = document.createElement("button");
      btn.className = "chip-remove tier-" + tierOf(t);
      btn.innerHTML = `${escHtml(t)} <span>×</span>`;
      btn.onclick = () => {
        pendingTags = pendingTags.filter(x => x !== t);
        renderPendingTags();
        renderTagPalette();
      };
      container.appendChild(btn);
    });
  }

  // True if the pending set contains at least one primary tag.
  const pendingHasPrimary = () => pendingTags.some(t => tierOf(t) === "primary");

  $("add-tag-btn").onclick = async () => {
    const names = $("new-tag-input").value
      .split(",")
      .map(t => t.replace(/^#/, "").trim().toLowerCase())
      .filter(Boolean);
    if (!names.length) return;
    const tier = $("new-tag-tier").value;
    // Create/classify these tags at the chosen tier, then refresh the tag list.
    await api("POST", "/api/tags/batch", { text: names.join(","), tier });
    await loadSidebar();  // updates allTags so tierOf() reflects the new tier
    let added = false;
    names.forEach(name => {
      if (!pendingTags.includes(name)) { pendingTags.push(name); added = true; }
    });
    if (added) { renderPendingTags(); renderTagPalette(); }
    $("new-tag-input").value = "";
  };

  $("new-tag-input").onkeydown = e => { if (e.key === "Enter") $("add-tag-btn").click(); };

  // Saves the whole tip from the detail pane: text (content + anecdote) and its tags.
  $("save-tags-btn").onclick = async () => {
    if (!selectedTip) return;
    const fail = (msg) => { $("save-status").style.color = "#c0392b"; $("save-status").textContent = msg; };
    const content = $("detail-content").value.trim();
    if (!content) { fail("The tip can't be empty."); $("detail-content").focus(); return; }
    if (!pendingHasPrimary()) { fail("Add at least one primary tag before saving."); return; }
    const anecdote = $("detail-anecdote").value.trim();
    // 1) tip text (this also refreshes the semantic embedding), then 2) tags.
    const saved = await api("PUT", `/api/tips/${selectedTip.id}`, { content, anecdote });
    if (saved.error) { fail(saved.error); return; }
    const updated = await api("PUT", `/api/tips/${selectedTip.id}/tags`, { tags: pendingTags });
    if (updated.error) { fail(updated.error); return; }
    selectedTip = updated;
    $("save-status").style.color = "#5a8a2a";
    $("save-status").textContent = "Saved!";
    setTimeout(() => { $("save-status").textContent = ""; }, 2000);
    loadTips(activeTags.join(","));
    loadSidebar();
  };

  // ── Search ────────────────────────────────────────────────────
  // One field, two modes chosen by the inline toggle: "Keyword" (full-text via FTS5) or
  // "Meaning" (semantic similarity). Enter or the magnifier runs the search in the active mode;
  // clicking a mode switches and re-runs it. Tag filtering lives on the sidebar, independent.
  function updateSearchModeUI() {
    if (!embeddingsEnabled && searchMode === "meaning") searchMode = "keyword";  // semantic needs the model
    const mm = $("mode-meaning");
    if (mm) mm.style.display = embeddingsEnabled ? "" : "none";
    const mk = $("mode-keyword");
    if (mk) mk.classList.toggle("active", searchMode === "keyword");
    if (mm) mm.classList.toggle("active", searchMode === "meaning");
  }
  function runSearch() {
    if (searchMode === "meaning" && embeddingsEnabled) runSemanticSearch();
    else runTextSearch();
  }
  function setSearchMode(mode, andRun) {
    searchMode = mode;
    try { localStorage.setItem("searchMode", mode); } catch (e) {}
    updateSearchModeUI();
    if (andRun && $("search-input").value.trim()) runSearch();
  }
  $("search-go").onclick = runSearch;
  $("search-input").onkeydown = e => { if (e.key === "Enter") runSearch(); };
  $("mode-keyword").onclick = () => setSearchMode("keyword", true);
  $("mode-meaning").onclick = () => setSearchMode("meaning", true);

  function showOnlySearchPanel() {
    ["tip-list", "network-view", "card-view", "fav-list", "advise-view"].forEach(id => { $(id).style.display = "none"; });
    stopSim();
    $("net-tooltip").style.display = "none";
    $("search-results").style.display = "flex";
  }

  // Full-text search over the words of each tip.
  async function runTextSearch() {
    const q = $("search-input").value.trim();
    if (!q) { $("search-input").focus(); return; }
    searchActive = true;
    showOnlySearchPanel();
    const panel = $("search-results");
    panel.innerHTML = `<div class="fav-list-head">Searching for “${escHtml(q)}”…</div>${SPINNER}`;
    const res = await api("GET", "/api/tips/fts?q=" + encodeURIComponent(q));
    if (!searchActive) return;                       // user navigated away while it loaded
    if (res.error) { panel.innerHTML = ERR(res.error); return; }
    lastSearch = { q, results: res.results || [], mode: "text" };
    renderSearchResults();
  }

  // Semantic ("meaning") search via embeddings.
  async function runSemanticSearch() {
    const q = $("search-input").value.trim();
    if (!q) { $("search-input").focus(); return; }
    if (!embeddingsEnabled) { toast("Semantic search isn't configured (no AI key)."); return; }
    searchActive = true;
    showOnlySearchPanel();
    const panel = $("search-results");
    panel.innerHTML = `<div class="fav-list-head">✨ Searching for “${escHtml(q)}”…</div>${SPINNER}`;
    const res = await api("GET", "/api/tips/search?q=" + encodeURIComponent(q));
    if (!searchActive) return;
    if (res.error) { panel.innerHTML = ERR(res.error); return; }
    lastSearch = { q, results: res.results || [], mode: "meaning" };
    renderSearchResults();
  }

  function renderSearchResults() {
    const panel = $("search-results");
    const { q, results, mode } = lastSearch;
    const head = mode === "meaning"
      ? `✨ Closest in meaning to “${escHtml(q)}”`
      : `Tips matching “${escHtml(q)}”`;
    panel.innerHTML =
      `<div class="fav-list-head">${head}<button class="btn secondary" id="search-clear">✕ Clear</button></div>`;
    $("search-clear").onclick = clearSearch;
    if (!results.length) {
      panel.insertAdjacentHTML("beforeend",
        `<div id="empty-state">No tips matched “${escHtml(q)}”.</div>`);
      return;
    }
    results.forEach(tip => {
      const card = document.createElement("div");
      card.className = "tip-card";
      const badge = (mode === "meaning" && tip.similarity != null)
        ? `<span class="sim-badge" title="How close this tip is in meaning">${Math.round(tip.similarity * 100)}%</span>`
        : "";
      card.dataset.id = tip.id;
      card.innerHTML = `
        <div class="vote-col">
          <button class="vote-btn up${tip.my_vote === 1 ? " on" : ""}" title="Upvote (saves to favorites)" aria-label="Upvote">▲</button>
          <span class="vote-score">${tip.score}</span>
          <button class="vote-btn down${tip.my_vote === -1 ? " on" : ""}" title="Downvote" aria-label="Downvote">▼</button>
        </div>
        <div class="tip-main">
          <div class="tip-content">${escHtml(tip.content)}</div>
          ${tip.tags.length ? `<div class="tip-tags">${tip.tags.map(t => `<span class="chip">${escHtml(t)}</span>`).join("")}</div>` : ""}
        </div>${badge}`;
      if (currentView === "favorites") {
        card.classList.toggle("selected", selectedFav?.id === tip.id);
        card.onclick = () => openFavAnalysis(tip);
      }
      bindTipControls(card, tip);
      panel.appendChild(card);
    });
  }

  function clearSearch() {
    searchActive = false;
    $("search-results").style.display = "none";
    renderCurrentView();
  }

  // ── Add / Edit Tip modal ──────────────────────────────────────
  $("add-tip-btn").onclick = () => {
    editingId = null;
    $("modal-title").textContent = "Add new tip";
    $("modal-save").textContent = "Save tip";
    $("modal-tags-row").style.display = "block";
    $("modal-content").value = "";
    $("modal-anecdote").value = "";
    $("modal-tags").value = "";
    $("modal-status").textContent = "";
    $("modal-overlay").classList.remove("hidden");
    $("modal-content").focus();
  };

  $("delete-tip-btn").onclick = async () => {
    if (!selectedTip) return;
    if (!confirm("Delete this tip? This cannot be undone.")) return;
    await api("DELETE", `/api/tips/${selectedTip.id}`);
    selectedTip = null;
    $("detail-pane").classList.add("hidden");
    loadTips(activeTags.join(","));
    loadSidebar();
  };

  $("modal-cancel").onclick = () => $("modal-overlay").classList.add("hidden");

  $("modal-save").onclick = async (e) => {
    e.stopPropagation();
    const content = $("modal-content").value.trim();
    if (!content) { $("modal-content").focus(); return; }
    const anecdote = $("modal-anecdote").value.trim();
    $("modal-save").disabled = true;
    try {
      if (editingId) {
        const updated = await api("PUT", `/api/tips/${editingId}`, { content, anecdote });
        if (updated.error) { $("modal-status").textContent = updated.error; return; }
        if (selectedTip && selectedTip.id === editingId) selectTip(updated);
      } else {
        const tags = $("modal-tags").value
          .split(",")
          .map(t => t.replace(/^#/, "").trim().toLowerCase())
          .filter(Boolean);
        const created = await api("POST", "/api/tips", { content, anecdote, tags });
        if (created.error) { $("modal-status").textContent = created.error; return; }
      }
      $("modal-overlay").classList.add("hidden");
      loadTips(activeTags.join(","));
      loadSidebar();
    } catch (err) {
      console.error("Save failed:", err);
      $("modal-status").textContent =
        "Could not reach the server. Open the app at http://localhost:5001 (not the file preview).";
    } finally {
      $("modal-save").disabled = false;
    }
  };

  // Only dismiss when the press AND release both land on the backdrop itself.
  // (Prevents closing when a text selection drag ends on the backdrop.)
  function dismissOnBackdrop(overlayId) {
    const overlay = $(overlayId);
    let downOnBackdrop = false;
    overlay.addEventListener("mousedown", e => { downOnBackdrop = e.target === overlay; });
    overlay.addEventListener("mouseup", e => {
      if (downOnBackdrop && e.target === overlay) overlay.classList.add("hidden");
      downOnBackdrop = false;
    });
  }
  dismissOnBackdrop("modal-overlay");

  // ── Batch import modal ────────────────────────────────────────
  // ── Batch import: paste → review/edit → commit ──
  let batchItems = [];   // [{ id, content, tags:[...] }]
  let batchSeq = 0;

  function showBatchStage(stage) {
    $("batch-stage-input").classList.toggle("hidden", stage !== "input");
    $("batch-stage-review").classList.toggle("hidden", stage !== "review");
  }

  $("batch-import-btn").onclick = () => {
    $("batch-text").value = "";
    $("batch-input-status").textContent = "";
    $("batch-status").textContent = "";
    showBatchStage("input");
    $("batch-overlay").classList.remove("hidden");
    $("batch-text").focus();
  };
  $("batch-cancel").onclick = () => $("batch-overlay").classList.add("hidden");
  $("batch-back-btn").onclick = () => showBatchStage("input");
  dismissOnBackdrop("batch-overlay");

  $("batch-preview-btn").onclick = async () => {
    const text = $("batch-text").value.trim();
    if (!text) { $("batch-text").focus(); return; }
    $("batch-preview-btn").disabled = true;
    const res = await api("POST", "/api/tips/batch/preview", { text });
    $("batch-preview-btn").disabled = false;
    if (!res.tips || !res.tips.length) {
      $("batch-input-status").textContent = "Couldn't find any tips in that text.";
      return;
    }
    batchItems = res.tips.map(t => ({ id: ++batchSeq, content: t.content, tags: t.tags.slice() }));
    renderBatchReview();
    showBatchStage("review");
  };

  function renderBatchReview() {
    const list = $("batch-review-list");
    list.innerHTML = "";
    batchItems.forEach(item => list.appendChild(renderBatchRow(item)));
    updateBatchSummary();
  }

  function renderBatchRow(item) {
    const row = document.createElement("div");
    row.className = "batch-row";
    const del = document.createElement("button");
    del.className = "batch-del"; del.title = "Remove this tip"; del.textContent = "×";
    del.setAttribute("aria-label", "Remove this tip");
    const main = document.createElement("div"); main.className = "batch-row-main";
    const contentInput = document.createElement("input");
    contentInput.className = "batch-content"; contentInput.type = "text"; contentInput.value = item.content;
    const tagsInput = document.createElement("input");
    tagsInput.className = "batch-tags"; tagsInput.type = "text"; tagsInput.value = item.tags.join(", ");
    tagsInput.placeholder = "tags, comma-separated — first is primary";
    const chips = document.createElement("div"); chips.className = "batch-chips";
    const paintChips = () => {
      chips.innerHTML = item.tags.length
        ? item.tags.map((t, i) => `<span class="batch-chip ${i === 0 ? "primary" : "secondary"}">${escHtml(t)}</span>`).join("")
        : `<span class="batch-warn">⚠ no tags — this tip will be skipped</span>`;
      row.classList.toggle("no-tags", item.tags.length === 0);
    };
    contentInput.oninput = () => { item.content = contentInput.value; };
    tagsInput.oninput = () => {
      item.tags = tagsInput.value.split(",").map(s => s.replace(/^#/, "").trim().toLowerCase()).filter(Boolean);
      paintChips(); updateBatchSummary();
    };
    del.onclick = () => {
      batchItems = batchItems.filter(x => x.id !== item.id);
      row.remove(); updateBatchSummary();
    };
    main.append(contentInput, tagsInput, chips);
    row.append(del, main);
    paintChips();
    return row;
  }

  function updateBatchSummary() {
    const keep = batchItems.filter(i => i.content.trim() && i.tags.length).length;
    const skip = batchItems.length - keep;
    $("batch-review-summary").innerHTML =
      `<b>${batchItems.length}</b> tip${batchItems.length !== 1 ? "s" : ""} parsed — edit tags inline, click × to remove.` +
      (skip ? ` <span style="color:#c0392b">${skip} with no tags will be skipped.</span>` : "");
    $("batch-commit-btn").textContent = `Import ${keep} tip${keep !== 1 ? "s" : ""}`;
    $("batch-commit-btn").disabled = keep === 0;
  }

  $("batch-commit-btn").onclick = async () => {
    const tips = batchItems
      .map(i => ({ content: i.content.trim(), tags: i.tags }))
      .filter(i => i.content && i.tags.length);
    if (!tips.length) return;
    $("batch-commit-btn").disabled = true;
    const result = await api("POST", "/api/tips/batch/commit", { tips });
    $("batch-status").textContent =
      `Imported ${result.imported} tip${result.imported !== 1 ? "s" : ""}${result.skipped ? `, skipped ${result.skipped}` : ""}.`;
    loadSidebar();
    renderCurrentView();
    setTimeout(() => $("batch-overlay").classList.add("hidden"), 1200);
  };

  // AI tag suggestions (Gemini): fills tags for rows that don't have any yet.
  $("batch-suggest-btn").onclick = async () => {
    const empties = batchItems.filter(i => i.content.trim() && !i.tags.length);
    if (!empties.length) { toast("Every tip already has tags — clear some to re-suggest."); return; }
    const btn = $("batch-suggest-btn");
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Suggesting…";
    $("batch-status").textContent = `Asking the AI to tag ${empties.length} tip${empties.length !== 1 ? "s" : ""}…`;
    const res = await api("POST", "/api/llm/suggest-tags", { contents: empties.map(i => i.content.trim()) });
    btn.disabled = false; btn.textContent = label;
    if (res.error) { $("batch-status").textContent = ""; toast(res.error); return; }
    let filled = 0;
    (res.suggestions || []).forEach((sug, idx) => {
      const item = empties[idx];
      if (!item) return;
      const tags = [];
      if (sug.primary) tags.push(sug.primary);
      (sug.secondary || []).forEach(t => { if (!tags.includes(t)) tags.push(t); });
      if (tags.length) { item.tags = tags; filled++; }
    });
    renderBatchReview();
    $("batch-status").textContent = `AI suggested tags for ${filled} tip${filled !== 1 ? "s" : ""}. Review and edit before importing.`;
  };

  // ── Import tags modal ─────────────────────────────────────────
  $("import-tags-btn").onclick = () => {
    $("tags-text").value = "";
    $("tags-status").textContent = "";
    $("tags-overlay").classList.remove("hidden");
    $("tags-text").focus();
  };

  $("tags-cancel").onclick = () => $("tags-overlay").classList.add("hidden");

  dismissOnBackdrop("tags-overlay");

  $("tags-save").onclick = async () => {
    const text = $("tags-text").value.trim();
    if (!text) { $("tags-text").focus(); return; }
    const tier = $("tags-tier").value;
    $("tags-save").disabled = true;
    const result = await api("POST", "/api/tags/batch", { text, tier });
    $("tags-save").disabled = false;
    $("tags-status").textContent = `Added ${result.added} new ${result.tier} tag${result.added !== 1 ? "s" : ""} (${result.submitted} submitted).`;
    loadSidebar();  // refreshes both the filter sidebar and the click-to-add palette
    setTimeout(() => $("tags-overlay").classList.add("hidden"), 1200);
  };

  // ── Apply a tag to tips (one click per tip) ───────────────────
  let applyTips = [];  // [{ id, content, tags:[...] }] — all tips, fetched when the modal opens

  const applyTagName = () => $("apply-tag-input").value.replace(/^#/, "").trim().toLowerCase();

  async function openApplyTag() {
    $("apply-tag-input").value = "";
    $("apply-filter").value = "";
    $("apply-tier-note").textContent = "";
    $("apply-tag-tier").disabled = false;
    $("apply-summary").textContent = "";
    $("apply-tip-list").innerHTML = SPINNER;
    $("apply-overlay").classList.remove("hidden");
    const tips = await api("GET", "/api/tips");
    if (!Array.isArray(tips)) { $("apply-tip-list").innerHTML = ERR("Couldn't load tips."); return; }
    applyTips = tips.map(t => ({ id: t.id, content: t.content, tags: t.tags.slice() }));
    const list = $("apply-tip-list");
    list.innerHTML = "";
    applyTips.forEach(tip => list.appendChild(renderApplyRow(tip)));
    refreshApplyState();
    $("apply-tag-input").focus();
  }

  function renderApplyRow(tip) {
    const row = document.createElement("div");
    row.className = "apply-tip";
    row.dataset.id = tip.id;
    row.innerHTML = `<div class="apply-check">✓</div>
      <div class="apply-tip-main"><div class="apply-tip-content"></div><div class="apply-tip-tags"></div></div>`;
    row.querySelector(".apply-tip-content").textContent = tip.content;
    row.querySelector(".apply-tip-tags").textContent = tip.tags.map(t => "#" + t).join(" ");
    row.onclick = () => toggleApplyTip(tip, row);
    return row;
  }

  async function toggleApplyTip(tip, row) {
    const name = applyTagName();
    if (!name) { toast("Type a tag name first."); $("apply-tag-input").focus(); return; }
    const has = tip.tags.includes(name);
    const updated = has
      ? await api("DELETE", `/api/tips/${tip.id}/tags/${encodeURIComponent(name)}`)
      : await api("POST", `/api/tips/${tip.id}/tags`, { tag: name, tier: $("apply-tag-tier").value });
    if (updated.error) { toast(updated.error); return; }
    tip.tags = updated.tags;
    row.querySelector(".apply-tip-tags").textContent = tip.tags.map(t => "#" + t).join(" ");
    row.classList.toggle("checked", tip.tags.includes(name));
    updateApplySummary();
  }

  // Reflect which tips already have the active tag, and whether it's new or existing.
  function refreshApplyState() {
    const name = applyTagName();
    document.querySelectorAll("#apply-tip-list .apply-tip").forEach(row => {
      const tip = applyTips.find(t => String(t.id) === row.dataset.id);
      row.classList.toggle("checked", !!name && tip.tags.includes(name));
    });
    const existing = name ? allTags.find(t => t.name === name) : null;
    const tierSel = $("apply-tag-tier");
    if (existing) {
      tierSel.value = existing.tier;
      tierSel.disabled = true;                       // can't re-tier an existing tag here
      $("apply-tier-note").textContent = "existing " + existing.tier + " tag";
    } else {
      tierSel.disabled = false;
      $("apply-tier-note").textContent = name ? "new tag" : "";
    }
    updateApplySummary();
  }

  function updateApplySummary() {
    const name = applyTagName();
    if (!name) { $("apply-summary").textContent = "Type a tag, then click tips to add it."; return; }
    const n = applyTips.filter(t => t.tags.includes(name)).length;
    $("apply-summary").innerHTML = `<b>${n}</b> tip${n !== 1 ? "s" : ""} tagged <b>#${escHtml(name)}</b>`;
  }

  function applyFilter() {
    const q = $("apply-filter").value.trim().toLowerCase();
    document.querySelectorAll("#apply-tip-list .apply-tip").forEach(row => {
      const tip = applyTips.find(t => String(t.id) === row.dataset.id);
      row.classList.toggle("hidden", !!q && !tip.content.toLowerCase().includes(q));
    });
  }

  function closeApplyTag() {
    $("apply-overlay").classList.add("hidden");
    loadSidebar();        // the new tag now exists / counts changed
    renderCurrentView();  // weave it into the network / list / cards
  }

  $("apply-tag-btn").onclick = openApplyTag;
  $("apply-tag-input").oninput = refreshApplyState;
  $("apply-filter").oninput = applyFilter;
  $("apply-done").onclick = closeApplyTag;
  // close on backdrop click, refreshing the views
  (() => {
    const ov = $("apply-overlay");
    let down = false;
    ov.addEventListener("mousedown", e => { down = e.target === ov; });
    ov.addEventListener("mouseup", e => { if (down && e.target === ov) closeApplyTag(); down = false; });
  })();

  // ── Manage tags modal ─────────────────────────────────────────
  $("manage-tags-btn").onclick = async () => {
    $("manage-tags-status").textContent = "";
    $("manage-tags-overlay").classList.remove("hidden");
    await renderManageTagsList();
  };

  $("manage-tags-close").onclick = () => $("manage-tags-overlay").classList.add("hidden");

  dismissOnBackdrop("manage-tags-overlay");

  async function renderManageTagsList() {
    const tags = await api("GET", "/api/tags");
    const container = $("manage-tags-list");
    container.innerHTML = "";
    if (!tags.length) {
      container.innerHTML = '<div style="color:#aaa;font-size:0.85rem">No tags yet.</div>';
      return;
    }
    ["primary", "secondary"].forEach(tier => {
      const group = tags.filter(t => t.tier === tier);
      if (!group.length) return;
      const label = document.createElement("div");
      label.className = "palette-group-label";
      label.textContent = tier === "primary" ? "Primary" : "Secondary";
      container.appendChild(label);
      const row = document.createElement("div");
      row.className = "palette-row";
      group.forEach(t => {
        const btn = document.createElement("button");
        btn.className = "chip-remove tier-" + tier;
        btn.innerHTML = `${escHtml(t.name)} <span class="count" style="opacity:0.7">${t.count}</span> <span>×</span>`;
        btn.title = `Delete "${t.name}"`;
        btn.onclick = () => deleteTag(t.name, t.count);
        row.appendChild(btn);
      });
      container.appendChild(row);
    });
  }

  async function deleteTag(name, count) {
    const result = await api("DELETE", `/api/tags/${encodeURIComponent(name)}`);
    if (result.error) {
      $("manage-tags-status").style.color = "#c0392b";
      $("manage-tags-status").textContent = result.error;
      return;
    }
    $("manage-tags-status").style.color = "#5a8a2a";
    $("manage-tags-status").textContent = `Deleted "${name}"${result.tips_affected ? ` (was on ${result.tips_affected} tip${result.tips_affected !== 1 ? "s" : ""})` : ""}.`;
    // If the deleted tag was in the active filter, drop it.
    if (activeTags.includes(name)) {
      activeTags = activeTags.filter(t => t !== name);
    }
    await renderManageTagsList();
    loadSidebar();
    loadTips(activeTags.join(","));
    // If the open tip lost this tag, refresh the detail pane.
    if (selectedTip && selectedTip.tags.includes(name)) {
      const refreshed = await api("GET", `/api/tips?tags=`);  // cheap reload then find by id
      const updated = refreshed.find(t => t.id === selectedTip.id);
      if (updated) selectTip(updated);
    }
  }

  // ════════════════ Network view ════════════════════════════════
  // Tips are nodes, grouped into labelled REGIONS by their primary tag. Edges
  // (two tips sharing a secondary tag) stay hidden until you click a node, so
  // the resting view reads as clean, named clusters rather than a hairball.
  //   • click a region label / legend row → focus that group (fade + zoom-fit)
  //   • click a node → show its links + open the detail pane
  //   • Reset view / Escape → zoom back out to all regions

  const PRIMARY_COLORS = {
    achievement: "#ffd166", cognitive: "#9b8cff", emotional: "#ff70a6",
    financial: "#06d6a0", moral: "#4cc9f0", physical: "#ff9f1c", social: "#ef476f",
  };
  // Colours for any primary tags that aren't in the known set above.
  const FALLBACK_COLORS = ["#b5179e", "#80ed99", "#f8961e", "#43aa8b", "#f9c74f", "#577590"];

  const SVGNS = "http://www.w3.org/2000/svg";
  const SIM = { REPEL: 2600, CLUSTER_PULL: 0.055, DAMP: 0.84 };  // desktop full-network force sim

  const NET = {
    raf: null, nodes: [], edges: [], byId: {},
    canvas: null, ctx: null, svg: null,
    gViewport: null, gLabels: null, gNodes: null, gNodeLabels: null, gRegions: null,
    cw: 0, ch: 0, dpr: 1, W: 0, H: 0,
    alpha: 0, transform: { x: 0, y: 0, k: 1 },
    selected: null, expr: null, defaultOp: "OR", linkTargets: [], suggested: null,
    visited: new Set(), prevSelected: null, focus: null, colorMap: {},
    clusters: [], clusterByTag: {}, legendRows: {}, regionEdges: [],
    // Drill-down level: "overview" shows one bubble per region; "focus" shows the tips of
    // one region. Lets the network stay legible no matter how large the library grows.
    level: "overview",
    // Network link mode: "tags" (shared-secondary-tag expression) or "related" (semantic
    // neighbours). relatedK caps how many nearest-by-meaning links to draw. Persisted.
    linkMode: (() => { try { return localStorage.getItem("netLinkMode") || "tags"; } catch (e) { return "tags"; } })(),
    relatedK: 8,
  };

  const primaryTagOf = tip => tip.tags.find(t => tierOf(t) === "primary") || tip.tags[0] || null;
  const colorForTip = tip => NET.colorMap[primaryTagOf(tip)] || "#9aa6b2";

  function hexToRgba(hex, a) {
    const h = hex.replace("#", "");
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }

  function buildColorMap(tips) {
    const map = { ...PRIMARY_COLORS };
    let i = 0;
    tips.forEach(t => {
      const p = primaryTagOf(t);
      if (p && !(p in map)) map[p] = FALLBACK_COLORS[i++ % FALLBACK_COLORS.length];
    });
    NET.colorMap = map;
  }

  async function buildNetwork() {
    if (!allTags.length) await loadSidebar();  // need tiers to tell primary from secondary
    const tagStr = activeTags.join(",");
    const params = [];
    if (tagStr) params.push("tags=" + encodeURIComponent(tagStr));
    $("net-loading").classList.remove("hidden");
    const tips = await api("GET", "/api/tips" + (params.length ? "?" + params.join("&") : ""));
    $("net-loading").classList.add("hidden");
    if (!Array.isArray(tips)) { stopSim(); return; }  // network error already toasted

    NET.canvas = $("net-canvas");
    NET.ctx = NET.canvas.getContext("2d");
    NET.svg = $("net-svg");
    sizeNetwork();
    buildColorMap(tips);
    computeClusters(tips);

    NET.nodes = tips.map(makeNode);
    NET.byId = {};
    NET.nodes.forEach(n => (NET.byId[n.id] = n));

    // Edges: shared secondary tag → link. Weight = how many secondary tags two tips share.
    const secMap = {};
    tips.forEach(t => t.tags.forEach(tag => {
      if (tierOf(tag) === "secondary") (secMap[tag] ||= []).push(t.id);
    }));
    const edgeW = new Map();
    Object.values(secMap).forEach(ids => {
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const a = Math.min(ids[i], ids[j]), b = Math.max(ids[i], ids[j]);
          const key = a + "|" + b;
          edgeW.set(key, (edgeW.get(key) || 0) + 1);
        }
    });
    NET.edges = [];
    edgeW.forEach((w, key) => {
      const [a, b] = key.split("|").map(Number);
      NET.byId[a].deg++; NET.byId[b].deg++;
      NET.edges.push({ a, b, w });
    });

    // Roll those tip-tip edges up to region-region weights, for the overview's links.
    const regW = new Map();
    NET.edges.forEach(e => {
      const ra = primaryTagOf(NET.byId[e.a].tip), rb = primaryTagOf(NET.byId[e.b].tip);
      if (!ra || !rb || ra === rb) return;
      const key = ra < rb ? ra + "|" + rb : rb + "|" + ra;
      regW.set(key, (regW.get(key) || 0) + e.w);
    });
    NET.regionEdges = [...regW].map(([key, w]) => { const [a, b] = key.split("|"); return { a, b, w }; });

    NET.selected = null;
    NET.prevSelected = null;
    NET.focus = null;
    // Seed the suggestion memory from the user's persisted history (signed-in only);
    // anonymous users keep whatever they've visited this session.
    if (currentUser) NET.visited = await loadSeen();
    renderNetworkDom();
    renderLegend();
    NET.transform = { x: 0, y: 0, k: 1 };
    // Phones open on the region-bubble overview; tapping a bubble expands to the full network
    // (all regions at once — no zoom into one, nothing hidden). Desktop opens on the full network.
    if (isMobileNet()) showOverview(); else showFull();
  }

  // One cluster per primary tag, arranged evenly on a ring around the centre.
  function computeClusters(tips) {
    const counts = {};
    tips.forEach(t => { const p = primaryTagOf(t); if (p) counts[p] = (counts[p] || 0) + 1; });
    const tags = Object.keys(counts).sort();
    const cx = NET.W / 2, cy = NET.H / 2;
    // Elliptical ring matched to the viewport's aspect: a tall phone spreads clusters
    // vertically, a wide desktop horizontally — so the cloud fills the space instead of
    // sitting as a small circle with empty margins around it.
    const Rx = NET.W * 0.32, Ry = NET.H * 0.30;
    const single = tags.length <= 1;
    NET.clusters = tags.map((tag, i) => {
      const ang = -Math.PI / 2 + (i / tags.length) * Math.PI * 2;
      return {
        tag, color: NET.colorMap[tag], count: counts[tag],
        x: single ? cx : cx + Math.cos(ang) * Rx,
        y: single ? cy : cy + Math.sin(ang) * Ry,
        radius: 18 + Math.sqrt(counts[tag]) * 6,
        labelEl: null,
      };
    });
    NET.clusterByTag = {};
    NET.clusters.forEach(c => (NET.clusterByTag[c.tag] = c));
  }

  function makeNode(tip) {
    const c = NET.clusterByTag[primaryTagOf(tip)] || { x: NET.W / 2, y: NET.H / 2 };
    return { id: tip.id, tip, x: c.x + (Math.random() - 0.5) * 70, y: c.y + (Math.random() - 0.5) * 70, vx: 0, vy: 0, deg: 0, r: 5, el: null };
  }

  function sizeNetwork() {
    const rect = $("network-view").getBoundingClientRect();
    NET.W = rect.width; NET.H = rect.height;
    NET.dpr = window.devicePixelRatio || 1;
    NET.cw = NET.W * NET.dpr; NET.ch = NET.H * NET.dpr;
    NET.canvas.width = NET.cw; NET.canvas.height = NET.ch;
    NET.svg.setAttribute("viewBox", `0 0 ${NET.W} ${NET.H}`);
  }

  // SVG layers (all inside one pan/zoom viewport <g>): region labels, nodes, node labels.
  function renderNetworkDom() {
    NET.svg.innerHTML = "";
    NET.gViewport = document.createElementNS(SVGNS, "g");
    NET.gRegions = document.createElementNS(SVGNS, "g");   // overview: one bubble per region
    NET.gLabels = document.createElementNS(SVGNS, "g");
    NET.gNodes = document.createElementNS(SVGNS, "g");
    NET.gNodeLabels = document.createElementNS(SVGNS, "g");
    NET.gViewport.append(NET.gRegions, NET.gNodes, NET.gNodeLabels, NET.gLabels);
    NET.svg.appendChild(NET.gViewport);

    NET.clusters.forEach(c => {
      // Region bubble (overview level): a translucent disc sized by tip count, tap to drill in.
      const g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", "region-bubble");
      g.addEventListener("click", e => { e.stopPropagation(); toggleFocus(c.tag); });
      const disc = document.createElementNS(SVGNS, "circle");
      disc.setAttribute("cx", c.x); disc.setAttribute("cy", c.y); disc.setAttribute("r", c.radius);
      disc.setAttribute("fill", hexToRgba(c.color, 0.20));
      disc.setAttribute("stroke", c.color); disc.setAttribute("stroke-width", "2");
      const cnt = document.createElementNS(SVGNS, "text");
      cnt.setAttribute("x", c.x); cnt.setAttribute("y", c.y);
      cnt.setAttribute("class", "region-count"); cnt.textContent = c.count;
      g.append(disc, cnt);
      c.bubbleEl = g;
      NET.gRegions.appendChild(g);

      const t = document.createElementNS(SVGNS, "text");
      t.setAttribute("class", "cluster-label");
      t.textContent = c.tag;
      t.style.fill = c.color;
      t.addEventListener("click", e => { e.stopPropagation(); toggleFocus(c.tag); });
      c.labelEl = t;
      NET.gLabels.appendChild(t);
    });

    // Auto-scale node sizes to how many tips are shown: more nodes → smaller dots
    // (area ∝ 1/N ⇒ radius ∝ 1/√N), so a bigger bank doesn't crowd the canvas.
    // Degree still sets the hub-vs-loner contrast, normalised so it holds at any N.
    const nodeCount = NET.nodes.length;
    const maxDeg = NET.nodes.reduce((m, x) => Math.max(m, x.deg), 1);
    const sizeScale = Math.max(0.5, Math.min(1.25, Math.sqrt(110 / nodeCount)));

    NET.nodes.forEach(n => {
      const norm = Math.pow(n.deg / maxDeg, 0.7);   // 0 (isolated) … 1 (busiest node)
      n.r = (3.5 + norm * 11) * sizeScale;
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("r", n.r);
      const color = colorForTip(n.tip);
      c.setAttribute("fill", color);
      c.setAttribute("class", "net-node");
      c.style.color = color;  // drives the currentColor glow on hover/select
      c.addEventListener("mouseenter", e => onNodeHover(n, e));
      c.addEventListener("mousemove", moveTooltip);
      c.addEventListener("mouseleave", () => onNodeOut(n));
      c.addEventListener("click", e => { e.stopPropagation(); selectNode(n); });
      n.el = c;
      NET.gNodes.appendChild(c);
    });

    positionClusterLabels();
    positionNodes();
  }

  function positionClusterLabels() {
    const cx = NET.W / 2, cy = NET.H / 2;
    NET.clusters.forEach(c => {
      let dx = c.x - cx, dy = c.y - cy, d = Math.hypot(dx, dy);
      if (d < 1 || NET.clusters.length <= 1) { dx = 0; dy = -1; d = 1; }  // push single label upward
      const off = c.radius + 18;
      c.labelEl.setAttribute("x", c.x + (dx / d) * off);
      c.labelEl.setAttribute("y", c.y + (dy / d) * off);
    });
  }

  function positionNodes() {
    NET.nodes.forEach(n => { n.el.setAttribute("cx", n.x); n.el.setAttribute("cy", n.y); });
  }

  function applyTransform() {
    const { x, y, k } = NET.transform;
    if (NET.gViewport) NET.gViewport.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
    drawCanvas();
  }

  // Draw lines from the selected node to its current link targets, coloured by region.
  // Targets are all edge-neighbours, or — when a card tag is chosen — just the tips
  // that share that one tag (see applySelectionHighlight).
  function drawCanvas() {
    const ctx = NET.ctx, dpr = NET.dpr, { x, y, k } = NET.transform;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, NET.cw, NET.ch);
    const sel = NET.selected;
    // Nothing selected: in the overview, draw the faint inter-region links between bubbles.
    if (sel == null) {
      if (NET.level === "overview" && NET.regionEdges.length) {
        ctx.setTransform(k * dpr, 0, 0, k * dpr, x * dpr, y * dpr);
        ctx.lineCap = "round";
        const maxW = NET.regionEdges.reduce((m, e) => Math.max(m, e.w), 1);
        NET.regionEdges.forEach(e => {
          const A = NET.clusterByTag[e.a], B = NET.clusterByTag[e.b];
          if (!A || !B) return;
          const t = e.w / maxW;
          ctx.lineWidth = (1 + t * 5) / k;
          ctx.strokeStyle = `rgba(255,255,255,${0.05 + t * 0.16})`;
          ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
        });
      }
      return;
    }
    // A tip is selected: draw the links from it to its associated tips (its ego-network).
    if (!NET.linkTargets.length && NET.suggested == null) return;
    ctx.setTransform(k * dpr, 0, 0, k * dpr, x * dpr, y * dpr);
    ctx.lineCap = "round";
    const A = NET.byId[sel];
    // regular links in the region colour
    ctx.lineWidth = 1.4 / k;
    ctx.strokeStyle = hexToRgba(colorForTip(A.tip), 0.6);
    NET.linkTargets.forEach(id => {
      if (id === NET.suggested) return;  // the suggested link is drawn separately
      const B = NET.byId[id];
      if (!B) return;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    });
    // the suggested link: brighter gold + thicker
    const S = NET.byId[NET.suggested];
    if (S) {
      ctx.lineWidth = 2.6 / k;
      ctx.strokeStyle = "rgba(255,207,51,0.95)";
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(S.x, S.y); ctx.stroke();
    }
  }

  // ── Force simulation (desktop full-network view): repulsion + pull to region centre ──
  function startSim() {
    cancelAnimationFrame(NET.raf);
    NET.alpha = 1;
    const step = () => {
      simTick();
      positionNodes();
      drawCanvas();
      NET.alpha *= 0.985;
      if (NET.alpha > 0.025) {
        NET.raf = requestAnimationFrame(step);
      } else {
        NET.raf = null;
        frameCurrentLevel();  // tidy final framing
      }
    };
    NET.raf = requestAnimationFrame(step);
  }
  function stopSim() { cancelAnimationFrame(NET.raf); NET.raf = null; }

  function simTick() {
    const nodes = NET.nodes, n = nodes.length, a = NET.alpha;
    const MIN_D = 12, MAX_V = 28;  // distance floor + speed cap keep the sim stable
    for (let i = 0; i < n; i++) {       // pairwise repulsion
      const A = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const B = nodes[j];
        let dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.001) { const ang = Math.random() * 6.283; dx = Math.cos(ang); dy = Math.sin(ang); d = 1; }
        const eff = Math.max(d, MIN_D);            // floor distance so near-coincident pairs don't explode
        const f = (SIM.REPEL / (eff * eff)) * a;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        A.vx -= fx; A.vy -= fy; B.vx += fx; B.vy += fy;
      }
    }
    nodes.forEach(nd => {               // pull to region centre, damp, cap speed, integrate, clamp
      const c = NET.clusterByTag[primaryTagOf(nd.tip)];
      if (c) { nd.vx += (c.x - nd.x) * SIM.CLUSTER_PULL * a; nd.vy += (c.y - nd.y) * SIM.CLUSTER_PULL * a; }
      nd.vx *= SIM.DAMP; nd.vy *= SIM.DAMP;
      const sp = Math.hypot(nd.vx, nd.vy);
      if (sp > MAX_V) { nd.vx = nd.vx / sp * MAX_V; nd.vy = nd.vy / sp * MAX_V; }
      nd.x += nd.vx; nd.y += nd.vy;
      const pad = nd.r + 6;
      nd.x = Math.max(pad, Math.min(NET.W - pad, nd.x));
      nd.y = Math.max(pad, Math.min(NET.H - pad, nd.y));
    });
  }

  function scatterNodes() {
    NET.nodes.forEach(n => {
      const c = NET.clusterByTag[primaryTagOf(n.tip)] || { x: NET.W / 2, y: NET.H / 2 };
      n.x = c.x + (Math.random() - 0.5) * 70; n.y = c.y + (Math.random() - 0.5) * 70; n.vx = 0; n.vy = 0;
    });
  }

  // ── Selection (a node's ego-network) ──
  // Persist a visit for signed-in users (server-side, so it survives logout/login).
  async function markSeen(id) {
    if (!currentUser) return;  // anonymous users only have in-session memory
    try { await api("POST", `/api/tips/${id}/seen`, {}); } catch (e) {}
  }
  async function loadSeen() {
    const data = await api("GET", "/api/seen");
    return new Set(data.seen || []);
  }

  function selectNode(n) {
    NET.prevSelected = NET.selected;  // remember where we came from (anti-loop)
    NET.selected = n.id;
    NET.visited.add(n.id);            // record the visit so it won't be re-suggested
    markSeen(n.id);                   // ...and persist it to the user's account
    // Build a fresh tag expression from this tip's secondary tags. Every tag is included,
    // joined by the last gate you chose (NET.defaultOp) so it persists across selections.
    const sec = n.tip.tags.filter(t => tierOf(t) === "secondary");
    NET.expr = {
      tags: sec,
      ops: sec.slice(1).map(() => NET.defaultOp),  // one operator between each consecutive pair
      included: sec.map(() => true),
    };
    applySelectionHighlight();
    showCard(n.tip);
    updateExprHint();
    // On a phone, keep the bubble map framed above the card (the tip sits on its bubble).
    if (isMobileNet()) frameCurrentLevel();
    // Semantic neighbours power both the meaning-mode gold suggestion and related-link mode.
    const needsRelated = (suggestMode === "meaning" || NET.linkMode === "related") && embeddingsEnabled;
    if (needsRelated && !relatedCache[n.id]) {
      fetchRelated(n.id).then(() => {
        if (NET.selected === n.id) { applySelectionHighlight(); updateExprHint(); }
      });
    }
  }

  // True if `candidateTags` satisfies the current tag expression. Included tags are
  // folded left-to-right; each tag joins the running result with the operator on its left.
  function exprMatches(candidateTags) {
    const { tags, ops, included } = NET.expr;
    let result = null;
    for (let i = 0; i < tags.length; i++) {
      if (!included[i]) continue;
      const has = candidateTags.includes(tags[i]);
      if (result === null) result = has;
      else result = ops[i - 1] === "AND" ? (result && has) : (result || has);
    }
    return result === null ? false : result;  // nothing included → no links
  }

  // Recompute which tips the selected node links to (per the expression), pick the
  // suggested next tip, dim the rest, and redraw.
  function applySelectionHighlight() {
    const selId = NET.selected;
    let targets;
    if (NET.linkMode === "related" && embeddingsEnabled) {
      // Links are this tip's nearest neighbours by meaning (top relatedK that are on screen).
      const rel = (relatedCache[selId] || []).filter(r => NET.byId[r.tip_id] && r.tip_id !== selId);
      targets = rel.slice(0, NET.relatedK).map(r => r.tip_id);
      const note = $("net-card-related-note");
      if (note) note.textContent = relatedCache[selId]
        ? `Linked to the ${targets.length} closest tip${targets.length !== 1 ? "s" : ""} by meaning.`
        : "Finding the closest tips by meaning…";
    } else {
      targets = NET.nodes
        .filter(m => m.id !== selId && exprMatches(m.tip.tags))
        .map(m => m.id);
    }
    // In a focused region we only draw links to tips within that region (cross-region
    // structure is shown at the overview level instead).
    if (isMobileNet() && NET.level === "focus") targets = targets.filter(id => primaryTagOf(NET.byId[id].tip) === NET.focus);
    NET.linkTargets = targets;
    NET.suggested = pickSuggestedFor(selId, targets);
    const keep = new Set([selId, ...targets]);
    if (NET.suggested != null) keep.add(NET.suggested);  // meaning-mode pick may be off the tag-links
    NET.nodes.forEach(m => {
      m.el.classList.toggle("dim", !keep.has(m.id));
      m.el.classList.toggle("sel", m.id === selId);
      m.el.classList.toggle("suggested", m.id === NET.suggested);
    });
    if (isMobileNet()) layoutEgoAtRegions();   // place the tip + its links on the bubble map
    drawCanvas();
  }

  // Secondary-tag profile of the user's favourites (= their upvoted tips), as {tag: count}.
  // Built from the loaded network, so it stays current as the user upvotes.
  function favoriteTagFreq() {
    const freq = {};
    NET.nodes.forEach(m => {
      if (m.tip.my_vote === 1) {  // favourited == upvoted
        m.tip.tags.forEach(t => {
          if (tierOf(t) === "secondary") freq[t] = (freq[t] || 0) + 1;
        });
      }
    });
    return freq;
  }

  // The "next suggested tip" is ranked by, in order:
  //   1. shared INCLUDED secondary tags with the present tip (relevance to where you are),
  //   2. affinity with your favourites' secondary tags (your taste),
  //   3. vote score.
  function pickSuggested(targets) {
    if (!targets.length) return null;
    // Memory: never suggest a tip already visited this session, so each suggestion is
    // new and can't ping-pong back. If every reachable tip has been seen, forget the
    // history (but keep the current + previous tip excluded) and start cycling afresh.
    let pool = targets.filter(id => !NET.visited.has(id));
    if (!pool.length) {
      // Everything reachable from here is already seen — keep the memory intact, but
      // still move forward: avoid only the current and previous tip so it won't bounce.
      pool = targets.filter(id => id !== NET.selected && id !== NET.prevSelected);
      if (!pool.length) pool = targets;
    }
    const incl = NET.expr.tags.filter((t, i) => NET.expr.included[i]);
    const favFreq = favoriteTagFreq();
    let best = null, bestShared = -1, bestFav = -1, bestScore = -Infinity;
    pool.forEach(id => {
      const tip = NET.byId[id].tip;
      const shared = incl.reduce((n, t) => n + (tip.tags.includes(t) ? 1 : 0), 0);
      const fav = tip.tags.reduce((n, t) => n + (tierOf(t) === "secondary" ? (favFreq[t] || 0) : 0), 0);
      const sc = tip.score || 0;
      if (shared > bestShared ||
          (shared === bestShared && fav > bestFav) ||
          (shared === bestShared && fav === bestFav && sc > bestScore)) {
        best = id; bestShared = shared; bestFav = fav; bestScore = sc;
      }
    });
    return best;
  }

  // Fetch (and cache) the semantic neighbours of a tip. The server computes these from the
  // stored vectors, so it's a cheap lookup with no model call.
  async function fetchRelated(id) {
    if (relatedCache[id]) return relatedCache[id];
    const res = await api("GET", `/api/tips/${id}/related?k=30`);
    relatedCache[id] = (res && res.related) || [];
    return relatedCache[id];
  }

  // From a ranked related list, pick the next tip to suggest: most-similar first, but only
  // among tips currently loaded (respects tag/favourite filters) and not already visited.
  // Falls back gracefully so we always move forward rather than getting stuck.
  function pickFromRelated(currentId) {
    const rel = (relatedCache[currentId] || []).filter(r => NET.byId[r.tip_id] && r.tip_id !== currentId);
    let pool = rel.filter(r => !NET.visited.has(r.tip_id));
    if (!pool.length) pool = rel.filter(r => r.tip_id !== NET.prevSelected && r.tip_id !== currentId);
    if (!pool.length) pool = rel;
    return pool.length ? pool[0].tip_id : null;
  }

  // Choose the suggested tip using whichever engine is active. In "meaning" mode we use the
  // semantic neighbours (if already fetched); otherwise the tag-overlap ranking.
  function pickSuggestedFor(selId, targets) {
    if (suggestMode === "meaning" && embeddingsEnabled && relatedCache[selId]) {
      return pickFromRelated(selId);
    }
    return pickSuggested(targets);
  }

  function clearNetSelection() {
    NET.selected = null;
    NET.expr = null;
    NET.linkTargets = [];
    NET.suggested = null;
    // NB: deliberately KEEP NET.visited / NET.prevSelected — deselecting must not wipe
    // the visited history, or re-selecting would walk back through already-seen tips.
    NET.nodes.forEach(m => m.el.classList.remove("dim", "sel", "suggested"));
    if (isMobileNet()) NET.gNodes.style.display = "none";   // back to the bubbles-only overview
    NET.gNodeLabels.innerHTML = "";
    hideCard();
    drawCanvas();
    resetHint();
    // On a phone, the card just freed its space — reframe the bubble map.
    if (isMobileNet()) frameCurrentLevel();
  }

  // ── Selected-tip card: full text + tag-expression builder ──
  function showCard(tip) {
    $("net-card-content").textContent = tip.content;
    $("net-card-anecdote").textContent = tip.anecdote || "";
    $("net-card-actions").innerHTML = tipControlsHTML(tip);
    bindTipControls($("net-card-actions"), tip, () => {
      // upvoting changes the favourites profile → re-pick the suggested tip
      if (NET.selected != null) { applySelectionHighlight(); updateExprHint(); }
    });
    renderLinkModeUI();
    renderTagExpr();
    $("net-tooltip").style.display = "none";   // the card supersedes any lingering hover tooltip
    $("net-card").classList.remove("hidden");
  }
  function hideCard() { $("net-card").classList.add("hidden"); }

  // ── Link mode: tag-expression links vs semantic "related" links ──
  function renderLinkModeUI() {
    const wrap = $("net-card-linkmode");
    if (!wrap) return;
    wrap.style.display = embeddingsEnabled ? "flex" : "none";
    const related = NET.linkMode === "related" && embeddingsEnabled;
    $("linkmode-tags").classList.toggle("active", !related);
    $("linkmode-related").classList.toggle("active", related);
    // The secondary-tag expression builder only makes sense in tag mode.
    $("net-card-tags-label").style.display = related ? "none" : "";
    $("net-card-tags").style.display = related ? "none" : "";
    $("net-card-related-note").style.display = related ? "" : "none";
  }

  function setLinkMode(mode) {
    NET.linkMode = mode;
    try { localStorage.setItem("netLinkMode", mode); } catch (e) {}
    renderLinkModeUI();
    if (NET.selected == null) return;
    const id = NET.selected;
    if (mode === "related" && embeddingsEnabled && !relatedCache[id]) {
      fetchRelated(id).then(() => { if (NET.selected === id) { applySelectionHighlight(); updateExprHint(); } });
    } else {
      applySelectionHighlight(); updateExprHint();
    }
  }

  // Render the secondary-tag expression: a chip per tag (click to include/leave out)
  // with an OR/AND button between each (click to toggle). Recomputes the links live.
  function renderTagExpr() {
    const wrap = $("net-card-tags");
    wrap.innerHTML = "";
    const { tags, ops, included } = NET.expr;
    if (!tags.length) {
      wrap.innerHTML = `<span class="net-expr-empty">No secondary tags on this tip.</span>`;
      return;
    }
    tags.forEach((t, i) => {
      if (i > 0) {
        const opBtn = document.createElement("button");
        opBtn.className = "net-op " + ops[i - 1].toLowerCase();
        opBtn.textContent = ops[i - 1];
        opBtn.title = "Switch between AND / OR";
        opBtn.onclick = e => {
          e.stopPropagation();
          ops[i - 1] = ops[i - 1] === "OR" ? "AND" : "OR";
          NET.defaultOp = ops[i - 1];   // remember the gate for future selections
          renderTagExpr(); applySelectionHighlight(); updateExprHint();
        };
        wrap.appendChild(opBtn);
      }
      const chip = document.createElement("button");
      chip.className = "net-card-tag tier-secondary" + (included[i] ? "" : " excluded");
      chip.textContent = "#" + t;
      chip.title = included[i] ? "Click to leave this tag out" : "Click to include this tag";
      chip.onclick = e => {
        e.stopPropagation();
        included[i] = !included[i];
        renderTagExpr(); applySelectionHighlight(); updateExprHint();
      };
      wrap.appendChild(chip);
    });
  }

  // A readable form of the active expression, e.g. "#focus AND #morning".
  function describeExpr() {
    const { tags, ops, included } = NET.expr;
    const parts = [];
    for (let i = 0; i < tags.length; i++) {
      if (!included[i]) continue;
      if (parts.length) parts.push(ops[i - 1]);
      parts.push("#" + tags[i]);
    }
    return parts.join(" ");
  }

  function updateExprHint() {
    if (NET.linkMode === "related" && embeddingsEnabled) {
      const c = NET.linkTargets.length;
      const sug = NET.suggested != null
        ? ` · <span style="color:#ffcf33;font-weight:700">●</span> next suggested tip`
        : "";
      $("net-hint").innerHTML =
        `Linked to the <b>${c}</b> closest tip${c !== 1 ? "s" : ""} <b>by meaning</b>${sug} · switch to <b>Tags</b> to combine secondary tags`;
      return;
    }
    const c = NET.linkTargets.length;
    const expr = describeExpr();
    if (!expr) { $("net-hint").innerHTML = `Pick at least one tag to show links`; return; }
    const sug = NET.suggested != null
      ? ` · <span style="color:#ffcf33;font-weight:700">●</span> next suggested tip`
      : "";
    $("net-hint").innerHTML =
      `Links where <b>${escHtml(expr)}</b> — <b>${c}</b> tip${c !== 1 ? "s" : ""}${sug} · click tags to include/leave out, OR/AND to switch`;
  }

  // ── Drill-down levels: region overview ⇄ one region's tips ──
  const focusedNodes = () => NET.nodes.filter(m => primaryTagOf(m.tip) === NET.focus);

  // Pseudo-nodes at the region bubbles, so fitTo can frame the overview constellation.
  const regionPoints = () => NET.clusters.map(c => ({ x: c.x, y: c.y, r: c.radius + 22 }));

  function frameCurrentLevel() {
    if (NET.level === "overview") fitTo(regionPoints());
    else if (NET.level === "full") fitTo(NET.nodes);
    else fitTo(focusedNodes());
  }

  // Clicking a region: phones drill into it (overview ⇄ focus); desktop just spotlights it
  // within the full network (full ⇄ focus).
  function toggleFocus(tag) {
    // Phones: tap a bubble → land on a random tip from that region and show its links, while
    // the bubble map stays put; you then hop tip-to-tip by tapping the linked tips.
    if (isMobileNet()) { const n = pickRandomFromRegion(tag); if (n) selectNode(n); return; }
    (NET.level === "focus" && NET.focus === tag) ? showFull() : desktopFocus(tag);
  }

  // Overview: just the region bubbles (+ their links). Individual tips are hidden.
  function showOverview() {
    if (NET.selected != null) clearNetSelection();
    NET.level = "overview"; NET.focus = null;
    NET.gNodes.style.display = "none"; NET.gNodeLabels.style.display = "none";
    NET.gRegions.style.display = "";
    NET.clusters.forEach(c => { c.labelEl.style.display = ""; c.labelEl.classList.remove("faded"); });
    Object.values(NET.legendRows).forEach(el => el.classList.remove("active"));
    fitTo(regionPoints());
    resetHint();
  }

  // Phones: a random tip from a region — the entry point when you tap a bubble.
  function pickRandomFromRegion(tag) {
    const ns = NET.nodes.filter(m => primaryTagOf(m.tip) === tag);
    return ns.length ? ns[Math.floor(Math.random() * ns.length)] : null;
  }

  // Phones: show the selected tip + its linked tips as nodes sitting on their home region
  // bubbles (everything else hidden), so the bubble map persists while you navigate tip-to-tip.
  function layoutEgoAtRegions() {
    NET.gNodes.style.display = "";
    const ego = new Set([NET.selected, ...NET.linkTargets]);
    if (NET.suggested != null) ego.add(NET.suggested);
    const byRegion = {};
    NET.nodes.forEach(m => {
      if (!ego.has(m.id)) { m.el.style.display = "none"; return; }
      m.el.style.display = "";
      (byRegion[primaryTagOf(m.tip)] ||= []).push(m);
    });
    Object.entries(byRegion).forEach(([tag, ns]) => {
      const c = NET.clusterByTag[tag] || { x: NET.W / 2, y: NET.H / 2 };
      ns.forEach((m, i) => {
        if (ns.length === 1) { m.x = c.x; m.y = c.y; return; }
        const ang = -Math.PI / 2 + (i / ns.length) * Math.PI * 2;
        const r = Math.max(c.radius * 0.66, 16);
        m.x = c.x + Math.cos(ang) * r; m.y = c.y + Math.sin(ang) * r;
      });
    });
    positionNodes();
  }

  // Focus: drill into one region — only its tips show.
  function applyFocusVisibility() {
    NET.nodes.forEach(m => { m.el.style.display = primaryTagOf(m.tip) === NET.focus ? "" : "none"; });
  }

  // Lay a region's tips out as an even golden-angle disc. They were positioned in the
  // context of the whole network, so on their own they'd look lopsided; this spreads them
  // evenly (and means we never run the O(n²) force sim, so it scales to any library size).
  function layoutRegion(tag) {
    const c = NET.clusterByTag[tag] || { x: NET.W / 2, y: NET.H / 2 };
    const ns = NET.nodes.filter(m => primaryTagOf(m.tip) === tag);
    for (let i = ns.length - 1; i > 0; i--) {   // shuffle so Re-layout gives a fresh arrangement
      const j = Math.floor(Math.random() * (i + 1)); [ns[i], ns[j]] = [ns[j], ns[i]];
    }
    const GA = Math.PI * (3 - Math.sqrt(5));     // golden angle → even sunflower packing
    const a = Math.sqrt(Math.max(NET.H, 1) / Math.max(NET.W, 1));  // gently match the viewport
    ns.forEach((m, i) => {
      const r = 30 * Math.sqrt(i + 0.5);
      m.x = c.x + Math.cos(i * GA) * r / a; m.y = c.y + Math.sin(i * GA) * r * a;
    });
    positionNodes();
  }

  function showFocus(tag) {
    if (NET.selected != null) clearNetSelection();
    stopSim();
    NET.level = "focus"; NET.focus = tag;
    NET.gRegions.style.display = "none";
    NET.gNodes.style.display = ""; NET.gNodeLabels.style.display = "";
    applyFocusVisibility();
    layoutRegion(tag);
    NET.clusters.forEach(c => { c.labelEl.style.display = c.tag === tag ? "" : "none"; });
    Object.entries(NET.legendRows).forEach(([t, el]) => el.classList.toggle("active", t === tag));
    fitTo(focusedNodes());
    resetHint();
  }

  // ── Desktop: the full force-directed network (all tips at once) ──
  function showFull() {
    if (NET.selected != null) clearNetSelection();
    NET.level = "full"; NET.focus = null;
    NET.gRegions.style.display = "none";
    NET.gNodes.style.display = ""; NET.gNodeLabels.style.display = "";
    NET.nodes.forEach(m => { m.el.style.display = ""; m.el.classList.remove("faded"); });
    NET.clusters.forEach(c => { c.labelEl.style.display = ""; c.labelEl.classList.remove("faded"); });
    Object.values(NET.legendRows).forEach(el => el.classList.remove("active"));
    startSim();   // lays out every node; settles, then frames the whole network
    resetHint();
  }

  // Desktop "focus a region": fade the rest (keep them on screen for context), zoom to fit.
  function desktopFocus(tag) {
    if (NET.selected != null) clearNetSelection();
    NET.level = "focus"; NET.focus = tag;
    NET.nodes.forEach(m => { m.el.style.display = ""; m.el.classList.toggle("faded", primaryTagOf(m.tip) !== tag); });
    NET.clusters.forEach(c => { c.labelEl.style.display = ""; c.labelEl.classList.toggle("faded", c.tag !== tag); });
    Object.entries(NET.legendRows).forEach(([t, el]) => el.classList.toggle("active", t === tag));
    fitTo(focusedNodes());
    resetHint();
  }

  function isMobileNet() {
    return window.matchMedia("(max-width: 700px), (orientation: landscape) and (max-height: 520px)").matches;
  }

  // Screen-space to keep clear of nodes when framing: the top controls, and — on a phone,
  // where the card is a bottom sheet — the open card itself. Lets fitTo frame the network
  // into the *visible* area rather than centring it under the card / controls.
  function viewInsets() {
    const mob = isMobileNet();
    const ins = { top: 16, right: 12, bottom: mob ? 14 : 50, left: 12 };
    const ctrls = $("net-controls");
    if (ctrls && !ctrls.classList.contains("hidden")) ins.top = ctrls.getBoundingClientRect().height + (mob ? 16 : 26);
    const card = $("net-card");
    if (mob && card && !card.classList.contains("hidden")) {
      ins.bottom = Math.min(NET.H * 0.58, card.getBoundingClientRect().height + 16);
    }
    return ins;
  }

  // The selected node plus everything it currently links to (its ego-network).
  function egoNodes() {
    const ids = new Set([NET.selected, ...NET.linkTargets]);
    if (NET.suggested != null) ids.add(NET.suggested);
    const ns = NET.nodes.filter(n => ids.has(n.id));
    return ns.length ? ns : NET.nodes.filter(n => n.id === NET.selected);
  }

  function fitTo(nodes) {
    if (!nodes || !nodes.length) return;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    nodes.forEach(n => {
      minx = Math.min(minx, n.x - n.r); miny = Math.min(miny, n.y - n.r);
      maxx = Math.max(maxx, n.x + n.r); maxy = Math.max(maxy, n.y + n.r);
    });
    const ins = viewInsets();
    const availW = Math.max(60, NET.W - ins.left - ins.right);
    const availH = Math.max(60, NET.H - ins.top - ins.bottom);
    // Overview needs extra horizontal room so the left/right region labels don't clip; a
    // focused region only has one centred label, so it can use the width.
    const padX = NET.level === "overview" ? Math.min(80, NET.W * 0.12) : Math.min(40, NET.W * 0.06);
    const padY = Math.min(50, NET.H * 0.04);
    const bw = (maxx - minx) + padX * 2, bh = (maxy - miny) + padY * 2;
    const k = Math.max(0.35, Math.min(2.4, Math.min(availW / bw, availH / bh)));
    const ccx = (minx + maxx) / 2, ccy = (miny + maxy) / 2;
    const tcx = ins.left + availW / 2, tcy = ins.top + availH / 2;   // centre of the clear area
    NET.transform = { k, x: tcx - ccx * k, y: tcy - ccy * k };
    applyTransform();
  }

  function resetView() {
    if (activeTags.length) {
      // A tag filter is active → clear it and reload the full network.
      activeTags = [];
      loadTips("");
      loadSidebar();
      buildNetwork();
    } else if (isMobileNet()) {
      showOverview();   // phones: back to the region-bubble overview
    } else {
      showFull();       // desktop: clear selection + focus, show the whole network
    }
  }

  // ── Status line / hint ──
  function resetHint() {
    if (activeTags.length) {
      $("net-hint").innerHTML = `Filtered to <b>#${escHtml(activeTags.join(" · #"))}</b> — <b>Reset view</b> brings back all tips`;
    } else if (NET.level === "focus") {
      $("net-hint").innerHTML = `Exploring <b>${escHtml(NET.focus)}</b> — click a tip for its links · Reset to zoom out`;
    } else if (NET.level === "overview") {
      $("net-hint").innerHTML = NET.selected != null
        ? `Tap a <b>linked tip</b> to hop to it · <b>Reset</b> for the regions`
        : `Tap a <b>region</b> to land on a tip · then follow its links`;
    } else if (isMobileNet()) {
      $("net-hint").innerHTML = `Tap a <b>tip</b> for its links · pinch to zoom · <b>Reset</b> for the overview`;
    } else {
      $("net-hint").innerHTML = `Click a <b>region</b> to focus it · click a <b>node</b> for its links &amp; details · scroll to zoom · drag to pan`;
    }
  }

  // ── Hover tooltip ──
  function onNodeHover(n, e) {
    // Touch devices have no real hover — a tap fires mouseenter too, which would leave the
    // tooltip stuck on screen next to the card (a confusing "second card"). Skip it there.
    if (window.matchMedia("(hover: none)").matches) return;
    if (NET.selected == null) n.el.classList.add("hover");
    const tip = n.tip;
    const snippet = tip.content.length > 130 ? tip.content.slice(0, 127) + "…" : tip.content;
    $("net-tooltip").innerHTML =
      `<div>${escHtml(snippet)}</div>
       <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
         ${tip.tags.map(t => `<span style="font-size:0.66rem;padding:1px 7px;border-radius:10px;background:rgba(255,255,255,0.13)">${escHtml(t)}</span>`).join("")}
       </div>`;
    $("net-tooltip").style.display = "block";
    moveTooltip(e);
  }
  function moveTooltip(e) {
    const tt = $("net-tooltip");
    if (tt.style.display !== "block") return;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + tt.offsetWidth > window.innerWidth - 10) x = e.clientX - tt.offsetWidth - 14;
    if (y + tt.offsetHeight > window.innerHeight - 10) y = e.clientY - tt.offsetHeight - 14;
    tt.style.left = x + "px"; tt.style.top = y + "px";
  }
  function onNodeOut(n) { n.el.classList.remove("hover"); $("net-tooltip").style.display = "none"; }

  // ── Legend (also a navigation control: click a row to focus that region) ──
  function renderLegend() {
    const legend = $("net-legend");
    legend.innerHTML = `<div class="legend-title">Regions (primary tag)</div>`;
    NET.legendRows = {};
    NET.clusters.forEach(c => {
      const row = document.createElement("div");
      row.className = "legend-row";
      row.innerHTML =
        `<span class="legend-dot" style="background:${c.color};color:${c.color}"></span>` +
        `<span class="legend-name">${escHtml(c.tag)}</span>` +
        `<span class="legend-count">${c.count}</span>`;
      row.onclick = () => toggleFocus(c.tag);
      NET.legendRows[c.tag] = row;
      legend.appendChild(row);
    });
  }

  // ── Pan / zoom / background-click ──
  function initNetInteractions() {
    const view = $("network-view"), svg = $("net-svg");
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    svg.addEventListener("mousedown", e => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = NET.transform.x; oy = NET.transform.y;
    });
    window.addEventListener("mousemove", e => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      NET.transform.x = ox + dx; NET.transform.y = oy + dy;
      applyTransform();
    });
    window.addEventListener("mouseup", e => {
      if (dragging && !moved && e.target === svg && NET.selected != null) clearNetSelection();
      dragging = false;
    });
    view.addEventListener("wheel", e => {
      e.preventDefault();
      const rect = view.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const k0 = NET.transform.k;
      const k = Math.max(0.3, Math.min(4, k0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      NET.transform.x = mx - (mx - NET.transform.x) * (k / k0);
      NET.transform.y = my - (my - NET.transform.y) * (k / k0);
      NET.transform.k = k;
      applyTransform();
    }, { passive: false });
  }

  // ════════════════ Card (sequential) view ══════════════════════
  // Reuses the network's data + suggestion engine, but renders one tip at a time
  // and advances along the "next suggested tip" chain (with the same visited memory).

  // Build the minimal tip data the suggestion engine needs (no graph rendering).
  async function loadTipData() {
    if (!allTags.length) await loadSidebar();
    const tagStr = activeTags.join(",");
    const params = [];
    if (tagStr) params.push("tags=" + encodeURIComponent(tagStr));
    const tips = await api("GET", "/api/tips" + (params.length ? "?" + params.join("&") : ""));
    if (!Array.isArray(tips)) return false;
    NET.nodes = tips.map(tip => ({ id: tip.id, tip }));
    NET.byId = {};
    NET.nodes.forEach(n => (NET.byId[n.id] = n));
    if (currentUser) NET.visited = await loadSeen();  // persisted per-account memory
    return true;
  }

  async function enterCardView() {
    cardBackStack = [];
    toggleRedirect(false);
    $("cv-content").innerHTML = SPINNER;
    $("cv-anecdote").textContent = ""; $("cv-tags").innerHTML = ""; $("cv-actions").innerHTML = "";
    const ok = await loadTipData();
    if (!ok) { $("cv-content").innerHTML = ERR("Couldn't load tips."); return; }
    if (!NET.nodes.length) { renderCardEmpty(); return; }
    // start at the first not-yet-seen tip (so returning users continue), else the first
    const start = NET.nodes.find(m => !NET.visited.has(m.id)) || NET.nodes[0];
    showCardTip(start.id);
  }

  function showCardTip(id) {
    cardCurrent = id;
    NET.selected = id;
    NET.visited.add(id);
    markSeen(id);            // persist the visit (signed-in users)
    computeCardNext();
    renderCard(NET.byId[id].tip);
  }

  // Work out the next suggested tip from the current one (default OR over its secondary
  // tags) using the shared ranking + memory, and update the nav buttons.
  async function computeCardNext() {
    const tip = NET.byId[cardCurrent].tip;
    if (suggestMode === "meaning" && embeddingsEnabled) {
      await fetchRelated(cardCurrent);             // semantic next: most similar unseen tip
      cardNextId = pickFromRelated(cardCurrent);
    } else {
      const sec = tip.tags.filter(t => tierOf(t) === "secondary");
      NET.expr = { tags: sec, ops: sec.slice(1).map(() => "OR"), included: sec.map(() => true) };
      NET.selected = cardCurrent;
      const targets = NET.nodes.filter(m => m.id !== cardCurrent && exprMatches(m.tip.tags)).map(m => m.id);
      cardNextId = pickSuggested(targets);
    }
    $("cv-next").disabled = cardNextId == null;
    $("cv-prev").disabled = cardBackStack.length === 0;
  }

  function renderCard(tip) {
    $("cv-content").textContent = tip.content;
    $("cv-anecdote").textContent = tip.anecdote || "";
    $("cv-tags").innerHTML = tip.tags.map(t => `<span class="chip">${escHtml(t)}</span>`).join("");
    $("cv-actions").innerHTML = tipControlsHTML(tip);
    // a vote changes your favourites profile → re-pick the next tip
    bindTipControls($("cv-actions"), tip, () => computeCardNext());
  }

  function renderCardEmpty() {
    $("cv-content").textContent = "No tips to show.";
    $("cv-anecdote").textContent = "";
    $("cv-tags").innerHTML = "";
    $("cv-actions").innerHTML = "";
    cardNextId = null;
    $("cv-next").disabled = true;
    $("cv-prev").disabled = true;
  }

  function cardNext() {
    if (cardNextId == null) return;
    cardBackStack.push(cardCurrent);
    NET.prevSelected = cardCurrent;
    showCardTip(cardNextId);
  }
  function cardPrev() {
    if (!cardBackStack.length) return;
    const prev = cardBackStack.pop();
    NET.prevSelected = cardBackStack.length ? cardBackStack[cardBackStack.length - 1] : null;
    showCardTip(prev);
  }
  async function cardRestart() {
    NET.visited = new Set();
    NET.prevSelected = null;
    await api("POST", "/api/seen/reset", {});  // clear persisted history too (if signed in)
    enterCardView();
  }

  // ── Change course: let the reader redirect the trail by theme or by description ──
  function toggleRedirect(force) {
    const panel = $("cv-redirect");
    const open = force === undefined ? panel.classList.contains("hidden") : force;
    panel.classList.toggle("hidden", !open);
    $("cv-change-course").setAttribute("aria-expanded", String(open));
    if (open) { renderRedirectGroups(); $("cv-redirect-status").textContent = ""; }
  }

  // Chips for every primary group present in the loaded tips, coloured like the network.
  function renderRedirectGroups() {
    if (!Object.keys(NET.colorMap).length) buildColorMap(NET.nodes.map(m => m.tip));  // region colours
    const groups = [...new Set(NET.nodes.map(m => primaryTagOf(m.tip)).filter(Boolean))].sort();
    const wrap = $("cv-redirect-groups");
    wrap.innerHTML = "";
    groups.forEach(tag => {
      const b = document.createElement("button");
      b.className = "cv-group-chip";
      b.textContent = tag;
      const color = NET.colorMap[tag] || "var(--accent)";
      b.style.borderColor = color; b.style.color = color;
      b.onclick = () => jumpToGroup(tag);
      wrap.appendChild(b);
    });
  }

  // Move to a tip, remembering where we were so Back still works, and close the panel.
  function jumpToCard(id) {
    if (id == null || !NET.byId[id]) return false;
    if (cardCurrent != null) { cardBackStack.push(cardCurrent); NET.prevSelected = cardCurrent; }
    toggleRedirect(false);
    showCardTip(id);
    return true;
  }

  // Pick a tip from a primary group — a not-yet-seen one if possible, at random for variety.
  function jumpToGroup(tag) {
    const inGroup = NET.nodes.filter(m => primaryTagOf(m.tip) === tag && m.id !== cardCurrent);
    let pool = inGroup.filter(m => !NET.visited.has(m.id));
    if (!pool.length) pool = inGroup;
    if (!pool.length) { $("cv-redirect-status").textContent = "No other tips in that theme yet."; return; }
    jumpToCard(pool[Math.floor(Math.random() * pool.length)].id);
  }

  // Pick the tip that best matches a free-text direction (semantic if available, else keywords).
  async function jumpToDescription(q) {
    q = (q || "").trim();
    if (!q) { $("cv-redirect-input").focus(); return; }
    const status = $("cv-redirect-status");
    status.style.color = "var(--text-tertiary)";
    status.textContent = "Finding a tip about that…";
    const url = (embeddingsEnabled ? "/api/tips/search?q=" : "/api/tips/fts?q=") + encodeURIComponent(q);
    const res = await api("GET", url);
    const results = (res && res.results) || [];
    // Prefer the closest match that's loaded and not yet seen; fall back so we always move.
    const hit = results.find(t => NET.byId[t.id] && !NET.visited.has(t.id))
             || results.find(t => NET.byId[t.id]);
    if (!hit) { status.style.color = "var(--danger)"; status.textContent = `Nothing matched “${q}”.`; return; }
    jumpToCard(hit.id);
  }

  // ── Card-view swipe gestures (Tinder-style: drag right = save, left = skip) ──
  // Pointer events cover both touch and mouse. Right past the threshold saves the tip (an
  // upvote/favourite) then advances; left just advances. Buttons inside the card still work.
  async function saveTipForSwipe(tip) {
    if (!requireLogin()) return false;          // not signed in → prompt, don't save
    if (tip.my_vote === 1) return true;          // already saved
    const u = await api("POST", `/api/tips/${tip.id}/vote`, { value: 1 });
    if (!u || u.error) { toast((u && u.error) || "Couldn't save."); return false; }
    Object.assign(tip, u);
    return true;
  }

  function resetSwipeBadges() {
    $("cv-card").querySelectorAll(".cv-swipe-badge").forEach(b => { b.style.opacity = 0; });
  }

  let cvAnimating = false;
  function commitSwipe(dir) {
    const card = $("cv-card");
    const off = dir === "save" ? 1 : -1;
    cvAnimating = true;
    card.classList.remove("swiping");
    card.style.transition = "transform var(--motion) var(--ease), opacity var(--motion) var(--ease)";
    card.style.transform = `translateX(${off * 130}%) rotate(${off * 14}deg)`;
    card.style.opacity = "0";
    const cur = cardCurrent;
    setTimeout(async () => {
      if (dir === "save" && cur != null && NET.byId[cur]) await saveTipForSwipe(NET.byId[cur].tip);
      const advanced = cardNextId != null;
      if (advanced) cardNext();                  // re-renders the card with the next tip
      // snap the (possibly new) card straight back to centre — no rAF, so it can't get
      // stuck off-screen if the tab is backgrounded; the outgoing fling is the feedback
      card.style.transition = "none";
      card.style.transform = "";
      card.style.opacity = "";
      resetSwipeBadges();
      cvAnimating = false;
      if (!advanced) toast(dir === "save" ? "Saved — that's the last suggested tip." : "That's the last suggested tip.");
    }, 190);
  }

  function initCardSwipe() {
    const card = $("cv-card");
    const saveBadge = card.querySelector(".cv-swipe-badge.save");
    const skipBadge = card.querySelector(".cv-swipe-badge.skip");
    const THRESH = 95;
    let dragging = false, decided = false, horizontal = false, startX = 0, startY = 0, dx = 0;

    card.addEventListener("pointerdown", e => {
      if (cvAnimating || cardCurrent == null) return;
      if (e.target.closest("button, a, input, textarea, select")) return;  // keep controls clickable
      dragging = true; decided = false; horizontal = false;
      startX = e.clientX; startY = e.clientY; dx = 0;
      card.style.transition = "none";
      try { card.setPointerCapture(e.pointerId); } catch (_) {}
    });
    card.addEventListener("pointermove", e => {
      if (!dragging) return;
      dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        horizontal = Math.abs(dx) > Math.abs(dy);
        decided = true;
        if (!horizontal) { dragging = false; return; }   // vertical intent → let the page scroll
        card.classList.add("swiping");
      }
      card.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
      const t = Math.min(Math.abs(dx) / THRESH, 1);
      if (saveBadge) saveBadge.style.opacity = dx > 0 ? t : 0;
      if (skipBadge) skipBadge.style.opacity = dx < 0 ? t : 0;
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove("swiping");
      if (horizontal && Math.abs(dx) > THRESH) {
        commitSwipe(dx > 0 ? "save" : "skip");
      } else {                                    // snap back
        card.style.transition = "transform var(--motion) var(--ease)";
        card.style.transform = "";
        resetSwipeBadges();
      }
    };
    card.addEventListener("pointerup", finish);
    card.addEventListener("pointercancel", finish);
  }

  function setView(v) {
    currentView = v;
    $("view-list").classList.toggle("active", v === "list");
    $("view-network").classList.toggle("active", v === "network");
    $("view-cards").classList.toggle("active", v === "cards");
    $("view-advise").classList.toggle("active", v === "advise");
    $("view-favorites").classList.toggle("active", v === "favorites");
    renderCurrentView();
  }

  // Decide which panel to show and render it. In Network/Cards views the favourites
  // filter swaps the graph/sequence for a vertical, scrollable list of favourite cards.
  function renderCurrentView() {
    searchActive = false;                 // any normal view render leaves semantic-search mode
    $("search-results").style.display = "none";
    const v = currentView;
    // The three-pane List layout (tag sidebar + list + detail) only appears in the List view,
    // and only for admins. Every other view is clean, full-width main content.
    const listPanes = isAdmin && v === "list";
    $("sidebar").style.display = listPanes ? "" : "none";
    if (!listPanes) $("detail-pane").classList.add("hidden");
    if (v !== "favorites") closeFavAnalysis();   // the "explore this tip" pane is favorites-only
    // Mobile: the tag sidebar is a slide-in drawer; its toggle only exists in List view.
    $("sidebar-toggle").classList.toggle("avail", listPanes);
    if (!listPanes) document.body.classList.remove("drawer-open");
    $("tip-list").style.display = v === "list" ? "flex" : "none";
    $("network-view").style.display = v === "network" ? "block" : "none";
    $("card-view").style.display = v === "cards" ? "flex" : "none";
    $("advise-view").style.display = v === "advise" ? "flex" : "none";
    $("fav-list").style.display = v === "favorites" ? "flex" : "none";
    if (v !== "network") { stopSim(); $("net-tooltip").style.display = "none"; }
    if (v === "favorites") renderFavList();
    else if (v === "network") buildNetwork();
    else if (v === "cards") enterCardView();
    else if (v === "advise") enterAdviseView();
    else if (v === "list") loadTips(activeTags.join(","));
  }

  // Vertical, scrollable list of the user's favourite tips (with vote controls).
  async function renderFavList() {
    const params = ["favorites=1"];
    const tagStr = activeTags.join(",");
    if (tagStr) params.push("tags=" + encodeURIComponent(tagStr));
    const list = $("fav-list");
    list.innerHTML = SPINNER;
    const tips = await api("GET", "/api/tips?" + params.join("&"));
    if (!Array.isArray(tips)) { list.innerHTML = ERR("Couldn't load favorites."); return; }
    const canReflect = embeddingsEnabled && tips.length >= 3;
    list.innerHTML =
      `<div class="fav-list-head">★ Your favorites${tips.length ? " (" + tips.length + ")" : ""}` +
      (canReflect ? `<button class="btn secondary" id="fav-reflect-btn" title="Use AI to reflect on what your saved tips say about you">✨ Reflect on these</button>` : "") +
      `</div>`;
    if (canReflect) $("fav-reflect-btn").onclick = openFavInsights;
    if (!tips.length) {
      list.insertAdjacentHTML("beforeend",
        `<div id="empty-state">No favorites yet — upvote a tip (▲) to save it.</div>`);
      return;
    }
    tips.forEach(tip => {
      const card = document.createElement("div");
      card.className = "tip-card";
      card.innerHTML = `
        <div class="vote-col">
          <button class="vote-btn up${tip.my_vote === 1 ? " on" : ""}" title="Upvote (saves to favorites)" aria-label="Upvote">▲</button>
          <span class="vote-score">${tip.score}</span>
          <button class="vote-btn down${tip.my_vote === -1 ? " on" : ""}" title="Downvote" aria-label="Downvote">▼</button>
        </div>
        <div class="tip-main">
          <div class="tip-content">${escHtml(tip.content)}</div>
          ${tip.tags.length ? `<div class="tip-tags">${tip.tags.map(t => `<span class="chip">${escHtml(t)}</span>`).join("")}</div>` : ""}
        </div>`;
      card.dataset.id = tip.id;
      card.classList.toggle("selected", selectedFav?.id === tip.id);
      card.onclick = () => openFavAnalysis(tip);   // open the analysis pane (vote clicks stopPropagation)
      // removing your upvote drops it from favourites → re-render the list
      bindTipControls(card, tip, () => { if (!tip.favorited) renderFavList(); });
      list.appendChild(card);
    });
    if (selectedFav && !tips.some(t => t.id === selectedFav.id)) closeFavAnalysis();
  }

  // ── "Explore this tip" pane (Favorites view): pick an analysis lens, generated on demand ──
  let selectedFav = null;
  const ANALYSIS_LABELS = {
    apply: "How to apply it in typical situations",
    avoid: "When not to apply it",
    opposing: "Opposing wisdom",
    misreadings: "Common misreadings",
    figures: "Notable figures who applied it",
  };

  function openFavAnalysis(tip) {
    selectedFav = tip;
    $("analysis-tip").textContent = tip.content;
    $("analysis-video").innerHTML = tip.video_embed ? videoEmbedHtml(tip.video_embed) : "";  // further info
    document.querySelectorAll(".analysis-opt").forEach(b => {
      b.classList.remove("active");
      b.disabled = !llmEnabled;
    });
    $("analysis-result").innerHTML = llmEnabled
      ? `<div class="analysis-hint">Pick an angle above to generate an analysis of this tip.</div>`
      : `<div class="analysis-hint">AI analysis isn't configured.</div>`;
    $("analysis-pane").classList.remove("hidden");
    document.querySelectorAll("#fav-list .tip-card, #search-results .tip-card").forEach(c =>
      c.classList.toggle("selected", Number(c.dataset.id) === tip.id));
  }

  async function runFavAnalysis(lens, btn) {
    if (!selectedFav) return;
    document.querySelectorAll(".analysis-opt").forEach(b => b.classList.toggle("active", b === btn));
    const out = $("analysis-result");
    const heading = `<div class="analysis-label">${escHtml(ANALYSIS_LABELS[lens] || "")}</div>`;
    out.innerHTML = heading + `<div class="advise-thinking">${SPINNER}<span>Thinking it through…</span></div>`;
    const res = await api("POST", `/api/tips/${selectedFav.id}/analyze`, { lens });
    if (res.error) { out.innerHTML = heading + ERR(res.error); return; }
    const points = res.points || [];
    out.innerHTML = heading + (points.length
      ? `<ul class="analysis-list">${points.map(p => `<li>${escHtml(p)}</li>`).join("")}</ul>`
      : `<div class="analysis-hint">No analysis came back — try another angle.</div>`);
  }

  function closeFavAnalysis() {
    selectedFav = null;
    $("analysis-pane").classList.add("hidden");
    document.querySelectorAll("#fav-list .tip-card").forEach(c => c.classList.remove("selected"));
  }

  $("analysis-close").onclick = closeFavAnalysis;
  document.querySelectorAll(".analysis-opt").forEach(b => { b.onclick = () => runFavAnalysis(b.dataset.lens, b); });

  // ════════════════ Ask-for-advice view (RAG) ═══════════════════
  // The user describes a situation; the server retrieves the most relevant tips by meaning
  // and Gemini writes advice grounded in them. We then show which tips it drew on.
  function enterAdviseView() {
    const input = $("advise-input");
    if (input && !input.value) setTimeout(() => input.focus(), 0);
  }

  async function runAdvise() {
    const situation = $("advise-input").value.trim();
    if (!situation) { $("advise-input").focus(); return; }
    const btn = $("advise-btn"), out = $("advise-result");
    btn.disabled = true;
    out.innerHTML = `<div class="advise-thinking">${SPINNER}<span>Reading your tips and thinking it through…</span></div>`;
    const res = await api("POST", "/api/advise", { situation });
    btn.disabled = false;
    if (res.error) { out.innerHTML = ERR(res.error); return; }
    renderAdvice(res);
  }

  function renderAdvice(res) {
    const out = $("advise-result");
    const used = new Set(res.used || []);
    const tips = res.tips || [];
    // Prefer the tips the model cited; if it cited none, show all the retrieved ones.
    const drawn = tips.filter(t => used.has(t.id));
    const list = drawn.length ? drawn : tips;
    out.innerHTML =
      `<div class="advise-answer">${escHtml(res.answer || "").replace(/\n/g, "<br>")}</div>` +
      (list.length ? `<div class="advise-source-label">Drawn from these tips</div><div class="advise-tips"></div>` : "");
    const wrap = out.querySelector(".advise-tips");
    if (!wrap) return;
    list.forEach(tip => {
      const card = document.createElement("div");
      card.className = "tip-card";
      const pct = tip.similarity != null ? `<span class="sim-badge">${Math.round(tip.similarity * 100)}%</span>` : "";
      card.innerHTML = `
        <div class="vote-col">
          <button class="vote-btn up${tip.my_vote === 1 ? " on" : ""}" title="Save to favorites" aria-label="Save to favorites">▲</button>
          <span class="vote-score">${tip.score}</span>
          <button class="vote-btn down${tip.my_vote === -1 ? " on" : ""}" title="Downvote" aria-label="Downvote">▼</button>
        </div>
        <div class="tip-main">
          <div class="tip-content">${escHtml(tip.content)}</div>
          ${tip.tags.length ? `<div class="tip-tags">${tip.tags.map(t => `<span class="chip">${escHtml(t)}</span>`).join("")}</div>` : ""}
        </div>${pct}`;
      bindTipControls(card, tip);   // ▲ saves to favourites, like every other tip card
      wrap.appendChild(card);
    });
  }

  $("advise-btn").onclick = runAdvise;
  $("advise-input").onkeydown = e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAdvise();  // ⌘/Ctrl+Enter to submit
  };

  // ════════════════ Favorites insights ══════════════════════════
  // Reflect on the signed-in user's favourite tips: themes, what resonates, and small steps.
  async function openFavInsights() {
    $("insights-regen").style.display = "none";
    $("insights-overlay").classList.remove("hidden");
    await runFavInsights();
  }

  async function runFavInsights() {
    const body = $("insights-body");
    $("insights-regen").style.display = "none";
    body.innerHTML = `<div class="advise-thinking">${SPINNER}<span>Reading your favourites and reflecting…</span></div>`;
    const res = await api("POST", "/api/favorites/insights", {});
    if (res.error) { body.innerHTML = ERR(res.error); if (!res._network) $("insights-regen").style.display = ""; return; }
    renderFavInsights(res.insight, res.count);
    $("insights-regen").style.display = "";
  }

  function renderFavInsights(ins, count) {
    const questions = (ins.questions || []).map(q => `<li>${escHtml(q)}</li>`).join("");
    const experiments = (ins.experiments || []).map(x => `<li>${escHtml(x)}</li>`).join("");
    $("insights-body").innerHTML =
      `<div class="insights-count">From the ${count} tip${count !== 1 ? "s" : ""} you chose out of the whole library</div>` +
      (ins.pattern ? `<div class="advise-answer">${escHtml(ins.pattern).replace(/\n/g, "<br>")}</div>` : "") +
      (questions ? `<div class="insights-label">Questions to sit with</div><ul class="insights-list">${questions}</ul>` : "") +
      (experiments ? `<div class="insights-label">Experiments to try this week</div><ul class="insights-list">${experiments}</ul>` : "");
  }

  $("insights-close").onclick = () => $("insights-overlay").classList.add("hidden");
  $("insights-regen").onclick = runFavInsights;
  dismissOnBackdrop("insights-overlay");

  // ════════════════ Community submissions ═══════════════════════
  // Any signed-in user can suggest a tip; it enters a moderation queue admins review.
  function openSuggest() {
    $("suggest-content").value = ""; $("suggest-anecdote").value = ""; $("suggest-tags").value = "";
    $("suggest-status").textContent = "";
    $("suggest-history").innerHTML = "";
    $("suggest-overlay").classList.remove("hidden");
    $("suggest-content").focus();
    loadSuggestHistory();
  }
  // the "Suggest a tip" button is rendered in the header (next to Admin) by renderAuth.
  $("suggest-cancel").onclick = () => $("suggest-overlay").classList.add("hidden");
  dismissOnBackdrop("suggest-overlay");

  async function loadSuggestHistory() {
    const res = await api("GET", "/api/submissions/mine");
    renderSuggestHistory((res && res.submissions) || []);
  }
  function renderSuggestHistory(subs) {
    const wrap = $("suggest-history");
    if (!subs.length) { wrap.innerHTML = ""; return; }
    const label = s => s === "approved" ? "Added ✓" : (s === "rejected" ? "Not used" : "Pending");
    wrap.innerHTML = `<div class="suggest-hist-label">Your recent suggestions</div>` +
      subs.map(s =>
        `<div class="suggest-hist-row"><span class="suggest-hist-text">${escHtml(s.content)}</span>` +
        `<span class="sub-status ${s.status}">${label(s.status)}</span></div>`).join("");
  }

  $("suggest-submit").onclick = async () => {
    const content = $("suggest-content").value.trim();
    if (!content) { $("suggest-content").focus(); return; }
    const anecdote = $("suggest-anecdote").value.trim();
    const tags = $("suggest-tags").value.split(",").map(t => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean);
    $("suggest-submit").disabled = true;
    const res = await api("POST", "/api/submissions", { content, anecdote, tags });
    $("suggest-submit").disabled = false;
    if (res.error) { $("suggest-status").style.color = "var(--danger)"; $("suggest-status").textContent = res.error; return; }
    // keep the modal open so the user sees their tip land in the queue
    $("suggest-content").value = ""; $("suggest-anecdote").value = ""; $("suggest-tags").value = "";
    $("suggest-status").style.color = "var(--accent)";
    $("suggest-status").textContent = "Thanks — your tip is in the review queue.";
    toast("Thanks! Your tip is in the review queue.");
    loadSuggestHistory();
  };

  // ── Admin: moderation queue ──
  let reviewItems = [];
  async function openReview() {
    $("review-overlay").classList.remove("hidden");
    $("review-status").textContent = "";
    $("review-suggest-btn").style.display = llmEnabled ? "" : "none";
    $("review-list").innerHTML = SPINNER;
    const res = await api("GET", "/api/submissions?status=pending");
    if (!res || !res.submissions) { $("review-list").innerHTML = ERR("Couldn't load submissions."); return; }
    reviewItems = res.submissions.map(s => ({ id: s.id, content: s.content, anecdote: s.anecdote, tags: s.tags.slice(), submitter: s.submitter }));
    renderReviewList();
  }

  function renderReviewList() {
    const list = $("review-list");
    list.innerHTML = "";
    if (!reviewItems.length) {
      list.innerHTML = `<div id="empty-state">No tips awaiting review. 🎉</div>`;
      updateReviewSummary();
      return;
    }
    reviewItems.forEach(item => list.appendChild(renderReviewRow(item)));
    updateReviewSummary();
  }

  function renderReviewRow(item) {
    const row = document.createElement("div");
    row.className = "review-row";
    const meta = document.createElement("div");
    meta.className = "review-meta";
    meta.textContent = item.submitter ? `Suggested by ${item.submitter}` : "Suggested anonymously";
    const content = document.createElement("input");
    content.className = "review-content"; content.type = "text"; content.value = item.content;
    content.oninput = () => { item.content = content.value; };
    const tags = document.createElement("input");
    tags.className = "review-tags"; tags.type = "text"; tags.value = item.tags.join(", ");
    tags.placeholder = "tags, comma-separated — first is primary";
    tags.oninput = () => { item.tags = tags.value.split(",").map(s => s.replace(/^#/, "").trim().toLowerCase()).filter(Boolean); };
    const actions = document.createElement("div");
    actions.className = "review-actions";
    const reject = document.createElement("button");
    reject.className = "btn secondary"; reject.textContent = "Reject";
    const approve = document.createElement("button");
    approve.className = "btn"; approve.textContent = "Approve";
    reject.onclick = () => decideReview(item, "reject", row);
    approve.onclick = () => decideReview(item, "approve", row);
    actions.append(reject, approve);
    row.append(meta, content, tags);
    if (item.anecdote) {
      const anec = document.createElement("div");
      anec.className = "review-anec"; anec.textContent = item.anecdote;
      row.append(anec);
    }
    row.append(actions);
    return row;
  }

  async function decideReview(item, action, row) {
    let res;
    if (action === "approve") {
      if (!item.tags.length) { toast("Add at least one tag (the first becomes the primary)."); return; }
      res = await api("POST", `/api/submissions/${item.id}/approve`,
                      { content: item.content.trim(), anecdote: item.anecdote, tags: item.tags });
    } else {
      res = await api("POST", `/api/submissions/${item.id}/reject`, {});
    }
    if (res.error) { toast(res.error); return; }
    reviewItems = reviewItems.filter(x => x.id !== item.id);
    row.remove();
    if (!reviewItems.length) renderReviewList();   // show the "all clear" empty state
    updateReviewSummary();
    pendingCount = Math.max(0, pendingCount - 1);
    updateReviewBtn();
    if (action === "approve") {
      $("review-status").style.color = "var(--accent)";
      $("review-status").textContent = "Approved — added to the collection.";
      loadSidebar();              // tag counts changed
    } else {
      $("review-status").style.color = "var(--text-secondary)";
      $("review-status").textContent = "Rejected.";
    }
  }

  function updateReviewSummary() {
    const n = reviewItems.length;
    $("review-summary").textContent = n ? `${n} tip${n !== 1 ? "s" : ""} awaiting review` : "";
  }

  // ✨ Suggest tags for submissions that don't have any (reuses the Gemini/Groq tagging endpoint).
  async function reviewSuggestTags() {
    const empties = reviewItems.filter(i => i.content.trim() && !i.tags.length);
    if (!empties.length) { toast("Every submission already has tags."); return; }
    const btn = $("review-suggest-btn"); const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Suggesting…";
    const res = await api("POST", "/api/llm/suggest-tags", { contents: empties.map(i => i.content.trim()) });
    btn.disabled = false; btn.textContent = label;
    if (res.error) { toast(res.error); return; }
    (res.suggestions || []).forEach((sug, idx) => {
      const item = empties[idx]; if (!item) return;
      const tags = [];
      if (sug.primary) tags.push(sug.primary);
      (sug.secondary || []).forEach(t => { if (!tags.includes(t)) tags.push(t); });
      if (tags.length) item.tags = tags;
    });
    renderReviewList();
  }

  $("review-subs-btn").onclick = openReview;
  $("review-close").onclick = () => $("review-overlay").classList.add("hidden");
  $("review-suggest-btn").onclick = reviewSuggestTags;
  dismissOnBackdrop("review-overlay");

  // ── Init ──────────────────────────────────────────────────────
  $("view-list").onclick = () => setView("list");
  $("view-network").onclick = () => setView("network");
  $("view-cards").onclick = () => setView("cards");
  $("view-advise").onclick = () => setView("advise");
  $("cv-next").onclick = cardNext;
  $("cv-prev").onclick = cardPrev;
  $("cv-restart").onclick = cardRestart;
  $("cv-change-course").onclick = () => toggleRedirect();
  $("cv-redirect-go").onclick = () => jumpToDescription($("cv-redirect-input").value);
  $("cv-redirect-input").onkeydown = e => { if (e.key === "Enter") jumpToDescription($("cv-redirect-input").value); };
  initCardSwipe();
  $("net-suggest-mode").onclick = flipSuggestMode;
  $("cv-suggest-mode").onclick = flipSuggestMode;
  $("linkmode-tags").onclick = () => setLinkMode("tags");
  $("linkmode-related").onclick = () => setLinkMode("related");
  $("net-reset").onclick = resetView;
  // Re-layout reshuffles the tips of the region you're exploring (no-op in the overview).
  $("net-relayout").onclick = () => { scatterNodes(); startSim(); };   // re-run the force layout
  $("net-clear-history").onclick = async () => {
    NET.visited = new Set();
    NET.prevSelected = null;
    await api("POST", "/api/seen/reset", {});  // clears the server-side history too (if signed in)
    if (NET.selected != null) {                // keep the tip you're on as "seen", re-pick
      NET.visited.add(NET.selected);
      applySelectionHighlight();
      updateExprHint();
    }
  };
  $("net-card-close").onclick = clearNetSelection;

  // ── Full screen ──
  function toggleFullscreen() {
    const el = $("network-view");
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    }
  }
  $("net-fullscreen").onclick = toggleFullscreen;
  function onFullscreenChange() {
    const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    $("net-fullscreen").textContent = fs ? "⛶ Exit full screen" : "⛶ Full screen";
    // the panel just resized to/from the whole screen — re-sync the layers and reframe
    if (currentView === "network" && NET.nodes.length) {
      sizeNetwork();
      frameCurrentLevel();
    }
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  initNetInteractions();
  window.addEventListener("keydown", e => {
    // Esc exits full screen (browser default); only reset the view when NOT full screen.
    if (currentView === "network" && e.key === "Escape" && !document.fullscreenElement) resetView();
  });
  // Keep the canvas (edges) and SVG (nodes) sized to the panel. This matters
  // because clicking a node opens the detail pane, which narrows #network-view —
  // without re-syncing, the two layers scale differently and edges drift off the dots.
  function onNetResize() {
    if (currentView !== "network" || !NET.nodes.length) return;
    const rect = $("network-view").getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return;  // hidden / mid-transition
    sizeNetwork();
    frameCurrentLevel();  // reframe to the new box, keep layout
  }
  if (window.ResizeObserver) {
    new ResizeObserver(onNetResize).observe($("network-view"));
  } else {
    window.addEventListener("resize", onNetResize);
  }

  $("view-favorites").onclick = () => setView("favorites");

  // ── Mobile navigation: tag-filter drawer + full-screen detail overlay ──
  $("sidebar-toggle").onclick = () => document.body.classList.toggle("drawer-open");
  $("drawer-backdrop").onclick = () => document.body.classList.remove("drawer-open");
  // picking a tag inside the drawer closes it so the filtered list is visible
  $("sidebar").addEventListener("click", e => {
    if (e.target.closest(".tag-btn")) document.body.classList.remove("drawer-open");
  });
  // "Back" dismisses the full-screen tip editor on phones
  $("detail-close").onclick = () => {
    $("detail-pane").classList.add("hidden");
    document.querySelectorAll(".tip-card.selected").forEach(c => c.classList.remove("selected"));
  };

  // Admin login modal
  $("admin-cancel").onclick = () => $("admin-overlay").classList.add("hidden");
  $("admin-login-btn").onclick = adminLoginSubmit;
  $("admin-password").onkeydown = e => { if (e.key === "Enter") adminLoginSubmit(); };
  dismissOnBackdrop("admin-overlay");

  // Tips & Tags Management dropdown
  $("mgmt-toggle").onclick = e => { e.stopPropagation(); $("mgmt-menu").classList.toggle("hidden"); };
  $("mgmt-menu").addEventListener("click", closeMgmtMenu);  // close after choosing an action
  document.addEventListener("click", e => { if (!$("mgmt-wrap").contains(e.target)) closeMgmtMenu(); });

  // Bootstrap: figure out the role first, then show the right view/controls.
  (async () => {
    await loadMe();
    applyRolePermissions();
  })();
