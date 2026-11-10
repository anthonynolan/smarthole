#!/usr/bin/env python3
"""Create the Atlas vector index for card similarity search. Run once per database:

    uv run scripts/create_card_vector_index.py [--db smarthole_prod]

Same method as grimoire's create_memory_index.py: a cosine vectorSearch
index named 'card_embedding_index' on the cards' `embedding` path
(1536 dimensions for text-embedding-3-small). Creating the index via this
script needs MONGO_PWD in the environment (or .env); Atlas UI works too.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "src"))

from smarthole import embeddings, mongo_connection  # noqa: E402


def main() -> int:
    load_dotenv(REPO_ROOT / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=None, help="database (default from ENV/MONGO_DB_NAME)")
    args = parser.parse_args()

    if not (os.getenv("MONGO_PWD") or "").strip():
        print("MONGO_PWD is not set.")
        return 2

    from pymongo import MongoClient
    from pymongo.operations import SearchIndexModel

    db_name = args.db or mongo_connection._get_db_name()
    client = MongoClient(mongo_connection.get_mongo_uri(db_name))
    collection = client[db_name]["cards"]
    print(json.dumps({"database": db_name, "collection": collection.name}))

    definition = {
        "fields": [
            {
                "type": "vector",
                "path": "embedding",
                "numDimensions": embeddings.EMBEDDING_DIMS,
                "similarity": "cosine",
            }
        ]
    }

    if not hasattr(collection, "list_search_indexes"):
        print("Collection does not support list_search_indexes().")
        return 3
    for idx in collection.list_search_indexes():
        if idx.get("name") == embeddings.INDEX_NAME:
            print(f"{embeddings.INDEX_NAME} already exists:")
            print(json.dumps(idx, default=str, indent=2))
            return 0

    if not hasattr(collection, "create_search_index"):
        print("Collection does not support create_search_index().")
        return 4
    name = collection.create_search_index(
        SearchIndexModel(
            definition=definition,
            name=embeddings.INDEX_NAME,
            type="vectorSearch",
        )
    )
    print(f"Created search index: {name}")
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
