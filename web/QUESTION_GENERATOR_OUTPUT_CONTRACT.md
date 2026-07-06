# EMSqbank Question Generator Output Contract

Use this contract when generating questions for website upload. The website importer expects a single JSON file whose top-level value is a JSON list. Each list item is one question object.

The generator should return only valid JSON when creating an upload file. Do not wrap the JSON in Markdown fences. Do not include comments, trailing commas, or prose outside the JSON list.

## Required Fields

Each question object must include:

- `question_id`: stable website-facing question identifier. Use a deterministic ID, not a random UUID.
- `job_id`: stable generation-map job/concept identifier. This becomes the preferred concept lifecycle key.
- `concept_key`: same value as `job_id` unless there is a specific reason to use a different stable concept key.
- `content_id`: 2026 Core Content terminal topic code.
- `core_content_code`: same value as `content_id`.
- `domain`: Core Content domain name, matching the top-level Core Content domain when available.
- `topic_group`: Core Content section name, meaning the second-level Core Content heading such as `Medical Emergencies` or `EMS Systems`.
- `topic`: terminal Core Content topic name, or the closest tested-concept label when the terminal topic is broad.
- `title`: short descriptive authored question title. The website nests this under the Core Content hierarchy; it should not duplicate the full hierarchy.
- `stem`: board-style single-best-answer stem.
- `options`: object with option letters as keys. Use `A`, `B`, `C`, and `D` unless a deliberate exception is needed.
- `answer`: the correct option letter exactly matching one key in `options`.
- `rationale`: concise explanation of why the correct answer is best and why distractors are wrong.
- `citation`: controlling source citation with enough locator detail to audit the item.

## Strongly Preferred Fields

- `map_row_id`: stable row ID from the generation/content map, if different from `job_id`.
- `question_number`: ordinal number within the generated batch.

Do not submit a hand-built `core_content_path` for routine EMSqbank imports. The website derives the full displayed tree from `content_id` / `core_content_code` using the audited 2026 Core Content outline, then nests the authored `title` beneath that terminal topic.

## Lifecycle Rules

- One JSON file should represent one generation batch.
- Keep `job_id` and `concept_key` stable for the underlying concept across revisions.
- Keep `question_id` stable only when the item is an intentional revision of that same website question. If the same `question_id` is imported with changed content, the website preserves lineage by creating a new internal `record_id`.
- Do not reuse a `job_id` or `concept_key` for a different concept.
- Before generating a new batch, use the website admin `Export concepts` file to avoid regenerating concepts that are already accepted, voting, paused, retired, or duplicate-risk unless you are intentionally revising them.

## Exact JSON Shape

Use `web/templates/question_generator_import_template.json` as the upload template.

Minimal valid shape:

```json
[
  {
    "question_id": "EMS2026-2-3-1-6-2-REV01",
    "job_id": "JOB-2-3-1-6-2-03",
    "concept_key": "JOB-2-3-1-6-2-03",
    "map_row_id": "MAP-2-3-1-6-2",
    "question_number": 1,
    "content_id": "2.3.1.6.2",
    "core_content_code": "2.3.1.6.2",
    "domain": "Clinical Aspects of EMS Medicine",
    "topic_group": "Medical Emergencies",
    "topic": "Example terminal Core Content topic",
    "title": "Short authored question title",
    "stem": "Question stem text goes here.",
    "options": {
      "A": "Option A text.",
      "B": "Option B text.",
      "C": "Option C text.",
      "D": "Option D text."
    },
    "answer": "C",
    "rationale": "Explain why C is best and why A, B, and D are less appropriate.",
    "citation": "Author or organization. Source title. Year; page/table/section/URL/DOI locator."
  }
]
```

## Local Validation And Import

Validate by importing paused first:

```bash
python3 web/server.py import outputs/path/to/generated_items.json \
  --label generated_batch_label \
  --batch-id YYYYMMDD_generated_batch_label \
  --paused \
  --notes "Generated in LLM session; awaiting admin release to voting."
```

If validation fails, the importer reports the first missing or malformed required fields. Use `--paused` until the batch has passed admin review and you intentionally release it to evaluator voting.
