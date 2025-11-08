import os
from celery import Celery

# --- Broker & backend setup ---
BROKER_URL = os.getenv("CELERY_BROKER_URL", "redis://redis:6379/0")
RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", BROKER_URL)

# --- Celery app init ---
celery_app = Celery(
    "rag_eval",
    broker=BROKER_URL,
    backend=RESULT_BACKEND,
    include=[
        "rag_backend.single_turn_evaluation",
        "rag_backend.rag_evalation",
        "rag_backend.user_satisfaction_evaluation.user_satisfaction_evaluation"
    ],
)

# --- Celery config ---
celery_app.conf.update(
    task_default_queue="evalq",
    task_queues={
        "evalq": {"exchange": "evalq", "routing_key": "evalq"}
    },
    task_track_started=True,
)

# no autodiscover_tasks() needed — direct include is safer for non-Django setups
