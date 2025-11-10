import os
import re
import requests
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from reranking import router as reranking_router
from single_turn_evaluation import router as evaluation_router
from rag_evalation import router as rag_eval_router
from user_satisfaction_evaluation.user_satisfaction_evaluation import (
    router as user_eval_router,
)
from user_satisfaction_evaluation.user_satisfaction_evaluation import router as user_sat_router

CHUNK_API_URL = os.getenv("CHUNK_API_URL", "http://app:3000/api/upload-chunks")
DATA_DIR = Path(os.getenv("MOVIE_DATA_DIR", "/app/movie_data")).resolve()

app = FastAPI()

app.include_router(reranking_router)
app.include_router(evaluation_router)
app.include_router(rag_eval_router)
app.include_router(user_eval_router)
app.include_router(user_sat_router)


class FileReq(BaseModel):
    filename: str


def process_file(path: Path) -> list[str]:
    ext = path.suffix.lower()
    filename = str(path)

    # Select appropriate partitioner based on file extension
    if ext == ".md":
        from unstructured.partition.md import partition_md
        elements = partition_md(filename=filename)
    elif ext == ".txt":
        from unstructured.partition.text import partition_text
        elements = partition_text(filename=filename)
    elif ext in (".html", ".htm"):
        from unstructured.partition.html import partition_html
        elements = partition_html(filename=filename)
    else:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {ext}")

    # Filter out empty, very short, or separator-like elements
    filtered_elements = []
    for el in elements:
        text = str(el).strip()
        if not text:
            continue
        # Skip if too short and contains only non-alphanumeric symbols
        if len(text) < 10 and re.match(r'^[-–—_=*#.\s]+$', text):
            continue
        filtered_elements.append(el)

    # Chunk the filtered elements
    from unstructured.chunking.basic import chunk_elements
    chunks = chunk_elements(filtered_elements, max_characters=500, overlap=50)

    # Convert chunks to plain text strings
    texts = [str(ch).strip() for ch in chunks if str(ch).strip()]
    return texts


@app.post("/process-file")
def process_single_file(req: FileReq):
    path = (DATA_DIR / req.filename).resolve()
    try:
        path.relative_to(DATA_DIR)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path.")

    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {req.filename}")

    texts = process_file(path)
    if not texts:
        return {"processed_chunks": []}

    # Upload processed chunks to the application endpoint
    try:
        res = requests.post(CHUNK_API_URL, json={"chunks": texts}, timeout=60)
        payload = res.json()
    except Exception:
        payload = {"status_code": res.status_code, "text": res.text if res else "no response"}

    return {"processed_chunks": texts, "next_response": payload}
