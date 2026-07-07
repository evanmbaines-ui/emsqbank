# Live-400 Tracker Hygiene Assessment

Date: 2026-07-07

## Bottom Line

The current local tracking hygiene is not clean enough to choose a replacement by intuition. There is no durable `live400` tracker yet. The existing tracker is `live300`, the staged primary-doctrine packet is intended to occupy review orders 301-400, and the local website `server_data` still contains only 100 records.

Artifact-based expected state: live300 tracker + staged 301-400 packet = 400 rows, but only 398 unique `question_id` values because two staged questions reuse question IDs already present in live300.

## Count Check

- Local `web/server_data/question_bank.json`: 100 records.
- Local `web/seed_data/question_bank.json`: 100 records.
- Existing artifact tracker: 300 records in `live300_interleaved_review_order.csv`.
- Staged packet for 301-400: 100 records.
- Expected combined artifact tracker: 400 rows, 398 unique question IDs.

## Exact Duplicate IDs

### `EMS2026-2-2-6-02`
- Review order 60: Alkali Eye Burn Irrigation (`paramedic_next_action_50`, content `2.2.6`)
- Review order 380: Ocular Chemical Burn Next Action (`primary_doctrine_uncovered100`, content `2.2.6`)

### `EMS2026-2-3-1-4-01`
- Review order 84: CPAP For Pulmonary Edema (`paramedic_next_action_50`, content `2.3.1.4`)
- Review order 351: Noninvasive Positive-Pressure Ventilation Candidate Selection (`primary_doctrine_uncovered100`, content `2.3.1.4`)

These are the immediate replacement targets if the goal is 400 unique active website questions. If they are imported intentionally as revisions, they should be treated as lineage records and the older record should be retired or the new one kept paused until adjudicated. They should not both be active as ordinary voting questions.

## Broader Duplication Signals

- Staged 301-400 questions whose content area already appears in live300: 33.
- This is not automatically wrong, because a content area can legitimately need multiple questions, but it is not the same as “unused content area.”
- The staged packet also contains repeated content areas internally; this is acceptable for allocated multi-question topics, but replacements should preferentially use content areas absent from the combined tracker.

## Hygiene Recommendation

1. Do not use the stale `live300` tracker alone for replacement selection.
2. Treat the artifact-based live400 files in this folder as a provisional tracker only.
3. Export the actual website concept/lifecycle registry after import; that export should become the canonical tracker.
4. Replace both exact duplicate IDs before releasing the staged batch as ordinary voting content if the target is 400 unique questions.
5. For the burn/ocular duplicate `EMS2026-2-2-6-02`, the initial escharotomy replacement candidate was rejected on validation because `2.2.4.1` is already represented in the staged tracker. Use an actually unused content code replacement instead; the current replacement packet uses `2.3.13.4.5 Oxygen toxicity`. For the respiratory duplicate `EMS2026-2-3-1-4-01`, use another unused respiratory/cardiovascular content area rather than another noninvasive-ventilation item.

## Files Written

- `expected_live400_review_order_artifact_based.csv`
- `expected_live400_duplicate_question_or_job_ids.csv`
- `expected_live400_content_area_usage_artifact_based.csv`
- `staged_301_400_content_overlaps_vs_live300.csv`
