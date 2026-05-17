import os
import sys
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from loguru import logger

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../config/.env"))
if not os.path.exists(os.path.join(os.path.dirname(__file__), "../../config/.env")):
    load_dotenv()

_engine = None


def get_engine():
    global _engine
    if _engine is not None:
        return _engine

    url = os.getenv("DATABASE_URL")
    if not url:
        logger.error("DATABASE_URL not set. Copy config/.env.example to config/.env and fill in values.")
        sys.exit(1)

    try:
        _engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 10})
        with _engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        logger.success("Connected to database")
        return _engine
    except OperationalError as e:
        logger.error(f"Database connection failed: {e}")
        sys.exit(1)


def get_connection():
    return get_engine().connect()
