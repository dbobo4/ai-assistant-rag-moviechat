import os
import uuid
import logging
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, HTTPException, Request
from celery.result import AsyncResult
from openai import OpenAI

from celery_app import celery_app

router = APIRouter()
log = logging.getLogger("rag.eval.rag_level")

OPENAI_MODEL = os.getenv("DATASET_MODEL") or os.getenv("OPENAI_DATASET_MODEL") or "gpt-4o-mini"
SAMPLES_ENDPOINT = os.getenv("RAG_LEVEL_SAMPLES_ENDPOINT", "http://app:3000/api/rag_level/samples")
RETRIEVER_ENDPOINT = os.getenv("RAG_LEVEL_RETRIEVER_ENDPOINT", "http://app:3000/api/rag_level/retriever")
DEFAULT_LIMIT = int(os.getenv("RAG_LEVEL_SAMPLE_CHUNKS", "20"))
DEFAULT_TOPK = int(os.getenv("RAG_LEVEL_TOP_K", "5"))
HTTP_TIMEOUT = int(os.getenv("RAG_LEVEL_HTTP_TIMEOUT", "60"))

QUERY_PROMPT = """You are helping to evaluate a retriever. Given the document text below, produce ONE natural user query that can be answered by it.
Return ONLY the query text (no preface or postface). Keep it to one sentence.

Document:
{document}

Query:
"""

openai_client = OpenAI()


def _truncate(text: str, limit: int = 120) -> str:
  if len(text) <= limit:
    return text
  return text[: limit - 3] + "..."


def fetch_samples(limit: int) -> List[Dict[str, Any]]:
  try:
    # A Next route POST-ot vár és {items: [...]}-t ad vissza
    resp = requests.post(
      SAMPLES_ENDPOINT,
      json={"limit": limit},
      timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and isinstance(data.get("items"), list):
      return data["items"]
    if isinstance(data, list):  # védelem, ha valahol mégis listát adsz vissza
      return data
    log.warning("Samples endpoint returned unexpected payload shape")
  except Exception as exc:
    log.error("Failed to fetch samples", exc_info=exc)
  return []


def call_retriever(question: str, top_k: int) -> List[Dict[str, Any]]:
  payload = {"question": question, "topK": top_k}
  try:
    resp = requests.post(
      RETRIEVER_ENDPOINT,
      json=payload,
      timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    # A Next retriever {results: [...]}-t ad vissza
    if isinstance(data, dict) and isinstance(data.get("results"), list):
      return data["results"]
    if isinstance(data, list):  # kompatibilitás régi formátummal
      return data
    log.warning("Retriever endpoint returned unexpected payload shape")
  except Exception as exc:
    log.error("Retriever request failed", exc_info=exc)
  return []


def generate_query(text: str) -> str:
  prompt = QUERY_PROMPT.format(document=text)
  response = openai_client.chat.completions.create(
    model=OPENAI_MODEL,
    messages=[{"role": "user", "content": prompt}],
    temperature=0.3,
  )
  return (response.choices[0].message.content or "").strip()


def evaluate_rag_level(top_k: int, limit: int) -> Dict[str, Any]:
  samples = fetch_samples(limit)
  if not samples:
    return {
      "metrics": {
        "precision": 0,
        "recall": 0,
        "f1_score": 0,
        "total_queries": 0,
        "relevant_retrieved": 0,
      },
      "details": [],
    }

  total = 0
  matches = 0
  details: List[Dict[str, Any]] = []

  for sample in samples:
    text = sample.get("text") or sample.get("content")
    if not text:
      continue

    try:
      query = generate_query(text)
    except Exception as exc:
      log.error("Query generation failed", exc_info=exc)
      continue

    total += 1
    retrieved = call_retriever(query, top_k)

    source_meta = sample.get("metadata") or {}
    source_idx = (
      source_meta.get("chunk_index")
      if isinstance(source_meta, dict)
      else None
    )
    fallback_id = sample.get("id")

    retrieved_indices: List[int] = []
    retrieved_ids: List[Any] = []

    for item in retrieved:
      meta = item.get("metadata") or {}
      if isinstance(meta, dict) and "chunk_index" in meta:
        retrieved_indices.append(meta["chunk_index"])
      retrieved_ids.append(item.get("id"))

    match = False
    if source_idx is not None:
      match = source_idx in retrieved_indices
    elif fallback_id is not None:
      match = fallback_id in retrieved_ids

    if match:
      matches += 1

    details.append(
      {
        "source_chunk_index": source_idx if source_idx is not None else fallback_id,
        "generated_query": query,
        "retrieved_chunk_indices": retrieved_indices or retrieved_ids,
        "match": match,
        "source_preview": _truncate(text),
        "result_preview": _truncate(retrieved[0].get("content", "")) if retrieved else "",
      }
    )

  precision = matches / total if total else 0
  recall = precision
  f1 = (2 * precision * recall / (precision + recall)) if precision + recall > 0 else 0

  return {
    "metrics": {
      "precision": precision,
      "recall": recall,
      "f1_score": f1,
      "total_queries": total,
      "relevant_retrieved": matches,
    },
    "details": details,
  }


@celery_app.task(bind=True, name="tasks.rag_level_job")
def rag_level_job(self, *, top_k: Optional[int] = None, limit: Optional[int] = None):
  top = top_k or DEFAULT_TOPK
  lim = limit or DEFAULT_LIMIT
  result = evaluate_rag_level(top, lim)
  self.update_state(state="SUCCESS", meta=result)
  return result


@router.post("/rag-level-job")
def start_rag_job(body: Dict[str, Any]):
  top_k = int(body.get("top_k") or body.get("topK") or DEFAULT_TOPK)
  limit = int(body.get("limit") or DEFAULT_LIMIT)
  task = rag_level_job.apply_async(kwargs={"top_k": top_k, "limit": limit}, queue="evalq")
  return {"job_id": task.id}


@router.get("/rag-level-job/{job_id}")
def rag_job_status(job_id: str):
  result = AsyncResult(job_id, app=celery_app)
  state = result.state

  if state == "PENDING":
    return {"status": "PENDING"}
  if state in {"STARTED", "RETRY"}:
    return {"status": state}
  if state == "PROGRESS":
    meta = result.info if isinstance(result.info, dict) else {}
    return {"status": "PROGRESS", "progress": meta}
  if state == "SUCCESS":
    return {"status": "SUCCESS", "result": result.result}

  error_text = str(result.info) if result.info else "Unknown error"
  return {"status": "FAILURE", "error": error_text}
