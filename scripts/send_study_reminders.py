#!/usr/bin/env python3
"""Email evening study reminders to opted-in users who have not studied today.

Needs SMTP_HOST (SMTP_PORT/USER/PASS/FROM optional) plus MONGO_PWD.
Run from an evening cron job against the production database, e.g.:

    0 20 * * * cd /opt/smarthole && ENV=prod ./.venv/bin/python \\
        scripts/send_study_reminders.py >> logs/reminders.log 2>&1

With --dry-run, prints who would be emailed without sending anything.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "src"))


def main() -> int:
    load_dotenv(REPO_ROOT / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    from smarthole import mongo_connection, reminders

    db_name = args.db or mongo_connection._get_db_name()
    mongo_connection.connect_database(db_name)

    now = datetime.now(UTC)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    pending = reminders.users_needing_reminder(now, today_start)
    if not pending:
        print("No reminders to send.")
        return 0
    sent = 0
    for entry in pending:
        user = entry["user"]
        msg = reminders.build_reminder_email(user.email, entry["streak"], entry["due"])
        if args.dry_run:
            print(f"[dry-run] would email {user.email}: {msg['Subject']}")
            continue
        try:
            reminders.send_email(msg)
        except Exception as exc:  # noqa: BLE001 — keep going for other users
            print(f"Failed to email {user.email}: {exc}")
            continue
        sent += 1
    print(f"Sent {sent} reminder(s) to {len(pending)} user(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
