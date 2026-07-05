# EMS Board Question Bank Web Prototype

Run the local server from the project root:

```bash
python3 web/server.py serve --port 8000
```

Open:

```text
http://localhost:8000/web/
```

Initial registration access code:

```text
EMS2026-PILOT
```

## Data Model

- Raw emails are not stored. Login uses a server-secret HMAC of the normalized email.
- Each account receives an anonymous evaluator ID such as `ANON-...`.
- Forgot-password requests use short-lived reset codes. Raw email is used only transiently to compute the private account hash and, when configured, send the reset email.
- Learner answers and evaluator reviews are stored server-side under `web/server_data/`.
- Learner answer analytics are aggregated per question, including correct/incorrect attempts and selected/ignored counts for each distractor.
- Learner mode only includes accepted questions. Unvoted voting-pool questions are not available for practice.
- Learners can view an in-app progress report; individual learner progress export is not exposed in the user UI.
- Learners can flag accepted questions for admin review with the same issue labels used by evaluators.
- Each evaluator review stores the evaluator profile snapshot at submission, including board-status answer, training state, and practice state.
- Only reviews whose submission-time profile says the evaluator previously took the board exam count as qualified votes.
- Sandbox and beta-test reviews are recorded but do not count toward accept/reject decisions.
- Each evaluator review stores `evaluationMode` as `sandbox`, `beta`, or `live`, plus `countsTowardDecision`.
- Evaluators choose one disposition: `Accept as is`, `Accept with revisions`, `Major revisions needed`, or `Reject`.
- `Accept as is` and `Accept with revisions` count as accept votes.
- `Major revisions needed` and `Reject` count as reject votes.
- A question is accepted after 2 qualified accept votes.
- A question is rejected after 2 qualified reject votes.
- If the first 2 qualified votes split 1 accept / 1 reject, the question remains open as a tiebreaker item.
- Evaluators cannot vote on the same question twice, and completed questions are removed from their evaluator feed.
- Evaluators do not see per-question vote counts, prior-review status, or whether an available question is a tiebreaker.
- Evaluator and learner feeds are randomized per anonymous user ID.
- Evaluator and learner views can be filtered by domain, readable topic group, and topic.
- Topic groups display names such as `Resuscitation` or `EMS Systems`; the underlying numeric topic-group code is retained for admin/export traceability.
- Non-admin evaluators see only high-level review counts, not the pool table.
- Prior provisional-lock status from generated packets is ignored for pool decisions.

## Admin Dashboard

Use the `Admin` login tab with the token stored at:

```text
web/server_data/admin_token.txt
```

The admin dashboard is blinded. It shows aggregate evaluator counts, pool status, tiebreaker counts, per-question vote tallies, and feedback/action counts without displaying raw email addresses. The detailed pool table lives here, not in the evaluator account UI.

The dashboard also shows whether the server is running in sandbox, beta, or live decision mode. In sandbox and beta modes, evaluator votes and learner flags are saved, but votes do not move questions into accepted or rejected status.

The admin dashboard includes an Evaluation Mode switch. Use it to choose Sandbox, Beta, or Live from the GUI. The saved GUI setting is stored in `web/server_data/runtime_config.json` and takes effect immediately for new review submissions. Previously submitted sandbox or beta reviews remain labeled as non-counting feedback; switching to Live does not retroactively count them.

To run an online beta where testers can vote without affecting real question decisions:

```bash
EMS_QBANK_EVALUATION_ENV=beta python3 web/server.py serve --port 8000
```

To run a live deployment where qualified votes can change accepted/rejected status:

```bash
EMS_QBANK_EVALUATION_ENV=production python3 web/server.py serve --port 8000
```

Keep local development in the default sandbox mode unless you intentionally want the running data store to behave as the live site.

## Password Reset Email

In sandbox mode, password reset codes are shown on screen so the flow can be tested locally. In beta and live modes, reset codes are not shown in the browser; configure SMTP delivery before opening the site to testers:

```bash
EMS_QBANK_SMTP_HOST=smtp.example.com
EMS_QBANK_SMTP_PORT=587
EMS_QBANK_SMTP_USER=...
EMS_QBANK_SMTP_PASSWORD=...
EMS_QBANK_MAIL_FROM=no-reply@example.com
EMS_QBANK_SMTP_STARTTLS=1
EMS_QBANK_SMTP_SSL=0
EMS_QBANK_PASSWORD_RESET_BASE_URL=https://your-site.example.com/web/
```

