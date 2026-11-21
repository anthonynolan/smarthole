"""MongoEngine documents for smarthole.

Content (decks/cards) is shared; scheduling state is per (user, card) so one
imported collection can serve many logins. Anki ids are kept for idempotent
re-imports but scheduling always starts fresh under FSRS.
"""

from datetime import UTC, datetime

from mongoengine import (
    BinaryField,
    BooleanField,
    DateTimeField,
    Document,
    FloatField,
    IntField,
    ListField,
    ReferenceField,
    StringField,
)


def utcnow() -> datetime:
    return datetime.now(UTC)


def next_card_number() -> int:
    """Next persistent browse number (global, never reused)."""
    try:
        coll = Card._get_collection()
        row = coll.find_one(
            {"card_number": {"$ne": None}}, sort=[("card_number", -1)]
        )
        if row and row.get("card_number"):
            return int(row["card_number"]) + 1
    except Exception:
        pass
    return 1


def ensure_card_number(card: "Card") -> int:
    """Assign a persistent number if missing; return the card's number."""
    try:
        if getattr(card, "card_number", None):
            return int(card.card_number)
    except Exception:
        pass
    number = next_card_number()
    try:
        card.update(set__card_number=number)
        card.reload()
    except Exception:
        pass
    return number


class User(Document):
    meta = {"collection": "users", "indexes": ["email"]}

    email = StringField(required=True, unique=True)
    pw_hash = StringField()  # None for Google-only accounts
    name = StringField()
    picture = StringField()
    google_sub = StringField()
    created_at = DateTimeField(default=utcnow)
    daily_goal = IntField(default=20, min_value=1, max_value=1000)
    reminder_enabled = BooleanField(default=False)


class Session(Document):
    meta = {
        "collection": "sessions",
        "indexes": [{"fields": ["expires_at"], "expireAfterSeconds": 0}],
    }

    session_id = StringField(required=True, primary_key=True)
    user = ReferenceField(User, required=True)
    expires_at = DateTimeField(required=True)


class Deck(Document):
    meta = {"collection": "decks", "indexes": ["owner", "name"]}

    owner = ReferenceField(User, required=True)
    name = StringField(required=True)
    source_apkg = StringField()
    created_at = DateTimeField(default=utcnow)
    # Per-deck new-card budget (None = global NEW_CARDS_PER_DAY default).
    new_cards_per_day = IntField()
    # New-card gather order: Anki position order, or newest-created first.
    new_order = StringField(default="position")


class Card(Document):
    meta = {
        "collection": "cards",
        "indexes": [
            "deck",
            "anki_guid",
            ("deck", "anki_nid", "anki_ord"),
            # Browse filter (deck + logical-delete flag).
            ("deck", "deleted"),
            # Browse filter for MCP-created cards.
            ("deck", "created_via_mcp"),
            # Browse filter for tags.
            ("deck", "tags"),
        ],
    }

    deck = ReferenceField(Deck, required=True)
    # Persistent browse number, assigned once when the card is written.
    card_number = IntField()
    front_html = StringField(required=True)
    back_html = StringField(required=True)
    anki_nid = IntField()
    anki_ord = IntField()
    anki_guid = StringField()
    tags = ListField(StringField(), default=list)
    suspended = BooleanField(default=False)
    new_position = IntField(default=0)  # Anki new-queue order
    created_at = DateTimeField(default=utcnow)
    deleted = BooleanField(default=False)  # logical delete; hard delete purges
    deleted_at = DateTimeField()
    created_via_mcp = BooleanField(default=False)  # True for MCP-created cards
    # OpenAI embedding for similarity search (Atlas vector index
    # 'card_embedding_index' on this path; also the basis for DB chat).
    embedding = ListField(FloatField(), default=list)
    embedding_model = StringField()


class CardState(Document):
    """Per-user FSRS scheduling state for one card."""

    meta = {
        "collection": "card_states",
        "indexes": [
            "user",
            "due",
            {"fields": ("user", "card"), "unique": True},
            # Browse/deck-count filters sort and page by these fields per user.
            ("user", "due"),
            ("user", "last_review"),
        ],
    }

    user = ReferenceField(User, required=True)
    card = ReferenceField(Card, required=True)
    fsrs_card_id = IntField(required=True)
    state = IntField(
        required=True
    )  # fsrs State value: 1 Learning, 2 Review, 3 Relearning
    step = IntField(default=0)
    stability = FloatField()
    difficulty = FloatField()
    due = DateTimeField(required=True)
    last_review = DateTimeField()
    reps = IntField(default=0)
    lapses = IntField(default=0)
    introduced_at = DateTimeField()  # first grading; drives the new-card budget
    new_position = IntField(default=0)  # Anki new-order, for DB-side sorting


class Feedback(Document):
    """User feedback about the app (status starts at "submitted")."""

    meta = {"collection": "feedback", "indexes": ["user", "status", "created_at"]}

    user = ReferenceField(User, required=True)
    email = StringField(required=True)  # snapshot for admin filtering
    username = StringField()  # User.name snapshot, may be empty
    text = StringField(required=True)
    screen = StringField()  # where the feedback was given, if known
    status = StringField(required=True, default="submitted")
    created_at = DateTimeField(default=utcnow)


class Review(Document):
    meta = {"collection": "reviews", "indexes": ["user", "card", "reviewed_at"]}

    user = ReferenceField(User, required=True)
    card = ReferenceField(Card, required=True)
    rating = IntField(required=True, min_value=1, max_value=4)
    reviewed_at = DateTimeField(default=utcnow)
    next_due = DateTimeField(required=True)
    stability = FloatField()
    difficulty = FloatField()


class SchedulerConfig(Document):
    """Per-user FSRS weights tuned on that user's review history.

    Absent means the library defaults (see fsrs_service.DEFAULT_PARAMETERS).
    """

    meta = {"collection": "scheduler_configs", "indexes": ["user"]}

    user = ReferenceField(User, required=True, unique=True)
    parameters = ListField(FloatField(), required=True)
    reviews_used = IntField(default=0)
    log_loss_before = FloatField()
    log_loss_after = FloatField()
    updated_at = DateTimeField(default=utcnow)
    # Learning/relearning steps in minutes (defaults mirror the Scheduler).
    learning_steps = ListField(IntField(), default=[1, 10])
    relearning_steps = ListField(IntField(), default=[10])


class Media(Document):
    """Imported APKG media, content-addressed by sha256 hex."""

    meta = {"collection": "media", "indexes": ["sha256"]}

    sha256 = StringField(required=True, unique=True)
    filename = StringField(required=True)
    content_type = StringField(required=True, default="application/octet-stream")
    data = BinaryField(required=True)
