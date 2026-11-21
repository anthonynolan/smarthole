"""Study streaks, daily goals, and evening email reminders.

Streaks count consecutive UTC days with at least one graded review, ending
today (or yesterday when today is still unstudied — the streak is alive).
Reminders go out via SMTP (see .env.example); run
``scripts/send_study_reminders.py`` from an evening cron job.
"""

import logging
import os
import smtplib
from datetime import datetime, timedelta
from email.message import EmailMessage

logger = logging.getLogger(__name__)


def review_days(user, since) -> set:
    """UTC dates on which the user graded at least one review since ``since``."""
    from . import fsrs_service
    from .models import Review

    return {
        fsrs_service.ensure_aware(reviewed_at).date()
        for reviewed_at in Review.objects(
            user=user, reviewed_at__gte=since
        ).values_list("reviewed_at")
        if reviewed_at is not None
    }


def compute_streak(days: set, today) -> int:
    """Consecutive-day streak ending today (or yesterday, if alive)."""
    start = today if today in days else today - timedelta(days=1)
    streak = 0
    cursor = start
    while cursor in days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def streak_for_user(user, now: datetime, today_start: datetime) -> int:
    """The user's current streak (looks back up to 5 years)."""
    return compute_streak(
        review_days(user, now - timedelta(days=5 * 365)), today_start.date()
    )


def due_count(user, now: datetime) -> int:
    """Cards currently due for review (same definition as the review queue)."""
    from .models import Card, CardState, Deck

    deck_ids = [d.id for d in Deck.objects(owner=user)]
    if not deck_ids:
        return 0
    ids = [
        c.id
        for c in Card.objects(
            deck__in=deck_ids, suspended=False, deleted__ne=True
        ).only("id")
    ]
    if not ids:
        return 0
    return CardState.objects(
        user=user, card__in=ids, reps__gt=0, due__lte=now
    ).count()


def users_needing_reminder(now: datetime, today_start: datetime) -> list[dict]:
    """Opted-in users with no graded review today, with streak + due count."""
    from .models import Review, User

    out = []
    for user in User.objects(reminder_enabled=True):
        if Review.objects(user=user, reviewed_at__gte=today_start).count() > 0:
            continue
        streak = streak_for_user(user, now, today_start)
        out.append({"user": user, "streak": streak, "due": due_count(user, now)})
    return out


def build_reminder_email(to_email: str, streak: int, due: int) -> EmailMessage:
    """The evening nudge; streak-at-risk is the hook when one is alive."""
    subject = (
        f"Study reminder — your {streak}-day streak is at stake"
        if streak > 0
        else "Study reminder — time for your daily reviews"
    )
    lines = [
        "You haven't studied today.",
        f"Cards due right now: {due}.",
        (
            f"Your {streak}-day streak ends tonight unless you review."
            if streak > 0
            else "Review today to start a streak."
        ),
        "",
        "— smarthole",
    ]
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.getenv("SMTP_FROM", "smarthole@localhost")
    msg["To"] = to_email
    msg.set_content("\n".join(lines))
    return msg


def send_email(msg: EmailMessage) -> None:
    """Deliver via SMTP (SMTP_HOST/PORT/USER/PASS/FROM); raises when unset."""
    host = (os.getenv("SMTP_HOST") or "").strip()
    if not host:
        raise RuntimeError("SMTP_HOST is not set")
    port = int(os.getenv("SMTP_PORT", "587"))
    username = (os.getenv("SMTP_USER") or "").strip()
    password = os.getenv("SMTP_PASS") or ""
    with smtplib.SMTP(host, port, timeout=30) as smtp:
        smtp.starttls()
        if username:
            smtp.login(username, password)
        smtp.send_message(msg)
    logger.info("Sent study reminder to %s", msg["To"])
