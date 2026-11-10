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


class User(Document):
    meta = {"collection": "users", "indexes": ["email"]}

    email = StringField(required=True, unique=True)
    pw_hash = StringField()  # None for Google-only accounts
    name = StringField()
    picture = StringField()
    google_sub = StringField()
    created_at = DateTimeField(default=utcnow)


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


class Card(Document):
    meta = {
        "collection": "cards",
        "indexes": ["deck", "anki_guid", ("deck", "anki_nid", "anki_ord")],
    }

    deck = ReferenceField(Deck, required=True)
    front_html = StringField(required=True)
    back_html = StringField(required=True)
    anki_nid = IntField()
    anki_ord = IntField()
    anki_guid = StringField()
    suspended = BooleanField(default=False)
    new_position = IntField(default=0)  # Anki new-queue order
    created_at = DateTimeField(default=utcnow)
    deleted = BooleanField(default=False)  # logical delete; hard delete purges
    deleted_at = DateTimeField()
    # OpenAI embedding for similarity search (Atlas vector index
    # 'card_embedding_index' on this path; also the basis for DB chat).
    embedding = ListField(FloatField(), default=list)
    embedding_model = StringField()


class CardState(Document):
    """Per-user FSRS scheduling state for one card."""

    meta = {
        "collection": "card_states",
        "indexes": ["user", "due", {"fields": ("user", "card"), "unique": True}],
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


class Review(Document):
    meta = {"collection": "reviews", "indexes": ["user", "card", "reviewed_at"]}

    user = ReferenceField(User, required=True)
    card = ReferenceField(Card, required=True)
    rating = IntField(required=True, min_value=1, max_value=4)
    reviewed_at = DateTimeField(default=utcnow)
    next_due = DateTimeField(required=True)
    stability = FloatField()
    difficulty = FloatField()


class Media(Document):
    """Imported APKG media, content-addressed by sha256 hex."""

    meta = {"collection": "media", "indexes": ["sha256"]}

    sha256 = StringField(required=True, unique=True)
    filename = StringField(required=True)
    content_type = StringField(required=True, default="application/octet-stream")
    data = BinaryField(required=True)
