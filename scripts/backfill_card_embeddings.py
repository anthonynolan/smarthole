#!/usr/bin/env python3
"""Backfill card embeddings for similarity search. Run after creating the
vector index (scripts/create_card_vector_index.py):

    uv run scripts/backfill_card_embeddings.py [--db smarthole_prod] [--batch 100] [--limit 0]

Only cards with an empty embedding are processed, in batches via one
embeddings API call per batch. Needs OPENAI_API_KEY and MONGO_PWD
(.env is loaded). Imports skip embedding (too slow/costly inline), so run
this after a big import too. Re-run any time; it only fills gaps.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "src"))


def main() -> int:
    load_dotenv(REPO_ROOT / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=None)
    parser.add_argument("--batch", type=int, default=100)
    parser.add_argument("--limit", type=int, default=0, help="max cards (0 = all)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    from smarthole import embeddings, mongo_connection
    from smarthole.models import Card

    db_name = args.db or mongo_connection._get_db_name()
    mongo_connection.connect_database(db_name)

    missing = Card.objects(
        __raw__={
            "$or": [
                {"embedding": []},
                {"embedding": None},
                {"embedding": {"$exists": False}},
            ]
        }
    )
    ids = [c.id for c in missing.only("id")]
    if args.limit:
        ids = ids[: args.limit]
    print(f"{len(ids)} card(s) without embeddings in {db_name}")
    if args.dry_run or not ids:
        return 0

    done = 0
    for i in range(0, len(ids), args.batch):
        chunk_ids = ids[i : i + args.batch]
        cards = {c.id: c for c in Card.objects(id__in=chunk_ids)}
        texts = [embeddings.card_embedding_text(c.front_html, c.back_html) for c in cards.values()]
        vectors, used_model = embeddings.embed_texts(texts)
        for card, vector in zip(cards.values(), vectors):
            card.update(set__embedding=vector, set__embedding_model=used_model)
        done += len(chunk_ids)
        print(f"embedded {done}/{len(ids)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
