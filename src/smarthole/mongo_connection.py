"""MongoDB Atlas connection, mirroring the grimoire-service pattern.

Same cluster, separate database. Credentials come from the environment:

- ``MONGO_PWD``: Atlas password for ``myAtlasDBUser`` (required, never committed)
- ``MONGO_DB_NAME``: explicit database override
- ``ENV=prod``: selects ``smarthole_prod`` when no override is set

Default database is ``smarthole_dev`` so local runs never touch production.
"""

import logging
import os
from threading import Lock
from urllib.parse import quote_plus

from mongoengine import connect, disconnect

logger = logging.getLogger(__name__)

CLUSTER_HOST = "grimoire-mongo-cluster.5gmhjuk.mongodb.net"
CLUSTER_USER = "myAtlasDBUser"
APP_NAME = "grimoire-mongo-cluster"

DEV_DB = "smarthole_dev"
PROD_DB = "smarthole_prod"

ADMIN_DATABASES = frozenset({DEV_DB, PROD_DB})

_connection_lock = Lock()


def _get_db_name() -> str:
    override = (os.getenv("MONGO_DB_NAME") or "").strip()
    if override:
        return override
    env = (os.getenv("ENV") or "dev").strip().lower()
    return PROD_DB if env == "prod" else DEV_DB


def get_mongo_uri(db_name: str | None = None) -> str:
    """Build the Atlas connection URI for the selected database."""
    mongo_pwd = quote_plus(os.getenv("MONGO_PWD") or "")
    selected = db_name or _get_db_name()
    return (
        f"mongodb+srv://{CLUSTER_USER}:{mongo_pwd}"
        f"@{CLUSTER_HOST}/{selected}"
        f"?retryWrites=true&w=majority&appName={APP_NAME}"
    )


def connect_database(db_name: str) -> None:
    with _connection_lock:
        try:
            disconnect(alias="default")
        except Exception:
            logger.debug("No existing default Mongo connection to disconnect")
        connect(
            db=db_name,
            host=get_mongo_uri(db_name),
            alias="default",
            uuidrepresentation="pythonLegacy",
        )
    logger.info("Connected to Mongo database '%s'", db_name)


def init() -> None:
    if os.getenv("TESTING"):
        logger.info("Mongo connection disabled for testing")
        return
    db_name = _get_db_name()
    logger.info("Connecting to Mongo database '%s'", db_name)
    connect_database(db_name)
