(function () {
  "use strict";

  const STORAGE = {
    token: "ems-qbank-session-token-v2",
    adminToken: "ems-qbank-admin-token-v1"
  };

  const STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
    "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
    "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
    "UT", "VT", "VA", "WA", "WV", "WI", "WY"
  ];

  const GENERATION_ISSUES = [
    ["not_supported_by_source", "Not supported by source"],
    ["nonfunctional_distractor", "Nonfunctional distractor"],
    ["too_easy_cognitive_underreach", "Too easy / underreaches"],
    ["giveaway_in_question", "Giveaway in question"],
    ["not_clinically_current", "Not clinically current"],
    ["terminology_domain_fidelity", "Terminology/domain fidelity"],
    ["poor_confusing_wording", "Poor/confusing wording"],
    ["other", "Other"]
  ];

  const REVIEW_DISPOSITIONS = [
    ["accept_as_is", "Accept as is"],
    ["accept_with_revisions", "Accept with revisions"],
    ["major_revisions_needed", "Major revisions needed"],
    ["reject", "Reject"]
  ];

  const DISPLAY_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

  const TOPIC_GROUP_LABELS = {
    "1.1": "Medical Oversight",
    "1.2": "EMS Systems",
    "1.3": "EMS Personnel",
    "1.4": "EMS System Management",
    "1.5": "Crisis and Emergency Risk Communication",
    "2.1": "Resuscitation",
    "2.2": "Trauma",
    "2.3": "Medical Emergencies",
    "2.4": "Special Clinical Considerations",
    "3.1": "Quality Management",
    "3.2": "Research",
    "4.1": "Disaster Management",
    "4.2": "Mass Gathering",
    "4.3": "Fireground Operations",
    "4.4": "Tactical",
    "4.5": "Technical Rescue and Urban Search and Rescue",
    "4.6": "Wilderness",
    "4.7": "Mobile Integrated Healthcare / Community Paramedicine"
  };

  const app = document.getElementById("app");

  const state = {
    token: localStorage.getItem(STORAGE.token) || "",
    adminToken: localStorage.getItem(STORAGE.adminToken) || "",
    adminSummary: null,
    isAdmin: false,
    user: null,
    questions: [],
    poolCounts: null,
    reviews: {},
    progress: {},
    learnerSessions: {},
    learnerFlags: {},
    view: "auth",
    authMode: "login",
    pendingResetCode: "",
    message: null,
    loadError: "",
    learnerFilter: "all",
    learnerDomain: "all",
    learnerTopicGroup: "all",
    learnerTopic: "all",
    learnerQid: "",
    learnerQuizCount: 10,
    learnerSession: null,
    learnerFlagOpenQid: "",
    evaluatorFilter: "voting",
    evaluatorDomain: "all",
    evaluatorTopicGroup: "all",
    evaluatorTopic: "all",
    evaluatorQid: "",
    evaluatorHelpOpen: false
  };

  document.addEventListener("DOMContentLoaded", init);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  document.addEventListener("keydown", handleKeyDown);

  async function init() {
    if (consumePasswordResetCodeFromUrl()) {
      render();
      return;
    }
    try {
      if (state.token) {
        await loadSession();
        state.view = "menu";
      } else if (state.adminToken) {
        await loadAdmin();
        state.view = "admin";
      }
    } catch (error) {
      localStorage.removeItem(STORAGE.token);
      state.token = "";
      state.adminToken = "";
      state.isAdmin = false;
      state.user = null;
      state.loadError = "";
      setMessage("error", "Session expired. Please log in again.");
    }
    render();
  }

  function consumePasswordResetCodeFromUrl() {
    const url = new URL(window.location.href);
    let resetCode = url.searchParams.get("reset_code") || url.searchParams.get("resetCode") || "";
    if (!resetCode && url.hash) {
      const hashValue = url.hash.replace(/^#/, "");
      const hashParams = new URLSearchParams(hashValue.includes("=") ? hashValue : `reset_code=${hashValue}`);
      resetCode = hashParams.get("reset_code") || hashParams.get("resetCode") || "";
    }
    if (!resetCode) {
      return false;
    }
    state.pendingResetCode = resetCode;
    state.authMode = "reset";
    state.view = "auth";
    state.token = "";
    state.adminToken = "";
    state.user = null;
    state.isAdmin = false;
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.adminToken);
    url.searchParams.delete("reset_code");
    url.searchParams.delete("resetCode");
    url.hash = "";
    window.history.replaceState({}, document.title, url.pathname + url.search);
    setMessage("success", "Enter a new password to complete the reset.");
    return true;
  }

  async function loadAdmin() {
    state.adminSummary = await adminGet("/api/admin/summary");
    state.isAdmin = true;
  }

  async function loadSession() {
    const me = await apiGet("/api/me");
    state.user = me.user;
    await refreshData();
  }

  async function refreshData() {
    const [questionData, reviewData, progressData, learnerSessionData, learnerFlagData] = await Promise.all([
      apiGet("/api/questions"),
      apiGet("/api/my-reviews"),
      apiGet("/api/my-progress"),
      apiGet("/api/my-learner-sessions"),
      apiGet("/api/my-learner-flags")
    ]);
    state.questions = questionData.questions.map(normalizeQuestion);
    state.poolCounts = questionData.counts || null;
    state.reviews = reviewData.reviews || {};
    state.progress = progressData.progress || {};
    state.learnerSessions = Object.fromEntries(
      Object.entries(learnerSessionData.sessions || {}).map(([sessionId, session]) => [sessionId, normalizeLearnerSession(session)])
    );
    state.learnerFlags = learnerFlagData.learnerFlags || {};
  }

  function normalizeQuestion(q, index) {
    const optionObject = q.options || {};
    const topicGroupCode = q.topic_group_code || deriveTopicGroupCode(q);
    return {
      id: q.record_id,
      number: q.source_question_number || index + 1,
      questionId: q.question_id || q.record_id,
      jobId: q.job_id || "",
      contentId: q.content_id || "",
      coreContentCode: q.core_content_code || "",
      sourceLabel: q.source_label || "",
      domain: q.domain || "Unassigned",
      topicGroupCode,
      topicGroup: topicGroupLabel(q.topic_group, topicGroupCode, q),
      topic: q.topic || "",
      answer: q.answer || "",
      title: q.title || `Question ${index + 1}`,
      stem: q.stem || "",
      options: Object.keys(optionObject).sort().map((letter) => ({ letter, text: optionObject[letter] })),
      rationale: q.rationale || "",
      citation: q.citation || "",
      poolState: q.pool_state || "available",
      reviewAvailable: typeof q.review_available === "boolean" ? q.review_available : (q.pool_state || "voting") === "voting",
      learnAvailable: typeof q.learn_available === "boolean" ? q.learn_available : !["rejected", "paused"].includes(q.pool_state)
    };
  }

  function deriveTopicGroupCode(q) {
    const code = String(q.content_id || q.core_content_code || "").trim();
    const parts = code.split(".").filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(0, 2).join(".");
    }
    return parts[0] || "";
  }

  function topicGroupLabel(rawLabel, code, q = {}) {
    const normalizedCode = code || deriveTopicGroupCode(q);
    if (TOPIC_GROUP_LABELS[normalizedCode]) {
      return TOPIC_GROUP_LABELS[normalizedCode];
    }
    const label = String(rawLabel || "").trim();
    if (TOPIC_GROUP_LABELS[label]) {
      return TOPIC_GROUP_LABELS[label];
    }
    if (label && label !== normalizedCode) {
      return label;
    }
    return displayDomain(q.domain);
  }

  function normalizeLearnerSession(session = {}) {
    const criteria = session.criteria || {};
    const id = session.id || session.quizSessionId || "";
    return {
      id,
      quizSessionId: id,
      createdAt: session.createdAt || "",
      updatedAt: session.updatedAt || "",
      status: session.status || "active",
      requestedCount: Number(session.requestedCount || criteria.requestedCount || 0),
      filter: session.filter || criteria.filter || "all",
      domain: session.domain || criteria.domain || "all",
      topicGroup: session.topicGroup || criteria.topicGroup || "all",
      topic: session.topic || criteria.topic || "all",
      questionIds: Array.isArray(session.questionIds) ? session.questionIds : [],
      answerOrders: session.answerOrders || {},
      answeredCount: Number(session.answeredCount || 0),
      correctCount: Number(session.correctCount || 0),
      incorrectCount: Number(session.incorrectCount || 0),
      unansweredCount: Number(session.unansweredCount || 0)
    };
  }

  async function apiGet(path) {
    return api(path, { method: "GET" });
  }

  async function apiPost(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  async function api(path, options) {
    const headers = Object.assign({}, options.headers || {});
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }
    const response = await fetch(path, Object.assign({}, options, { headers }));
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : {};
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  async function adminGet(path) {
    const response = await fetch(path, { headers: { "X-Admin-Token": state.adminToken } });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  async function adminPost(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": state.adminToken
      },
      body: JSON.stringify(body || {})
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  function render() {
    if (state.loadError) {
      app.innerHTML = renderLoadError();
      return;
    }
    if (state.isAdmin) {
      app.innerHTML = renderAdminShell();
      return;
    }
    if (!state.user) {
      app.innerHTML = state.view === "methods" ? renderPublicMethods() : renderAuth();
      return;
    }
    const viewMap = {
      menu: renderMenu,
      learner: renderLearner,
      evaluator: renderEvaluator,
      report: renderProgressReport,
      profile: renderProfile,
      methods: renderMethodsPage
    };
    app.innerHTML = renderShell((viewMap[state.view] || renderMenu)());
  }

  function renderShell(content) {
    return `
      <header class="topbar">
        <div class="brand">
          <img class="brand-logo" src="assets/emsqbank-logo.png" alt="EMSqbank logo">
          <div>
            <h1 class="brand-title">EMSqbank</h1>
            <p class="brand-subtitle">${escapeHTML(state.user.anonymousUserId)}${state.user.qualifiedVoter ? " | qualified voter" : " | feedback only"}</p>
          </div>
        </div>
        <nav class="nav" aria-label="Main menu">
          ${navButton("menu", "Menu")}
          ${navButton("learner", "Learner")}
          ${navButton("evaluator", "Evaluator")}
          ${navButton("report", "Progress")}
          ${navButton("profile", "Profile")}
          ${navButton("methods", "Methods")}
          <button class="button ghost" type="button" data-action="logout">Log out</button>
        </nav>
      </header>
      ${renderMessage()}
      ${state.user.qualifiedVoter || state.view === "methods" ? "" : renderQualificationNotice()}
      ${content}
      ${state.evaluatorHelpOpen ? renderEvaluatorInstructionsModal() : ""}
      ${renderDisclaimer()}
    `;
  }

  function renderAdminShell() {
    const summary = state.adminSummary;
    return `
      <header class="topbar">
        <div class="brand">
          <img class="brand-logo" src="assets/emsqbank-logo.png" alt="EMSqbank logo">
          <div>
            <h1 class="brand-title">EMSqbank Admin</h1>
            <p class="brand-subtitle">Blinded progress dashboard</p>
          </div>
        </div>
        <nav class="nav" aria-label="Admin menu">
          <button class="button${state.view === "methods" ? "" : " active"}" type="button" data-view="admin">Dashboard</button>
          <button class="button${state.view === "methods" ? " active" : ""}" type="button" data-view="methods">Methods</button>
          <button class="button primary" type="button" data-action="admin-refresh">Refresh</button>
          <button class="button" type="button" data-action="export-admin-summary">Export summary</button>
          <button class="button" type="button" data-action="export-concepts-json">Export concepts</button>
          <button class="button" type="button" data-action="export-lifecycle-json">Export lifecycle</button>
          <button class="button" type="button" data-action="export-llm-feedback-json">Export LLM feedback</button>
          <button class="button" type="button" data-action="export-generation-feedback-json">Export generation feedback</button>
          <button class="button" type="button" data-action="export-publication-json">Export publication data</button>
          <button class="button ghost" type="button" data-action="logout">Log out</button>
        </nav>
      </header>
      ${renderMessage()}
      ${state.view === "methods" ? renderMethodsPage() : summary ? renderAdminDashboard(summary) : renderEmptyQuestion("Admin summary is not loaded.")}
      ${renderDisclaimer()}
    `;
  }

  function renderAdminDashboard(summary) {
    const pool = summary.pool_counts || {};
    const reviewers = summary.reviewer_counts || {};
    const activity = summary.activity || {};
    const concepts = summary.concept_counts || {};
    return `
      ${renderAdminAlerts(summary)}
      ${renderEvaluationModeControl(summary.environment || {})}
      ${renderReviewerNotificationPanel(summary)}
      <section class="menu-grid">
        <div class="panel mode-panel">
          <h2>Pool Status</h2>
          <div class="stat-grid">
            ${stat(pool.voting || 0, "Voting")}
            ${stat(pool.tiebreaker || 0, "Tiebreaker")}
            ${stat(pool.accepted || 0, "Accepted")}
          </div>
          <div class="stat-grid">
            ${stat(pool.rejected || 0, "Rejected")}
            ${stat(pool.retired || 0, "Retired")}
            ${stat(pool.paused || 0, "Paused")}
          </div>
          <div class="stat-grid">
            ${stat((summary.questions || []).length, "Total")}
          </div>
        </div>
        <div class="panel mode-panel">
          <h2>Evaluator Activity</h2>
          <div class="stat-grid">
            ${stat(reviewers.total || 0, "Accounts")}
            ${stat(reviewers.qualified || 0, "Qualified")}
            ${stat(reviewers.feedback_only || 0, "Feedback only")}
          </div>
          <div class="stat-grid">
            ${stat(activity.total_reviews || 0, "Reviews")}
            ${stat(activity.learner_total_attempts || 0, "Learner attempts")}
            ${stat(activity.learner_answered_questions || 0, "Questions tried")}
          </div>
          <div class="stat-grid">
            ${stat(activity.learner_correct_attempts || 0, "Learner correct")}
            ${stat(activity.learner_incorrect_attempts || 0, "Learner incorrect")}
            ${stat(topCount(summary.issue_counts), "Top issue")}
          </div>
        </div>
        <div class="panel mode-panel">
          <h2>Concept Ledger</h2>
          <div class="stat-grid">
            ${stat(concepts.total_concepts_on_site || 0, "Pushed concepts")}
            ${stat(concepts.in_evaluator_voting || 0, "In voting")}
            ${stat(concepts.accepted_on_site || 0, "Accepted")}
          </div>
          <div class="stat-grid">
            ${stat(concepts.rejected_rework_needed || 0, "Rejected")}
            ${stat(concepts.pushed_paused || 0, "Paused")}
            ${stat(concepts.duplicate_risk_concepts || 0, "Duplicate risk")}
          </div>
        </div>
      </section>
      ${renderLearnerFlagAdminSection(summary.learner_flags || {})}
      ${renderConceptDuplicateSection(summary.concept_duplicates || [])}
      <section class="panel">
        <div class="panel-body">
          <h2 class="section-title">Question Progress</h2>
          <div class="pool-table" role="table" aria-label="Admin question progress">
            <div class="pool-row admin-row progress-row pool-head" role="row">
              <span>Question</span>
              <span>Status</span>
              <span>Votes</span>
              <span>Feedback</span>
              <span>Learner</span>
              <span>Topic</span>
            </div>
            ${(summary.questions || []).map(renderAdminRow).join("")}
          </div>
        </div>
      </section>
    `;
  }

  function renderEvaluationModeControl(environment) {
    const currentMode = environment.evaluation_mode || "sandbox";
    return `
      <section class="panel admin-mode-panel">
        <div class="panel-body">
          <div class="admin-mode-header">
            <div>
              <h2 class="section-title">Evaluation Mode</h2>
              <p class="muted">${escapeHTML(environment.decision_note || "")}</p>
            </div>
            <span class="pill ${escapeAttr(currentMode)}">${escapeHTML(evaluationModeLabel(currentMode))}</span>
          </div>
          <form class="evaluation-mode-form" data-form="evaluation-mode">
            <label class="mode-choice ${currentMode === "sandbox" ? "active" : ""}">
              <input type="radio" name="evaluationMode" value="sandbox" ${currentMode === "sandbox" ? "checked" : ""}>
              <span>
                <strong>Sandbox</strong>
                <small>Local testing. Reviews are saved but never count.</small>
              </span>
            </label>
            <label class="mode-choice ${currentMode === "beta" ? "active" : ""}">
              <input type="radio" name="evaluationMode" value="beta" ${currentMode === "beta" ? "checked" : ""}>
              <span>
                <strong>Beta</strong>
                <small>Online testing. Reviews are labeled beta and do not count.</small>
              </span>
            </label>
            <label class="mode-choice ${currentMode === "live" ? "active" : ""}">
              <input type="radio" name="evaluationMode" value="live" ${currentMode === "live" ? "checked" : ""}>
              <span>
                <strong>Live</strong>
                <small>Qualified new reviews can accept or reject questions.</small>
              </span>
            </label>
            <button class="primary" type="submit">Save mode</button>
          </form>
        </div>
      </section>
    `;
  }

  function evaluationModeLabel(mode) {
    if (mode === "live") {
      return "Live";
    }
    if (mode === "beta") {
      return "Beta";
    }
    return "Sandbox";
  }

  function renderReviewerNotificationPanel(summary) {
    const reviewers = summary.reviewer_counts || {};
    const pool = summary.pool_counts || {};
    const environment = summary.environment || {};
    const contactable = Number(reviewers.qualified_contactable || 0);
    const qualified = Number(reviewers.qualified || 0);
    const missing = Number(reviewers.qualified_missing_contact || Math.max(0, qualified - contactable));
    const availableCount = Number(pool.voting || 0);
    const smtpReady = Boolean(environment.password_reset_email_configured);
    const disabled = !smtpReady || contactable < 1;
    const disabledReason = !smtpReady
      ? "SMTP email is not configured in Render yet."
      : contactable < 1
        ? "No qualified reviewers have a server-side contact email on file yet."
        : "";
    return `
      <section class="panel admin-notification-panel">
        <div class="panel-body">
          <div class="admin-mode-header">
            <div>
              <h2 class="section-title">Reviewer Email Alert</h2>
              <p class="muted">Send a blinded batch email to qualified reviewers with contact emails on file.</p>
            </div>
            <span class="pill">${escapeHTML(String(contactable))}/${escapeHTML(String(qualified))} contactable</span>
          </div>
          <div class="notification-default">
            <strong>Default email</strong>
            <span>Requests help reviewing newly added draft questions, includes the live sign-in link, and states both the newly added count and the current total evaluator-pool count.</span>
          </div>
          <form class="notification-form" data-form="notify-qualified-reviewers">
            <div class="field">
              <label for="notify-question-count">Newly added questions</label>
              <input id="notify-question-count" name="questionCount" type="number" min="0" step="1" value="${escapeAttr(availableCount)}">
            </div>
            <div class="field">
              <label for="notify-total-count">Total in evaluator pool</label>
              <input id="notify-total-count" name="availableQuestionCount" type="number" value="${escapeAttr(availableCount)}" readonly>
            </div>
            <div class="field notification-note-field">
              <label for="notify-note">Optional note</label>
              <textarea id="notify-note" name="note" placeholder="Leave blank to send only the standard reviewer request. Anything entered here is appended below the default message."></textarea>
            </div>
            <button class="primary" type="submit" ${disabled ? "disabled" : ""}>Send alert</button>
          </form>
          <p class="footer-note">
            ${escapeHTML(disabledReason || `${missing} qualified reviewer${missing === 1 ? "" : "s"} missing contact email. Emails are sent individually and addresses are not shown in admin.`)}
          </p>
        </div>
      </section>
    `;
  }

  function renderAdminAlerts(summary) {
    const alerts = [];
    const environment = summary.environment || {};
    const learnerFlags = summary.learner_flags || {};
    if (environment.evaluation_mode === "beta") {
      alerts.push({
        type: "",
        text: "Beta test mode is active. Evaluator votes are recorded as beta votes and do not change accepted/rejected status."
      });
    } else if (!environment.live_evaluation) {
      alerts.push({
        type: "",
        text: "Sandbox mode is active. Evaluator votes are recorded but do not change accepted/rejected status."
      });
    }
    if (environment.evaluation_mode !== "sandbox" && !environment.password_reset_email_configured) {
      alerts.push({
        type: "error",
        text: "Password reset email is not configured. Forgot-password requests will not work until SMTP settings are added in Render."
      });
    }
    if ((learnerFlags.open || 0) > 0) {
      alerts.push({
        type: "error",
        text: `${learnerFlags.open} learner flag${learnerFlags.open === 1 ? "" : "s"} pending admin review.`
      });
    }
    if ((summary.concept_counts || {}).duplicate_risk_concepts > 0) {
      alerts.push({
        type: "error",
        text: `${summary.concept_counts.duplicate_risk_concepts} concept${summary.concept_counts.duplicate_risk_concepts === 1 ? "" : "s"} have duplicate-risk records in the website ledger.`
      });
    }
    return alerts.map((alert) => `<div class="alert ${alert.type}">${escapeHTML(alert.text)}</div>`).join("");
  }

  function renderConceptDuplicateSection(rows) {
    if (!rows.length) {
      return "";
    }
    return `
      <section class="panel">
        <div class="panel-body">
          <h2 class="section-title">Concept Duplicate Risk</h2>
          <div class="pool-table" role="table" aria-label="Concept duplicate risk">
            <div class="pool-row progress-row pool-head" role="row">
              <span>Concept</span>
              <span>Status</span>
              <span>Records</span>
              <span>Hashes</span>
              <span>States</span>
              <span>Topic</span>
            </div>
            ${rows.slice(0, 20).map(renderConceptDuplicateRow).join("")}
          </div>
        </div>
      </section>
    `;
  }

  function renderConceptDuplicateRow(row) {
    const stateCounts = Object.entries(row.state_counts || {})
      .filter(([, count]) => Number(count || 0) > 0)
      .map(([key, count]) => `${labelize(key)}: ${count}`)
      .join(", ");
    return `
      <div class="pool-row progress-row" role="row">
        <span><strong>${escapeHTML(row.core_content_code || "")}</strong> ${escapeHTML(row.concept_key || "")}</span>
        <span><span class="pill ${escapeAttr(row.status || "")}">${escapeHTML(labelize(row.status || ""))}</span></span>
        <span>${escapeHTML(String(row.record_count || 0))} total / ${escapeHTML(String(row.active_record_count || 0))} active</span>
        <span>${escapeHTML(String(row.content_hash_count || 0))}</span>
        <span>${escapeHTML(stateCounts || "None")}</span>
        <span>${escapeHTML(row.topic_group || row.topic || displayDomain(row.domain) || "")}</span>
      </div>
    `;
  }

  function renderLearnerFlagAdminSection(learnerFlags) {
    const rows = learnerFlags.questions || [];
    if (!rows.length) {
      return "";
    }
    return `
      <section class="panel">
        <div class="panel-body">
          <h2 class="section-title">Learner Flags</h2>
          <div class="pool-table" role="table" aria-label="Learner question flags">
            <div class="pool-row admin-row pool-head" role="row">
              <span>Question</span>
              <span>Status</span>
              <span>Flags</span>
              <span>Latest</span>
              <span>Issues</span>
            </div>
            ${rows.map(renderLearnerFlagAdminRow).join("")}
          </div>
        </div>
      </section>
    `;
  }

  function renderLearnerFlagAdminRow(row) {
    const issues = issueSummary(row.issue_counts || {});
    const status = row.open_flags ? "Open" : "Resolved";
    return `
      <div class="pool-row admin-row" role="row">
        <span><strong>${escapeHTML(String(row.source_question_number || ""))}</strong> ${escapeHTML(row.question_id || row.record_id)}</span>
        <span><span class="pill ${row.open_flags ? "rejected" : "accepted"}">${escapeHTML(status)}</span></span>
        <span>${escapeHTML(String(row.open_flags || 0))} open / ${escapeHTML(String(row.total_flags || 0))} total</span>
        <span>${escapeHTML(row.latest_at ? formatDateTime(row.latest_at) : "None")}</span>
        <span>${escapeHTML(issues || "Comments only")}</span>
      </div>
    `;
  }

  function renderAdminRow(row) {
    const stage = row.review_stage === "tiebreaker" && row.pool_state === "voting" ? "tiebreaker" : row.pool_state;
    const nonDecisionParts = [];
    if (row.beta_reviews) {
      nonDecisionParts.push(`${row.beta_reviews} beta`);
    }
    if (row.sandbox_reviews) {
      nonDecisionParts.push(`${row.sandbox_reviews} sandbox`);
    }
    const otherNonDecision = Math.max(0, (row.nondecision_reviews || 0) - (row.beta_reviews || 0) - (row.sandbox_reviews || 0));
    if (otherNonDecision) {
      nonDecisionParts.push(`${otherNonDecision} non-counting`);
    }
    const feedback = nonDecisionParts.length
      ? `${row.total_reviews} reviews (${nonDecisionParts.join(", ")})`
      : `${row.total_reviews} reviews`;
    return `
      <div class="pool-row admin-row progress-row" role="row">
        <span><strong>${escapeHTML(String(row.source_question_number || ""))}</strong> ${escapeHTML(row.question_id || row.record_id)}</span>
        <span><span class="pill ${escapeAttr(stage)}">${escapeHTML(labelize(stage))}</span></span>
        <span>${escapeHTML(String(row.qualified_accept))} accept / ${escapeHTML(String(row.qualified_reject))} reject</span>
        <span>${escapeHTML(feedback)}</span>
        <span>${escapeHTML(learnerAnswerSummary(row.learner_tally || {}))}</span>
        <span>${escapeHTML(row.topic_group || row.topic || displayDomain(row.domain) || "")}</span>
      </div>
    `;
  }

  function learnerAnswerSummary(tally) {
    const attempts = Number(tally.total_attempts || 0);
    if (!attempts) {
      return "No learner attempts";
    }
    const correct = Number(tally.correct_attempts || 0);
    const incorrect = Number(tally.incorrect_attempts || 0);
    const distractors = Object.entries(tally.distractors || {})
      .map(([letter, row]) => [letter, Number((row && row.selected) || 0)])
      .filter(([, selected]) => selected > 0)
      .sort((a, b) => b[1] - a[1]);
    const topDistractor = distractors.length ? `; top distractor ${distractors[0][0]}: ${distractors[0][1]}` : "; no distractors selected";
    return `${correct} right / ${incorrect} wrong${topDistractor}`;
  }

  function issueSummary(counts) {
    return Object.entries(counts || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([issue, count]) => `${labelize(issue)}: ${count}`)
      .join(", ");
  }

  function topCount(counts) {
    const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      return "None";
    }
    return `${labelize(entries[0][0])}: ${entries[0][1]}`;
  }

  function navButton(view, label) {
    const active = state.view === view ? " active" : "";
    return `<button class="button${active}" type="button" data-view="${view}">${label}</button>`;
  }

  function renderQualificationNotice() {
    return `
      <div class="alert">
        Your reviews are saved as anonymous feedback. They do not count toward question acceptance or rejection unless your profile says you have previously taken the board exam.
      </div>
    `;
  }

  function renderLoadError() {
    return `
      <section class="panel">
        <div class="panel-body">
          <h1>EMS Board Question Bank</h1>
          <div class="alert error">${escapeHTML(state.loadError)}</div>
        </div>
      </section>
    `;
  }

  function renderAuth() {
    const isRegister = state.authMode === "register";
    const isAdmin = state.authMode === "admin";
    const isForgot = state.authMode === "forgot";
    const isReset = state.authMode === "reset";
    return `
      ${renderLandingIntro()}
      <section id="account-access" class="account-access-section" tabindex="-1">
        <div class="panel auth-panel">
          <h2 class="section-title">Account Access</h2>
          <p class="brand-subtitle">Enter the private beta as an evaluator or learner.</p>
          <div class="tabs" role="tablist" aria-label="Account access">
            <button type="button" class="${!isRegister && !isAdmin ? "active" : ""}" data-auth-mode="login">Log in</button>
            <button type="button" class="${isRegister ? "active" : ""}" data-auth-mode="register">Register</button>
            <button type="button" class="${isAdmin ? "active" : ""}" data-auth-mode="admin">Admin</button>
          </div>
          ${renderMessage()}
          ${isAdmin ? renderAdminLoginForm() : isRegister ? renderRegisterForm() : isForgot ? renderForgotPasswordForm() : isReset ? renderResetPasswordForm() : renderLoginForm()}
          ${renderRequestAccessNote()}
        </div>
      </section>
      ${renderDisclaimer()}
    `;
  }

  function renderLandingIntro() {
    return `
      <section class="landing-hero">
        <div class="landing-hero-inner">
          <div class="landing-hero-top">
            <div class="landing-wordmark">EMSqbank</div>
            <div class="landing-stage">Private beta</div>
          </div>
          <div class="landing-copy">
            <p class="landing-kicker">FOAMed EMS board review</p>
            <h1>EMS board review question bank</h1>
            <p class="landing-lede">
              A focused question-bank project using AI-assisted drafting, machine learning workflows, and physician crowd review to build high-quality EMS board preparation.
            </p>
            <div class="landing-meta" aria-label="Project focus">
              <span>AI-assisted drafting</span>
              <span>Physician reviewed</span>
              <span>Learner pool in development</span>
            </div>
            <div class="landing-actions">
              <button class="primary" type="button" data-auth-mode="register" data-auth-cta="true">Register</button>
              <button class="button" type="button" data-auth-mode="login" data-auth-cta="true">Log in</button>
              <button class="button" type="button" data-view="methods">Methods</button>
            </div>
            ${renderRequestAccessNote("landing-access-note")}
          </div>
          <a class="landing-association" href="https://health.mil/Education-and-Training/DHA-GME/Institutions/SAUSHEC/Programs/ems" target="_blank" rel="noopener noreferrer" aria-label="SAUSHEC Military EMS and Disaster Medicine Fellowship Program">
            <img src="assets/bamc-fellowship-logo.png" alt="SAUSHEC Military EMS and Disaster Medicine Fellowship Program logo">
            <div>
              <span class="association-label">In association with</span>
              <strong>SAUSHEC Military EMS &amp; Disaster Medicine Fellowship Program</strong>
            </div>
          </a>
        </div>
      </section>
    `;
  }

  function renderRequestAccessNote(className = "request-access-note") {
    return `
      <p class="${escapeAttr(className)}">
        Need an access code?
        <a href="mailto:Evan.m.baines@gmail.com?subject=EMSqbank%20access%20request">Request access</a>
        from Evan.m.baines@gmail.com.
      </p>
    `;
  }

  function renderPublicMethods() {
    return `
      <header class="topbar">
        <div class="brand">
          <img class="brand-logo" src="assets/emsqbank-logo.png" alt="EMSqbank logo">
          <div>
            <h1 class="brand-title">EMSqbank</h1>
            <p class="brand-subtitle">Emergency Medicine Question Bank</p>
          </div>
        </div>
        <nav class="nav" aria-label="Public menu">
          <button class="button active" type="button" data-view="methods">Methods</button>
          <button class="button" type="button" data-auth-mode="login" data-auth-cta="true">Log in</button>
          <button class="button primary" type="button" data-auth-mode="register" data-auth-cta="true">Register</button>
        </nav>
      </header>
      ${renderMethodsPage()}
      ${renderDisclaimer()}
    `;
  }

  function renderMethodsPage() {
    return `
      <article class="panel methods-page">
        <div class="panel-body">
          <p class="landing-kicker">Methods</p>
          <h1>How the question files are created</h1>
          <p class="methods-lede">
            EMSqbank is a FOAMed project using artificial intelligence, machine learning workflows, and crowd-sourced physician review to build a high-quality EMS Medicine board review system. The long-term goal is a learner-facing question bank. The current stage focuses on reviewing and improving draft board-style questions before they are accepted into the learner pool.
          </p>

          <div class="methods-facts" aria-label="Project build facts">
            <div><strong>545</strong><span>Core Content outline rows mapped</span></div>
            <div><strong>410</strong><span>Terminal topics used for sampling</span></div>
            <div><strong>2,500</strong><span>Planned single-best-answer items</span></div>
            <div><strong>160</strong><span>Indexed local source records</span></div>
          </div>

          <section class="methods-section">
            <h2>Starting Framework</h2>
            <p>
              The project starts with <em>The 2026 Core Content of Emergency Medical Services Medicine</em>, which is treated as the controlling map for what the question bank should cover.<sup>[1]</sup> The outline was converted into a structured content map with 545 rows and 410 terminal topics. A separate audit compared the generated map back against the official Core Content PDF and found no drift issues in the working map.
            </p>
          </section>

          <section class="methods-section">
            <h2>Source Corpus</h2>
            <p>
              Question writing is source-grounded rather than open-ended. The local corpus includes the 2026 Core Content outline, EMS textbooks and companion searchable text, board-review slide modules, NAEMSP review guides, position statements, official and regulatory documents, peer-reviewed EMS reviews, and other vetted EMS-relevant sources. Sources are prioritized in a fixed hierarchy: Core Content for scope, EMS textbooks for core explanations, NAEMSP and other official consensus documents for current policy or standards, board-review materials for emphasis, peer-reviewed reviews for gap filling, and other vetted sources only when higher-tier material is not available.
            </p>
            <p>
              The source map records coverage status, source links, textbook locators, and whether a content area needs supplemental review. This is meant to keep each question traceable back to a supportable source instead of relying on the model's memory.
            </p>
          </section>

          <section class="methods-section">
            <h2>Question Blueprint</h2>
            <p>
              A 2,500-item target map was built using the broad board-review domain weights used in the EMS subspecialty review materials: 30% Medical Oversight, 40% Clinical Aspects, 10% Quality Management/Research, and 20% Disaster/Special Operations. Within those domains, targets were distributed across terminal topics using a blended rule: mostly terminal-topic breadth, with a smaller equal-subsection component so smaller named topics did not disappear. The result is a reproducible blueprint rather than a hand-picked list of favorite topics.
            </p>
          </section>

          <section class="methods-section">
            <h2>LLM Drafting Workflow</h2>
            <p>
              A large language model is used as a drafting and revision engine, not as an unsupervised author. For each planned item, the generation index records the tested concept, concept summary, controlling source citation, source locator, distractor strategy, and stem-angle notes. The model uses that structured record to draft a board-style single-best-answer question, answer explanation, and distractors.
            </p>
            <p>
              This design follows the emerging medical-education literature suggesting that LLMs can help generate multiple-choice or single-best-answer questions, but that quality is variable and requires human review, source boundaries, and quality assurance before learner use.<sup>[2-5]</sup>
            </p>
          </section>

          <section class="methods-section">
            <h2>Quality Checks</h2>
            <p>
              Draft questions are audited before external review. Automated checks look for missing citations, missing Core Content codes, answer imbalance, unexpanded acronyms, obvious answer-length or complexity cues, option-only solvability, weak distractors, repeated concepts, source concentration, and structural problems. Separate source-readiness and clinical-currentness queues flag topics that are legal/regulatory, emerging, controversial, local-protocol dependent, equity-sensitive, or otherwise likely to need human review before release.
            </p>
            <p>
              These checks do not decide whether a question is good. They remove avoidable defects and create review queues so physician reviewers can spend their time on judgment-heavy issues: source fidelity, clinical accuracy, currentness, difficulty, wording, and whether the distractors are genuinely plausible.
            </p>
          </section>

          <section class="methods-section">
            <h2>Reviewer And Learner Data</h2>
            <p>
              The website is the next stage of the process. Reviewers are assigned anonymous user IDs. Their feedback is saved on the server by anonymous ID, not by email. Only reviewers who report that they have previously taken the board exam count toward question acceptance or rejection. A question can enter the learner pool after two qualified accept votes, can be rejected after two qualified reject votes, and requires a tiebreaker if the first two qualified votes conflict.
            </p>
            <p>
              Accepted questions move into learner mode. Learner responses are tracked by question so the system can later review correct and incorrect rates, selected and ignored distractors, and learner flags for bad or outdated questions. That response data will be used to identify questions that are too easy, too difficult, misleading, or psychometrically weak. The broader medical-education literature supports the importance of practice questions and question-bank use for board preparation, but also highlights access and equity concerns that motivate a FOAMed approach.<sup>[6-8]</sup>
            </p>
          </section>

          <section class="methods-section">
            <h2>Current Status</h2>
            <p>
              At this stage, EMSqbank should be understood as a pilot development and review system. AI helps generate and revise candidate items. Automated audits catch repeatable mechanical problems. Physician review decides which questions are acceptable. Learner performance data will later help calibrate item difficulty and distractor performance. Questions are not considered final simply because they were generated or mechanically passed an audit.
            </p>
          </section>

          <section class="methods-section">
            <h2>References</h2>
            <ol class="reference-list">
              <li><em>The 2026 Core Content of Emergency Medical Services Medicine</em>. <em>Prehospital Emergency Care</em>. 2026. <a href="https://doi.org/10.1080/10903127.2026.2692037" target="_blank" rel="noopener noreferrer">doi:10.1080/10903127.2026.2692037</a>.</li>
              <li>Artsi Y, Sorin V, Konen E, Glicksberg BS, Nadkarni G, Klang E. Large language models for generating medical examinations: systematic review. <em>BMC Medical Education</em>. 2024;24:354. <a href="https://doi.org/10.1186/s12909-024-05239-y" target="_blank" rel="noopener noreferrer">doi:10.1186/s12909-024-05239-y</a>.</li>
              <li>Ahmed A, Kerr E, O'Malley A. Quality assurance and validity of AI-generated single best answer questions. <em>BMC Medical Education</em>. 2025;25:300. <a href="https://doi.org/10.1186/s12909-025-06881-w" target="_blank" rel="noopener noreferrer">doi:10.1186/s12909-025-06881-w</a>.</li>
              <li>Riehm L, Nanji K, Lakhani M, Pankiv E, Hasanee D, Pfeifer W. The use of large language models in generating multiple choice questions for health professions education: a systematic review and network meta-analysis. <em>PLoS One</em>. 2026;21(1):e0340277. <a href="https://doi.org/10.1371/journal.pone.0340277" target="_blank" rel="noopener noreferrer">doi:10.1371/journal.pone.0340277</a>.</li>
              <li>Zahn A, Overla S, Lowrie DJ, Zhou CY, Santen SA, Zheng W, Turner L. An artificial intelligence-driven platform for practice question generation. <em>Academic Medicine</em>. 2026;101:279-283. <a href="https://doi.org/10.1093/acamed/wvaf074" target="_blank" rel="noopener noreferrer">doi:10.1093/acamed/wvaf074</a>.</li>
              <li>Burk-Rafel J, Santen SA, Purkiss J. Study behaviors and USMLE Step 1 performance: implications of a student self-directed parallel curriculum. <em>Academic Medicine</em>. 2017;92:S67-S74. <a href="https://doi.org/10.1097/ACM.0000000000001916" target="_blank" rel="noopener noreferrer">doi:10.1097/ACM.0000000000001916</a>.</li>
              <li>Banos JH, Pepin ME, Van Wagoner N. Class-wide access to a commercial Step 1 question bank during preclinical organ-based modules: a pilot project. <em>Academic Medicine</em>. 2018;93:486-490. <a href="https://doi.org/10.1097/ACM.0000000000001861" target="_blank" rel="noopener noreferrer">doi:10.1097/ACM.0000000000001861</a>.</li>
              <li>Ghersin H, Gulfo MC, Frohlich BA, et al. Socioeconomic factors and test preparation strategies are related to success on the USMLE Step 2 clinical knowledge (CK) exam: a single-institution study. <em>BMC Medical Education</em>. 2024;24:1412. <a href="https://doi.org/10.1186/s12909-024-06414-x" target="_blank" rel="noopener noreferrer">doi:10.1186/s12909-024-06414-x</a>.</li>
              <li>Cone DC, Brice JH, Delbridge TR, Myers JB, eds. <em>Emergency Medical Services: Clinical Practice and Systems Oversight</em>. 3rd ed. John Wiley &amp; Sons; 2021.</li>
            </ol>
            <p class="methods-note">
              Project build records used for this summary include the EMSqbank source-quality hierarchy, 2026 Core Content source gap analysis, content-source map, target map, production plan, generation-index audit, readiness audit, and methods log.
            </p>
          </section>
        </div>
      </article>
    `;
  }

  function renderDisclaimer() {
    return `
      <footer class="site-disclaimer">
        This website contains the views of its authors and does not reflect the official views of any branch of the military, the Department of War, or Brooke Army Medical Center.
      </footer>
    `;
  }

  function renderAdminLoginForm() {
    return `
      <form class="form-grid" data-form="admin-login">
        <div class="field">
          <label for="admin-token">Admin token</label>
          <input id="admin-token" name="adminToken" type="password" autocomplete="off" required>
        </div>
        <button class="primary" type="submit">Open admin dashboard</button>
      </form>
    `;
  }

  function renderLoginForm() {
    return `
      <form class="form-grid" data-form="login">
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" autocomplete="email" required>
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button class="primary" type="submit">Log in</button>
      </form>
      <div class="auth-link-row">
        <button class="link-button" type="button" data-auth-mode="forgot">Forgot password?</button>
      </div>
    `;
  }

  function renderForgotPasswordForm() {
    return `
      <form class="form-grid" data-form="forgot-password">
        <div class="field">
          <label for="forgot-email">Email</label>
          <input id="forgot-email" name="email" type="email" autocomplete="email" required>
        </div>
        <button class="primary" type="submit">Send reset code</button>
      </form>
      <div class="auth-link-row">
        <button class="link-button" type="button" data-auth-mode="reset">I already have a reset code</button>
        <button class="link-button" type="button" data-auth-mode="login">Back to log in</button>
      </div>
    `;
  }

  function renderResetPasswordForm() {
    return `
      <form class="form-grid" data-form="reset-password">
        <div class="field">
          <label for="reset-code">Reset code</label>
          <input id="reset-code" name="resetCode" type="text" autocomplete="one-time-code" value="${escapeAttr(state.pendingResetCode)}" required>
        </div>
        <div class="field">
          <label for="reset-password">New password</label>
          <input id="reset-password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        </div>
        <button class="primary" type="submit">Reset password</button>
      </form>
      <div class="auth-link-row">
        <button class="link-button" type="button" data-auth-mode="forgot">Request a new code</button>
        <button class="link-button" type="button" data-auth-mode="login">Back to log in</button>
      </div>
    `;
  }

  function renderRegisterForm() {
    return `
      <form class="form-grid" data-form="register">
        <div class="field">
          <label for="register-email">Email</label>
          <input id="register-email" name="email" type="email" autocomplete="email" required>
        </div>
        <div class="two-col">
          <div class="field">
            <label for="register-password">Password</label>
            <input id="register-password" name="password" type="password" autocomplete="new-password" minlength="8" required>
          </div>
          <div class="field">
            <label for="access-code">Access code</label>
            <input id="access-code" name="accessCode" type="text" autocapitalize="characters" required>
          </div>
        </div>
        <div class="two-col">
          <div class="field">
            <label for="training-status">Training status</label>
            <select id="training-status" name="trainingStatus" required>
              ${selectOption("", "Select one", "")}
              ${selectOption("board_certified", "Board certified", "")}
              ${selectOption("board_eligible", "Board eligible", "")}
              ${selectOption("fellow", "Fellow", "")}
            </select>
          </div>
          <div class="field">
            <label for="previous-board">Previously taken the board</label>
            <select id="previous-board" name="previousBoard" required>
              ${selectOption("", "Select one", "")}
              ${selectOption("yes", "Yes", "")}
              ${selectOption("no", "No", "")}
            </select>
          </div>
        </div>
        <div class="two-col">
          <div class="field">
            <label for="training-state">Training state</label>
            <select id="training-state" name="trainingState" required>${stateOptions()}</select>
          </div>
          <div class="field">
            <label for="practice-state">Current practice state</label>
            <select id="practice-state" name="practiceState" required>${stateOptions()}</select>
          </div>
        </div>
        <button class="primary" type="submit">Create anonymous account</button>
      </form>
    `;
  }

  function renderMenu() {
    const pool = poolStats();
    const learner = learnerStats();
    const evaluator = evaluatorStats();
    const available = availableEvaluationCount();
    return `
      <section class="menu-grid">
        <div class="panel mode-panel">
          <div class="mode-copy">
            <h2>Learner Mode</h2>
            <p>Practice accepted questions and save right/wrong history on the server.</p>
          </div>
          <div class="stat-grid">
            ${stat(learner.answered, "Answered")}
            ${stat(`${learner.percent}%`, "Correct")}
            ${stat(learner.remaining, "Remaining")}
          </div>
          <div class="mode-actions">
            <button class="primary" type="button" data-view="learner">Open learner</button>
            <button class="button" type="button" data-view="report">Progress report</button>
          </div>
        </div>
        <div class="panel mode-panel">
          <div class="mode-copy">
            <h2>Evaluator Mode</h2>
            <p>Evaluate candidate questions, cast anonymous votes, and capture structured generation feedback. Questions are randomly fed, and completed items leave your queue.</p>
            <button class="link-button evaluator-help-link" type="button" data-action="open-evaluator-instructions">How should I evaluate questions?</button>
          </div>
          <div class="stat-grid">
            ${stat(available, "Available")}
            ${stat(evaluator.reviewed, "My votes")}
            ${stat(`${pool.accepted}/${pool.rejected}`, "Accepted / rejected")}
          </div>
          <div class="mode-actions">
            <button class="primary" type="button" data-view="evaluator">Open evaluator</button>
          </div>
        </div>
      </section>
    `;
  }

  function renderEvaluatorInstructionsModal() {
    return `
      <div class="modal-backdrop" data-action="close-evaluator-instructions">
        <section class="modal-card evaluator-instructions" role="dialog" aria-modal="true" aria-labelledby="evaluator-instructions-title">
          <div class="modal-header">
            <div>
              <p class="landing-kicker">Evaluator calibration</p>
              <h2 id="evaluator-instructions-title">How to review questions</h2>
            </div>
            <button class="button ghost modal-close" type="button" data-action="close-evaluator-instructions" aria-label="Close evaluator instructions">Close</button>
          </div>
          <div class="instruction-grid">
            <div>
              <h3>What we are building</h3>
              <p>The goal is not to reproduce board questions exactly. The goal is to create high-quality EMS board-preparation questions that teach and reinforce the content in the Core Content.</p>
            </div>
            <div>
              <h3>What to judge</h3>
              <p>Focus on whether the answer is supported, clinically current, clearly written, appropriately difficult, and paired with plausible distractors.</p>
            </div>
            <div>
              <h3>How to vote</h3>
              <p><strong>Accept as is</strong> and <strong>accept with revisions</strong> are accept votes. <strong>Major revisions needed</strong> and <strong>reject</strong> are reject votes.</p>
            </div>
            <div>
              <h3>What helps revision</h3>
              <p>Use flags and comments for feedback that can be applied back into the generation workflow: unsupported source, confusing wording, giveaway cues, currentness concerns, or weak distractors.</p>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  function renderEvaluator() {
    const questions = filteredEvaluatorQuestions();
    const q = ensureCurrentQuestion("evaluator", questions);
    return `
      <section class="workbench">
        ${renderEvaluatorSidePanel(questions)}
        ${q ? renderEvaluatorQuestion(q, state.reviews[q.id]) : renderEmptyQuestion("No questions match the current evaluator filters.")}
      </section>
    `;
  }

  function renderEvaluatorSidePanel(questions) {
    const stats = evaluatorStats();
    return `
      <aside class="panel side-panel">
        <h2>Evaluator Review</h2>
        <div class="stat-grid">
          ${stat(stats.reviewed, "Mine")}
          ${stat(stats.acceptedVotes, "Accept")}
          ${stat(stats.rejectedVotes, "Reject")}
        </div>
        <div class="filter-stack">
          <div class="field">
            <label for="evaluator-domain">Domain</label>
            <select id="evaluator-domain" data-filter="evaluatorDomain">${domainOptions(state.evaluatorDomain)}</select>
          </div>
          <div class="field">
            <label for="evaluator-topic-group">Topic group</label>
            <select id="evaluator-topic-group" data-filter="evaluatorTopicGroup">${topicGroupOptions(state.evaluatorTopicGroup, "evaluator")}</select>
          </div>
          <div class="field">
            <label for="evaluator-topic">Topic</label>
            <select id="evaluator-topic" data-filter="evaluatorTopic">${topicOptions(state.evaluatorTopic, "evaluator")}</select>
          </div>
        </div>
        <div class="question-picker" aria-label="Evaluator question picker">
          ${questions.map((question) => evaluatorQuestionButton(question, state.reviews[question.id])).join("")}
        </div>
      </aside>
    `;
  }

  function evaluatorQuestionButton(q, record) {
    const active = q.id === state.evaluatorQid ? " active" : "";
    const reviewed = record ? " reviewed" : "";
    return `<button class="question-button${active}${reviewed}" type="button" data-evaluator-qid="${escapeAttr(q.id)}">${escapeHTML(String(q.number))}</button>`;
  }

  function renderEvaluatorQuestion(q, record = {}) {
    const isClosed = !q.reviewAvailable;
    return `
      <article class="panel question-panel">
        ${renderQuestionHeader(q)}
        <div class="question-body">
          ${record.updatedAt ? `<div class="alert success">Review saved ${formatDateTime(record.updatedAt)}</div>` : ""}
          ${isClosed ? `<div class="alert">This question is not currently accepting evaluator submissions.</div>` : ""}
          <p class="stem">${escapeHTML(q.stem)}</p>
          <div class="option-list">${q.options.map((option) => renderStaticOption(option, q.answer)).join("")}</div>
          ${renderAnswerPanel(q)}
          <form class="form-grid" data-form="review">
            <input type="hidden" name="recordId" value="${escapeAttr(q.id)}">
            <div class="two-col">
              <div class="field">
                <label for="verdict">Vote</label>
                <select id="verdict" name="disposition" required ${isClosed ? "disabled" : ""}>
                  ${selectOption("", "Select one", reviewDisposition(record))}
                  ${REVIEW_DISPOSITIONS.map(([value, label]) => selectOption(value, label, reviewDisposition(record))).join("")}
                </select>
              </div>
              <div class="field">
                <label for="difficulty">Difficulty</label>
                <select id="difficulty" name="difficulty" required ${isClosed ? "disabled" : ""}>
                  ${selectOption("", "Select one", record.difficulty || "")}
                  ${selectOption("too_easy", "Too easy", record.difficulty || "")}
                  ${selectOption("easy", "Easy", record.difficulty || "")}
                  ${selectOption("appropriate", "Appropriate", record.difficulty || "")}
                  ${selectOption("difficult", "Difficult", record.difficulty || "")}
                  ${selectOption("too_hard", "Too hard", record.difficulty || "")}
                  ${selectOption("not_sure", "Not sure", record.difficulty || "")}
                </select>
              </div>
            </div>
            <div class="two-col">
              <div class="field">
                <label for="quality">Overall quality</label>
                <select id="quality" name="quality" required ${isClosed ? "disabled" : ""}>
                  ${selectOption("", "Select one", String(record.quality || ""))}
                  ${selectOption("5", "5 - excellent", String(record.quality || ""))}
                  ${selectOption("4", "4 - strong", String(record.quality || ""))}
                  ${selectOption("3", "3 - usable", String(record.quality || ""))}
                  ${selectOption("2", "2 - weak", String(record.quality || ""))}
                  ${selectOption("1", "1 - not usable", String(record.quality || ""))}
                </select>
              </div>
              <div class="field">
                <label for="confidence">Evaluator confidence</label>
                <select id="confidence" name="confidence" ${isClosed ? "disabled" : ""}>
                  ${selectOption("", "Select one", record.confidence || "")}
                  ${selectOption("high", "High", record.confidence || "")}
                  ${selectOption("moderate", "Moderate", record.confidence || "")}
                  ${selectOption("low", "Low", record.confidence || "")}
                </select>
              </div>
            </div>
            <fieldset class="checkbox-grid">
              <legend class="field-label">Generation feedback flags</legend>
              ${GENERATION_ISSUES.map(([value, label]) => renderCheckbox("generationIssueFlags", value, label, record.generationIssueFlags || [], isClosed)).join("")}
            </fieldset>
            <div class="field">
              <label for="comments">Comments for generation/revision</label>
              <textarea id="comments" name="comments" ${isClosed ? "disabled" : ""}>${escapeHTML(record.comments || "")}</textarea>
            </div>
            <div class="toolbar">
              <div class="toolbar-left">
                <button class="button" type="button" data-action="evaluator-prev">Previous</button>
                <button class="primary" type="submit" ${isClosed ? "disabled" : ""}>Save vote</button>
                <button class="button" type="button" data-action="evaluator-next">Next</button>
              </div>
              <div class="toolbar-right">
              </div>
            </div>
          </form>
        </div>
      </article>
    `;
  }

  function renderLearner() {
    if (!state.learnerSession) {
      return renderLearnerSetup();
    }
    const questions = learnerSessionQuestions();
    if (!questions.length) {
      state.learnerSession = null;
      state.learnerQid = "";
      return renderLearnerSetup("This quiz no longer has available accepted questions. Build a new quiz to continue.");
    }
    const q = ensureCurrentQuestion("learner", questions);
    return `
      <section class="workbench">
        ${renderLearnerSidePanel(questions)}
        ${q ? renderLearnerQuestion(q) : renderEmptyQuestion("No accepted learner-pool questions match the current filters.")}
      </section>
    `;
  }

  function renderLearnerSetup(notice = "") {
    const stats = learnerStats();
    const questions = filteredLearnerQuestions();
    const available = questions.length;
    const requested = Math.min(Math.max(1, Number(state.learnerQuizCount || 10)), Math.max(1, available || 1));
    const resumableSessions = resumableLearnerSessions();
    return `
      <section class="panel learner-setup">
        <div class="panel-body">
          <div class="learner-setup-header">
            <div>
              <p class="landing-kicker">Learner mode</p>
              <h2 class="section-title">Build a practice quiz</h2>
              <p class="muted">Accepted questions only. Each quiz gets its own shuffled answer order and records session-level results while preserving your overall progress.</p>
            </div>
            <span class="pill accepted">${escapeHTML(String(stats.totalAvailable))} accepted</span>
          </div>
          ${notice ? `<div class="alert error">${escapeHTML(notice)}</div>` : ""}
          <div class="stat-grid learner-setup-stats">
            ${stat(stats.answered, "Answered")}
            ${stat(`${stats.percent}%`, "Correct")}
            ${stat(stats.remaining, "Unseen")}
          </div>
          ${resumableSessions.length ? renderResumableLearnerSessions(resumableSessions) : ""}
          <form class="quiz-setup-form" data-form="learner-session">
            <div class="quiz-setup-grid">
              <div class="field">
                <label for="learner-question-count">Questions in this set</label>
                <input id="learner-question-count" name="questionCount" type="number" min="1" max="${escapeAttr(Math.max(1, available))}" step="1" value="${escapeAttr(requested)}" ${available ? "" : "disabled"}>
              </div>
              <div class="field">
                <label for="learner-filter">Question status</label>
                <select id="learner-filter" data-filter="learnerFilter">
                  ${selectOption("all", "All questions", state.learnerFilter)}
                  ${selectOption("unanswered", "Unseen questions", state.learnerFilter)}
                  ${selectOption("missed", "Previously incorrect", state.learnerFilter)}
                  ${selectOption("correct", "Previously correct", state.learnerFilter)}
                </select>
              </div>
              <div class="field">
                <label for="learner-domain">Domain</label>
                <select id="learner-domain" data-filter="learnerDomain">${domainOptions(state.learnerDomain)}</select>
              </div>
              <div class="field">
                <label for="learner-topic-group">Topic group</label>
                <select id="learner-topic-group" data-filter="learnerTopicGroup">${topicGroupOptions(state.learnerTopicGroup, "learner")}</select>
              </div>
              <div class="field">
                <label for="learner-topic">Topic</label>
                <select id="learner-topic" data-filter="learnerTopic">${topicOptions(state.learnerTopic, "learner")}</select>
              </div>
            </div>
            <div class="quiz-availability">
              <strong>${escapeHTML(String(available))}</strong>
              <span>${available === 1 ? "accepted question matches" : "accepted questions match"} these settings.</span>
            </div>
            <div class="toolbar">
              <div class="toolbar-left">
                <button class="primary" type="submit" ${available ? "" : "disabled"}>Generate quiz</button>
              </div>
            </div>
          </form>
        </div>
      </section>
    `;
  }

  function renderLearnerSidePanel(questions) {
    const stats = learnerSessionStats(questions);
    const session = state.learnerSession || {};
    return `
      <aside class="panel side-panel">
        <h2>Quiz Session</h2>
        <div class="stat-grid">
          ${stat(stats.answered, "Done")}
          ${stat(stats.correct, "Right")}
          ${stat(stats.remaining, "Left")}
        </div>
        <p class="session-summary">${escapeHTML(sessionSummaryText(session, questions.length))}</p>
        <div class="question-picker" aria-label="Learner question picker">
          ${questions.map((question, index) => learnerQuestionButton(question, currentLearnerAttempt(question.id), index + 1)).join("")}
        </div>
        <div class="side-actions">
          <button class="button" type="button" data-action="learner-pause-session">Pause quiz</button>
          <button class="button" type="button" data-action="learner-finish-session">Finish early</button>
        </div>
      </aside>
    `;
  }

  function renderResumableLearnerSessions(sessions) {
    return `
      <section class="resumable-quiz-panel">
        <h3>Paused quizzes</h3>
        <div class="resumable-quiz-list">
          ${sessions.map((session) => {
            const total = session.questionIds.length;
            const answered = sessionAnsweredCount(session);
            return `
              <div class="resumable-quiz-row">
                <div>
                  <strong>${escapeHTML(sessionSummaryText(session, total))}</strong>
                  <span>${escapeHTML(String(answered))} of ${escapeHTML(String(total))} answered${session.updatedAt ? ` | updated ${escapeHTML(formatDateTime(session.updatedAt))}` : ""}</span>
                </div>
                <div class="resumable-actions">
                  <button class="primary" type="button" data-learner-resume-session="${escapeAttr(session.id)}">Resume</button>
                  <button class="button" type="button" data-learner-finish-session="${escapeAttr(session.id)}">Finish</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }

  function learnerQuestionButton(q, record, label) {
    const active = q.id === state.learnerQid ? " active" : "";
    const status = record ? (record.correct ? " correct" : " incorrect") : "";
    return `<button class="question-button${active}${status}" type="button" data-learner-qid="${escapeAttr(q.id)}">${escapeHTML(String(label || q.number))}</button>`;
  }

  function renderLearnerQuestion(q) {
    const record = currentLearnerAttempt(q.id);
    const answered = Boolean(record);
    const selected = record ? record.selected : "";
    const options = learnerDisplayOptions(q);
    const answerLabel = displayLetterForOriginal(q.answer, options);
    const selectedLabel = displayLetterForOriginal(selected, options);
    const sessionQuestions = learnerSessionQuestions();
    const position = Math.max(1, sessionQuestions.findIndex((question) => question.id === q.id) + 1);
    const total = Math.max(position, sessionQuestions.length);
    return `
      <article class="panel question-panel">
        ${renderQuestionHeader(q, { showMeta: false, showCode: false, title: `Question ${position} of ${total}` })}
        <div class="question-body">
          ${answered ? renderResultBanner(record, selectedLabel) : ""}
          <p class="stem">${escapeHTML(q.stem)}</p>
          <form data-form="learner-answer">
            <input type="hidden" name="recordId" value="${escapeAttr(q.id)}">
            <input type="hidden" name="quizSessionId" value="${escapeAttr(state.learnerSession?.id || "")}">
            <input type="hidden" name="displayOrder" value="${escapeAttr(options.map((option) => option.letter).join(","))}">
            <div class="option-list">
              ${options.map((option) => renderLearnerOption(option, q.answer, selected, answered)).join("")}
            </div>
            ${answered ? renderAnswerPanel(q, answerLabel) : `<button class="primary" type="submit">Submit answer</button>`}
          </form>
          <div class="toolbar">
            <div class="toolbar-left">
              <button class="button" type="button" data-action="learner-prev">Previous</button>
              <button class="button" type="button" data-action="learner-next">Next</button>
            </div>
            <div class="toolbar-right">
              <button class="button" type="button" data-action="learner-pause-session">Pause quiz</button>
              <button class="button" type="button" data-action="learner-finish-session">Finish early</button>
            </div>
          </div>
          ${renderLearnerFlagPanel(q, state.learnerFlags[q.id] || {})}
        </div>
      </article>
    `;
  }

  function renderLearnerFlagPanel(q, flag) {
    const selected = flag.generationIssueFlags || [];
    const isOpen = state.learnerFlagOpenQid === q.id;
    const toggleText = isOpen ? "Hide flag form" : (flag.updatedAt ? "Edit flag" : "Flag this question");
    if (!isOpen) {
      return `
        <section class="flag-panel collapsed">
          <div class="flag-panel-header">
            <div>
              <h3>Flag this question</h3>
              ${flag.updatedAt ? `<p class="small muted">Flag saved ${formatDateTime(flag.updatedAt)}</p>` : ""}
            </div>
            <button class="button" type="button" data-learner-flag-toggle="${escapeAttr(q.id)}" aria-expanded="false">${escapeHTML(toggleText)}</button>
          </div>
        </section>
      `;
    }
    return `
      <section class="flag-panel">
        <div class="flag-panel-header">
          <div>
            <h3>Flag this question</h3>
            ${flag.updatedAt ? `<p class="small muted">Flag saved ${formatDateTime(flag.updatedAt)}</p>` : ""}
          </div>
          <button class="button" type="button" data-learner-flag-toggle="${escapeAttr(q.id)}" aria-expanded="true">${escapeHTML(toggleText)}</button>
        </div>
        <form class="form-grid" data-form="learner-flag">
          <input type="hidden" name="recordId" value="${escapeAttr(q.id)}">
          <fieldset class="checkbox-grid">
            <legend class="field-label">Question issue flags</legend>
            ${GENERATION_ISSUES.map(([value, label]) => renderCheckbox("learnerIssueFlags", value, label, selected, false)).join("")}
          </fieldset>
          <div class="field">
            <label for="learner-flag-comments">Comments for review</label>
            <textarea id="learner-flag-comments" name="comments">${escapeHTML(flag.comments || "")}</textarea>
          </div>
          <div class="toolbar">
            <div class="toolbar-left">
              <button class="button" type="submit">${flag.updatedAt ? "Update flag" : "Send flag"}</button>
            </div>
          </div>
        </form>
      </section>
    `;
  }

  function renderProgressReport() {
    const stats = learnerStats();
    const domainRows = progressBreakdown("domain");
    const topicGroupRows = progressBreakdown("topicGroup");
    const missed = state.questions
      .filter((q) => state.progress[q.id] && !state.progress[q.id].correct)
      .slice(0, 12);
    return `
      <section class="panel">
        <div class="panel-body">
          <h2 class="section-title">Progress Report</h2>
          <div class="stat-grid">
            ${stat(stats.answered, "Answered")}
            ${stat(`${stats.percent}%`, "Correct")}
            ${stat(stats.remaining, "Remaining")}
          </div>
          <div class="stat-grid">
            ${stat(stats.correct, "Right")}
            ${stat(stats.incorrect, "Wrong")}
            ${stat(stats.totalAvailable, "Available")}
          </div>
        </div>
      </section>
      <section class="profile-grid">
        <div class="panel">
          <div class="panel-body">
            <h2 class="section-title">By Domain</h2>
            ${renderProgressTable(domainRows)}
          </div>
        </div>
        <div class="panel">
          <div class="panel-body">
            <h2 class="section-title">By Topic Group</h2>
            ${renderProgressTable(topicGroupRows)}
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-body">
          <h2 class="section-title">Review List</h2>
          ${missed.length ? renderMissedList(missed) : `<p class="muted">No missed questions recorded yet.</p>`}
        </div>
      </section>
    `;
  }

  function renderProgressTable(rows) {
    if (!rows.length) {
      return `<p class="muted">No progress recorded yet.</p>`;
    }
    return `
      <div class="pool-table" role="table" aria-label="Progress breakdown">
        <div class="pool-row report-row pool-head" role="row">
          <span>Set</span>
          <span>Answered</span>
          <span>Correct</span>
          <span>Remaining</span>
        </div>
        ${rows.map((row) => `
          <div class="pool-row report-row" role="row">
            <span>${escapeHTML(row.label)}</span>
            <span>${escapeHTML(String(row.answered))} / ${escapeHTML(String(row.total))}</span>
            <span>${escapeHTML(String(row.percent))}%</span>
            <span>${escapeHTML(String(row.remaining))}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderMissedList(questions) {
    return `
      <div class="pool-table" role="table" aria-label="Missed questions">
        <div class="pool-row report-row pool-head" role="row">
          <span>Question</span>
          <span>Domain</span>
          <span>Topic</span>
          <span>Result</span>
        </div>
        ${questions.map((q) => {
          const record = state.progress[q.id];
          return `
            <div class="pool-row report-row" role="row">
              <span>${escapeHTML(String(q.number))}. ${escapeHTML(q.title)}</span>
              <span>${escapeHTML(displayDomain(q.domain))}</span>
              <span>${escapeHTML(q.topic || q.topicGroup)}</span>
              <span>${escapeHTML(record.selected)} -> ${escapeHTML(record.correctAnswer)}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderProfile() {
    const profile = state.user.profile || {};
    return `
      <section class="profile-grid">
        <div class="panel">
          <div class="panel-body">
            <h2 class="section-title">Anonymous Profile</h2>
            <p class="muted">Evaluator ID: <strong>${escapeHTML(state.user.anonymousUserId)}</strong></p>
            <form class="form-grid" data-form="profile">
              <div class="two-col">
                <div class="field">
                  <label for="profile-training-status">Training status</label>
                  <select id="profile-training-status" name="trainingStatus" required>
                    ${selectOption("board_certified", "Board certified", profile.trainingStatus || "")}
                    ${selectOption("board_eligible", "Board eligible", profile.trainingStatus || "")}
                    ${selectOption("fellow", "Fellow", profile.trainingStatus || "")}
                  </select>
                </div>
                <div class="field">
                  <label for="profile-previous-board">Previously taken the board</label>
                  <select id="profile-previous-board" name="previousBoard" required>
                    ${selectOption("yes", "Yes", profile.previousBoard || "")}
                    ${selectOption("no", "No", profile.previousBoard || "")}
                  </select>
                </div>
              </div>
              <div class="two-col">
                <div class="field">
                  <label for="profile-training-state">Training state</label>
                  <select id="profile-training-state" name="trainingState" required>${stateOptions(profile.trainingState || "")}</select>
                </div>
                <div class="field">
                  <label for="profile-practice-state">Current practice state</label>
                  <select id="profile-practice-state" name="practiceState" required>${stateOptions(profile.practiceState || "")}</select>
                </div>
              </div>
              <button class="primary" type="submit">Save profile</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-body">
            <h2 class="section-title">Exports</h2>
            <div class="mode-actions">
              <button class="button" type="button" data-view="report">Progress report</button>
            </div>
            <p class="footer-note">Server-side generation exports use anonymous evaluator IDs and do not include raw email addresses.</p>
          </div>
        </div>
      </section>
    `;
  }

  function renderQuestionHeader(q, options = {}) {
    const showMeta = options.showMeta !== false;
    const showCode = options.showCode !== false;
    const title = options.title || `${String(q.number)}. ${q.title}`;
    return `
      <header class="question-header">
        <div>
          <h2>${escapeHTML(title)}</h2>
          ${showMeta ? `<div class="question-meta">
            <span class="pill">${escapeHTML(displayDomain(q.domain))}</span>
            <span class="pill">${escapeHTML(q.topicGroup)}</span>
            <span class="pill">Core ${escapeHTML(q.coreContentCode || "n/a")}</span>
            ${q.topic && q.topic !== q.topicGroup ? `<span class="pill">${escapeHTML(q.topic)}</span>` : ""}
          </div>` : ""}
        </div>
        ${showCode ? `<span class="question-code">${escapeHTML(q.questionId)}</span>` : ""}
      </header>
    `;
  }

  function renderStaticOption(option, answer) {
    const rowClass = option.letter === answer ? " correct" : "";
    return `
      <div class="option-row${rowClass}">
        <span class="option-letter">${escapeHTML(option.letter)}.</span>
        <span>${escapeHTML(option.text)}</span>
      </div>
    `;
  }

  function renderLearnerOption(option, answer, selected, answered) {
    const isCorrect = answered && option.letter === answer;
    const isIncorrect = answered && option.letter === selected && selected !== answer;
    const rowClass = isCorrect ? " correct" : isIncorrect ? " incorrect" : "";
    const checked = option.letter === selected ? " checked" : "";
    const disabled = answered ? " disabled" : "";
    const displayLetter = option.displayLetter || option.letter;
    return `
      <label class="option-row${rowClass}">
        <input type="radio" name="selected" value="${escapeAttr(option.letter)}"${checked}${disabled} required>
        <span><span class="option-letter">${escapeHTML(displayLetter)}.</span>${escapeHTML(option.text)}</span>
      </label>
    `;
  }

  function renderAnswerPanel(q, answerLabel = "") {
    return `
      <section class="answer-panel">
        <h3>Answer: ${escapeHTML(answerLabel || q.answer)}</h3>
        <p>${escapeHTML(q.rationale)}</p>
        <p class="citation">${escapeHTML(q.citation)}</p>
      </section>
    `;
  }

  function renderResultBanner(record, selectedLabel = "") {
    const cls = record.correct ? "correct" : "incorrect";
    const text = record.correct ? "Correct" : `Incorrect. You selected ${selectedLabel || record.selected}.`;
    return `<div class="result-banner ${cls}">${escapeHTML(text)}</div>`;
  }

  function renderCheckbox(name, value, label, selected, disabled) {
    const checked = selected.includes(value) ? " checked" : "";
    const disabledAttr = disabled ? " disabled" : "";
    return `
      <label class="checkbox-chip">
        <input type="checkbox" name="${escapeAttr(name)}" value="${escapeAttr(value)}"${checked}${disabledAttr}>
        <span>${escapeHTML(label)}</span>
      </label>
    `;
  }

  function renderEmptyQuestion(message) {
    return `<section class="panel empty-state"><p>${escapeHTML(message)}</p></section>`;
  }

  function renderMessage() {
    if (!state.message) {
      return "";
    }
    const type = state.message.type === "error" ? "error" : "success";
    return `<div class="alert ${type}">${escapeHTML(state.message.text)}</div>`;
  }

  async function handleSubmit(event) {
    const formType = event.target.dataset.form;
    if (!formType) {
      return;
    }
    event.preventDefault();
    clearMessage();
    try {
      const data = new FormData(event.target);
      if (formType === "register") {
        await register(data);
      } else if (formType === "login") {
        await login(data);
      } else if (formType === "forgot-password") {
        await requestPasswordReset(data);
      } else if (formType === "reset-password") {
        await resetPassword(data);
      } else if (formType === "admin-login") {
        await adminLogin(data);
      } else if (formType === "evaluation-mode") {
        await saveEvaluationMode(data);
      } else if (formType === "notify-qualified-reviewers") {
        await notifyQualifiedReviewers(data);
      } else if (formType === "review") {
        await saveReview(data);
      } else if (formType === "learner-session") {
        await startLearnerSession(data);
      } else if (formType === "learner-answer") {
        await saveLearnerAnswer(data);
      } else if (formType === "learner-flag") {
        await saveLearnerFlag(data);
      } else if (formType === "profile") {
        await saveProfile(data);
      }
    } catch (error) {
      setMessage("error", error.message || "Something went wrong.");
      render();
    }
  }

  function handleClick(event) {
    const modalCard = event.target.closest(".modal-card");
    const backdropAction = event.target.classList.contains("modal-backdrop") ? event.target.dataset.action : "";
    if (backdropAction && !modalCard) {
      runAction(backdropAction);
      return;
    }
    const view = event.target.closest("[data-view]")?.dataset.view;
    if (view) {
      state.view = view;
      clearMessage();
      render();
      return;
    }
    const authMode = event.target.closest("[data-auth-mode]")?.dataset.authMode;
    if (authMode) {
      const shouldShowAccountAccess = Boolean(event.target.closest("[data-auth-cta]"));
      state.authMode = authMode;
      state.view = "auth";
      clearMessage();
      render();
      if (shouldShowAccountAccess) {
        requestAnimationFrame(scrollToAccountAccess);
      }
      return;
    }
    const learnerQid = event.target.closest("[data-learner-qid]")?.dataset.learnerQid;
    if (learnerQid) {
      state.learnerQid = learnerQid;
      state.learnerFlagOpenQid = "";
      clearMessage();
      render();
      return;
    }
    const learnerFlagQid = event.target.closest("[data-learner-flag-toggle]")?.dataset.learnerFlagToggle;
    if (learnerFlagQid) {
      state.learnerFlagOpenQid = state.learnerFlagOpenQid === learnerFlagQid ? "" : learnerFlagQid;
      clearMessage();
      render();
      return;
    }
    const resumeSessionId = event.target.closest("[data-learner-resume-session]")?.dataset.learnerResumeSession;
    if (resumeSessionId) {
      resumeLearnerSession(resumeSessionId);
      return;
    }
    const finishSessionId = event.target.closest("[data-learner-finish-session]")?.dataset.learnerFinishSession;
    if (finishSessionId) {
      finishLearnerSession(finishSessionId);
      return;
    }
    const evaluatorQid = event.target.closest("[data-evaluator-qid]")?.dataset.evaluatorQid;
    if (evaluatorQid) {
      state.evaluatorQid = evaluatorQid;
      clearMessage();
      render();
      return;
    }
    const actionElement = event.target.closest("[data-action]");
    if (modalCard && actionElement?.classList.contains("modal-backdrop")) {
      return;
    }
    const action = actionElement?.dataset.action;
    if (action) {
      runAction(action);
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Escape" && state.evaluatorHelpOpen) {
      state.evaluatorHelpOpen = false;
      render();
    }
  }

  function handleChange(event) {
    const filter = event.target.dataset.filter;
    if (!filter) {
      return;
    }
    state[filter] = event.target.value;
    if (filter === "learnerDomain") {
      state.learnerTopicGroup = "all";
      state.learnerTopic = "all";
    }
    if (filter === "learnerTopicGroup") {
      state.learnerTopic = "all";
    }
    if (filter === "evaluatorDomain") {
      state.evaluatorTopicGroup = "all";
      state.evaluatorTopic = "all";
    }
    if (filter === "evaluatorTopicGroup") {
      state.evaluatorTopic = "all";
    }
    if (filter.startsWith("learner")) {
      state.learnerQid = "";
    }
    if (filter.startsWith("evaluator")) {
      state.evaluatorQid = "";
    }
    clearMessage();
    render();
  }

  function scrollToAccountAccess() {
    const panel = document.getElementById("account-access");
    if (!panel) {
      return;
    }
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    panel.focus({ preventScroll: true });
  }

  async function register(data) {
    const payload = formPayload(data);
    const response = await apiPost("/api/register", payload);
    state.token = response.token;
    localStorage.setItem(STORAGE.token, state.token);
    state.user = response.user;
    await refreshData();
    state.learnerSession = null;
    state.learnerQid = "";
    state.learnerFlagOpenQid = "";
    state.view = "menu";
    setMessage("success", `Anonymous account created: ${state.user.anonymousUserId}`);
    render();
  }

  async function login(data) {
    const response = await apiPost("/api/login", formPayload(data));
    state.token = response.token;
    localStorage.setItem(STORAGE.token, state.token);
    state.user = response.user;
    await refreshData();
    state.learnerSession = null;
    state.learnerQid = "";
    state.learnerFlagOpenQid = "";
    state.view = "menu";
    setMessage("success", `Logged in as ${state.user.anonymousUserId}`);
    render();
  }

  async function requestPasswordReset(data) {
    const response = await apiPost("/api/request-password-reset", {
      email: String(data.get("email") || "")
    });
    state.pendingResetCode = response.resetCode || "";
    state.authMode = "reset";
    setMessage("success", response.message || "If an account exists for that email, a reset code has been sent.");
    render();
  }

  async function resetPassword(data) {
    const response = await apiPost("/api/reset-password", {
      resetCode: String(data.get("resetCode") || ""),
      password: String(data.get("password") || "")
    });
    state.token = response.token;
    localStorage.setItem(STORAGE.token, state.token);
    state.user = response.user;
    state.pendingResetCode = "";
    await refreshData();
    state.learnerSession = null;
    state.learnerQid = "";
    state.learnerFlagOpenQid = "";
    state.view = "menu";
    state.authMode = "login";
    setMessage("success", "Password reset. You are logged in.");
    render();
  }

  async function adminLogin(data) {
    state.adminToken = String(data.get("adminToken") || "").trim();
    state.token = "";
    localStorage.removeItem(STORAGE.token);
    await loadAdmin();
    localStorage.setItem(STORAGE.adminToken, state.adminToken);
    state.view = "admin";
    setMessage("success", "Admin dashboard opened.");
    render();
  }

  async function saveReview(data) {
    const payload = {
      recordId: String(data.get("recordId") || ""),
      disposition: String(data.get("disposition") || ""),
      difficulty: String(data.get("difficulty") || ""),
      quality: String(data.get("quality") || ""),
      confidence: String(data.get("confidence") || ""),
      generationIssueFlags: data.getAll("generationIssueFlags").map(String),
      comments: String(data.get("comments") || "")
    };
    const response = await apiPost("/api/review", payload);
    await refreshData();
    if (response.review?.lateAfterDecision) {
      setMessage("success", "Feedback saved. This question had already reached a decision, so it was logged but not counted.");
    } else if (state.user.qualifiedVoter) {
      setMessage("success", "Qualified vote saved.");
    } else {
      setMessage("success", "Feedback saved. It is not counted as a qualified vote.");
    }
    render();
  }

  async function startLearnerSession(data) {
    const questions = filteredLearnerQuestions();
    if (!questions.length) {
      setMessage("error", "No accepted learner-pool questions match those settings.");
      render();
      return;
    }
    const requested = Math.max(1, Math.floor(Number(data.get("questionCount") || state.learnerQuizCount || 10)));
    const count = Math.min(requested, questions.length);
    const sessionId = newLearnerSessionId();
    const selectedQuestions = shuffleWithSeed(questions, sessionId).slice(0, count);
    const answerOrders = {};
    selectedQuestions.forEach((question) => {
      answerOrders[question.id] = shuffleWithSeed(question.options.map((option) => option.letter), `${sessionId}:${question.id}`);
    });
    state.learnerQuizCount = requested;
    const session = {
      id: sessionId,
      quizSessionId: sessionId,
      createdAt: new Date().toISOString(),
      status: "active",
      requestedCount: requested,
      filter: state.learnerFilter,
      domain: state.learnerDomain,
      topicGroup: state.learnerTopicGroup,
      topic: state.learnerTopic,
      questionIds: selectedQuestions.map((question) => question.id),
      answerOrders
    };
    const response = await apiPost("/api/learner-session", { action: "create", session });
    state.learnerSession = normalizeLearnerSession(response.session || session);
    state.learnerSessions[state.learnerSession.id] = state.learnerSession;
    state.learnerQid = selectedQuestions[0]?.id || "";
    state.learnerFlagOpenQid = "";
    setMessage("success", `Quiz generated with ${count} question${count === 1 ? "" : "s"}.`);
    render();
  }

  async function saveLearnerAnswer(data) {
    const recordId = String(data.get("recordId") || "");
    const selected = String(data.get("selected") || "");
    const displayOrder = String(data.get("displayOrder") || "")
      .split(",")
      .map((letter) => letter.trim())
      .filter(Boolean);
    const displaySelected = displayLetterForOriginal(selected, learnerDisplayOptions(state.questions.find((q) => q.id === recordId) || {}));
    await apiPost("/api/learner-answer", {
      recordId,
      selected,
      quizSessionId: String(data.get("quizSessionId") || state.learnerSession?.id || ""),
      quizQuestionIds: state.learnerSession?.questionIds || [],
      quizCriteria: state.learnerSession ? {
        requestedCount: state.learnerSession.requestedCount,
        filter: state.learnerSession.filter,
        domain: state.learnerSession.domain,
        topicGroup: state.learnerSession.topicGroup,
        topic: state.learnerSession.topic
      } : {},
      displayOrder,
      displaySelected
    });
    await refreshData();
    const record = currentLearnerAttempt(recordId) || state.progress[recordId];
    setMessage(record?.correct ? "success" : "error", record?.correct ? "Correct." : "Incorrect.");
    render();
  }

  async function pauseLearnerSession() {
    const sessionId = state.learnerSession?.id || "";
    if (!sessionId) {
      setMessage("error", "No active quiz to pause.");
      render();
      return;
    }
    try {
      const response = await apiPost("/api/learner-session", { action: "pause", quizSessionId: sessionId });
      const session = normalizeLearnerSession(response.session || {});
      if (session.id) {
        state.learnerSessions[session.id] = session;
      }
      state.learnerSession = null;
      state.learnerQid = "";
      state.learnerFlagOpenQid = "";
      setMessage("success", "Quiz paused. You can resume it from learner mode.");
      render();
    } catch (error) {
      setMessage("error", error.message || "Could not pause quiz.");
      render();
    }
  }

  async function resumeLearnerSession(sessionId) {
    const existing = state.learnerSessions[sessionId];
    if (!existing) {
      setMessage("error", "That paused quiz was not found.");
      render();
      return;
    }
    try {
      const response = await apiPost("/api/learner-session", { action: "resume", quizSessionId: sessionId });
      const session = normalizeLearnerSession(response.session || existing);
      state.learnerSessions[session.id] = session;
      state.learnerSession = session;
      state.learnerQid = firstUnansweredQuestionId(session) || session.questionIds[0] || "";
      state.learnerFlagOpenQid = "";
      setMessage("success", "Quiz resumed.");
      render();
    } catch (error) {
      setMessage("error", error.message || "Could not resume quiz.");
      render();
    }
  }

  async function finishLearnerSession(sessionId) {
    sessionId = sessionId || state.learnerSession?.id || "";
    if (!sessionId) {
      setMessage("error", "No quiz session was selected.");
      render();
      return;
    }
    try {
      const response = await apiPost("/api/learner-session", { action: "finish", quizSessionId: sessionId });
      const session = normalizeLearnerSession(response.session || {});
      if (session.id) {
        state.learnerSessions[session.id] = session;
      }
      if (state.learnerSession?.id === sessionId) {
        state.learnerSession = null;
        state.learnerQid = "";
        state.learnerFlagOpenQid = "";
      }
      const unanswered = Number(session.unansweredCount || Math.max(0, (session.questionIds || []).length - sessionAnsweredCount(session)));
      const suffix = unanswered
        ? ` ${unanswered} unanswered question${unanswered === 1 ? "" : "s"} returned to the learner pool.`
        : "";
      setMessage("success", `Quiz finished. Your completed answers remain in your learner progress.${suffix}`);
      render();
    } catch (error) {
      setMessage("error", error.message || "Could not finish quiz.");
      render();
    }
  }

  async function saveLearnerFlag(data) {
    const recordId = String(data.get("recordId") || "");
    await apiPost("/api/learner-flag", {
      recordId,
      generationIssueFlags: data.getAll("learnerIssueFlags").map(String),
      comments: String(data.get("comments") || "")
    });
    await refreshData();
    state.learnerFlagOpenQid = "";
    setMessage("success", "Question flag saved for admin review.");
    render();
  }

  async function saveProfile(data) {
    const response = await apiPost("/api/profile", formPayload(data));
    state.user = response.user;
    await refreshData();
    setMessage("success", "Profile saved.");
    render();
  }

  async function saveEvaluationMode(data) {
    const evaluationMode = String(data.get("evaluationMode") || "sandbox");
    const response = await adminPost("/api/admin/set-evaluation-mode", { evaluationMode });
    state.adminSummary = response.summary;
    setMessage("success", `Evaluation mode set to ${evaluationModeLabel(response.environment?.evaluation_mode || evaluationMode)}.`);
    render();
  }

  async function notifyQualifiedReviewers(data) {
    const response = await adminPost("/api/admin/notify-qualified-reviewers", {
      questionCount: Number(data.get("questionCount") || 0),
      availableQuestionCount: Number(data.get("availableQuestionCount") || 0),
      note: String(data.get("note") || "")
    });
    state.adminSummary = response.summary;
    const missing = Number(response.missing_contact || 0);
    const failed = Number(response.failed || 0);
    const detail = failed
      ? `${response.sent} sent, ${failed} failed, ${missing} missing contact email.`
      : `${response.sent} sent. ${missing} qualified reviewer${missing === 1 ? "" : "s"} missing contact email.`;
    setMessage(failed ? "error" : "success", `Reviewer alert complete: ${detail}`);
    render();
  }

  function formPayload(data) {
    return {
      email: String(data.get("email") || ""),
      password: String(data.get("password") || ""),
      accessCode: String(data.get("accessCode") || ""),
      trainingStatus: String(data.get("trainingStatus") || ""),
      previousBoard: String(data.get("previousBoard") || ""),
      trainingState: String(data.get("trainingState") || ""),
      practiceState: String(data.get("practiceState") || "")
    };
  }

  function runAction(action) {
    if (action === "open-evaluator-instructions") {
      state.evaluatorHelpOpen = true;
      render();
      return;
    }
    if (action === "close-evaluator-instructions") {
      state.evaluatorHelpOpen = false;
      render();
      return;
    }
    if (action === "logout") {
      localStorage.removeItem(STORAGE.token);
      localStorage.removeItem(STORAGE.adminToken);
      state.token = "";
      state.adminToken = "";
      state.isAdmin = false;
      state.adminSummary = null;
      state.user = null;
      state.view = "auth";
      state.authMode = "login";
      state.pendingResetCode = "";
      state.questions = [];
      state.reviews = {};
      state.progress = {};
      state.learnerSessions = {};
      state.learnerFlags = {};
      state.learnerSession = null;
      state.learnerQid = "";
      state.learnerFlagOpenQid = "";
      clearMessage();
      render();
      return;
    }
    if (action === "admin-refresh") {
      refreshAdminDashboard();
      return;
    }
    if (action === "export-admin-summary") {
      exportAdminSummary();
      return;
    }
    if (action === "export-lifecycle-json") {
      exportLifecycleJSON();
      return;
    }
    if (action === "export-concepts-json") {
      exportConceptsJSON();
      return;
    }
    if (action === "export-llm-feedback-json") {
      exportLLMFeedbackJSON();
      return;
    }
    if (action === "export-generation-feedback-json") {
      exportGenerationFeedbackJSON();
      return;
    }
    if (action === "export-publication-json") {
      exportPublicationJSON();
      return;
    }
    if (action === "learner-new-session") {
      state.learnerSession = null;
      state.learnerQid = "";
      state.learnerFlagOpenQid = "";
      clearMessage();
      render();
      return;
    }
    if (action === "learner-pause-session") {
      pauseLearnerSession();
      return;
    }
    if (action === "learner-finish-session") {
      finishLearnerSession(state.learnerSession?.id || "");
      return;
    }
    if (action === "learner-prev" || action === "learner-next") {
      moveQuestion("learner", action.endsWith("next") ? 1 : -1);
      render();
      return;
    }
    if (action === "evaluator-prev" || action === "evaluator-next") {
      moveQuestion("evaluator", action.endsWith("next") ? 1 : -1);
      render();
      return;
    }
  }

  function moveQuestion(mode, direction) {
    const questions = mode === "learner" ? learnerSessionQuestions() : filteredEvaluatorQuestions();
    if (!questions.length) {
      return;
    }
    const key = mode === "learner" ? "learnerQid" : "evaluatorQid";
    const current = Math.max(0, questions.findIndex((q) => q.id === state[key]));
    state[key] = questions[(current + direction + questions.length) % questions.length].id;
    if (mode === "learner") {
      state.learnerFlagOpenQid = "";
    }
    clearMessage();
  }

  function ensureCurrentQuestion(mode, questions) {
    if (!questions.length) {
      return null;
    }
    const key = mode === "learner" ? "learnerQid" : "evaluatorQid";
    if (!state[key] || !questions.some((q) => q.id === state[key])) {
      state[key] = questions[0].id;
    }
    return questions.find((q) => q.id === state[key]) || questions[0];
  }

  function filteredEvaluatorQuestions() {
    return state.questions.filter((q) => {
      if (state.reviews[q.id]) {
        return false;
      }
      if (!q.reviewAvailable) {
        return false;
      }
      if (state.evaluatorDomain !== "all" && q.domain !== state.evaluatorDomain) {
        return false;
      }
      if (state.evaluatorTopicGroup !== "all" && topicGroupFilterKey(q) !== state.evaluatorTopicGroup) {
        return false;
      }
      if (state.evaluatorTopic !== "all" && q.topic !== state.evaluatorTopic) {
        return false;
      }
      return true;
    });
  }

  function filteredLearnerQuestions() {
    return state.questions.filter((q) => {
      if (!q.learnAvailable) {
        return false;
      }
      if (state.learnerDomain !== "all" && q.domain !== state.learnerDomain) {
        return false;
      }
      if (state.learnerTopicGroup !== "all" && topicGroupFilterKey(q) !== state.learnerTopicGroup) {
        return false;
      }
      if (state.learnerTopic !== "all" && q.topic !== state.learnerTopic) {
        return false;
      }
      const record = state.progress[q.id];
      if (state.learnerFilter === "unanswered") {
        return !record;
      }
      if (state.learnerFilter === "missed") {
        return record && !record.correct;
      }
      if (state.learnerFilter === "correct") {
        return record && record.correct;
      }
      return true;
    });
  }

  function learnerSessionQuestions() {
    const session = state.learnerSession;
    if (!session || !Array.isArray(session.questionIds)) {
      return [];
    }
    const byId = new Map(state.questions.map((question) => [question.id, question]));
    return session.questionIds
      .map((recordId) => byId.get(recordId))
      .filter((question) => question && question.learnAvailable);
  }

  function resumableLearnerSessions() {
    return Object.values(state.learnerSessions || {})
      .filter((session) => session && ["active", "paused"].includes(session.status))
      .filter((session) => Array.isArray(session.questionIds) && session.questionIds.some((recordId) => {
        const question = state.questions.find((q) => q.id === recordId);
        return question && question.learnAvailable;
      }))
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  }

  function sessionAnsweredCount(session) {
    return (session.questionIds || []).filter((recordId) => {
      const record = state.progress[recordId];
      const history = Array.isArray(record?.history) ? record.history : [];
      return history.some((attempt) => attempt?.quizSessionId === session.id);
    }).length;
  }

  function firstUnansweredQuestionId(session) {
    return (session.questionIds || []).find((recordId) => {
      const question = state.questions.find((q) => q.id === recordId);
      if (!question || !question.learnAvailable) {
        return false;
      }
      const record = state.progress[recordId];
      const history = Array.isArray(record?.history) ? record.history : [];
      return !history.some((attempt) => attempt?.quizSessionId === session.id);
    });
  }

  function learnerDisplayOptions(q) {
    const options = Array.isArray(q.options) ? q.options : [];
    const session = state.learnerSession || {};
    const storedOrder = session.answerOrders?.[q.id];
    const order = Array.isArray(storedOrder) && storedOrder.length
      ? storedOrder
      : options.map((option) => option.letter);
    const byLetter = new Map(options.map((option) => [option.letter, option]));
    const ordered = order
      .map((letter) => byLetter.get(letter))
      .filter(Boolean);
    options.forEach((option) => {
      if (!ordered.some((orderedOption) => orderedOption.letter === option.letter)) {
        ordered.push(option);
      }
    });
    return ordered.map((option, index) => ({
      ...option,
      displayLetter: DISPLAY_LETTERS[index] || String(index + 1)
    }));
  }

  function displayLetterForOriginal(originalLetter, displayOptions) {
    const match = displayOptions.find((option) => option.letter === originalLetter);
    return match ? match.displayLetter : originalLetter;
  }

  function currentLearnerAttempt(recordId) {
    const sessionId = state.learnerSession?.id;
    if (!sessionId) {
      return null;
    }
    const record = state.progress[recordId];
    const history = Array.isArray(record?.history) ? record.history : [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const attempt = history[index];
      if (attempt && attempt.quizSessionId === sessionId) {
        return {
          selected: attempt.selected || "",
          correctAnswer: record.correctAnswer || attempt.correctAnswer || "",
          correct: Boolean(attempt.correct),
          answeredAt: attempt.answeredAt || "",
          quizSessionId: sessionId
        };
      }
    }
    return null;
  }

  function learnerSessionStats(questions) {
    const attempts = questions.map((question) => currentLearnerAttempt(question.id)).filter(Boolean);
    const correct = attempts.filter((attempt) => attempt.correct).length;
    return {
      total: questions.length,
      answered: attempts.length,
      correct,
      incorrect: attempts.length - correct,
      remaining: Math.max(0, questions.length - attempts.length)
    };
  }

  function sessionSummaryText(session, questionCount) {
    if (!session) {
      return "";
    }
    const parts = [
      learnerFilterLabel(session.filter),
      session.domain === "all" ? "all domains" : displayDomain(session.domain),
      session.topicGroup === "all" ? "" : topicGroupLabelForKey(session.topicGroup),
      session.topic === "all" ? "" : session.topic
    ].filter(Boolean);
    return `${questionCount} question${questionCount === 1 ? "" : "s"} from ${parts.join(" / ")}.`;
  }

  function learnerFilterLabel(value) {
    if (value === "unanswered") {
      return "unseen";
    }
    if (value === "missed") {
      return "previously incorrect";
    }
    if (value === "correct") {
      return "previously correct";
    }
    return "all questions";
  }

  function topicGroupLabelForKey(key) {
    if (!key || key === "all") {
      return "";
    }
    const match = state.questions.find((question) => topicGroupFilterKey(question) === key);
    return match?.topicGroup || TOPIC_GROUP_LABELS[key] || key;
  }

  function newLearnerSessionId() {
    return `learn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function hashString(value) {
    let hash = 2166136261;
    String(value).split("").forEach((char) => {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    });
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let value = hashString(seed) || 1;
    return function nextRandom() {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      return value / 4294967296;
    };
  }

  function shuffleWithSeed(items, seed) {
    const shuffled = items.slice();
    const random = seededRandom(seed);
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  function learnerStats() {
    const available = state.questions.filter((q) => q.learnAvailable);
    const records = Object.entries(state.progress).filter(([recordId]) => available.some((q) => q.id === recordId)).map(([, record]) => record);
    const answered = records.length;
    const correct = records.filter((record) => record.correct).length;
    return {
      answered,
      correct,
      incorrect: answered - correct,
      percent: answered ? Math.round((correct / answered) * 100) : 0,
      remaining: Math.max(0, available.length - answered),
      totalAvailable: available.length
    };
  }

  function progressBreakdown(key) {
    const rows = new Map();
    state.questions
      .filter((q) => q.learnAvailable)
      .forEach((q) => {
        const label = key === "domain" ? displayDomain(q[key]) : (q[key] || "Unassigned");
        if (!rows.has(label)) {
          rows.set(label, { label, total: 0, answered: 0, correct: 0, remaining: 0, percent: 0 });
        }
        const row = rows.get(label);
        const record = state.progress[q.id];
        row.total += 1;
        if (record) {
          row.answered += 1;
          if (record.correct) {
            row.correct += 1;
          }
        }
      });
    return Array.from(rows.values())
      .map((row) => ({
        ...row,
        remaining: Math.max(0, row.total - row.answered),
        percent: row.answered ? Math.round((row.correct / row.answered) * 100) : 0
      }))
      .sort((a, b) => b.answered - a.answered || a.label.localeCompare(b.label));
  }

  function evaluatorStats() {
    const records = Object.values(state.reviews);
    return {
      reviewed: records.length,
      acceptedVotes: records.filter((record) => voteBucket(record) === "accept").length,
      rejectedVotes: records.filter((record) => voteBucket(record) === "reject").length
    };
  }

  function reviewDisposition(record = {}) {
    if (record.disposition) {
      return record.disposition;
    }
    if (record.verdict === "accept") {
      return "accept_as_is";
    }
    if (record.verdict === "reject") {
      return "reject";
    }
    return "";
  }

  function voteBucket(record = {}) {
    if (record.verdict === "accept" || record.verdict === "reject") {
      return record.verdict;
    }
    const disposition = reviewDisposition(record);
    if (disposition === "accept_as_is" || disposition === "accept_with_revisions") {
      return "accept";
    }
    if (disposition === "major_revisions_needed" || disposition === "reject") {
      return "reject";
    }
    return "";
  }

  function poolStats() {
    if (state.poolCounts) {
      return {
        voting: state.poolCounts.voting || 0,
        accepted: state.poolCounts.accepted || 0,
        rejected: state.poolCounts.rejected || 0,
        paused: state.poolCounts.paused || 0
      };
    }
    return {
      voting: state.questions.filter((q) => q.reviewAvailable).length,
      accepted: 0,
      rejected: 0,
      paused: 0
    };
  }

  function availableEvaluationCount() {
    if (state.poolCounts) {
      return state.poolCounts.available_for_evaluation || 0;
    }
    return state.questions.filter((q) => q.reviewAvailable && !state.reviews[q.id]).length;
  }

  function domainOptions(selected) {
    const domains = Array.from(new Set(state.questions.map((q) => q.domain))).sort((a, b) => displayDomain(a).localeCompare(displayDomain(b)));
    return selectOption("all", "All domains", selected) + domains.map((domain) => selectOption(domain, displayDomain(domain), selected)).join("");
  }

  function displayDomain(value) {
    const text = String(value || "Unassigned").trim();
    if (!text || text === "Unassigned") {
      return "Unassigned";
    }
    if (text !== text.toUpperCase()) {
      return text;
    }
    const lowerWords = new Set(["and", "of", "or", "the", "to", "in", "for"]);
    const preserve = new Set(["EMS", "QI", "QA", "CQI", "CBRNE", "CBRN", "MIH"]);
    return text
      .toLowerCase()
      .split(/\s+/)
      .map((word, index) => {
        const bare = word.replace(/[^a-z0-9]/g, "").toUpperCase();
        if (preserve.has(bare)) {
          return word.replace(/[a-z0-9]+/i, bare);
        }
        if (index > 0 && lowerWords.has(word)) {
          return word;
        }
        return word.replace(/^[a-z]/, (char) => char.toUpperCase());
      })
      .join(" ");
  }

  function topicGroupOptions(selected, mode) {
    const questions = scopedQuestionsForTopicControls(mode, false);
    const groups = new Map();
    questions.forEach((q) => {
      const key = topicGroupFilterKey(q);
      if (key && !groups.has(key)) {
        groups.set(key, q.topicGroup || key);
      }
    });
    const options = Array.from(groups.entries()).sort((a, b) => sortTopicGroupKeys(a[0], b[0]));
    return selectOption("all", "All topic groups", selected) + options.map(([key, label]) => selectOption(key, label, selected)).join("");
  }

  function topicOptions(selected, mode) {
    const questions = scopedQuestionsForTopicControls(mode, true);
    const topics = Array.from(new Set(questions.map((q) => q.topic).filter(Boolean))).sort();
    return selectOption("all", "All topics", selected) + topics.map((topic) => selectOption(topic, topic, selected)).join("");
  }

  function scopedQuestionsForTopicControls(mode, includeTopicGroup) {
    const domain = state[`${mode}Domain`];
    const topicGroup = state[`${mode}TopicGroup`];
    return state.questions.filter((q) => {
      if (mode === "evaluator" && (state.reviews[q.id] || !q.reviewAvailable)) {
        return false;
      }
      if (mode === "learner" && !q.learnAvailable) {
        return false;
      }
      if (domain && domain !== "all" && q.domain !== domain) {
        return false;
      }
      if (includeTopicGroup && topicGroup && topicGroup !== "all" && topicGroupFilterKey(q) !== topicGroup) {
        return false;
      }
      return true;
    });
  }

  function topicGroupFilterKey(q) {
    return q.topicGroupCode || q.topicGroup || "Unassigned";
  }

  function sortTopicGroupKeys(a, b) {
    const knownA = TOPIC_GROUP_LABELS[a] ? 0 : 1;
    const knownB = TOPIC_GROUP_LABELS[b] ? 0 : 1;
    if (knownA !== knownB) {
      return knownA - knownB;
    }
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  function stateOptions(selected = "") {
    return selectOption("", "Select state", selected) + STATES.map((stateCode) => selectOption(stateCode, stateCode, selected)).join("");
  }

  function selectOption(value, label, selected) {
    const isSelected = String(value) === String(selected) ? " selected" : "";
    return `<option value="${escapeAttr(value)}"${isSelected}>${escapeHTML(label)}</option>`;
  }

  function stat(value, label) {
    return `
      <div class="stat">
        <span class="stat-value">${escapeHTML(String(value))}</span>
        <span class="stat-label">${escapeHTML(label)}</span>
      </div>
    `;
  }

  async function refreshAdminDashboard() {
    try {
      await loadAdmin();
      setMessage("success", "Admin dashboard refreshed.");
      render();
    } catch (error) {
      setMessage("error", error.message || "Could not refresh admin dashboard.");
      render();
    }
  }

  function exportAdminSummary() {
    if (!state.adminSummary) {
      setMessage("error", "Admin summary is not loaded.");
      render();
      return;
    }
    downloadText(`ems_admin_summary_${dateStamp()}.json`, JSON.stringify(state.adminSummary, null, 2), "application/json");
  }

  async function exportLifecycleJSON() {
    try {
      const response = await adminGet("/api/admin/export-lifecycle");
      downloadText(`ems_lifecycle_registry_${dateStamp()}.json`, JSON.stringify(response, null, 2), "application/json");
    } catch (error) {
      setMessage("error", error.message || "Could not export lifecycle registry.");
      render();
    }
  }

  async function exportConceptsJSON() {
    try {
      const response = await adminGet("/api/admin/export-concepts");
      downloadText(`ems_concept_lifecycle_registry_${dateStamp()}.json`, JSON.stringify(response, null, 2), "application/json");
    } catch (error) {
      setMessage("error", error.message || "Could not export concept registry.");
      render();
    }
  }

  async function exportLLMFeedbackJSON() {
    try {
      const response = await adminGet("/api/admin/export-llm-feedback");
      downloadText(`ems_llm_feedback_${dateStamp()}.json`, JSON.stringify(response, null, 2), "application/json");
    } catch (error) {
      setMessage("error", error.message || "Could not export LLM feedback.");
      render();
    }
  }

  async function exportGenerationFeedbackJSON() {
    try {
      const response = await adminGet("/api/admin/export-generation-feedback");
      downloadText(`ems_generation_feedback_${dateStamp()}.json`, JSON.stringify(response, null, 2), "application/json");
    } catch (error) {
      setMessage("error", error.message || "Could not export generation feedback.");
      render();
    }
  }

  async function exportPublicationJSON() {
    try {
      const response = await adminGet("/api/admin/export-publication");
      downloadText(`ems_publication_state_analysis_${dateStamp()}.json`, JSON.stringify(response, null, 2), "application/json");
    } catch (error) {
      setMessage("error", error.message || "Could not export publication data.");
      render();
    }
  }

  function toCSV(rows) {
    if (!rows.length) {
      return "";
    }
    const headers = Object.keys(rows[0]);
    return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n");
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function setMessage(type, text) {
    state.message = { type, text };
  }

  function clearMessage() {
    state.message = null;
  }

  function dateStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value || "";
    }
    return date.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function labelize(value) {
    return String(value || "").replaceAll("_", " ");
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHTML(value);
  }
})();
