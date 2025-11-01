FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libmagic1 \
        libmagic-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir fastapi uvicorn requests tqdm \
    "unstructured[md,html]" markdown beautifulsoup4 lxml

COPY . .

EXPOSE 8000
CMD ["uvicorn", "upload_docs:app", "--host", "0.0.0.0", "--port", "8000"]
