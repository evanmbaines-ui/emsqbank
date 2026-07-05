# Question Lifecycle Workflow

This is the standard round-trip between this LLM workspace and the website.

## Canonical States

- `paused`: imported but not visible to evaluators.
- `voting`: visible to evaluators.
- `accepted`: accepted by qualified evaluator vote and available to learners.
- `rejected`: rejected by qualified evaluator vote and hidden from learners.
- `retired`: deliberately removed from use. Do not reuse without importing a revised record.

## Sandbox, Beta, And Live Decisions

The local prototype defaults to sandbox mode. In sandbox mode, evaluator reviews are saved for testing and export visibility, but they are marked `evaluationMode: sandbox` and `countsTowardDecision: false`; they cannot move questions into `accepted` or `rejected`.

The admin dashboard also has an Evaluation Mode switch. A saved GUI setting takes effect immediately for new review submissions and is stored at `web/server_data/runtime_config.json`. Existing sandbox or beta reviews remain non-counting feedback even if the mode is later switched to live.

Use beta mode for an online beta test where real testers can use the site before launch without creating official accept/reject decisions:

```bash
EMS_QBANK_EVALUATION_ENV=beta python3 web/server.py serve --port 8000
```

Beta reviews are marked `evaluationMode: beta` and `countsTowardDecision: false`. Admin tables and exports list beta review counts separately from sandbox and live votes.

Only run the live deployment with decision counting enabled:

```bash
EMS_QBANK_EVALUATION_ENV=production python3 web/server.py serve --port 8000
```

Use this cleanup command if local smoke-test votes need to be protected from the official decision tally:

```bash
python3 web/server.py protect-sandbox-decisions --actor local_cleanup
```

## Add A New Generated Batch

Use `web/QUESTION_GENERATOR_OUTPUT_CONTRACT.md` as the generator prompt contract and `web/templates/question_generator_import_template.json` as the exact JSON upload shape.

Generated question files must be JSON lists. Each item should have:

- stable `question_id`
- `content_id` or `core_content_code`
- `domain`, `topic`, `stem`, `options`, `answer`, `rationale`, and `citation`
- `job_id` when available

Import with an explicit batch ID:

```bash
python3 web/server.py import outputs/path/to/generated_items.json \
  --label v9_candidate_pool \
  --batch-id 20260704_v9_candidate_pool \
  --paused \
  --notes "Generated in LLM session; awaiting admin release to voting."
```

Use `--paused` for newly generated material until you intentionally open it for voting. To open a question or batch later, use admin state changes or:

```bash
python3 web/server.py set-state RECORD_ID voting --reason "released_for_evaluator_voting"
```

## What The Import Records

Every import writes:

- `web/server_data/intake_manifests/<batch_id>.json`
- `web/server_data/lifecycle_audit_log.jsonl`
- per-question `intake_batch_id`, `intake_source_path`, `intake_source_sha256`, `content_hash`, `concept_key`, duplicate warnings, and `state_history`

If a generated item reuses a `question_id` but its content hash differs, the server creates a new lineage record instead of overwriting the old one.

## Concept-Level Production Control

The website tracks two different identifiers:

- `record_id`: the exact website question record shown to evaluators or learners.
- `concept_key`: the mapped concept/job being tested, preferably `job_id` from the 2500-question generation index.

Use `record_id` for exact question state changes. Use `concept_key` to reconcile the website against the generation map and prevent concept duplication.

On import, the server now flags:

- exact content duplication: another record has the same stem/options/answer/rationale hash.
- concept duplication: another record already represents the same `concept_key`.

Duplicate warnings are preserved in the intake manifest, admin summary, lifecycle export, and concept registry. They do not automatically block import because deliberate revisions may reuse the same concept. Treat each duplicate warning as a production-control review item before releasing a batch to voting.

Admin dashboard concept states:

- `accepted_on_site`: at least one record for the concept is accepted.
- `in_evaluator_voting`: at least one record is currently voting.
- `pushed_paused`: the concept has been imported but is not currently visible to evaluators.
- `rejected_rework_needed`: all visible lineage is rejected unless a revision is imported.
- `retired`: records exist but should not be reused.

Before generating a new batch, export the concept registry and exclude or intentionally revise concepts that are already accepted, voting, paused, or retired:

```bash
python3 web/server.py export-concepts \
  --out outputs/web_feedback/ems_concept_lifecycle_registry_YYYYMMDD.json
```

The admin dashboard also has an `Export concepts` button. Use this export to update the question generation map columns for:

- pushed to website
- latest website state
- accepted/rejected/paused/voting/retired
- current `record_id`
- current `content_hash`
- duplicate-risk flag
- revision needed from evaluator feedback

## Export Feedback Back To The LLM

Use the LLM feedback packet for revision work:

```bash
python3 web/server.py export-llm-feedback \
  --out outputs/web_feedback/ems_llm_feedback_YYYYMMDD.json
```

This packet includes each question's current state, vote tally, issue flags, comments, content hash, batch ID, lineage parent, and `llm_action`.

The feedback packet intentionally includes both qualified and non-qualified evaluator responses. Use `qualified_vote` to identify whether the submission-time profile said the reviewer had previously taken the board exam. The export reports `qualified_responses`, `nonqualified_responses`, and `total_responses` overall and per question.

Use `counts_toward_decision` and `evaluation_mode` to distinguish official live decision-eligible votes from beta or sandbox testing reviews. Learner flags are exported separately under `learner_flags` and `learner_issue_counts`; they should prompt admin review of accepted learner-pool questions and can be used as revision signals for future generated batches.

## Export Publication Data

Use the publication export for de-identified analysis of reviewer geography and state-specific response patterns:

```bash
python3 web/server.py export-publication \
  --out outputs/web_feedback/ems_publication_state_analysis_YYYYMMDD.json
```

This export includes anonymous response rows and aggregate tables by practice state, training state, state pair, question, and topic group. It does not include raw email addresses. Suppress or combine small state-level cells before publication when needed.

Use the lifecycle registry for durable record keeping:

```bash
python3 web/server.py export-lifecycle \
  --out outputs/web_feedback/ems_lifecycle_registry_YYYYMMDD.json
```

This registry is the full chain-of-custody export: imports, source manifests, current question states, state history, and the append-only audit log.

## Revision Rule

Do not overwrite accepted, rejected, or retired records. Generate a revised question as a new item. If it intentionally keeps the same `question_id`, the server will preserve lineage by creating a new `record_id` with the new content hash.

## Retirement Rule

Use `retired` for questions that should not be shown, reused, or treated as simple rejected candidates:

```bash
python3 web/server.py set-state RECORD_ID retired --reason "superseded_by_revised_question"
```

Retired questions remain in the lifecycle registry and audit log.
