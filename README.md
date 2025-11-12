# AI Assistant RAG MovieChat

AI Assistant RAG MovieChat is a Retrieval-Augmented Generation (RAG) movie knowledge assistant. Users can upload movie-related documents, ask questions, and get answers from a knowledge base. The project also includes tools to evaluate the assistant's accuracy and a retriever validation workflow.

## Features

- Next.js frontend with a polished `/evaluate` dashboard that groups all evaluation modes (file-count controls for single-turn, sample-size & top-K inputs for RAG validation, persona/goal pickers for user satisfaction).
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

The `app/evaluate/page.tsx` page (a fully styled dashboard that auto-loads persona/goal metadata via `/api/evaluate`) lets you run asynchronous evaluations:

1. **Single-turn evaluation**
   - Generates a golden dataset of questions/answers from existing documents.
   - Sends them through the chat endpoint.
   - Judges correctness & relevance via LLM.
   - Supports scoping the run to a specific number of uploaded files (UI field + `fileCount`/`file_limit` parameter).
   - Celery task defined in `rag_backend/single_turn_evaluation.py`.

2. **Retriever-level evaluation**
   - Validates the retriever by sampling chunks, synthesizing queries with OpenAI, and checking whether the original chunk appears in the top-K retriever results.
   - Implementation: `rag_backend/rag_evalation.py` (fetch samples, generate query, call retriever, compute precision/recall/F1 + per-query precision@K and ranks).
   - UI controls let you set `sample size` and `Top-K`, which the API forwards as `limit`/`top_k`.

3. **User satisfaction simulation**
   - Spins up a synthetic multi-turn conversation using configurable personas and goals (see `rag_backend/user_satisfaction_evaluation/personas.py` and `goals.py`).
   - Measures per-turn metrics (satisfaction, clarity, relevance, completeness, frustration incidents) and aggregates them into summary stats (goal achievement %, averages, total frustration).
   - Exposed through FastAPI endpoints (`/user-satisfaction-job`, `/evaluate-user-satisfaction`) and orchestrated via the Celery task defined in `rag_backend/user_satisfaction_evaluation/user_satisfaction_evaluation.py`.

The Next.js API (`/api/evaluate/*`) proxies requests to the backend, and the frontend polls for results, presenting metrics and tables.

### Backend Services

- `rag_backend/upload_docs.py`: FastAPI server exposing:
  - `/process-file`: handles chunking and storing documents.
  - `/evaluate-single-turn`: runs synchronous evaluation (debug).
  - `/evaluate-job`: Celery job queueing for single-turn evaluation.
- Both evaluation endpoints accept an optional `file_limit` to cap how many files are sampled when generating the golden dataset.
- `rag_backend/celery_app.py`: Configures Celery with Redis broker and backend.
- `rag_backend/user_satisfaction_evaluation/user_satisfaction_evaluation.py`: Provides `/user-satisfaction-job`, `/evaluate-user-satisfaction`, and metadata endpoints for personas/goals. Each job simulates a persona/goal conversation, summarizes per-turn metrics, and surfaces progress/results through Celery.
- `rag_backend/rag_evalation.py`: Implements the retriever-level workflow (sample selection, query synthesis via OpenAI, retriever calls, precision/recall/F1 computation) behind `/rag-level-job`.

### Database Schema

Defined in `lib/db/schema.ts`. Key tables:

| Table      | Description                                                                 |
|------------|-----------------------------------------------------------------------------|
| resources  | Stores raw text chunks ingested from uploads.                               |
| embeddings | pgvector embeddings linked to resources (vector(1536) using pgvector).      |
| monitoring | Lightweight telemetry for chat/upload events (origin, model, tokens, latency). |

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
2. On the `/evaluate` dashboard’s Single-turn card (styled control strip at the top), set **Files to evaluate** if you want to limit the run.
3. Press “Start Single-turn evaluation”; the UI immediately queues a Celery job via `/api/evaluate/start` and begins polling `/api/evaluate/status`.
4. Once complete, inspect the correctness/relevance summary and detail grid rendered below the controls (pulled directly from `rag_backend/single_turn_evaluation.py` results).

#### Limiting the scope

- In the Single-turn section of `/evaluate`, use the **Files to evaluate** input to choose how many uploaded files should be sampled. The default is 1, and the backend automatically clamps the value to the number of available files.
- API callers can pass `fileCount` (or `file_limit`) in the body of `POST /api/evaluate` or `/api/evaluate/start`. The proxy forwards this as `file_limit` to FastAPI, which in turn passes it to `rag_backend/single_turn_evaluation.py`.
- Supplying a number larger than the current corpus simply processes every available file; values less than 1 are normalized to 1.

### Retriever Evaluation

1. Use the RAG-level card on `/evaluate` to set **Sample size (chunks)** and **Top-K**; the inputs feed `limit` and `top_k` to the backend.
2. Start the evaluation; `/api/evaluate` forwards the request to `/rag-level-job`, executed by `rag_backend/rag_evalation.py`.
3. For each sampled chunk the worker:
   - Calls `app/api/rag_level/samples` to fetch text.
   - Generates a natural-language query with OpenAI (`generate_query`).
   - Calls the retriever endpoint with the query and requested top-K.
   - Calculates whether the original chunk appeared within the retrieved set plus precision@K, rank, previews, etc.
4. The UI displays precision/recall/F1 aggregated metrics plus a detailed table per query.

### User Satisfaction Evaluation

1. Pick a persona/goal pair on `/evaluate` (metadata served from `/user-satisfaction/personas` and `/user-satisfaction/goals`).
2. Choose how many conversational turns to simulate (1–12); the control sits beside the persona/goal selectors.
3. The backend (`rag_backend/user_satisfaction_evaluation/user_satisfaction_evaluation.py`) runs AssistantConversationRunner against the chat endpoint, logging every turn.
4. Metrics captured per turn—goal achieved, user satisfaction, clarity, relevance, completeness, frustration incidents—and summarized into averages plus a goal-achievement rate.
5. Launch via the UI or by POSTing `type: "user-satisfaction"` (with `persona_id`, `goal_id`, `turns`) to `/api/evaluate`; the Next.js proxy forwards the request to `/user-satisfaction-job` and exposes status updates just like other jobs.

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
