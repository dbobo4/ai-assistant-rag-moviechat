import os
import requests
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

CHUNK_API_URL = os.getenv("CHUNK_API_URL", "http://app:3000/api/upload-chunks")
DATA_DIR = Path(os.getenv("MOVIE_DATA_DIR", "/app/movie_data")).resolve()

app = FastAPI()


class FileReq(BaseModel):
    filename: str


def process_file(path: Path) -> list[str]:
    ext = path.suffix.lower()
    filename = str(path)

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

    from unstructured.chunking.basic import chunk_elements

    chunks = chunk_elements(elements, max_characters=500, overlap=50)
    texts = [str(ch) for ch in chunks if str(ch).strip()]
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

    res = requests.post(CHUNK_API_URL, json={"chunks": texts})
    try:
        payload = res.json()
    except Exception:
        payload = {"status_code": res.status_code, "text": res.text}

    return {"processed_chunks": texts, "next_response": payload}
