"""FSRS scheduling wrapper around the ``fsrs`` (py-fsrs) package.

V1 uses the library's default parameters and retention verbatim: the installed
release carries 19 weights (FSRS-5 generation). The DSR model, power-law
forgetting curve, and 4-grade state machine all come from the spaced-repetition
research lineage; see README for the exact update rules the library applies.

Per-user tuned weights (POST /api/fsrs/optimize) are stored in
``SchedulerConfig`` and used wherever that user reviews. Tuning is a small
coordinate descent on the log-loss of the user's own review history — no
torch needed — and rescheduling replays each card's history through the
tuned scheduler via the library's own ``reschedule_card``.
"""

import math
import os
from datetime import UTC, datetime, timedelta

from fsrs import Card, Rating, Scheduler
from fsrs.scheduler import (
    DEFAULT_PARAMETERS,
    LOWER_BOUNDS_PARAMETERS,
    UPPER_BOUNDS_PARAMETERS,
)

# Coordinate descent needs enough predictable reviews (every review after
# each card's first, which has nothing to predict from) to beat noise.
MIN_TUNE_REVIEWS = 50

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

# Learning/relearning steps in minutes (defaults mirror the Scheduler).
DEFAULT_LEARNING_STEPS = [1, 10]
DEFAULT_RELEARNING_STEPS = [10]
MAX_STEP_MINUTES = 1440


def _steps_to_timedeltas(minutes: list[int]) -> list[timedelta]:
    return [timedelta(minutes=m) for m in minutes]


def validate_steps(values, name: str) -> list[int]:
    """Validate learning/relearning steps (minutes); raise ValueError."""
    if not isinstance(values, list) or not 1 <= len(values) <= 8:
        raise ValueError(f"{name} must be a list of 1-8 minute values")
    cleaned = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{name} must be whole minutes")
        if not 1 <= value <= MAX_STEP_MINUTES:
            raise ValueError(f"{name} entries must be 1-{MAX_STEP_MINUTES} minutes")
        cleaned.append(value)
    return cleaned

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


def apply_rating(
    state: dict,
    rating_value: int,
    now: datetime | None = None,
    scheduler: Scheduler | None = None,
) -> dict:
    """Grade a card Again(1)/Hard(2)/Good(3)/Easy(4); return updated fields.

    Intraday learning/relearning steps (minutes) keep their FSRS due times,
    so a card graded today can come due again later the same day and each
    grade previews a distinct next-due period. Uses the given scheduler
    (tuned weights) or the library-default one.
    """
    moment = ensure_aware(now) or datetime.now(UTC)
    rating = Rating(rating_value)
    card = _load(state)
    reviewed, _log = (scheduler or SCHEDULER).review_card(card, rating, moment)
    fields = _dump(reviewed)
    fields["reps"] = state.get("reps", 0) + 1
    fields["lapses"] = state.get("lapses", 0) + (1 if rating is Rating.Again else 0)
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


def tuned_scheduler(
    parameters: list[float],
    learning_minutes: list[int] | None = None,
    relearning_minutes: list[int] | None = None,
) -> Scheduler:
    """A Scheduler with custom weights and steps (same retention as default)."""
    return Scheduler(
        parameters=list(parameters),
        desired_retention=0.9,
        learning_steps=_steps_to_timedeltas(
            learning_minutes if learning_minutes is not None
            else DEFAULT_LEARNING_STEPS
        ),
        relearning_steps=_steps_to_timedeltas(
            relearning_minutes if relearning_minutes is not None
            else DEFAULT_RELEARNING_STEPS
        ),
        maximum_interval=36500,
        enable_fuzzing=True,
    )


def get_parameters(user) -> list[float] | None:
    """The user's tuned weights, or None for library defaults."""
    from .models import SchedulerConfig

    config = SchedulerConfig.objects(user=user).first()
    return list(config.parameters) if config is not None else None


def get_scheduler(user=None) -> Scheduler:
    """The user's tuned scheduler, or the library-default one."""
    if user is not None:
        from .models import SchedulerConfig

        config = SchedulerConfig.objects(user=user).first()
        if config is not None:
            return tuned_scheduler(
                list(config.parameters or DEFAULT_PARAMETERS),
                list(config.learning_steps or DEFAULT_LEARNING_STEPS),
                list(config.relearning_steps or DEFAULT_RELEARNING_STEPS),
            )
    return SCHEDULER


def get_scheduler_steps(user) -> dict:
    """The user's learning/relearning steps in minutes."""
    from .models import SchedulerConfig

    config = SchedulerConfig.objects(user=user).first()
    if config is None:
        return {
            "learning_steps": list(DEFAULT_LEARNING_STEPS),
            "relearning_steps": list(DEFAULT_RELEARNING_STEPS),
            "custom": False,
        }
    return {
        "learning_steps": list(config.learning_steps or DEFAULT_LEARNING_STEPS),
        "relearning_steps": list(config.relearning_steps or DEFAULT_RELEARNING_STEPS),
        "custom": True,
    }


