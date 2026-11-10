"""FSRS scheduling wrapper around the ``fsrs`` (py-fsrs) package.

V1 uses the library's default parameters and retention verbatim: the installed
release carries 19 weights (FSRS-5 generation). The DSR model, power-law
forgetting curve, and 4-grade state machine all come from the spaced-repetition
research lineage; see README for the exact update rules the library applies.
"""

import os
from datetime import UTC, datetime, timedelta

from fsrs import Card, Rating, Scheduler

SCHEDULER = Scheduler(
    desired_retention=0.9,
    learning_steps=[timedelta(minutes=1), timedelta(minutes=10)],
    relearning_steps=[timedelta(minutes=10)],
    maximum_interval=36500,
    enable_fuzzing=True,
)

LEARNING = 1
REVIEW = 2
RELEARNING = 3

# New cards introduced per UTC day, mirroring Anki's daily new-card limit.
NEW_CARDS_PER_DAY = int(os.getenv("NEW_CARDS_PER_DAY", "20"))

VALID_RATINGS = (Rating.Again, Rating.Hard, Rating.Good, Rating.Easy)


def ensure_aware(value: datetime | None) -> datetime | None:
    """Mongo returns naive UTC datetimes; the app works timezone-aware."""
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def fresh_state(now: datetime | None = None) -> dict:
    """Initial CardState fields for a newly imported card (due immediately)."""
    moment = ensure_aware(now) or datetime.now(UTC)
    card = Card()
    card.due = moment
    return _dump(card)


def state_from_anki(anki: dict, now: datetime | None = None) -> dict:
    """Carry Anki scheduling into FSRS state.

    Approximations (FSRS self-corrects on the next reviews): interval stands
    in for stability (both target ~90% recall) and ease factor maps linearly
    to difficulty. Review due dates reuse Anki's own day numbers anchored on
    the source collection creation time, falling back to last review plus
    interval when that anchor is missing.
    """
    from .apkg_import import BURIED_QUEUES

    moment = ensure_aware(now) or datetime.now(UTC)
    atype = anki.get("type", 0)
    queue = anki.get("queue", 0)
    ivl = anki.get("ivl", 0) or 0
    factor = anki.get("factor", 0) or 2500
    reps = anki.get("reps", 0) or 0
    lapses = anki.get("lapses", 0) or 0
    last_rev = ensure_aware(anki.get("last_rev"))
    crt = anki.get("crt", 0) or 0
    due_day = anki.get("due")
    if due_day is None:
        due_day = 0
    difficulty = _difficulty_from_factor(factor)

    if atype == 2 and ivl > 0:
        stability = max(float(ivl), 0.1)
        if crt and anki.get("due") is not None:
            due = datetime.fromtimestamp(crt + due_day * 86400, tz=UTC)
        elif last_rev is not None:
            due = last_rev + timedelta(days=ivl)
        else:
            due = moment
        state, last_review = REVIEW, last_rev
    elif atype == 1:
        raw_due = anki.get("due", 0) or 0
        if raw_due > 1_000_000_000:
            due = datetime.fromtimestamp(raw_due, tz=UTC)
        elif last_rev is not None:
            due = last_rev + timedelta(days=max(raw_due, 0))
        else:
            due = moment
        stability = 0.5
        state, last_review = (RELEARNING if lapses > 0 else LEARNING), last_rev
    else:
        fields = fresh_state(moment)
        fields["reps"] = reps
        fields["lapses"] = lapses
        return fields

    if queue in BURIED_QUEUES and due <= moment:
        # Buried hides until the next day; don't strand the card forever.
        due = moment + timedelta(days=1)
    return {
        "fsrs_card_id": Card().to_dict()["card_id"],
        "state": state,
        "step": 0,
        "stability": stability,
        "difficulty": difficulty,
        "due": due,
        "last_review": last_review,
        "reps": reps,
        "lapses": lapses,
    }


def _difficulty_from_factor(factor: int) -> float:
    # Anki ease ~1300 (hardest) to ~3000+ (easiest); FSRS difficulty 1..10.
    return min(10.0, max(1.0, 10.0 - (float(factor) - 1300.0) / 250.0))


def apply_rating(state: dict, rating_value: int, now: datetime | None = None) -> dict:
    """Grade a card Again(1)/Hard(2)/Good(3)/Easy(4); return updated fields.

    One wave of due cards per day: intraday learning/relearning steps
    (minutes) are clamped to the start of the next UTC day, so a card
    graded today never comes due again until tomorrow.
    """
    moment = ensure_aware(now) or datetime.now(UTC)
    rating = Rating(rating_value)
    card = _load(state)
    reviewed, _log = SCHEDULER.review_card(card, rating, moment)
    fields = _dump(reviewed)
    fields["reps"] = state.get("reps", 0) + 1
    fields["lapses"] = state.get("lapses", 0) + (1 if rating is Rating.Again else 0)
    tomorrow = moment.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(
        days=1
    )
    if fields["due"] is not None and ensure_aware(fields["due"]) < tomorrow:
        fields["due"] = tomorrow
    return fields


def _as_datetime(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return ensure_aware(value)
    return ensure_aware(datetime.fromisoformat(value))


def _dump(card: Card) -> dict:
    data = card.to_dict()
    return {
        "fsrs_card_id": data["card_id"],
        "state": int(data["state"]),
        "step": data["step"] or 0,
        "stability": data["stability"],
        "difficulty": data["difficulty"],
        "due": _as_datetime(data["due"]),
        "last_review": _as_datetime(data["last_review"]),
    }


def _as_iso(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _load(state: dict) -> Card:
    return Card.from_dict(
        {
            "card_id": state["fsrs_card_id"],
            "state": state["state"],
            "step": state.get("step", 0),
            "stability": state.get("stability"),
            "difficulty": state.get("difficulty"),
            "due": _as_iso(ensure_aware(state["due"])),
            "last_review": _as_iso(ensure_aware(state.get("last_review"))),
        }
    )