For cPanel email, use the mailbox's outgoing SMTP settings. Many cPanel hosts use port `587` with `EMS_QBANK_SMTP_STARTTLS=1`; some use port `465` with `EMS_QBANK_SMTP_SSL=1` and `EMS_QBANK_SMTP_STARTTLS=0`.

## Question Pool Maintenance

See `web/QUESTION_LIFECYCLE_WORKFLOW.md` for the full LLM-to-website round-trip.
Use `web/QUESTION_GENERATOR_OUTPUT_CONTRACT.md` and `web/templates/question_generator_import_template.json` as the required output format for generated batches.

Import a newly generated JSON question file into the voting pool:

```bash
python3 web/server.py import outputs/path/to/generated_items.json \
  --label v9_candidate_pool \
  --batch-id 20260704_v9_candidate_pool
```

Import without activating yet:

```bash
python3 web/server.py import outputs/path/to/generated_items.json \
  --label v9_candidate_pool \
  --batch-id 20260704_v9_candidate_pool \
  --paused \
  --notes "Generated in LLM session; awaiting release to voting."
```

Retire a question without deleting its history:

```bash
python3 web/server.py set-state RECORD_ID retired --reason "superseded_by_revised_question"
```

Export feedback back to the LLM:

```bash
python3 web/server.py export-llm-feedback --out outputs/web_feedback/ems_llm_feedback_YYYYMMDD.json
```

Export the full lifecycle registry and audit log:

```bash
python3 web/server.py export-lifecycle --out outputs/web_feedback/ems_lifecycle_registry_YYYYMMDD.json
```

Export the concept-level production ledger:

```bash
python3 web/server.py export-concepts --out outputs/web_feedback/ems_concept_lifecycle_registry_YYYYMMDD.json
```

The lifecycle registry tracks exact website question records. The concept ledger tracks mapped concepts through `concept_key`, preferably the generation-map `job_id`, so accepted, voting, paused, rejected, retired, and duplicate-risk concepts can be reconciled before the next generation batch.

Export de-identified publication analysis data, including reviewer training/practice state aggregates:

```bash
python3 web/server.py export-publication --out outputs/web_feedback/ems_publication_state_analysis_YYYYMMDD.json
```

The server also exposes local admin endpoints for import, state changes, lifecycle export, LLM feedback export, and generation-feedback export. The local admin token is created at:

```text
web/server_data/admin_token.txt
```

## Render Deployment

This app must run as a Python web service, not a static GitHub Pages site. Logins, registration, voting, admin mode, exports, and review storage all require `web/server.py`.

The repo includes `render.yaml` for a Render Blueprint deployment. It creates:

- a Python web service
- a persistent disk mounted at `/var/data`
- `EMS_QBANK_DATA_ROOT=/var/data`
- initial `EMS_QBANK_EVALUATION_ENV=beta`

The server seeds `/var/data/question_bank.json` from `web/seed_data/question_bank.json` on first boot only. After that, `/var/data` is the source of truth and must be backed up. Do not overwrite it during deploys.

On Render:

1. Create a new Blueprint from the GitHub repository.
2. Confirm the service starts with:

```bash
python web/server.py serve --host 0.0.0.0 --port $PORT
```

3. Confirm the persistent disk is mounted at `/var/data`.
4. Add the custom domains `emsqbank.com` and `www.emsqbank.com`.
5. Copy the DNS records Render gives you into Network Solutions.
6. Wait for Render to issue SSL certificates.

For password reset outside sandbox mode, configure these environment variables in Render:

```bash
EMS_QBANK_SMTP_HOST=...
EMS_QBANK_SMTP_PORT=587
EMS_QBANK_SMTP_USER=...
EMS_QBANK_SMTP_PASSWORD=...
EMS_QBANK_MAIL_FROM=no-reply@emsqbank.com
EMS_QBANK_SMTP_STARTTLS=1
EMS_QBANK_SMTP_SSL=0
EMS_QBANK_PASSWORD_RESET_BASE_URL=https://emsqbank.com/web/
```

The admin token on Render is created inside the persistent disk:

```text
/var/data/admin_token.txt
```

Use the Render shell or logs to retrieve it after first boot.
