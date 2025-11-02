import os
import threading
from typing import List, Optional, Union

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

router = APIRouter()

_model_lock = threading.Lock()
_cross_encoder: Optional[CrossEncoder] = None


def get_cross_encoder() -> CrossEncoder:
    global _cross_encoder
    if _cross_encoder is None:
        with _model_lock:
            if _cross_encoder is None:
                model_name = os.getenv(
                    "RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2"
                )
                device = os.getenv("RERANKER_DEVICE")
                _cross_encoder = CrossEncoder(model_name, device=device)
    return _cross_encoder


class Candidate(BaseModel):
    id: Union[str, int]
    content: str
    distance: Optional[float] = None


class RerankRequest(BaseModel):
    query: str
    candidates: List[Candidate]
    top_n: Optional[int] = None


@router.post("/rerank")
async def rerank(request: RerankRequest):
    if not request.candidates:
        return {"results": []}

    top_n = request.top_n or len(request.candidates)
    encoder = get_cross_encoder()

    pairs = [[request.query, candidate.content] for candidate in request.candidates]
    scores = await run_in_threadpool(encoder.predict, pairs)

    combined = []
    for candidate, score in zip(request.candidates, scores):
        combined.append(
            {
                "id": candidate.id,
                "content": candidate.content,
                "distance": candidate.distance,
                "rerank_score": float(score),
            }
        )

    combined.sort(key=lambda item: item["rerank_score"], reverse=True)
    return {"results": combined[:top_n]}
