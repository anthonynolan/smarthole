"""Card embeddings via the OpenAI API (same method as grimoire).

Each card stores its embedding vector on the document so cards can be
similarity-searched with a MongoDB Atlas vector index. This powers the
"related card" hint during review today and full-database chat later.
"""

import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
# text-embedding-3-small produces 1536 dimensions; the Atlas vector index
# must use the same number (see scripts/create_card_vector_index.py).
EMBEDDING_DIMS = 1536
INDEX_NAME = "card_embedding_index"


def embedding_model() -> str:
    """Model used for card embeddings (override with EMBEDDING_MODEL)."""
    return (os.getenv("EMBEDDING_MODEL") or DEFAULT_EMBEDDING_MODEL).strip()


def _get_client():
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    from openai import OpenAI

    return OpenAI(api_key=api_key)


def embed_text(text: str, *, model: str | None = None) -> tuple[list[float], str]:
    """Return (vector, model used) for a single string."""
    used_model = model or embedding_model()
    client = _get_client()
    resp = client.embeddings.create(input=text, model=used_model)
    return list(resp.data[0].embedding), used_model


def embed_texts(
    texts: list[str], *, model: str | None = None
) -> tuple[list[list[float]], str]:
    """Return (vectors, model used) for a batch of strings."""
    used_model = model or embedding_model()
    if not texts:
        return [], used_model
    client = _get_client()
    resp = client.embeddings.create(input=texts, model=used_model)
    return [list(d.embedding) for d in resp.data], used_model


def card_embedding_text(front_html: str, back_html: str) -> str:
    """Plain-text view of a card used as the embedding input."""
    from .apkg_import import html_to_text

    front = html_to_text(front_html or "")
    back = html_to_text(back_html or "")
    return f"{front}\n\n{back}".strip()


def refresh_card_embedding(card) -> bool:
    """(Re)compute and store a card's embedding; False when unavailable.

    Never raises: when the API key is missing or the call fails the card
    is left without an embedding (a backfill script can fill it in later).
    """
    try:
        text = card_embedding_text(card.front_html, card.back_html)
        if not text:
            return False
        vector, used_model = embed_text(text)
    except Exception as exc:
        logger.warning("embedding unavailable for card %s: %s", card.id, exc)
        return False
    card.update(
        set__embedding=vector,
        set__embedding_model=used_model,
    )
    return True


def similar_cards(
    collection,
    query_vector: list[float],
    *,
    exclude_id=None,
    deck_ids: list | None = None,
    limit: int = 3,
    min_score: float = 0.0,
    index: str = INDEX_NAME,
    num_candidates: int = 100,
) -> list[dict]:
    """Atlas $vectorSearch over the cards collection; raw rows with scores.

    Returns [{_id, front_html, deck, score}] ordered by descending score,
    filtered to score >= min_score. Raises when Atlas/a vector index is
    unavailable — callers decide how to degrade.
    """
    if not query_vector:
        return []
    over_fetch = max(limit, min(num_candidates, max(limit * 10, 50)))
    pipeline: list[dict] = [
        {
            "$vectorSearch": {
                "index": index,
                "queryVector": list(query_vector),
                "path": "embedding",
                "limit": over_fetch,
                "numCandidates": num_candidates,
            }
        },
        {"$match": {"deleted": {"$ne": True}, "suspended": False}},
        {"$limit": limit},
        {
            "$project": {
                "front_html": 1,
                "deck": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]
    match = pipeline[1]["$match"]
    if exclude_id is not None:
        match["_id"] = {"$ne": exclude_id}
    if deck_ids:
        match["deck"] = {"$in": list(deck_ids)}
    rows = list(collection.aggregate(pipeline))
    return [r for r in rows if (r.get("score") or 0) >= min_score]
