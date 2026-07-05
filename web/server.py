#!/usr/bin/env python3
"""Local server for the EMS question-bank prototype."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import smtplib
import sys
import threading
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get("EMS_QBANK_DATA_ROOT", str(WEB_ROOT / "server_data"))).expanduser()
if not DATA_ROOT.is_absolute():
    DATA_ROOT = PROJECT_ROOT / DATA_ROOT
DEFAULT_SOURCE = (
    PROJECT_ROOT
    / "outputs"
    / "ems_locked_priority_superset_100_20260704"
    / "ems_locked_priority_superset_100_items.json"
)
SEED_QUESTION_BANK_FILE = WEB_ROOT / "seed_data" / "question_bank.json"

USERS_FILE = DATA_ROOT / "users.json"
SESSIONS_FILE = DATA_ROOT / "sessions.json"
QUESTION_BANK_FILE = DATA_ROOT / "question_bank.json"
REVIEWS_FILE = DATA_ROOT / "reviews.json"
LEARNER_FILE = DATA_ROOT / "learner_progress.json"
LEARNER_FLAGS_FILE = DATA_ROOT / "learner_flags.json"
PASSWORD_RESETS_FILE = DATA_ROOT / "password_resets.json"
SECRET_FILE = DATA_ROOT / "server_secret.txt"
ADMIN_TOKEN_FILE = DATA_ROOT / "admin_token.txt"
RUNTIME_CONFIG_FILE = DATA_ROOT / "runtime_config.json"
AUDIT_LOG_FILE = DATA_ROOT / "lifecycle_audit_log.jsonl"
INTAKE_MANIFEST_DIR = DATA_ROOT / "intake_manifests"

VALID_POOL_STATES = {"voting", "accepted", "rejected", "paused", "retired"}
CLOSED_POOL_STATES = {"accepted", "rejected", "retired"}
VALID_EVALUATION_MODES = {"sandbox", "beta", "live"}
LIVE_EVALUATION_ENVS = {"live", "production", "prod"}
BETA_EVALUATION_ENVS = {"beta", "beta_test", "beta-test", "betatest", "staging", "prelive", "pre-live", "pilot"}
EVALUATION_ENV = (
    os.environ.get("EMS_QBANK_EVALUATION_ENV", os.environ.get("EMS_QBANK_ENV", "sandbox")).strip().lower()
    or "sandbox"
)


def evaluation_mode_for_env(environment: str) -> str:
    environment = str(environment or "").strip().lower()
    if environment in LIVE_EVALUATION_ENVS:
        return "live"
    if environment in BETA_EVALUATION_ENVS:
        return "beta"
    return "sandbox"


EVALUATION_MODE = evaluation_mode_for_env(EVALUATION_ENV)
LIVE_EVALUATION = EVALUATION_MODE == "live"
BETA_EVALUATION = EVALUATION_MODE == "beta"
PASSWORD_RESET_MINUTES = int(os.environ.get("EMS_QBANK_PASSWORD_RESET_MINUTES", "30"))

ACCESS_CODES = {
    code.strip().upper()
    for code in os.environ.get("EMS_QBANK_ACCESS_CODES", "EMS2026-PILOT,EMS2026-EVAL,EMS2026-LEARN").split(",")
    if code.strip()
}

TOPIC_GROUP_LABELS = {
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
    "4.7": "Mobile Integrated Healthcare / Community Paramedicine",
}

DATA_LOCK = threading.Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def ensure_data_root() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    INTAKE_MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    if not SECRET_FILE.exists():
        SECRET_FILE.write_text(secrets.token_urlsafe(48) + "\n")
    if not ADMIN_TOKEN_FILE.exists():
        ADMIN_TOKEN_FILE.write_text(secrets.token_urlsafe(24) + "\n")


def secret() -> str:
    ensure_data_root()
    return SECRET_FILE.read_text().strip()


def admin_token() -> str:
    ensure_data_root()
    return ADMIN_TOKEN_FILE.read_text().strip()


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return fallback


def save_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def evaluation_env_for_mode(mode: str) -> str:
    mode = str(mode or "").strip().lower()
    if mode == "live":
        return "production"
    if mode == "beta":
        return "beta"
    return "sandbox"


def runtime_config() -> dict:
    ensure_data_root()
    return load_json(RUNTIME_CONFIG_FILE, {})


def current_evaluation_environment() -> tuple[str, str, str]:
    config = runtime_config()
    mode = str(config.get("evaluation_mode", "")).strip().lower()
    if mode in VALID_EVALUATION_MODES:
        return evaluation_env_for_mode(mode), mode, "admin_config"
    return EVALUATION_ENV, EVALUATION_MODE, "environment"


def current_evaluation_payload() -> dict:
    evaluation_env, evaluation_mode, source = current_evaluation_environment()
    live_evaluation = evaluation_mode == "live"
    notes = {
        "live": "Live mode is active. Qualified decision-eligible votes can change accepted/rejected status. Beta and sandbox reviews remain exportable but are hidden from live dashboards and evaluator queues.",
        "beta": "Beta test mode is active. Evaluator votes are recorded as beta votes but do not change accepted/rejected status. Live dashboards and queues start clean when live mode is enabled.",
        "sandbox": "Sandbox mode is active. Evaluator votes are recorded as sandbox votes but do not change accepted/rejected status. Live dashboards and queues start clean when live mode is enabled.",
    }
    return {
        "evaluation_env": evaluation_env,
        "evaluation_mode": evaluation_mode,
        "evaluation_source": source,
        "live_evaluation": live_evaluation,
        "beta_evaluation": evaluation_mode == "beta",
        "counts_toward_decision": live_evaluation,
        "decision_note": notes.get(evaluation_mode, notes["sandbox"]),
    }


def set_runtime_evaluation_mode(mode: str, actor: str = "admin") -> dict:
    mode = str(mode or "").strip().lower()
    if mode not in VALID_EVALUATION_MODES:
        raise ValueError("Invalid evaluation mode.")
    before = current_evaluation_payload()
    save_json(
        RUNTIME_CONFIG_FILE,
        {
            "evaluation_mode": mode,
            "evaluation_env": evaluation_env_for_mode(mode),
            "updated_at": utc_now(),
            "updated_by": actor,
        },
    )
    after = current_evaluation_payload()
    append_audit_event(
        "evaluation_mode_changed",
        actor=actor,
        previous_mode=before.get("evaluation_mode"),
        previous_env=before.get("evaluation_env"),
        new_mode=after.get("evaluation_mode"),
        new_env=after.get("evaluation_env"),
        counts_toward_decision=after.get("counts_toward_decision"),
    )
    return after


def relative_project_path(path: Path) -> str:
    resolved = path.resolve()
    if PROJECT_ROOT in resolved.parents or resolved == PROJECT_ROOT:
        return str(resolved.relative_to(PROJECT_ROOT))
    return str(resolved)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def slugify(value: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in str(value or "batch"))
    return "_".join(part for part in cleaned.split("_") if part) or "batch"


def append_audit_event(event_type: str, **fields) -> dict:
    ensure_data_root()
    event = {
        "event_id": secrets.token_hex(8),
        "event_type": event_type,
        "event_at": utc_now(),
        **fields,
    }
    with AUDIT_LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")
    return event


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def email_digest(email: str) -> str:
    return hmac.new(secret().encode("utf-8"), normalize_email(email).encode("utf-8"), hashlib.sha256).hexdigest()


def password_hash(password: str, salt: str) -> str:
    material = (secret() + "\n" + password).encode("utf-8")
    digest = hashlib.pbkdf2_hmac("sha256", material, bytes.fromhex(salt), 220_000)
    return digest.hex()


def token_digest(token: str) -> str:
    return hmac.new(secret().encode("utf-8"), str(token or "").strip().encode("utf-8"), hashlib.sha256).hexdigest()


def parse_utc(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or ""))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def password_reset_expires_at() -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=PASSWORD_RESET_MINUTES)).replace(microsecond=0).isoformat()


def prune_password_resets(resets: dict) -> bool:
    changed = False
    now = datetime.now(timezone.utc)
    reset_map = resets.setdefault("resets", {})
    for digest, record in list(reset_map.items()):
        expires = parse_utc(record.get("expires_at", ""))
        if record.get("used_at") or (expires and expires < now):
            reset_map.pop(digest, None)
            changed = True
    return changed


def smtp_configured() -> bool:
    return bool(os.environ.get("EMS_QBANK_SMTP_HOST") and os.environ.get("EMS_QBANK_MAIL_FROM"))


def send_password_reset_email(email: str, reset_code: str) -> bool:
    if not smtp_configured():
        return False
    base_url = os.environ.get("EMS_QBANK_PASSWORD_RESET_BASE_URL", "").strip()
    if not base_url:
        base_url = "http://localhost:8000/web/"
    message = EmailMessage()
    message["From"] = os.environ["EMS_QBANK_MAIL_FROM"]
    message["To"] = email
    message["Subject"] = "EMSqbank password reset code"
    message.set_content(
        "\n".join(
            [
                "A password reset was requested for your EMSqbank account.",
                "",
                f"Reset code: {reset_code}",
                f"This code expires in {PASSWORD_RESET_MINUTES} minutes.",
                "",
                f"Open {base_url} and choose Reset password to set a new password.",
                "",
                "If you did not request this, you can ignore this message.",
            ]
        )
    )
    host = os.environ["EMS_QBANK_SMTP_HOST"]
    port = int(os.environ.get("EMS_QBANK_SMTP_PORT", "587"))
    username = os.environ.get("EMS_QBANK_SMTP_USER", "")
    password = os.environ.get("EMS_QBANK_SMTP_PASSWORD", "")
    use_starttls = os.environ.get("EMS_QBANK_SMTP_STARTTLS", "1").strip().lower() not in {"0", "false", "no"}
    with smtplib.SMTP(host, port, timeout=20) as smtp:
        if use_starttls:
            smtp.starttls()
        if username:
            smtp.login(username, password)
        smtp.send_message(message)
    return True


def new_anonymous_id(users: dict) -> str:
    existing = {user.get("anonymous_user_id") for user in users.get("users", {}).values()}
    while True:
        candidate = "ANON-" + secrets.token_hex(5).upper()
        if candidate not in existing:
            return candidate


def question_content_hash(item: dict) -> str:
    payload = {
        "stem": item.get("stem", ""),
        "options": item.get("options", {}),
        "answer": item.get("answer", ""),
        "rationale": item.get("rationale", ""),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:12]


def topic_group_code_for_question(question: dict) -> str:
    code = str(question.get("content_id") or question.get("core_content_code") or "").strip()
    parts = [part for part in code.split(".") if part]
    if len(parts) >= 2:
        return ".".join(parts[:2])
    if parts:
        return parts[0]
    return ""


def topic_group_for_question(question: dict) -> str:
    code = topic_group_code_for_question(question)
    if code in TOPIC_GROUP_LABELS:
        return TOPIC_GROUP_LABELS[code]
    existing = str(question.get("topic_group") or "").strip()
    if existing in TOPIC_GROUP_LABELS:
        return TOPIC_GROUP_LABELS[existing]
    if existing and existing != code:
        return existing
    return str(question.get("domain") or "Unassigned")


def concept_key_for_question(question: dict) -> str:
    """Stable production key for the tested concept behind a question record."""
    for field in ("concept_key", "job_id", "map_row_id", "question_id"):
        value = str(question.get(field, "") or "").strip()
        if value:
            return value
    code = str(question.get("content_id") or question.get("core_content_code") or "").strip()
    title = slugify(question.get("title", ""))
    if code and title:
        return f"{code}::{title}"
    return str(question.get("record_id") or "").strip()


def normalize_question(item: dict, index: int, source_label: str) -> dict:
    base_id = (
        item.get("question_id")
        or item.get("superset_id")
        or item.get("pilot_id")
        or f"{source_label}-{index + 1}"
    )
    number = (
        item.get("superset_question_number")
        or item.get("question_number")
        or item.get("pilot_question_number")
        or index + 1
    )
    options = item.get("options") or {}
    return {
        "record_id": str(base_id),
        "question_id": item.get("question_id") or str(base_id),
        "concept_key": concept_key_for_question(item),
        "map_row_id": item.get("map_row_id", ""),
        "source_label": source_label,
        "source_question_number": number,
        "job_id": item.get("job_id", ""),
        "content_id": item.get("content_id", ""),
        "core_content_code": item.get("core_content_code", ""),
        "domain": item.get("domain", "Unassigned"),
        "topic": item.get("topic", ""),
        "topic_group_code": topic_group_code_for_question(item),
        "topic_group": topic_group_for_question(item),
        "answer": item.get("answer", ""),
        "title": item.get("title", f"Question {number}"),
        "stem": item.get("stem", ""),
        "options": {key: options.get(key, "") for key in sorted(options.keys())},
        "rationale": item.get("rationale", ""),
        "citation": item.get("citation", ""),
        "content_hash": question_content_hash(item),
        "pool_state": "voting",
        "decision_reason": "",
        "added_at": utc_now(),
        "closed_at": "",
    }


def validate_question_item(item: dict, index: int) -> list[str]:
    prefix = f"item {index + 1}"
    errors = []
    if not isinstance(item, dict):
        return [f"{prefix}: item must be an object"]
    if not str(item.get("stem", "")).strip():
        errors.append(f"{prefix}: missing stem")
    options = item.get("options")
    if not isinstance(options, dict) or len(options) < 2:
        errors.append(f"{prefix}: options must be an object with at least 2 options")
    else:
        answer = str(item.get("answer", ""))
        if not answer:
            errors.append(f"{prefix}: missing answer")
        elif answer not in {str(key) for key in options.keys()}:
            errors.append(f"{prefix}: answer {answer!r} is not one of the option keys")
    if not (item.get("question_id") or item.get("superset_id") or item.get("pilot_id")):
        errors.append(f"{prefix}: missing stable question_id/superset_id/pilot_id")
    if not (item.get("content_id") or item.get("core_content_code")):
        errors.append(f"{prefix}: missing content_id/core_content_code")
    return errors


def state_history_entry(
    event_type: str,
    old_state: str,
    new_state: str,
    reason: str,
    actor: str,
    event_at: str | None = None,
    metadata: dict | None = None,
) -> dict:
    return {
        "event_type": event_type,
        "event_at": event_at or utc_now(),
        "actor": actor,
        "from_state": old_state,
        "to_state": new_state,
        "reason": reason,
        "metadata": metadata or {},
    }


def apply_question_state(question: dict, new_state: str, reason: str, actor: str, metadata: dict | None = None) -> dict:
    if new_state not in VALID_POOL_STATES:
        raise ValueError(f"Invalid pool state: {new_state}")
    old_state = str(question.get("pool_state", ""))
    changed_at = utc_now()
    question["pool_state"] = new_state
    question["decision_reason"] = reason
    question["closed_at"] = changed_at if new_state in CLOSED_POOL_STATES else ""
    question.setdefault("state_history", []).append(
        state_history_entry("state_changed", old_state, new_state, reason, actor, changed_at, metadata)
    )
    append_audit_event(
        "question_state_changed",
        actor=actor,
        record_id=question.get("record_id", ""),
        question_id=question.get("question_id", ""),
        from_state=old_state,
        to_state=new_state,
        reason=reason,
        metadata=metadata or {},
    )
    return question


def import_questions_from_file(
    source_path: Path,
    source_label: str,
    activate: bool = True,
    batch_id: str = "",
    notes: str = "",
    actor: str = "cli",
) -> dict:
    resolved = source_path.resolve()
    if PROJECT_ROOT not in resolved.parents and resolved != PROJECT_ROOT:
        raise ValueError("Question source must be inside the project folder.")
    raw = json.loads(resolved.read_text())
    if not isinstance(raw, list):
        raise ValueError("Question source must be a JSON list.")
    validation_errors = []
    for index, item in enumerate(raw):
        validation_errors.extend(validate_question_item(item, index))
    if validation_errors:
        raise ValueError("Question source failed validation: " + "; ".join(validation_errors[:20]))

    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    bank.setdefault("questions", {})
    bank.setdefault("sources", [])
    added = 0
    skipped = 0
    revised = 0
    imported_at = utc_now()
    batch_id = slugify(batch_id or f"{source_label}_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}")
    source_hash = file_sha256(resolved)
    source_rel = relative_project_path(resolved)
    target_state = "voting" if activate else "paused"
    records = []
    existing_by_content_hash: dict[str, list[str]] = {}
    existing_by_concept_key: dict[str, list[str]] = {}
    for existing_record_id, existing_question in bank["questions"].items():
        existing_hash = str(existing_question.get("content_hash", "") or "")
        if existing_hash:
            existing_by_content_hash.setdefault(existing_hash, []).append(existing_record_id)
        existing_concept_key = concept_key_for_question(existing_question)
        if existing_concept_key:
            existing_by_concept_key.setdefault(existing_concept_key, []).append(existing_record_id)

    for index, item in enumerate(raw):
        question = normalize_question(item, index, source_label)
        question["concept_key"] = concept_key_for_question(question)
        question["added_at"] = imported_at
        question["intake_batch_id"] = batch_id
        question["intake_source_path"] = source_rel
        question["intake_source_sha256"] = source_hash
        question["intake_notes"] = notes
        question["pool_state"] = target_state
        question["state_history"] = [
            state_history_entry(
                "imported",
                "",
                target_state,
                "intake_import",
                actor,
                imported_at,
                {"batch_id": batch_id, "source_label": source_label, "source_path": source_rel},
            )
        ]
        if not activate:
            question["pool_state"] = "paused"
        record_id = question["record_id"]
        existing = bank["questions"].get(record_id)
        duplicate_warnings = []
        matching_hash_records = [
            existing_record_id
            for existing_record_id in existing_by_content_hash.get(question["content_hash"], [])
            if existing_record_id != record_id
        ]
        if matching_hash_records:
            duplicate_warnings.append(
                {
                    "type": "duplicate_content_hash",
                    "existing_record_ids": matching_hash_records,
                    "message": "Another website record already has identical stem/options/answer/rationale content.",
                }
            )
        matching_concept_records = [
            existing_record_id
            for existing_record_id in existing_by_concept_key.get(question["concept_key"], [])
            if existing_record_id != record_id
        ]
        if matching_concept_records:
            duplicate_warnings.append(
                {
                    "type": "concept_already_present",
                    "concept_key": question["concept_key"],
                    "existing_record_ids": matching_concept_records,
                    "message": "This mapped concept already has a website record; treat as revision/lineage unless deliberate.",
                }
            )
        question["duplicate_warnings"] = duplicate_warnings
        if existing and existing.get("content_hash") == question["content_hash"]:
            skipped += 1
            records.append(
                {
                    "action": "skipped_duplicate_hash",
                    "record_id": record_id,
                    "question_id": question["question_id"],
                    "concept_key": question["concept_key"],
                    "content_hash": question["content_hash"],
                    "source_question_number": question.get("source_question_number", ""),
                    "duplicate_warnings": duplicate_warnings,
                }
            )
            continue
        if existing and existing.get("content_hash") != question["content_hash"]:
            parent_record_id = record_id
            record_id = f"{record_id}__{question['content_hash']}"
            revised_existing = bank["questions"].get(record_id)
            if revised_existing and revised_existing.get("content_hash") == question["content_hash"]:
                skipped += 1
                records.append(
                    {
                        "action": "skipped_duplicate_revised_hash",
                        "record_id": record_id,
                        "question_id": question["question_id"],
                        "concept_key": question["concept_key"],
                        "content_hash": question["content_hash"],
                        "source_question_number": question.get("source_question_number", ""),
                        "lineage_parent_record_id": parent_record_id,
                        "duplicate_warnings": duplicate_warnings,
                    }
                )
                continue
            question["record_id"] = record_id
            question["lineage_parent_record_id"] = parent_record_id
            question["lineage_parent_content_hash"] = existing.get("content_hash", "")
            question["lineage_reason"] = "same_question_id_new_content_hash"
            revised += 1
            action = "revised_as_new_record"
        else:
            action = "added"
        bank["questions"][record_id] = question
        added += 1
        records.append(
            {
                "action": action,
                "record_id": record_id,
                "question_id": question["question_id"],
                "concept_key": question["concept_key"],
                "content_hash": question["content_hash"],
                "source_question_number": question.get("source_question_number", ""),
                "pool_state": question["pool_state"],
                "lineage_parent_record_id": question.get("lineage_parent_record_id", ""),
                "duplicate_warnings": duplicate_warnings,
            }
        )
        existing_by_content_hash.setdefault(question["content_hash"], []).append(record_id)
        existing_by_concept_key.setdefault(question["concept_key"], []).append(record_id)

    manifest = {
        "batch_id": batch_id,
        "source_label": source_label,
        "source_path": source_rel,
        "source_sha256": source_hash,
        "imported_at": imported_at,
        "actor": actor,
        "notes": notes,
        "item_count": len(raw),
        "added": added,
        "skipped": skipped,
        "revised_as_new_records": revised,
        "activated": activate,
        "target_state": target_state,
        "records": records,
    }

    bank["sources"].append(manifest)
    save_json(QUESTION_BANK_FILE, bank)
    manifest_path = INTAKE_MANIFEST_DIR / f"{batch_id}.json"
    save_json(manifest_path, manifest)
    append_audit_event(
        "question_batch_imported",
        actor=actor,
        batch_id=batch_id,
        source_label=source_label,
        source_path=source_rel,
        source_sha256=source_hash,
        added=added,
        skipped=skipped,
        revised_as_new_records=revised,
        activated=activate,
        notes=notes,
        manifest_path=relative_project_path(manifest_path),
    )
    for record in records:
        append_audit_event("question_import_record", actor=actor, batch_id=batch_id, **record)
    return {
        "batch_id": batch_id,
        "manifest_path": relative_project_path(manifest_path),
        "source_sha256": source_hash,
        "added": added,
        "skipped": skipped,
        "revised_as_new_records": revised,
        "records": records,
    }


def backfill_lifecycle_metadata(actor: str = "system") -> dict:
    ensure_data_root()
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    if bank.get("lifecycle_schema_version") == 1:
        return {"updated_questions": 0, "updated_sources": 0, "already_current": True}

    sources = bank.setdefault("sources", [])
    source_by_label = {source.get("source_label", ""): source for source in sources}
    source_updates = 0
    question_updates = 0
    backfilled_at = utc_now()

    for source in sources:
        if source.get("batch_id"):
            continue
        label = source.get("source_label", "legacy_source")
        source["batch_id"] = f"legacy_{slugify(label)}"
        source["target_state"] = "voting" if source.get("activated", True) else "paused"
        source_updates += 1

    for record_id, question in bank.get("questions", {}).items():
        label = question.get("source_label", "legacy_source")
        source = source_by_label.get(label, {})
        batch_id = source.get("batch_id") or f"legacy_{slugify(label)}"
        source_path = source.get("source_path", "")
        source_sha = ""
        if source_path:
            candidate = PROJECT_ROOT / source_path
            if candidate.exists() and candidate.is_file():
                source_sha = file_sha256(candidate)
        changed = False
        for key, value in {
            "intake_batch_id": batch_id,
            "intake_source_path": source_path,
            "intake_source_sha256": source_sha,
            "intake_notes": "Backfilled from existing website question bank when lifecycle tracking was standardized.",
            "concept_key": concept_key_for_question(question),
        }.items():
            if not question.get(key) and value:
                question[key] = value
                changed = True
        if not question.get("state_history"):
            state = question.get("pool_state", "voting")
            question["state_history"] = [
                state_history_entry(
                    "legacy_backfill",
                    "",
                    state,
                    "baseline_existing_question_bank",
                    actor,
                    question.get("added_at") or backfilled_at,
                    {"batch_id": batch_id, "source_label": label, "source_path": source_path},
                )
            ]
            changed = True
        if changed:
            question_updates += 1
            bank["questions"][record_id] = question

    bank["lifecycle_schema_version"] = 1
    save_json(QUESTION_BANK_FILE, bank)
    append_audit_event(
        "lifecycle_metadata_backfilled",
        actor=actor,
        updated_questions=question_updates,
        updated_sources=source_updates,
        reason="baseline_existing_question_bank",
    )
    return {"updated_questions": question_updates, "updated_sources": source_updates, "already_current": False}


def protect_sandbox_decisions(actor: str = "system") -> dict:
    ensure_data_root()
    reviews = load_json(REVIEWS_FILE, {"reviews": {}})
    review_updates = 0
    for review_map in reviews.get("reviews", {}).values():
        for review in review_map.values():
            changed = False
            if "evaluationEnvironment" not in review:
                review["evaluationEnvironment"] = "legacy_sandbox"
                changed = True
            if "evaluationMode" not in review:
                review["evaluationMode"] = review_evaluation_mode(review)
                changed = True
            if "countsTowardDecision" not in review:
                review["countsTowardDecision"] = False
                changed = True
            if changed:
                review_updates += 1
    if review_updates:
        save_json(REVIEWS_FILE, reviews)

    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    state_updates = 0
    for record_id, question in bank.get("questions", {}).items():
        pool_state = question.get("pool_state", "voting")
        if pool_state not in {"accepted", "rejected"}:
            continue
        tally = tally_for_question(record_id, reviews, qualified_reviewer_ids())
        if tally.get("decision") == pool_state:
            continue
        apply_question_state(
            question,
            "voting",
            "sandbox_votes_do_not_count",
            actor,
            {
                "previous_state": pool_state,
                "decision_eligible_reviews": tally.get("decisionEligibleReviews", 0),
                "sandbox_reviews": tally.get("sandboxReviews", 0),
                "beta_reviews": tally.get("betaReviews", 0),
                "total_reviews": tally.get("totalReviews", 0),
            },
        )
        bank["questions"][record_id] = question
        state_updates += 1
    if state_updates:
        save_json(QUESTION_BANK_FILE, bank)

    append_audit_event(
        "sandbox_decisions_protected",
        actor=actor,
        review_updates=review_updates,
        state_updates=state_updates,
        evaluation_environment=evaluation_environment_payload().get("evaluation_env"),
        evaluation_mode=evaluation_environment_payload().get("evaluation_mode"),
    )
    environment = evaluation_environment_payload()
    return {
        "review_updates": review_updates,
        "state_updates": state_updates,
        "evaluation_environment": environment.get("evaluation_env"),
        "evaluation_mode": environment.get("evaluation_mode"),
        "live_evaluation": environment.get("live_evaluation"),
    }


def ensure_question_bank() -> None:
    ensure_data_root()
    with DATA_LOCK:
        bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
        if bank.get("questions"):
            return
        if SEED_QUESTION_BANK_FILE.exists():
            seeded_bank = load_json(SEED_QUESTION_BANK_FILE, {"questions": {}, "sources": []})
            save_json(QUESTION_BANK_FILE, seeded_bank)
            append_audit_event(
                "question_bank_seeded",
                actor="system",
                seed_source=relative_project_path(SEED_QUESTION_BANK_FILE),
                question_count=len(seeded_bank.get("questions", {})),
            )
            return
        if DEFAULT_SOURCE.exists():
            import_questions_from_file(DEFAULT_SOURCE, "locked_priority_superset_100", activate=True)
        else:
            save_json(QUESTION_BANK_FILE, bank)


def user_from_token(token: str | None) -> tuple[str, dict] | tuple[None, None]:
    if not token:
        return None, None
    sessions = load_json(SESSIONS_FILE, {"tokens": {}})
    session = sessions.get("tokens", {}).get(token)
    if not session:
        return None, None
    users = load_json(USERS_FILE, {"users": {}})
    email_hash = session.get("email_hash")
    user = users.get("users", {}).get(email_hash)
    if not user:
        return None, None
    return email_hash, user


def safe_user(user: dict) -> dict:
    profile = user.get("profile", {})
    return {
        "anonymousUserId": user.get("anonymous_user_id", ""),
        "profile": profile,
        "qualifiedVoter": profile.get("previousBoard") == "yes",
        "createdAt": user.get("created_at", ""),
    }


def qualified_reviewer_ids() -> set[str]:
    users = load_json(USERS_FILE, {"users": {}})
    qualified = set()
    for user in users.get("users", {}).values():
        if user.get("profile", {}).get("previousBoard") == "yes":
            qualified.add(user.get("anonymous_user_id"))
    return qualified


def reviewer_profile_snapshot(user: dict) -> dict:
    return profile_from_payload(user.get("profile", {}))


def review_qualified_at_submission(anonymous_id: str, review: dict, qualified_ids: set[str]) -> bool:
    if "qualifiedAtSubmission" in review:
        return bool(review.get("qualifiedAtSubmission"))
    profile = review.get("profileAtSubmission")
    if isinstance(profile, dict) and "previousBoard" in profile:
        return profile.get("previousBoard") == "yes"
    return anonymous_id in qualified_ids


def review_evaluation_mode(review: dict) -> str:
    mode = str(review.get("evaluationMode", "")).strip().lower()
    if mode in {"sandbox", "beta", "live"}:
        return mode
    return evaluation_mode_for_env(review.get("evaluationEnvironment", "legacy_sandbox"))


def review_counts_toward_decision(review: dict) -> bool:
    if "countsTowardDecision" in review:
        return bool(review.get("countsTowardDecision"))
    return review_evaluation_mode(review) == "live"


def review_storage_key(anonymous_id: str, evaluation_mode: str) -> str:
    evaluation_mode = str(evaluation_mode or "sandbox").strip().lower()
    if evaluation_mode == "live":
        return anonymous_id
    return f"{anonymous_id}__{evaluation_mode}"


def review_owner_id(storage_key: str, review: dict) -> str:
    owner = str(review.get("anonymousUserId", "") or "").strip()
    if owner:
        return owner
    for suffix in ("__sandbox", "__beta"):
        if str(storage_key).endswith(suffix):
            return str(storage_key)[: -len(suffix)]
    return str(storage_key)


def review_matches_mode(review: dict, mode: str) -> bool:
    return review_evaluation_mode(review) == str(mode or "").strip().lower()


def active_review_filter(review: dict) -> bool:
    return review_matches_mode(review, evaluation_environment_payload().get("evaluation_mode", "sandbox"))


def evaluation_environment_payload() -> dict:
    return current_evaluation_payload()


def vote_bucket_for_review(review: dict) -> str:
    verdict = str(review.get("verdict", ""))
    if verdict in {"accept", "reject"}:
        return verdict
    disposition = str(review.get("disposition", ""))
    if disposition in {"accept_as_is", "accept_with_revisions"}:
        return "accept"
    if disposition in {"major_revisions_needed", "reject"}:
        return "reject"
    return ""


def normalize_disposition(value: str) -> str:
    value = str(value or "")
    if value in {"accept_as_is", "accept_with_revisions", "major_revisions_needed", "reject"}:
        return value
    if value == "accept":
        return "accept_as_is"
    return value


def tally_for_question(
    record_id: str,
    reviews: dict | None = None,
    qualified_ids: set[str] | None = None,
    include_review=None,
) -> dict:
    reviews = reviews or load_json(REVIEWS_FILE, {"reviews": {}})
    if qualified_ids is None:
        qualified_ids = qualified_reviewer_ids()
    question_reviews = reviews.get("reviews", {}).get(record_id, {})
    qualified_accept = 0
    qualified_reject = 0
    qualified_total = 0
    nonqualified_total = 0
    total_reviews = 0
    decision_eligible_reviews = 0
    sandbox_reviews = 0
    beta_reviews = 0
    nondecision_reviews = 0

    for storage_key, review in question_reviews.items():
        if include_review and not include_review(review):
            continue
        anonymous_id = review_owner_id(storage_key, review)
        verdict = vote_bucket_for_review(review)
        if verdict not in {"accept", "reject"}:
            continue
        total_reviews += 1
        if not review_counts_toward_decision(review):
            nondecision_reviews += 1
            mode = review_evaluation_mode(review)
            if mode == "beta":
                beta_reviews += 1
            elif mode == "sandbox":
                sandbox_reviews += 1
            continue

        decision_eligible_reviews += 1
        if review_qualified_at_submission(anonymous_id, review, qualified_ids):
            qualified_total += 1
            if verdict == "accept":
                qualified_accept += 1
            elif verdict == "reject":
                qualified_reject += 1
        else:
            nonqualified_total += 1

    needed = ""
    if qualified_accept >= 2:
        needed = "accepted"
    elif qualified_reject >= 2:
        needed = "rejected"
    review_stage = "complete" if needed else "tiebreaker" if qualified_accept >= 1 and qualified_reject >= 1 else "open"

    return {
        "qualifiedAccept": qualified_accept,
        "qualifiedReject": qualified_reject,
        "qualifiedTotal": qualified_total,
        "nonQualifiedVotes": nonqualified_total,
        "totalReviews": total_reviews,
        "decisionEligibleReviews": decision_eligible_reviews,
        "nonDecisionReviews": nondecision_reviews,
        "sandboxReviews": sandbox_reviews,
        "betaReviews": beta_reviews,
        "decision": needed,
        "reviewStage": review_stage,
        "votesNeededForDecision": 0 if needed else max(0, 2 - max(qualified_accept, qualified_reject)),
    }


def update_pool_decision(record_id: str) -> dict:
    if not evaluation_environment_payload().get("live_evaluation"):
        return {}
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    question = bank.get("questions", {}).get(record_id)
    if not question:
        return {}
    if question.get("pool_state") != "voting":
        return question
    tally = tally_for_question(record_id)
    if tally["decision"] == "accepted":
        apply_question_state(
            question,
            "accepted",
            "two_qualified_accept_votes",
            "system",
            {"qualified_accept": tally["qualifiedAccept"], "qualified_reject": tally["qualifiedReject"]},
        )
    elif tally["decision"] == "rejected":
        apply_question_state(
            question,
            "rejected",
            "two_qualified_reject_votes",
            "system",
            {"qualified_accept": tally["qualifiedAccept"], "qualified_reject": tally["qualifiedReject"]},
        )
    bank["questions"][record_id] = question
    save_json(QUESTION_BANK_FILE, bank)
    return question


def question_payload(anonymous_id: str | None = None) -> list[dict]:
    ensure_question_bank()
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    questions = []
    for question in bank.get("questions", {}).values():
        pool_state = question.get("pool_state", "voting")
        if pool_state not in {"voting", "accepted"}:
            continue
        item = dict(question)
        item["topic_group_code"] = item.get("topic_group_code") or topic_group_code_for_question(item)
        item["topic_group"] = topic_group_for_question(item)
        item["review_available"] = pool_state == "voting"
        item["learn_available"] = pool_state == "accepted"
        item["pool_state"] = "available"
        for hidden_field in (
            "closed_at",
            "decision_reason",
            "tally",
            "content_hash",
            "intake_batch_id",
            "intake_source_path",
            "intake_source_sha256",
            "intake_notes",
            "lineage_parent_record_id",
            "lineage_parent_content_hash",
            "lineage_reason",
            "state_history",
            "duplicate_warnings",
        ):
            item.pop(hidden_field, None)
        questions.append(item)
    if anonymous_id:
        return sorted(
            questions,
            key=lambda q: hashlib.sha256(f"{anonymous_id}:{q['record_id']}".encode("utf-8")).hexdigest(),
        )
    return sorted(questions, key=lambda q: (q.get("source_label", ""), int_or_text(q.get("source_question_number", 0)), q["record_id"]))


def public_question_counts(anonymous_id: str) -> dict:
    ensure_question_bank()
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    reviewed = set(reviews_for_user(anonymous_id, evaluation_environment_payload().get("evaluation_mode", "sandbox")))
    counts = {
        "voting": 0,
        "accepted": 0,
        "rejected": 0,
        "paused": 0,
        "retired": 0,
        "available_for_evaluation": 0,
        "available_for_learning": 0,
    }
    for record_id, question in bank.get("questions", {}).items():
        pool_state = question.get("pool_state", "voting")
        counts[pool_state] = counts.get(pool_state, 0) + 1
        if pool_state == "voting" and record_id not in reviewed:
            counts["available_for_evaluation"] += 1
        if pool_state == "accepted":
            counts["available_for_learning"] += 1
    return counts


def int_or_text(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return str(value)


def profile_from_payload(payload: dict) -> dict:
    return {
        "trainingStatus": str(payload.get("trainingStatus", "")),
        "previousBoard": str(payload.get("previousBoard", "")),
        "trainingState": str(payload.get("trainingState", "")),
        "practiceState": str(payload.get("practiceState", "")),
    }


def reviews_for_user(anonymous_id: str, mode: str | None = None) -> dict:
    reviews = load_json(REVIEWS_FILE, {"reviews": {}})
    mode = mode or evaluation_environment_payload().get("evaluation_mode", "sandbox")
    mine = {}
    for record_id, review_map in reviews.get("reviews", {}).items():
        matching_reviews = [
            review
            for storage_key, review in review_map.items()
            if review_owner_id(storage_key, review) == anonymous_id and review_matches_mode(review, mode)
        ]
        if matching_reviews:
            mine[record_id] = sorted(matching_reviews, key=lambda review: review.get("updatedAt", ""))[-1]
    return mine


def learner_for_user(anonymous_id: str) -> dict:
    progress = load_json(LEARNER_FILE, {"progress": {}})
    return progress.get("progress", {}).get(anonymous_id, {})


def empty_learner_answer_tally(question: dict) -> dict:
    options = question.get("options", {}) if isinstance(question.get("options"), dict) else {}
    answer = str(question.get("answer", ""))
    option_rows = {
        str(letter): {
            "text": str(text),
            "selected": 0,
            "ignored": 0,
            "is_correct": str(letter) == answer,
        }
        for letter, text in sorted(options.items())
    }
    distractors = {
        letter: {
            "text": row["text"],
            "selected": 0,
            "ignored": 0,
        }
        for letter, row in option_rows.items()
        if not row["is_correct"]
    }
    return {
        "learner_count": 0,
        "total_attempts": 0,
        "correct_attempts": 0,
        "incorrect_attempts": 0,
        "latest_correct_learners": 0,
        "latest_incorrect_learners": 0,
        "answer": answer,
        "option_selection_counts": {letter: 0 for letter in option_rows},
        "options": option_rows,
        "distractors": distractors,
    }


def learner_answer_tallies(bank: dict | None = None, progress: dict | None = None) -> dict[str, dict]:
    bank = bank or load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    progress = progress or load_json(LEARNER_FILE, {"progress": {}})
    tallies = {
        record_id: empty_learner_answer_tally(question)
        for record_id, question in bank.get("questions", {}).items()
    }

    for user_progress in progress.get("progress", {}).values():
        if not isinstance(user_progress, dict):
            continue
        for record_id, record in user_progress.items():
            question = bank.get("questions", {}).get(record_id, {})
            tally = tallies.setdefault(record_id, empty_learner_answer_tally(question))
            if not isinstance(record, dict):
                continue
            history = record.get("history")
            if not isinstance(history, list) or not history:
                history = [{"selected": record.get("selected", ""), "correct": record.get("correct", False)}]
            valid_attempts = 0
            latest_selected = ""
            for attempt in history:
                if not isinstance(attempt, dict):
                    continue
                selected = str(attempt.get("selected", ""))
                if not selected:
                    continue
                valid_attempts += 1
                latest_selected = selected
                if selected not in tally["options"]:
                    tally["options"][selected] = {"text": "", "selected": 0, "ignored": 0, "is_correct": False}
                    tally["option_selection_counts"][selected] = 0
                    tally["distractors"].setdefault(selected, {"text": "", "selected": 0, "ignored": 0})
                tally["total_attempts"] += 1
                tally["option_selection_counts"][selected] = tally["option_selection_counts"].get(selected, 0) + 1
                tally["options"][selected]["selected"] += 1
                if selected == tally["answer"]:
                    tally["correct_attempts"] += 1
                else:
                    tally["incorrect_attempts"] += 1
            if valid_attempts:
                tally["learner_count"] += 1
                latest_selected = str(record.get("selected", "") or latest_selected)
                if latest_selected == tally["answer"]:
                    tally["latest_correct_learners"] += 1
                else:
                    tally["latest_incorrect_learners"] += 1

    for tally in tallies.values():
        total = tally["total_attempts"]
        for letter, row in tally["options"].items():
            row["ignored"] = max(0, total - int(row.get("selected", 0)))
        for letter, row in tally["distractors"].items():
            selected = int(tally["option_selection_counts"].get(letter, 0))
            row["selected"] = selected
            row["ignored"] = max(0, total - selected)
    return tallies


def learner_flags_for_user(anonymous_id: str) -> dict:
    flags = load_json(LEARNER_FLAGS_FILE, {"flags": {}})
    mine = {}
    for record_id, flag_map in flags.get("flags", {}).items():
        if anonymous_id in flag_map:
            mine[record_id] = flag_map[anonymous_id]
    return mine


def learner_flag_feedback_for_question(record_id: str, flag_data: dict | None = None) -> tuple[list[dict], dict[str, int]]:
    flag_data = flag_data or load_json(LEARNER_FLAGS_FILE, {"flags": {}})
    feedback = []
    issue_counts: dict[str, int] = {}
    for anonymous_id, flag in flag_data.get("flags", {}).get(record_id, {}).items():
        for issue in flag.get("generationIssueFlags", []):
            issue_counts[issue] = issue_counts.get(issue, 0) + 1
        feedback.append(
            {
                "anonymous_user_id": anonymous_id,
                "generation_issue_flags": flag.get("generationIssueFlags", []),
                "comments": flag.get("comments", ""),
                "profile_at_submission": flag.get("profileAtSubmission", {}),
                "qualified_at_submission": bool(flag.get("qualifiedAtSubmission")),
                "status": flag.get("status", "open"),
                "updated_at": flag.get("updatedAt", ""),
            }
        )
    return sorted(feedback, key=lambda row: row.get("updated_at", "")), issue_counts


def learner_flag_rollup(bank: dict) -> dict:
    flag_data = load_json(LEARNER_FLAGS_FILE, {"flags": {}})
    rows = []
    total = 0
    open_total = 0
    for record_id, flag_map in flag_data.get("flags", {}).items():
        question = bank.get("questions", {}).get(record_id, {})
        issue_counts: dict[str, int] = {}
        comments_count = 0
        latest_at = ""
        open_flags = 0
        for flag in flag_map.values():
            total += 1
            if flag.get("status", "open") != "resolved":
                open_total += 1
                open_flags += 1
            latest_at = max(latest_at, str(flag.get("updatedAt", "")))
            comments = str(flag.get("comments", "")).strip()
            if comments:
                comments_count += 1
            for issue in flag.get("generationIssueFlags", []):
                issue_counts[issue] = issue_counts.get(issue, 0) + 1
        rows.append(
            {
                "record_id": record_id,
                "question_id": question.get("question_id", ""),
                "source_question_number": question.get("source_question_number", ""),
                "pool_state": question.get("pool_state", ""),
                "topic_group": topic_group_for_question(question) if question else "",
                "topic": question.get("topic", ""),
                "total_flags": len(flag_map),
                "open_flags": open_flags,
                "latest_at": latest_at,
                "comments_count": comments_count,
                "issue_counts": issue_counts,
            }
        )
    return {
        "total": total,
        "open": open_total,
        "questions": sorted(rows, key=lambda row: (-row["open_flags"], row["latest_at"], row["record_id"])),
    }


def response_scope_counts(rows: list[dict]) -> dict:
    qualified = sum(1 for row in rows if row.get("qualified_vote"))
    total = len(rows)
    return {
        "response_scope": "qualified_and_nonqualified",
        "total_responses": total,
        "qualified_responses": qualified,
        "nonqualified_responses": total - qualified,
    }


def feedback_scope_counts(feedback: list[dict]) -> dict:
    return response_scope_counts(feedback)


def generation_feedback_export() -> dict:
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    reviews = load_json(REVIEWS_FILE, {"reviews": {}})
    qualified_ids = qualified_reviewer_ids()
    rows = []
    for record_id, review_map in reviews.get("reviews", {}).items():
        question = bank.get("questions", {}).get(record_id, {})
        tally = tally_for_question(record_id, reviews, qualified_ids)
        for storage_key, review in review_map.items():
            anonymous_id = review_owner_id(storage_key, review)
            profile_at_submission = review.get("profileAtSubmission") if isinstance(review.get("profileAtSubmission"), dict) else {}
            rows.append(
                {
                    "anonymous_user_id": anonymous_id,
                    "qualified_vote": review_qualified_at_submission(anonymous_id, review, qualified_ids),
                    "counts_toward_decision": review_counts_toward_decision(review),
                    "late_after_decision": bool(review.get("lateAfterDecision")),
                    "pool_state_at_submission": review.get("poolStateAtSubmission", ""),
                    "evaluation_environment": review.get("evaluationEnvironment", "legacy_sandbox"),
                    "evaluation_mode": review_evaluation_mode(review),
                    "training_status_at_submission": profile_at_submission.get("trainingStatus", ""),
                    "previous_board_at_submission": profile_at_submission.get("previousBoard", ""),
                    "training_state_at_submission": profile_at_submission.get("trainingState", ""),
                    "practice_state_at_submission": profile_at_submission.get("practiceState", ""),
                    "profile_last_updated_at_submission": review.get("profileLastUpdatedAtSubmission", ""),
                    "record_id": record_id,
                    "question_id": question.get("question_id", ""),
                    "content_hash": question.get("content_hash", ""),
                    "intake_batch_id": question.get("intake_batch_id", ""),
                    "intake_source_path": question.get("intake_source_path", ""),
                    "lineage_parent_record_id": question.get("lineage_parent_record_id", ""),
                    "concept_key": question.get("concept_key") or concept_key_for_question(question),
                    "job_id": question.get("job_id", ""),
                    "content_id": question.get("content_id", ""),
                    "core_content_code": question.get("core_content_code", ""),
                    "domain": question.get("domain", ""),
                    "topic_group_code": question.get("topic_group_code") or topic_group_code_for_question(question),
                    "topic_group": topic_group_for_question(question),
                    "topic": question.get("topic", ""),
                    "pool_state": question.get("pool_state", ""),
                    "qualified_accept": tally["qualifiedAccept"],
                    "qualified_reject": tally["qualifiedReject"],
                    "decision_eligible_reviews": tally["decisionEligibleReviews"],
                    "sandbox_reviews": tally["sandboxReviews"],
                    "beta_reviews": tally["betaReviews"],
                    "disposition": normalize_disposition(review.get("disposition") or review.get("verdict", "")),
                    "vote_bucket": vote_bucket_for_review(review),
                    "difficulty": review.get("difficulty", ""),
                    "quality": review.get("quality", ""),
                    "confidence": review.get("confidence", ""),
                    "generation_issue_flags": ";".join(review.get("generationIssueFlags", [])),
                    "comments": review.get("comments", ""),
                    "updated_at": review.get("updatedAt", ""),
                }
            )
    return {
        "exported_at": utc_now(),
        "schema": "ems_qbank_generation_feedback_v2",
        **response_scope_counts(rows),
        "rows": rows,
    }


def increment_count(counts: dict, key: str, amount: int = 1):
    key = str(key or "Unspecified")
    counts[key] = counts.get(key, 0) + amount


def publication_response_rows() -> list[dict]:
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    reviews = load_json(REVIEWS_FILE, {"reviews": {}})
    qualified_ids = qualified_reviewer_ids()
    rows = []
    for record_id, review_map in reviews.get("reviews", {}).items():
        question = bank.get("questions", {}).get(record_id, {})
        for storage_key, review in review_map.items():
            anonymous_id = review_owner_id(storage_key, review)
            profile_at_submission = review.get("profileAtSubmission") if isinstance(review.get("profileAtSubmission"), dict) else {}
            rows.append(
                {
                    "anonymous_user_id": anonymous_id,
                    "qualified_vote": review_qualified_at_submission(anonymous_id, review, qualified_ids),
                    "counts_toward_decision": review_counts_toward_decision(review),
                    "late_after_decision": bool(review.get("lateAfterDecision")),
                    "pool_state_at_submission": review.get("poolStateAtSubmission", ""),
                    "evaluation_mode": review_evaluation_mode(review),
                    "training_status_at_submission": profile_at_submission.get("trainingStatus", ""),
                    "previous_board_at_submission": profile_at_submission.get("previousBoard", ""),
                    "training_state_at_submission": profile_at_submission.get("trainingState", ""),
                    "practice_state_at_submission": profile_at_submission.get("practiceState", ""),
                    "record_id": record_id,
                    "question_id": question.get("question_id", ""),
                    "concept_key": question.get("concept_key") or concept_key_for_question(question),
                    "domain": question.get("domain", ""),
                    "topic_group": topic_group_for_question(question),
                    "topic": question.get("topic", ""),
                    "pool_state": question.get("pool_state", ""),
                    "vote_bucket": vote_bucket_for_review(review),
                    "disposition": normalize_disposition(review.get("disposition") or review.get("verdict", "")),
                    "difficulty": review.get("difficulty", ""),
                    "quality": review.get("quality", ""),
                    "confidence": review.get("confidence", ""),
                    "generation_issue_flags": review.get("generationIssueFlags", []),
                    "has_comments": bool(str(review.get("comments", "")).strip()),
                    "updated_at": review.get("updatedAt", ""),
                }
            )
    return sorted(
        rows,
        key=lambda row: (
            row["evaluation_mode"],
            row["practice_state_at_submission"],
            row["training_state_at_submission"],
            row["record_id"],
            row["anonymous_user_id"],
        ),
    )


def publication_group_rows(rows: list[dict], group_fields: list[str]) -> list[dict]:
    groups: dict[str, dict] = {}
    for row in rows:
        values = {field: str(row.get(field, "") or "Unspecified") for field in group_fields}
        group_key = " | ".join(values.values())
        group = groups.setdefault(
            group_key,
            {
                "group_key": group_key,
                "group_fields": values,
                "total_responses": 0,
                "unique_reviewers": 0,
                "_reviewer_ids": set(),
                "qualified_responses": 0,
                "nonqualified_responses": 0,
                "decision_eligible_responses": 0,
                "evaluation_mode_counts": {},
                "vote_bucket_counts": {},
                "disposition_counts": {},
                "difficulty_counts": {},
                "quality_counts": {},
                "confidence_counts": {},
                "issue_counts": {},
                "responses_with_comments": 0,
            },
        )
        group["total_responses"] += 1
        group["_reviewer_ids"].add(row.get("anonymous_user_id", ""))
        if row.get("qualified_vote"):
            group["qualified_responses"] += 1
        else:
            group["nonqualified_responses"] += 1
        if row.get("counts_toward_decision"):
            group["decision_eligible_responses"] += 1
        if row.get("has_comments"):
            group["responses_with_comments"] += 1
        increment_count(group["evaluation_mode_counts"], row.get("evaluation_mode", ""))
        increment_count(group["vote_bucket_counts"], row.get("vote_bucket", ""))
        increment_count(group["disposition_counts"], row.get("disposition", ""))
        increment_count(group["difficulty_counts"], row.get("difficulty", ""))
        increment_count(group["quality_counts"], row.get("quality", ""))
        increment_count(group["confidence_counts"], row.get("confidence", ""))
        for flag in row.get("generation_issue_flags", []) or []:
            increment_count(group["issue_counts"], flag)

    output = []
    for group in groups.values():
        group["unique_reviewers"] = len({reviewer for reviewer in group.pop("_reviewer_ids") if reviewer})
        output.append(group)
    return sorted(output, key=lambda row: (-row["total_responses"], row["group_key"]))


def publication_state_export() -> dict:
    rows = publication_response_rows()
    return {
        "exported_at": utc_now(),
        "schema": "ems_qbank_publication_state_analysis_v1",
        "environment": evaluation_environment_payload(),
        "privacy_note": "This export is de-identified. It includes anonymous reviewer IDs and submission-time profile states, but never raw email addresses. Small state-level cells should be suppressed or combined before publication when needed.",
        "instructions": "Use evaluation_mode and counts_toward_decision to separate beta/sandbox testing from live decision-eligible responses. Use practice_state_at_submission and training_state_at_submission for geographic subgroup analyses.",
        **response_scope_counts(rows),
        "state_patterns": {
            "by_practice_state": publication_group_rows(rows, ["practice_state_at_submission"]),
            "by_training_state": publication_group_rows(rows, ["training_state_at_submission"]),
            "by_training_and_practice_state": publication_group_rows(rows, ["training_state_at_submission", "practice_state_at_submission"]),
            "by_practice_state_and_question": publication_group_rows(rows, ["practice_state_at_submission", "question_id"]),
            "by_practice_state_and_topic_group": publication_group_rows(rows, ["practice_state_at_submission", "topic_group"]),
        },
        "response_rows": rows,
    }


def concept_lifecycle_status(state_counts: dict[str, int]) -> str:
    if state_counts.get("accepted", 0):
        return "accepted_on_site"
    if state_counts.get("voting", 0):
        return "in_evaluator_voting"
    if state_counts.get("paused", 0):
        return "pushed_paused"
    if state_counts.get("rejected", 0):
        return "rejected_rework_needed"
    if state_counts.get("retired", 0):
        return "retired"
    return "not_classified"


def concept_registry_summary(
    bank: dict | None = None,
    reviews: dict | None = None,
    learner_tallies: dict | None = None,
    qualified_ids: set[str] | None = None,
) -> dict:
    bank = bank if bank is not None else load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    reviews = reviews if reviews is not None else load_json(REVIEWS_FILE, {"reviews": {}})
    learner_tallies = learner_tallies if learner_tallies is not None else learner_answer_tallies(bank)
    qualified_ids = qualified_ids if qualified_ids is not None else qualified_reviewer_ids()
    groups: dict[str, dict] = {}

    for record_id, question in bank.get("questions", {}).items():
        concept_key = concept_key_for_question(question)
        row = groups.setdefault(
            concept_key,
            {
                "concept_key": concept_key,
                "content_id": question.get("content_id", ""),
                "core_content_code": question.get("core_content_code", ""),
                "domain": question.get("domain", ""),
                "topic_group_code": question.get("topic_group_code") or topic_group_code_for_question(question),
                "topic_group": topic_group_for_question(question),
                "topic": question.get("topic", ""),
                "record_ids": [],
                "question_ids": [],
                "content_hashes": [],
                "intake_batch_ids": [],
                "state_counts": {state: 0 for state in sorted(VALID_POOL_STATES)},
                "qualified_accept": 0,
                "qualified_reject": 0,
                "total_reviews": 0,
                "learner_attempts": 0,
                "duplicate_warning_count": 0,
                "duplicate_warning_types": {},
            },
        )
        pool_state = question.get("pool_state", "voting")
        row["state_counts"][pool_state] = row["state_counts"].get(pool_state, 0) + 1
        row["record_ids"].append(record_id)
        row["question_ids"].append(question.get("question_id", ""))
        row["content_hashes"].append(question.get("content_hash", ""))
        if question.get("intake_batch_id"):
            row["intake_batch_ids"].append(question.get("intake_batch_id", ""))
        tally = tally_for_question(record_id, reviews, qualified_ids)
        row["qualified_accept"] += tally.get("qualifiedAccept", 0)
        row["qualified_reject"] += tally.get("qualifiedReject", 0)
        row["total_reviews"] += tally.get("totalReviews", 0)
        row["learner_attempts"] += learner_tallies.get(record_id, {}).get("total_attempts", 0)
        for warning in question.get("duplicate_warnings", []) or []:
            warning_type = warning.get("type", "duplicate_warning")
            row["duplicate_warning_count"] += 1
            row["duplicate_warning_types"][warning_type] = row["duplicate_warning_types"].get(warning_type, 0) + 1

    rows = []
    counts_by_status: dict[str, int] = {}
    for row in groups.values():
        row["record_count"] = len(row["record_ids"])
        row["question_count"] = len(set(row["question_ids"]))
        row["content_hash_count"] = len(set(filter(None, row["content_hashes"])))
        row["intake_batch_ids"] = sorted(set(filter(None, row["intake_batch_ids"])))
        row["status"] = concept_lifecycle_status(row["state_counts"])
        row["active_record_count"] = sum(row["state_counts"].get(state, 0) for state in ("voting", "accepted", "paused"))
        row["duplicate_risk"] = row["active_record_count"] > 1 or row["content_hash_count"] > 1 or row["duplicate_warning_count"] > 0
        counts_by_status[row["status"]] = counts_by_status.get(row["status"], 0) + 1
        rows.append(row)

    duplicate_rows = [row for row in rows if row["duplicate_risk"]]
    return {
        "schema": "ems_qbank_concept_lifecycle_registry_v1",
        "generated_at": utc_now(),
        "counts": {
            "total_concepts_on_site": len(rows),
            "duplicate_risk_concepts": len(duplicate_rows),
            **counts_by_status,
        },
        "duplicate_risk_rows": sorted(
            duplicate_rows,
            key=lambda row: (-row["active_record_count"], -row["content_hash_count"], row["concept_key"]),
        ),
        "rows": sorted(rows, key=lambda row: (row["status"], row["core_content_code"], row["concept_key"])),
    }


def admin_summary() -> dict:
    ensure_question_bank()
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    reviews = load_json(REVIEWS_FILE, {"reviews": {}})
    users = load_json(USERS_FILE, {"users": {}})
    progress = load_json(LEARNER_FILE, {"progress": {}})
    learner_tallies = learner_answer_tallies(bank, progress)
    qualified_ids = qualified_reviewer_ids()
    concept_registry = concept_registry_summary(bank, reviews, learner_tallies, qualified_ids)
    include_active_review = active_review_filter

    pool_counts = {"voting": 0, "accepted": 0, "rejected": 0, "paused": 0, "retired": 0, "tiebreaker": 0}
    issue_counts: dict[str, int] = {}
    disposition_counts: dict[str, int] = {}
    rows = []

    for record_id, question in bank.get("questions", {}).items():
        tally = tally_for_question(record_id, reviews, qualified_ids, include_active_review)
        pool_state = question.get("pool_state", "voting")
        pool_counts[pool_state] = pool_counts.get(pool_state, 0) + 1
        if pool_state == "voting" and tally["reviewStage"] == "tiebreaker":
            pool_counts["tiebreaker"] += 1

        question_issue_counts: dict[str, int] = {}
        question_disposition_counts: dict[str, int] = {}
        for review in reviews.get("reviews", {}).get(record_id, {}).values():
            if not include_active_review(review):
                continue
            for flag in review.get("generationIssueFlags", []):
                issue_counts[flag] = issue_counts.get(flag, 0) + 1
                question_issue_counts[flag] = question_issue_counts.get(flag, 0) + 1
            disposition = normalize_disposition(review.get("disposition") or review.get("verdict", ""))
            if disposition:
                disposition_counts[disposition] = disposition_counts.get(disposition, 0) + 1
                question_disposition_counts[disposition] = question_disposition_counts.get(disposition, 0) + 1

        rows.append(
            {
                "record_id": record_id,
                "question_id": question.get("question_id", ""),
                "content_hash": question.get("content_hash", ""),
                "source_question_number": question.get("source_question_number", ""),
                "intake_batch_id": question.get("intake_batch_id", ""),
                "lineage_parent_record_id": question.get("lineage_parent_record_id", ""),
                "concept_key": question.get("concept_key") or concept_key_for_question(question),
                "duplicate_warnings": question.get("duplicate_warnings", []),
                "content_id": question.get("content_id", ""),
                "core_content_code": question.get("core_content_code", ""),
                "domain": question.get("domain", ""),
                "topic_group_code": question.get("topic_group_code") or topic_group_code_for_question(question),
                "topic_group": topic_group_for_question(question),
                "topic": question.get("topic", ""),
                "pool_state": pool_state,
                "review_stage": tally["reviewStage"],
                "qualified_accept": tally["qualifiedAccept"],
                "qualified_reject": tally["qualifiedReject"],
                "qualified_total": tally["qualifiedTotal"],
                "nonqualified_votes": tally["nonQualifiedVotes"],
                "total_reviews": tally["totalReviews"],
                "decision_eligible_reviews": tally["decisionEligibleReviews"],
                "nondecision_reviews": tally["nonDecisionReviews"],
                "sandbox_reviews": tally["sandboxReviews"],
                "beta_reviews": tally["betaReviews"],
                "learner_tally": learner_tallies.get(record_id, empty_learner_answer_tally(question)),
                "issue_counts": question_issue_counts,
                "disposition_counts": question_disposition_counts,
            }
        )

    reviewer_count = len(users.get("users", {}))
    qualified_reviewer_count = sum(
        1 for user in users.get("users", {}).values() if user.get("profile", {}).get("previousBoard") == "yes"
    )
    learner_total_attempts = sum(tally.get("total_attempts", 0) for tally in learner_tallies.values())
    learner_answered_questions = sum(1 for tally in learner_tallies.values() if tally.get("total_attempts", 0))
    learner_correct_attempts = sum(tally.get("correct_attempts", 0) for tally in learner_tallies.values())
    learner_incorrect_attempts = sum(tally.get("incorrect_attempts", 0) for tally in learner_tallies.values())
    total_reviews = sum(
        1
        for review_map in reviews.get("reviews", {}).values()
        for review in review_map.values()
        if include_active_review(review)
    )

    return {
        "generated_at": utc_now(),
        "environment": evaluation_environment_payload(),
        "pool_counts": pool_counts,
        "reviewer_counts": {
            "total": reviewer_count,
            "qualified": qualified_reviewer_count,
            "feedback_only": reviewer_count - qualified_reviewer_count,
        },
        "activity": {
            "total_reviews": total_reviews,
            "learner_answered_questions": learner_answered_questions,
            "learner_total_attempts": learner_total_attempts,
            "learner_correct_attempts": learner_correct_attempts,
            "learner_incorrect_attempts": learner_incorrect_attempts,
        },
        "issue_counts": issue_counts,
        "disposition_counts": disposition_counts,
        "learner_flags": learner_flag_rollup(bank),
        "concept_counts": concept_registry["counts"],
        "concept_duplicates": concept_registry["duplicate_risk_rows"],
        "questions": sorted(rows, key=lambda row: (row["pool_state"], row["review_stage"], int_or_text(row["source_question_number"]))),
    }


def load_audit_events() -> list[dict]:
    if not AUDIT_LOG_FILE.exists():
        return []
    events = []
    for line in AUDIT_LOG_FILE.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            events.append({"event_type": "unreadable_audit_log_line", "raw": line})
    return events


def lifecycle_registry_export() -> dict:
    ensure_question_bank()
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    reviews = load_json(REVIEWS_FILE, {"reviews": {}})
    progress = load_json(LEARNER_FILE, {"progress": {}})
    learner_tallies = learner_answer_tallies(bank, progress)
    qualified_ids = qualified_reviewer_ids()
    concept_registry = concept_registry_summary(bank, reviews, learner_tallies, qualified_ids)
    rows = []
    for record_id, question in bank.get("questions", {}).items():
        tally = tally_for_question(record_id, reviews, qualified_ids)
        rows.append(
            {
                "record_id": record_id,
                "question_id": question.get("question_id", ""),
                "content_hash": question.get("content_hash", ""),
                "source_label": question.get("source_label", ""),
                "source_question_number": question.get("source_question_number", ""),
                "intake_batch_id": question.get("intake_batch_id", ""),
                "intake_source_path": question.get("intake_source_path", ""),
                "intake_source_sha256": question.get("intake_source_sha256", ""),
                "lineage_parent_record_id": question.get("lineage_parent_record_id", ""),
                "lineage_parent_content_hash": question.get("lineage_parent_content_hash", ""),
                "concept_key": question.get("concept_key") or concept_key_for_question(question),
                "duplicate_warnings": question.get("duplicate_warnings", []),
                "pool_state": question.get("pool_state", "voting"),
                "decision_reason": question.get("decision_reason", ""),
                "added_at": question.get("added_at", ""),
                "closed_at": question.get("closed_at", ""),
                "content_id": question.get("content_id", ""),
                "core_content_code": question.get("core_content_code", ""),
                "domain": question.get("domain", ""),
                "topic_group_code": question.get("topic_group_code") or topic_group_code_for_question(question),
                "topic_group": topic_group_for_question(question),
                "topic": question.get("topic", ""),
                "review_stage": tally["reviewStage"],
                "qualified_accept": tally["qualifiedAccept"],
                "qualified_reject": tally["qualifiedReject"],
                "qualified_total": tally["qualifiedTotal"],
                "nonqualified_votes": tally["nonQualifiedVotes"],
                "total_reviews": tally["totalReviews"],
                "decision_eligible_reviews": tally["decisionEligibleReviews"],
                "nondecision_reviews": tally["nonDecisionReviews"],
                "sandbox_reviews": tally["sandboxReviews"],
                "beta_reviews": tally["betaReviews"],
                "learner_tally": learner_tallies.get(record_id, empty_learner_answer_tally(question)),
                "state_history": question.get("state_history", []),
            }
        )
    return {
        "exported_at": utc_now(),
        "schema": "ems_qbank_lifecycle_registry_v1",
        "environment": evaluation_environment_payload(),
        "pool_counts": admin_summary()["pool_counts"],
        "sources": bank.get("sources", []),
        "concept_registry": concept_registry,
        "questions": sorted(rows, key=lambda row: (row["pool_state"], row["intake_batch_id"], int_or_text(row["source_question_number"]))),
        "audit_log": load_audit_events(),
    }


def llm_action_for_question(question: dict, tally: dict, disposition_counts: dict, issue_counts: dict, has_comments: bool) -> str:
    state = question.get("pool_state", "voting")
    if state == "accepted":
        if disposition_counts.get("accept_with_revisions") or issue_counts or has_comments:
            return "accepted_with_revision_notes"
        return "accepted_as_is"
    if state == "rejected":
        return "rejected_rewrite_or_do_not_use"
    if state == "retired":
        return "retired_do_not_reuse"
    if state == "paused":
        return "paused_not_currently_in_review"
    if tally.get("reviewStage") == "tiebreaker":
        return "await_tiebreaker"
    return "await_more_votes"


def llm_feedback_export() -> dict:
    ensure_question_bank()
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    reviews = load_json(REVIEWS_FILE, {"reviews": {}})
    progress = load_json(LEARNER_FILE, {"progress": {}})
    learner_tallies = learner_answer_tallies(bank, progress)
    learner_flags = load_json(LEARNER_FLAGS_FILE, {"flags": {}})
    qualified_ids = qualified_reviewer_ids()
    items = []
    for record_id, question in bank.get("questions", {}).items():
        tally = tally_for_question(record_id, reviews, qualified_ids)
        disposition_counts: dict[str, int] = {}
        issue_counts: dict[str, int] = {}
        feedback = []
        learner_feedback, learner_issue_counts = learner_flag_feedback_for_question(record_id, learner_flags)
        for storage_key, review in reviews.get("reviews", {}).get(record_id, {}).items():
            anonymous_id = review_owner_id(storage_key, review)
            disposition = normalize_disposition(review.get("disposition") or review.get("verdict", ""))
            if disposition:
                disposition_counts[disposition] = disposition_counts.get(disposition, 0) + 1
            for flag in review.get("generationIssueFlags", []):
                issue_counts[flag] = issue_counts.get(flag, 0) + 1
            profile_at_submission = review.get("profileAtSubmission") if isinstance(review.get("profileAtSubmission"), dict) else {}
            feedback.append(
                {
                    "anonymous_user_id": anonymous_id,
                    "qualified_vote": review_qualified_at_submission(anonymous_id, review, qualified_ids),
                    "counts_toward_decision": review_counts_toward_decision(review),
                    "late_after_decision": bool(review.get("lateAfterDecision")),
                    "pool_state_at_submission": review.get("poolStateAtSubmission", ""),
                    "evaluation_environment": review.get("evaluationEnvironment", "legacy_sandbox"),
                    "evaluation_mode": review_evaluation_mode(review),
                    "disposition": disposition,
                    "vote_bucket": vote_bucket_for_review(review),
                    "difficulty": review.get("difficulty", ""),
                    "quality": review.get("quality", ""),
                    "confidence": review.get("confidence", ""),
                    "generation_issue_flags": review.get("generationIssueFlags", []),
                    "comments": review.get("comments", ""),
                    "profile_at_submission": profile_at_submission,
                    "updated_at": review.get("updatedAt", ""),
                }
            )
        has_comments = any(str(row.get("comments", "")).strip() for row in feedback + learner_feedback)
        feedback_counts = feedback_scope_counts(feedback)
        action_issue_counts = dict(issue_counts)
        for issue, count in learner_issue_counts.items():
            action_issue_counts[issue] = action_issue_counts.get(issue, 0) + count
        items.append(
            {
                "record_id": record_id,
                "question_id": question.get("question_id", ""),
                "content_hash": question.get("content_hash", ""),
                "intake_batch_id": question.get("intake_batch_id", ""),
                "lineage_parent_record_id": question.get("lineage_parent_record_id", ""),
                "concept_key": question.get("concept_key") or concept_key_for_question(question),
                "pool_state": question.get("pool_state", "voting"),
                "llm_action": llm_action_for_question(question, tally, disposition_counts, action_issue_counts, has_comments),
                "decision_reason": question.get("decision_reason", ""),
                "content_id": question.get("content_id", ""),
                "core_content_code": question.get("core_content_code", ""),
                "domain": question.get("domain", ""),
                "topic_group": topic_group_for_question(question),
                "topic": question.get("topic", ""),
                "stem": question.get("stem", ""),
                "options": question.get("options", {}),
                "answer": question.get("answer", ""),
                "rationale": question.get("rationale", ""),
                "citation": question.get("citation", ""),
                "tally": tally,
                "learner_tally": learner_tallies.get(record_id, empty_learner_answer_tally(question)),
                "disposition_counts": disposition_counts,
                "issue_counts": issue_counts,
                "learner_issue_counts": learner_issue_counts,
                "learner_flags_total": len(learner_feedback),
                "learner_flags": learner_feedback,
                **feedback_counts,
                "feedback": feedback,
            }
        )
    all_feedback = [row for item in items for row in item.get("feedback", [])]
    return {
        "exported_at": utc_now(),
        "schema": "ems_qbank_llm_feedback_v2",
        **response_scope_counts(all_feedback),
        "learner_flags_total": sum(item.get("learner_flags_total", 0) for item in items),
        "instructions": "This export intentionally includes both qualified and non-qualified evaluator responses. Use qualified_vote to identify reviewers whose submission-time profile said they previously took the board. Use counts_toward_decision and evaluation_mode to distinguish official live votes from beta or sandbox feedback. Learner_tally includes per-question learner correct/incorrect attempts plus option and distractor selected/ignored counts. Learner flags are included separately under learner_flags for accepted questions that may need admin review or revision. Use record_id, question_id, content_hash, intake_batch_id, pool_state, llm_action, issue_counts, learner_issue_counts, learner_tally, and comments to revise or retire generated questions. Do not overwrite an existing accepted/rejected/retired record; import revisions as new records or let the server create lineage records when content_hash changes.",
        "items": sorted(items, key=lambda row: (row["pool_state"], row["intake_batch_id"], row["record_id"])),
    }


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "EMSQuestionBank/0.2"

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self.handle_api_get(parsed.path, parse_qs(parsed.query))
            else:
                self.serve_static(parsed.path)
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": str(exc)}, status=500)

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self.handle_api_post(parsed.path)
            else:
                self.send_json({"error": "Not found"}, status=404)
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": str(exc)}, status=500)

    def handle_api_get(self, path: str, query: dict):
        if path == "/api/health":
            self.send_json({"ok": True, "time": utc_now()})
            return

        if path == "/api/admin/export-generation-feedback":
            if not self.require_admin():
                return
            self.send_json(generation_feedback_export())
            return
        if path == "/api/admin/export-publication":
            if not self.require_admin():
                return
            self.send_json(publication_state_export())
            return
        if path == "/api/admin/export-concepts":
            if not self.require_admin():
                return
            self.send_json(concept_registry_summary())
            return
        if path == "/api/admin/export-llm-feedback":
            if not self.require_admin():
                return
            self.send_json(llm_feedback_export())
            return
        if path == "/api/admin/export-lifecycle":
            if not self.require_admin():
                return
            self.send_json(lifecycle_registry_export())
            return
        if path == "/api/admin/summary":
            if not self.require_admin():
                return
            self.send_json(admin_summary())
            return

        email_hash, user = self.require_user()
        if not user:
            return

        if path == "/api/me":
            self.send_json({"user": safe_user(user)})
            return
        if path == "/api/questions":
            anonymous_id = user["anonymous_user_id"]
            self.send_json({"questions": question_payload(anonymous_id), "counts": public_question_counts(anonymous_id)})
            return
        if path == "/api/my-reviews":
            self.send_json({"reviews": reviews_for_user(user["anonymous_user_id"])})
            return
        if path == "/api/my-progress":
            self.send_json({"progress": learner_for_user(user["anonymous_user_id"])})
            return
        if path == "/api/my-learner-flags":
            self.send_json({"learnerFlags": learner_flags_for_user(user["anonymous_user_id"])})
            return

        self.send_json({"error": "Not found"}, status=404)

    def handle_api_post(self, path: str):
        payload = self.read_json_body()

        if path == "/api/register":
            self.register(payload)
            return
        if path == "/api/login":
            self.login(payload)
            return
        if path == "/api/request-password-reset":
            self.request_password_reset(payload)
            return
        if path == "/api/reset-password":
            self.reset_password(payload)
            return

        if path == "/api/admin/import-questions":
            if not self.require_admin():
                return
            source_path = Path(str(payload.get("sourcePath", "")))
            if not source_path.is_absolute():
                source_path = PROJECT_ROOT / source_path
            label = str(payload.get("sourceLabel", "")).strip() or source_path.stem
            activate = bool(payload.get("activate", True))
            batch_id = str(payload.get("batchId", "")).strip()
            notes = str(payload.get("notes", "")).strip()
            with DATA_LOCK:
                result = import_questions_from_file(source_path, label, activate=activate, batch_id=batch_id, notes=notes, actor="admin")
            self.send_json({"ok": True, **result})
            return

        if path == "/api/admin/set-evaluation-mode":
            if not self.require_admin():
                return
            mode = str(payload.get("evaluationMode", "")).strip().lower()
            if mode not in VALID_EVALUATION_MODES:
                self.send_json({"error": "Invalid evaluation mode."}, status=400)
                return
            with DATA_LOCK:
                environment = set_runtime_evaluation_mode(mode, actor="admin")
            self.send_json({"ok": True, "environment": environment, "summary": admin_summary()})
            return

        if path == "/api/admin/set-question-state":
            if not self.require_admin():
                return
            record_id = str(payload.get("recordId", ""))
            pool_state = str(payload.get("poolState", ""))
            if pool_state not in VALID_POOL_STATES:
                self.send_json({"error": "Invalid pool state."}, status=400)
                return
            reason = str(payload.get("reason", "")).strip() or "admin_set_state"
            with DATA_LOCK:
                bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
                question = bank.get("questions", {}).get(record_id)
                if not question:
                    self.send_json({"error": "Question not found."}, status=404)
                    return
                apply_question_state(question, pool_state, reason, "admin", {})
                bank["questions"][record_id] = question
                save_json(QUESTION_BANK_FILE, bank)
            self.send_json({"ok": True, "question": question})
            return

        email_hash, user = self.require_user()
        if not user:
            return

        if path == "/api/profile":
            self.save_profile(email_hash, user, payload)
            return
        if path == "/api/review":
            self.save_review(user, payload)
            return
        if path == "/api/learner-answer":
            self.save_learner_answer(user, payload)
            return
        if path == "/api/learner-flag":
            self.save_learner_flag(user, payload)
            return

        self.send_json({"error": "Not found"}, status=404)

    def register(self, payload: dict):
        email = normalize_email(str(payload.get("email", "")))
        password = str(payload.get("password", ""))
        access_code = str(payload.get("accessCode", "")).strip().upper()
        if not email or "@" not in email:
            self.send_json({"error": "A valid email is required."}, status=400)
            return
        if len(password) < 8:
            self.send_json({"error": "Password must be at least 8 characters."}, status=400)
            return
        if access_code not in ACCESS_CODES:
            self.send_json({"error": "Access code not recognized."}, status=403)
            return
        with DATA_LOCK:
            users = load_json(USERS_FILE, {"users": {}})
            digest = email_digest(email)
            if digest in users["users"]:
                self.send_json({"error": "An account already exists for that email."}, status=409)
                return
            salt = secrets.token_hex(16)
            user = {
                "anonymous_user_id": new_anonymous_id(users),
                "password_salt": salt,
                "password_hash": password_hash(password, salt),
                "profile": profile_from_payload(payload),
                "created_at": utc_now(),
            }
            users["users"][digest] = user
            save_json(USERS_FILE, users)
            token = self.create_session(digest)
        self.send_json({"token": token, "user": safe_user(user)})

    def login(self, payload: dict):
        email = normalize_email(str(payload.get("email", "")))
        password = str(payload.get("password", ""))
        digest = email_digest(email)
        users = load_json(USERS_FILE, {"users": {}})
        user = users.get("users", {}).get(digest)
        if not user:
            self.send_json({"error": "Email or password did not match."}, status=401)
            return
        if password_hash(password, user["password_salt"]) != user["password_hash"]:
            self.send_json({"error": "Email or password did not match."}, status=401)
            return
        token = self.create_session(digest)
        self.send_json({"token": token, "user": safe_user(user)})

    def request_password_reset(self, payload: dict):
        email = normalize_email(str(payload.get("email", "")))
        if not email or "@" not in email:
            self.send_json({"error": "A valid email is required."}, status=400)
            return
        environment = evaluation_environment_payload()
        evaluation_mode = environment.get("evaluation_mode", "sandbox")
        if evaluation_mode != "sandbox" and not smtp_configured():
            self.send_json({"error": "Password reset email delivery is not configured yet."}, status=503)
            return

        digest = email_digest(email)
        users = load_json(USERS_FILE, {"users": {}})
        user = users.get("users", {}).get(digest)
        response = {
            "ok": True,
            "message": "If an account exists for that email, a password reset code has been sent.",
        }
        if not user:
            append_audit_event("password_reset_requested", actor="public", account_found=False)
            self.send_json(response)
            return

        reset_code = secrets.token_urlsafe(18)
        reset_hash = token_digest(reset_code)
        delivery = "email"
        if evaluation_mode == "sandbox":
            delivery = "inline_sandbox"
            response["resetCode"] = reset_code
            response["message"] = "Sandbox reset code generated. Use it to set a new password."
        else:
            try:
                send_password_reset_email(email, reset_code)
            except Exception as exc:  # noqa: BLE001
                append_audit_event(
                    "password_reset_delivery_failed",
                    actor="system",
                    anonymous_user_id=user.get("anonymous_user_id", ""),
                    delivery="email",
                    error=str(exc),
                )
                self.send_json({"error": "Password reset email could not be sent. Please try again later."}, status=503)
                return

        with DATA_LOCK:
            resets = load_json(PASSWORD_RESETS_FILE, {"resets": {}})
            prune_password_resets(resets)
            resets.setdefault("resets", {})[reset_hash] = {
                "email_hash": digest,
                "anonymous_user_id": user.get("anonymous_user_id", ""),
                "created_at": utc_now(),
                "expires_at": password_reset_expires_at(),
                "used_at": "",
                "delivery": delivery,
                "evaluation_environment": environment.get("evaluation_env", "sandbox"),
                "evaluation_mode": evaluation_mode,
            }
            save_json(PASSWORD_RESETS_FILE, resets)
        append_audit_event(
            "password_reset_requested",
            actor="public",
            anonymous_user_id=user.get("anonymous_user_id", ""),
            account_found=True,
            delivery=delivery,
            evaluation_mode=evaluation_mode,
        )
        self.send_json(response)

    def reset_password(self, payload: dict):
        reset_code = str(payload.get("resetCode", "")).strip()
        new_password = str(payload.get("password", ""))
        if not reset_code:
            self.send_json({"error": "Reset code is required."}, status=400)
            return
        if len(new_password) < 8:
            self.send_json({"error": "Password must be at least 8 characters."}, status=400)
            return

        reset_hash = token_digest(reset_code)
        with DATA_LOCK:
            resets = load_json(PASSWORD_RESETS_FILE, {"resets": {}})
            changed = prune_password_resets(resets)
            record = resets.get("resets", {}).get(reset_hash)
            expires = parse_utc(record.get("expires_at", "")) if record else None
            if not record or record.get("used_at") or not expires or expires < datetime.now(timezone.utc):
                if changed:
                    save_json(PASSWORD_RESETS_FILE, resets)
                self.send_json({"error": "Reset code is invalid or expired."}, status=400)
                return

            users = load_json(USERS_FILE, {"users": {}})
            email_hash = record.get("email_hash", "")
            user = users.get("users", {}).get(email_hash)
            if not user:
                self.send_json({"error": "Reset code is invalid or expired."}, status=400)
                return

            salt = secrets.token_hex(16)
            user["password_salt"] = salt
            user["password_hash"] = password_hash(new_password, salt)
            user["password_reset_at"] = utc_now()
            users["users"][email_hash] = user
            for reset_record in resets.get("resets", {}).values():
                if reset_record.get("email_hash") == email_hash and not reset_record.get("used_at"):
                    reset_record["used_at"] = user["password_reset_at"]
            sessions = load_json(SESSIONS_FILE, {"tokens": {}})
            sessions["tokens"] = {
                token: session
                for token, session in sessions.get("tokens", {}).items()
                if session.get("email_hash") != email_hash
            }
            session_token = secrets.token_urlsafe(32)
            sessions.setdefault("tokens", {})[session_token] = {"email_hash": email_hash, "created_at": utc_now()}
            save_json(USERS_FILE, users)
            save_json(PASSWORD_RESETS_FILE, resets)
            save_json(SESSIONS_FILE, sessions)
        append_audit_event(
            "password_reset_completed",
            actor="public",
            anonymous_user_id=user.get("anonymous_user_id", ""),
            evaluation_mode=evaluation_environment_payload().get("evaluation_mode"),
        )
        self.send_json({"token": session_token, "user": safe_user(user)})

    def create_session(self, email_hash: str) -> str:
        sessions = load_json(SESSIONS_FILE, {"tokens": {}})
        token = secrets.token_urlsafe(32)
        sessions["tokens"][token] = {"email_hash": email_hash, "created_at": utc_now()}
        save_json(SESSIONS_FILE, sessions)
        return token

    def save_profile(self, email_hash: str, user: dict, payload: dict):
        with DATA_LOCK:
            users = load_json(USERS_FILE, {"users": {}})
            stored = users["users"].get(email_hash)
            if not stored:
                self.send_json({"error": "User not found."}, status=404)
                return
            stored["profile"] = profile_from_payload(payload)
            stored["profile_updated_at"] = utc_now()
            users["users"][email_hash] = stored
            save_json(USERS_FILE, users)
        self.send_json({"user": safe_user(stored)})

    def save_review(self, user: dict, payload: dict):
        record_id = str(payload.get("recordId", ""))
        disposition = normalize_disposition(payload.get("disposition") or payload.get("verdict", ""))
        verdict = vote_bucket_for_review({"disposition": disposition, "verdict": disposition})
        if verdict not in {"accept", "reject"}:
            self.send_json({"error": "Vote must be accept as is, accept with revisions, major revisions needed, or reject."}, status=400)
            return

        with DATA_LOCK:
            bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
            question = bank.get("questions", {}).get(record_id)
            if not question:
                self.send_json({"error": "Question not found."}, status=404)
                return
            pool_state_at_submission = question.get("pool_state", "voting")
            late_after_decision = pool_state_at_submission != "voting"

            reviews = load_json(REVIEWS_FILE, {"reviews": {}})
            reviews.setdefault("reviews", {}).setdefault(record_id, {})
            anonymous_id = user["anonymous_user_id"]
            profile_at_submission = reviewer_profile_snapshot(user)
            environment = evaluation_environment_payload()
            evaluation_mode = environment.get("evaluation_mode", "sandbox")
            live_evaluation = bool(environment.get("live_evaluation"))
            counts_toward_decision = live_evaluation and not late_after_decision
            review_map = reviews["reviews"][record_id]
            existing_unscoped = review_map.get(anonymous_id)
            if existing_unscoped and not review_matches_mode(existing_unscoped, "live"):
                legacy_mode = review_evaluation_mode(existing_unscoped)
                legacy_key = review_storage_key(anonymous_id, legacy_mode)
                existing_unscoped["anonymousUserId"] = anonymous_id
                if legacy_key not in review_map:
                    review_map[legacy_key] = existing_unscoped
                del review_map[anonymous_id]
            if any(
                review_owner_id(storage_key, review) == anonymous_id and review_matches_mode(review, evaluation_mode)
                for storage_key, review in review_map.items()
            ):
                self.send_json({"error": "This reviewer has already voted on this question in the current evaluation mode."}, status=409)
                return
            storage_key = review_storage_key(anonymous_id, evaluation_mode)
            if storage_key in review_map:
                storage_key = f"{storage_key}__{secrets.token_hex(4)}"
            review_map[storage_key] = {
                "anonymousUserId": anonymous_id,
                "verdict": verdict,
                "disposition": disposition,
                "difficulty": str(payload.get("difficulty", "")),
                "quality": str(payload.get("quality", "")),
                "confidence": str(payload.get("confidence", "")),
                "generationIssueFlags": [str(flag) for flag in payload.get("generationIssueFlags", [])],
                "comments": str(payload.get("comments", "")).strip(),
                "profileAtSubmission": profile_at_submission,
                "profileLastUpdatedAtSubmission": user.get("profile_updated_at", ""),
                "qualifiedAtSubmission": profile_at_submission.get("previousBoard") == "yes",
                "evaluationEnvironment": environment.get("evaluation_env", "sandbox"),
                "evaluationMode": evaluation_mode,
                "countsTowardDecision": counts_toward_decision,
                "lateAfterDecision": late_after_decision,
                "poolStateAtSubmission": pool_state_at_submission,
                "updatedAt": utc_now(),
            }
            save_json(REVIEWS_FILE, reviews)
            append_audit_event(
                "review_submitted",
                actor="evaluator",
                anonymous_user_id=anonymous_id,
                record_id=record_id,
                question_id=question.get("question_id", ""),
                intake_batch_id=question.get("intake_batch_id", ""),
                disposition=disposition,
                vote_bucket=verdict,
                qualified_at_submission=profile_at_submission.get("previousBoard") == "yes",
                evaluation_environment=environment.get("evaluation_env", "sandbox"),
                evaluation_mode=environment.get("evaluation_mode", "sandbox"),
                counts_toward_decision=counts_toward_decision,
                late_after_decision=late_after_decision,
                pool_state_at_submission=pool_state_at_submission,
                profile_at_submission=profile_at_submission,
                generation_issue_flags=[str(flag) for flag in payload.get("generationIssueFlags", [])],
                difficulty=str(payload.get("difficulty", "")),
                quality=str(payload.get("quality", "")),
                confidence=str(payload.get("confidence", "")),
            )
            if counts_toward_decision:
                update_pool_decision(record_id)
        self.send_json(
            {
                "ok": True,
                "review": review_map[storage_key],
            }
        )

    def save_learner_answer(self, user: dict, payload: dict):
        record_id = str(payload.get("recordId", ""))
        selected = str(payload.get("selected", ""))
        with DATA_LOCK:
            bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
            question = bank.get("questions", {}).get(record_id)
            if not question:
                self.send_json({"error": "Question not found."}, status=404)
                return
            if question.get("pool_state") != "accepted":
                self.send_json({"error": "Learner mode only includes accepted questions."}, status=409)
                return
            if selected not in set(question.get("options", {}).keys()):
                self.send_json({"error": "Selected answer is invalid."}, status=400)
                return
            progress = load_json(LEARNER_FILE, {"progress": {}})
            anonymous_id = user["anonymous_user_id"]
            user_progress = progress.setdefault("progress", {}).setdefault(anonymous_id, {})
            previous = user_progress.get(record_id, {})
            history = previous.get("history", [])
            if not isinstance(history, list):
                history = []
            correct = selected == question.get("answer")
            attempt = {"selected": selected, "correct": correct, "answeredAt": utc_now()}
            user_progress[record_id] = {
                "selected": selected,
                "correctAnswer": question.get("answer"),
                "correct": correct,
                "attempts": int(previous.get("attempts", 0)) + 1,
                "answeredAt": attempt["answeredAt"],
                "history": history + [attempt],
            }
            save_json(LEARNER_FILE, progress)
        self.send_json({"ok": True, "record": user_progress[record_id]})

    def save_learner_flag(self, user: dict, payload: dict):
        record_id = str(payload.get("recordId", ""))
        raw_flags = payload.get("generationIssueFlags", [])
        if isinstance(raw_flags, str):
            raw_flags = [raw_flags]
        generation_issue_flags = [str(flag) for flag in raw_flags if str(flag).strip()]
        comments = str(payload.get("comments", "")).strip()
        if not generation_issue_flags and not comments:
            self.send_json({"error": "Add at least one flag or comment before submitting."}, status=400)
            return

        with DATA_LOCK:
            bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
            question = bank.get("questions", {}).get(record_id)
            if not question:
                self.send_json({"error": "Question not found."}, status=404)
                return
            if question.get("pool_state") != "accepted":
                self.send_json({"error": "Only accepted learner-pool questions can be flagged from learner mode."}, status=409)
                return

            flags = load_json(LEARNER_FLAGS_FILE, {"flags": {}})
            anonymous_id = user["anonymous_user_id"]
            profile_at_submission = reviewer_profile_snapshot(user)
            record = {
                "generationIssueFlags": generation_issue_flags,
                "comments": comments,
                "profileAtSubmission": profile_at_submission,
                "profileLastUpdatedAtSubmission": user.get("profile_updated_at", ""),
                "qualifiedAtSubmission": profile_at_submission.get("previousBoard") == "yes",
                "questionPoolStateAtSubmission": question.get("pool_state", ""),
                "status": "open",
                "updatedAt": utc_now(),
            }
            flags.setdefault("flags", {}).setdefault(record_id, {})[anonymous_id] = record
            save_json(LEARNER_FLAGS_FILE, flags)
            append_audit_event(
                "learner_flag_submitted",
                actor="learner",
                anonymous_user_id=anonymous_id,
                record_id=record_id,
                question_id=question.get("question_id", ""),
                intake_batch_id=question.get("intake_batch_id", ""),
                profile_at_submission=profile_at_submission,
                qualified_at_submission=profile_at_submission.get("previousBoard") == "yes",
                generation_issue_flags=generation_issue_flags,
                has_comments=bool(comments),
            )
        self.send_json({"ok": True, "flag": record})

    def require_user(self) -> tuple[str, dict] | tuple[None, None]:
        auth = self.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
        email_hash, user = user_from_token(token)
        if not user:
            self.send_json({"error": "Authentication required."}, status=401)
            return None, None
        return email_hash, user

    def require_admin(self) -> bool:
        supplied = self.headers.get("X-Admin-Token", "")
        if not supplied or not hmac.compare_digest(supplied, admin_token()):
            self.send_json({"error": "Admin token required."}, status=401)
            return False
        return True

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw or "{}")

    def send_json(self, payload, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, path: str):
        if path in {"", "/"}:
            self.send_response(302)
            self.send_header("Location", "/web/")
            self.end_headers()
            return

        resolved = (PROJECT_ROOT / path.lstrip("/")).resolve()
        if PROJECT_ROOT not in resolved.parents and resolved != PROJECT_ROOT:
            self.send_error(403)
            return
        if resolved.is_dir():
            resolved = resolved / "index.html"
        if not resolved.exists() or not resolved.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        data = resolved.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))


def run_server(port: int, host: str = "localhost"):
    ensure_question_bank()
    admin_token()
    environment = evaluation_environment_payload()
    display_host = "localhost" if host in {"0.0.0.0", "::"} else host
    print(f"Serving EMS question bank on http://{display_host}:{port}/web/")
    print(
        f"Evaluation environment: {environment.get('evaluation_env')} "
        f"(mode: {environment.get('evaluation_mode')}, "
        f"source: {environment.get('evaluation_source')}, "
        f"live decisions: {str(environment.get('live_evaluation')).lower()})"
    )
    print(f"Admin token stored at {ADMIN_TOKEN_FILE}")
    print(f"Runtime data stored at {DATA_ROOT}")
    server = ThreadingHTTPServer((host, port), RequestHandler)
    server.serve_forever()


def import_command(args):
    ensure_data_root()
    source_path = Path(args.source)
    if not source_path.is_absolute():
        source_path = PROJECT_ROOT / source_path
    result = import_questions_from_file(
        source_path,
        args.label or source_path.stem,
        activate=not args.paused,
        batch_id=args.batch_id,
        notes=args.notes,
        actor="cli",
    )
    print(json.dumps(result, indent=2))


def write_or_print_json(payload: dict, out_path: str) -> None:
    if out_path:
        path = Path(out_path)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        save_json(path, payload)
        print(str(path))
    else:
        try:
            print(json.dumps(payload, indent=2, sort_keys=True))
        except BrokenPipeError:
            pass


def export_lifecycle_command(args):
    write_or_print_json(lifecycle_registry_export(), args.out)


def export_llm_feedback_command(args):
    write_or_print_json(llm_feedback_export(), args.out)


def export_publication_command(args):
    write_or_print_json(publication_state_export(), args.out)


def export_concepts_command(args):
    write_or_print_json(concept_registry_summary(), args.out)


def set_state_command(args):
    ensure_data_root()
    if args.state not in VALID_POOL_STATES:
        raise ValueError(f"Invalid pool state: {args.state}")
    bank = load_json(QUESTION_BANK_FILE, {"questions": {}, "sources": []})
    question = bank.get("questions", {}).get(args.record_id)
    if not question:
        raise ValueError(f"Question not found: {args.record_id}")
    apply_question_state(question, args.state, args.reason or "cli_set_state", args.actor, {})
    bank["questions"][args.record_id] = question
    save_json(QUESTION_BANK_FILE, bank)
    print(json.dumps({"ok": True, "record_id": args.record_id, "pool_state": args.state}, indent=2))


def backfill_lifecycle_command(args):
    print(json.dumps(backfill_lifecycle_metadata(actor=args.actor), indent=2))


def protect_sandbox_command(args):
    print(json.dumps(protect_sandbox_decisions(actor=args.actor), indent=2))


def main():
    parser = argparse.ArgumentParser(description="EMS question-bank local server")
    subparsers = parser.add_subparsers(dest="command")

    serve_parser = subparsers.add_parser("serve", help="serve the web app and API")
    serve_parser.add_argument("--host", default=os.environ.get("HOST", "localhost"))
    serve_parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))

    import_parser = subparsers.add_parser("import", help="import a generated question JSON file")
    import_parser.add_argument("source")
    import_parser.add_argument("--label", default="")
    import_parser.add_argument("--paused", action="store_true")
    import_parser.add_argument("--batch-id", default="")
    import_parser.add_argument("--notes", default="")

    lifecycle_parser = subparsers.add_parser("export-lifecycle", help="export the lifecycle registry and audit log")
    lifecycle_parser.add_argument("--out", default="")

    feedback_parser = subparsers.add_parser("export-llm-feedback", help="export LLM-ready website feedback")
    feedback_parser.add_argument("--out", default="")

    publication_parser = subparsers.add_parser("export-publication", help="export de-identified publication analysis data")
    publication_parser.add_argument("--out", default="")

    concepts_parser = subparsers.add_parser("export-concepts", help="export concept-level website lifecycle registry")
    concepts_parser.add_argument("--out", default="")

    state_parser = subparsers.add_parser("set-state", help="set a question pool state with an audit-log entry")
    state_parser.add_argument("record_id")
    state_parser.add_argument("state", choices=sorted(VALID_POOL_STATES))
    state_parser.add_argument("--reason", default="")
    state_parser.add_argument("--actor", default="cli")

    backfill_parser = subparsers.add_parser("backfill-lifecycle", help="add baseline lifecycle metadata to existing question-bank records")
    backfill_parser.add_argument("--actor", default="cli")

    sandbox_parser = subparsers.add_parser("protect-sandbox-decisions", help="mark legacy local reviews as sandbox and reconcile local decisions")
    sandbox_parser.add_argument("--actor", default="cli")

    args = parser.parse_args()
    if args.command == "import":
        import_command(args)
    elif args.command == "export-lifecycle":
        export_lifecycle_command(args)
    elif args.command == "export-llm-feedback":
        export_llm_feedback_command(args)
    elif args.command == "export-publication":
        export_publication_command(args)
    elif args.command == "export-concepts":
        export_concepts_command(args)
    elif args.command == "set-state":
        set_state_command(args)
    elif args.command == "backfill-lifecycle":
        backfill_lifecycle_command(args)
    elif args.command == "protect-sandbox-decisions":
        protect_sandbox_command(args)
    else:
        run_server(getattr(args, "port", 8000), getattr(args, "host", "localhost"))


if __name__ == "__main__":
    main()