def set_scheduler_steps(
    user, learning_minutes: list[int], relearning_minutes: list[int]
) -> dict:
    """Store learning/relearning steps (minutes); keep tuned weights."""
    from .models import SchedulerConfig

    learning = validate_steps(learning_minutes, "learning_steps")
    relearning = validate_steps(relearning_minutes, "relearning_steps")
    config = SchedulerConfig.objects(user=user).first()
    if config is None:
        config = SchedulerConfig(
            user=user, parameters=list(get_parameters(user) or DEFAULT_PARAMETERS)
        )
    config.learning_steps = learning
    config.relearning_steps = relearning
    config.updated_at = datetime.now(UTC)
    config.save()
    return {"learning_steps": learning, "relearning_steps": relearning}


def set_parameters(user, parameters: list[float]):
    """Store tuned weights after the library validates them."""
    from .models import SchedulerConfig

    Scheduler(
        parameters=list(parameters),
        desired_retention=0.9,
        learning_steps=[timedelta(minutes=1), timedelta(minutes=10)],
        relearning_steps=[timedelta(minutes=10)],
        maximum_interval=36500,
        enable_fuzzing=True,
    )
    config = SchedulerConfig.objects(user=user).first()
    if config is None:
        config = SchedulerConfig(user=user)
    config.parameters = list(parameters)
    config.updated_at = datetime.now(UTC)
    config.save()
    return config


def reset_parameters(user) -> None:
    """Forget tuned weights; the user returns to library defaults."""
    from .models import SchedulerConfig

    SchedulerConfig.objects(user=user).delete()


def review_sequences(user) -> list[list[tuple[int, datetime]]]:
    """Per-card (rating, reviewed_at) histories, oldest first, len >= 2."""
    from .models import Review

    by_card: dict = {}
    for review in Review.objects(user=user).order_by("reviewed_at"):
        if review.reviewed_at is None:
            continue
        by_card.setdefault(review.card.id, []).append(
            (review.rating, ensure_aware(review.reviewed_at))
        )
    return [seq for seq in by_card.values() if len(seq) >= 2]


def log_loss(parameters: list[float], sequences) -> float:
    """Mean binary log-loss of predicted recall over review sequences.

    Each review after a card's first is predicted from the stability the
    candidate weights give it at that point; Again counts as forgotten.
    """
    scheduler = tuned_scheduler(parameters)
    scheduler.enable_fuzzing = False
    total, count = 0.0, 0
    for seq in sequences:
        card = Card()
        for index, (rating_value, when) in enumerate(seq):
            if index > 0:
                predicted = scheduler.get_card_retrievability(card, when)
                predicted = min(1.0 - 1e-6, max(1e-6, predicted))
                actual = 1.0 if rating_value > 1 else 0.0
                total += -(
                    actual * math.log(predicted)
                    + (1.0 - actual) * math.log(1.0 - predicted)
                )
                count += 1
            card, _ = scheduler.review_card(card, Rating(rating_value), when)
    return total / count if count else float("inf")


def predictable_review_count(sequences) -> int:
    """Reviews that carry a prediction (all but each card's first)."""
    return sum(max(0, len(seq) - 1) for seq in sequences)


def optimize_parameters(
    user, sequences=None, max_passes: int = 3, step: float = 0.1
) -> dict:
    """Coordinate descent on log-loss; stores and returns the result."""
    sequences = review_sequences(user) if sequences is None else sequences
    usable = predictable_review_count(sequences)
    if usable < MIN_TUNE_REVIEWS:
        raise ValueError(
            f"Need at least {MIN_TUNE_REVIEWS} graded reviews to tune "
            f"(have {usable})"
        )
    current = list(get_parameters(user) or DEFAULT_PARAMETERS)
    best = log_loss(current, sequences)
    before = best
    for _ in range(max_passes):
        improved = False
        for i in range(len(current)):
            low, high = LOWER_BOUNDS_PARAMETERS[i], UPPER_BOUNDS_PARAMETERS[i]
            for factor in (1.0 + step, 1.0 - step):
                candidate = min(high, max(low, current[i] * factor))
                if candidate == current[i]:
                    continue
                trial = current.copy()
                trial[i] = candidate
                try:
                    loss = log_loss(trial, sequences)
                except Exception:
                    continue
                if loss < best - 1e-12:
                    best, current = loss, trial
                    improved = True
        if not improved:
            break
    config = set_parameters(user, current)
    config.update(
        set__reviews_used=usable,
        set__log_loss_before=before,
        set__log_loss_after=best,
    )
    config.reload()
    return {
        "parameters": current,
        "log_loss_before": before,
        "log_loss_after": best,
        "reviews_used": usable,
    }


def reschedule_fields(
    state: dict, reviews: list[tuple[int, datetime]], scheduler: Scheduler
) -> dict:
    """Replay one card's history through ``scheduler``; return fresh fields.

    Keeps reps/lapses/introduced_at/new_position (handled by the caller);
    stability, difficulty, due, and state come from the replay.
    """
    from fsrs.review_log import ReviewLog

    logs = [
        ReviewLog(
            card_id=state["fsrs_card_id"],
            rating=Rating(rating_value),
            review_datetime=ensure_aware(when),
            review_duration=None,
        )
        for rating_value, when in reviews
    ]
    return _dump(scheduler.reschedule_card(_load(state), logs))
