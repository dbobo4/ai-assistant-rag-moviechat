# AI Assistant RAG MovieChat

AI Assistant RAG MovieChat is a Retrieval-Augmented Generation (RAG) movie knowledge assistant. Users can upload movie-related documents, ask questions, and get answers from a knowledge base. The project also includes tools to evaluate the assistant's accuracy and a retriever validation workflow.

## Features

- Next.js frontend with a single-turn evaluation dashboard
- FastAPI backend for file processing and evaluations
- Celery/Redis integration for background evaluation jobs
- PostgreSQL + pgvector for storing resources and embeddings
- RAG pipeline: question input → embedding lookup → LLM response

## Project Structure

- `app/`: Next.js frontend. Displays chat UI and evaluation dashboards.
- `rag_backend/`: FastAPI app handling file uploads, evaluations, and Celery tasks.
- `lib/`: Shared utilities (database access, embedding functions).
- `docker-compose.yml`: Orchestrates app, backend, Redis, Celery worker, Postgres, pgAdmin.

## Key Components

### Chat UI

Located in `app/page.tsx`. Users submit questions, which are sent to `/api/chat` for processing. The chat history is kept client-side, and streaming responses are rendered as they arrive.

### File Uploads (RAG ingest)

Implemented in `app/api/upload/route.ts`. The Next.js route writes the file into `movie_data`, then calls the FastAPI endpoint `/process-file`. The backend saves files inside the shared volume and triggers parsing & chunking to feed the knowledge base.

### Evaluations

The `app/evaluate/page.tsx` page lets you run asynchronous evaluations:

1. **Single-turn evaluation**
   - Generates a golden dataset of questions/answers from existing documents.
   - Sends them through the chat endpoint.
   - Judges correctness & relevance via LLM.
   - Celery task defined in `rag_backend/single_turn_evaluation.py`.

2. **Retriever-level evaluation**
   - (In progress) Validates the retriever by generating queries from chunks, ensuring the original chunk appears in the top-K results.

The Next.js API (`/api/evaluate/*`) proxies requests to the backend, and the frontend polls for results, presenting metrics and tables.

### Backend Services

- `rag_backend/upload_docs.py`: FastAPI server exposing:
  - `/process-file`: handles chunking and storing documents.
  - `/evaluate-single-turn`: runs synchronous evaluation (debug).
  - `/evaluate-job`: Celery job queueing for single-turn evaluation.
- `rag_backend/celery_app.py`: Configures Celery with Redis broker and backend.

### Database Schema

Defined in `lib/db/schema.ts`. Key tables:

| Table      | Description                                     |
|------------|-------------------------------------------------|
| resources  | Stores raw text chunks.                         |
| embeddings | pgvector embeddings linked to resources.        |

### Embedding Retrieval

`lib/ai/embedding.ts` handles queries using OpenAI embeddings + pgvector similarity. It fetches top results and, optionally, reranks them with a cross encoder to improve answer quality.

## Running the Project

1. Copy environment templates: `cp app.env.example app.env`, `cp rag_backend/rag_backend.env.example rag_backend/rag_backend.env`.
2. Fill in secrets (OpenAI API key, etc.).
3. Start services:

```bash
docker-compose up --build
```

This launches:

- `app`: Next.js frontend (`http://localhost:3000`)
- `rag_backend`: FastAPI backend (`http://localhost:8000`)
- `celery_worker`: background evaluation worker
- `redis`: broker for Celery
- `db`: Postgres with pgvector extension
- `pgadmin`: UI for Postgres (`http://localhost:8080`)

## Evaluation Workflows

### Single-turn Evaluation

1. Upload documents.
2. Open `/evaluate` and start a single-turn evaluation.
3. Celery runs the evaluation, and the UI polls for status.
4. Review correctness/relevance stats and detailed results.

### Retriever Evaluation

1. Configure sample size & top-K (via env/UI).
2. Launch RAG-level evaluation (under construction).
3. Retrieves random chunks, generates queries, checks retriever accuracy.

## Development Guidelines

- Code style: TypeScript/React on frontend, Python (FastAPI/Celery) on backend.
- No secrets in Git: `.env` files are ignored; use `*_example` templates.
- Long-running tasks must run via Celery + Redis.
- Reranking uses `@xenova/transformers` cross encoder with caching.

## Roadmap

- Complete RAG-level evaluation task and UI integration.
- Add authentication and role-based access.
- Expand dataset ingestion (PDF, DOCX).
- Automated deployment scripts.

## License

MIT
