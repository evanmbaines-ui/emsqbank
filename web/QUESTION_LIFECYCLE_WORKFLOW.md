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
- per-question `intake_batch_id`, `intake_source_path`, `intake_source_sha256`, `content_hash`, and `state_history`

If a generated item reuses a `question_id` but its content hash differs, the server creates a new lineage record instead of overwriting the old one.

## Export Feedback Back To The LLM

Use the LLM feedback packet for revision work:

```bash
python3 web/server.py export-llm-feedback \
  --out outputs/web_feedback/ems_llm_feedback_YYYYMMDD.json
```

This packet includes each question's current state, vote tally, issue flags, comments, content hash, batch ID, lineage parent, and `llm_action`.

The feedback packet intentionally includes both qualified and non-qualified evaluator responses. Use `qualified_vote` to identify whether the submission-time profile said the reviewer had previously taken the board exam. The export reports `qualified_responses`, `nonqualified_responses`, and `total_responses` overall and per question.

Use `counts_toward_decision` and `evaluation_mode` to distinguish official live decision-eligible votes from beta or sandbox testing reviews. Learner flags are exported separately under `learner_flags` and `learner_issue_counts`; they should prompt admin review of accepted learner-pool questions and can be used as revision signals for future generated batches.

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
