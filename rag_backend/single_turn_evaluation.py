import json
import os
import re
import sys
import time
import uuid
import threading
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional

import requests
from fastapi import APIRouter, Request
from celery.result import AsyncResult

from celery_app import celery_app
from openai import OpenAI


def set_rid_for_thread(rid: str):
    pass


# --------- CONFIG ---------
router = APIRouter()

DEFAULT_APP_CHAT_URL = os.getenv("APP_CHAT_URL", "http://app:3000/api/chat")
DEFAULT_MOVIE_DATA_DIR = os.getenv("MOVIE_DATA_DIR", "/app/movie_data")
DEFAULT_GOLDEN_QUESTIONS = int(os.getenv("GOLDEN_PAIRS_PER_DOC", "5"))

DATASET_MODEL = os.getenv("DATASET_MODEL", os.getenv("OPENAI_DATASET_MODEL", "gpt-4o-mini"))
JUDGE_MODEL = os.getenv("JUDGE_MODEL", os.getenv("OPENAI_JUDGE_MODEL", "gpt-4o-mini"))

APP_CHAT_TIMEOUT = int(os.getenv("APP_CHAT_TIMEOUT", "180"))  # seconds
ASK_RETRIES = int(os.getenv("ASK_RETRIES", "2"))
OPENAI_RETRIES = int(os.getenv("OPENAI_RETRIES", "3"))
OPENAI_BACKOFF_BASE = float(os.getenv("OPENAI_BACKOFF_BASE", "0.8"))

client = OpenAI()

# --------- DATA ---------
@dataclass
class Sample:
    source: str
    question: str
    answer: str

# --------- PARSERS ---------
_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", flags=re.IGNORECASE | re.DOTALL)

def _strip_code_fences(s: str) -> str:
    return re.sub(_CODE_FENCE_RE, "", s).strip()

def _extract_inner_json_block(s: str) -> Optional[str]:
    try:
        start = s.find("{")
        end = s.rfind("}")
        if start != -1 and end != -1 and end > start:
            return s[start : end + 1]
    except Exception:
        pass
    return None

_QA_BLOCK_RE = re.compile(
    r"(?is)(?:^|\n)\s*(?:Q(?:uestion)?\s*[:\-]\s*)(.+?)\s*(?:\n+\s*(?:A(?:nswer)?\s*[:\-]\s*)(.+?))(?=\n\s*(?:Q(?:uestion)?\s*:|$))"
)

def _parse_qna_fallback(raw: str) -> List[Dict[str, str]]:
    pairs: List[Dict[str, str]] = []
    for m in _QA_BLOCK_RE.finditer(raw.strip() + "\nQ:"):
        q = m.group(1).strip()
        a = m.group(2).strip()
        if q and a:
            pairs.append({"question": q, "answer": a})
    return pairs

def _truncate(text: str, limit: int = 6000) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + "\n...\n" + text[-half:]

def _safe_parse_pairs(content: str, num_pairs: int) -> List[Dict[str, str]]:
    text = _strip_code_fences(content)
    # 1) direct JSON
    try:
        data = json.loads(text)
        pairs = data.get("pairs")
        if isinstance(pairs, list):
            return [{"question": str(it.get("question","")).strip(),
                     "answer": str(it.get("answer","")).strip()}
                    for it in pairs
                    if str(it.get("question","")).strip() and str(it.get("answer","")).strip()]
    except Exception:
        pass
    # 2) inner JSON
    inner = _extract_inner_json_block(text)
    if inner:
        try:
            data = json.loads(inner)
            pairs = data.get("pairs")
            if isinstance(pairs, list):
                return [{"question": str(it.get("question","")).strip(),
                         "answer": str(it.get("answer","")).strip()}
                        for it in pairs
                        if str(it.get("question","")).strip() and str(it.get("answer","")).strip()]
        except Exception:
            pass
    # 3) naive single->double
    try:
        coerced = text.replace("'", '"')
        data = json.loads(coerced)
        pairs = data.get("pairs")
        if isinstance(pairs, list):
            return [{"question": str(it.get("question","")).strip(),
                     "answer": str(it.get("answer","")).strip()}
                    for it in pairs
                    if str(it.get("question","")).strip() and str(it.get("answer","")).strip()]
    except Exception:
        pass
    # 4) Q/A fallback
    qa = _parse_qna_fallback(text)
    if qa:
        return qa[:num_pairs]
    return []

# --------- TIMERS ---------
def _now_ms():
    return int(time.time() * 1000)

def _sleep_backoff(attempt: int, base: float):
    # exponential backoff with small jitter
    delay = (base ** attempt) + (0.05 * attempt)
    time.sleep(delay)

# --------- CORE ---------
def _read_document(path: Path) -> Optional[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            text = path.read_text(encoding="latin-1")
        except Exception as exc:
            return None
    return text.strip()

def generate_pairs(content: str, file_name: str, num_pairs: int) -> List[Dict[str, str]]:
    t0 = _now_ms()
    last_exc = None
    for attempt in range(1, OPENAI_RETRIES + 1):
        try:
            messages = [
                {"role": "system", "content": (
                    "ROLE: You emit STRICT JSON ONLY. No prose, no markdown, no code fences, no comments.\n"
                    f"TASK: From the supplied document, create EXACTLY {num_pairs} distinct question–answer pairs.\n"
                    "HARD RULES:\n"
                    '- Output MUST be a single JSON object with EXACT schema: {"pairs":[{"question":"...","answer":"..."}]}\n'
                    "- The length of pairs MUST be exactly the requested number.\n"
                    "- Each question MUST be answerable using ONLY the provided document content; no external knowledge.\n"
                    "- Answers MUST be concise (<= 50 words), faithful (quote/paraphrase).\n"
                    "- Use double quotes, valid JSON (UTF-8), no trailing commas, no extra keys.\n"
                )},
                {"role": "user", "content": f"Source file: {file_name}\n\nDocument content:\n{content}"},
            ]
            resp = client.chat.completions.create(
                model=DATASET_MODEL,
                messages=messages,
                temperature=0.0,
            )
            raw = (resp.choices[0].message.content or "").strip()
            parsed = _safe_parse_pairs(raw, num_pairs)
            normalized: List[Dict[str, str]] = []
            for it in parsed:
                q = str(it.get("question","")).strip()
                a = str(it.get("answer","")).strip()
                if q and a:
                    normalized.append({"question": q, "answer": a})

            return normalized
        except Exception as exc:
            last_exc = exc
            if attempt < OPENAI_RETRIES:
                _sleep_backoff(attempt, OPENAI_BACKOFF_BASE)
                continue
            raise

def build_golden_dataset(
    data_dir: Path,
    num_pairs: int,
    *,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
    rid: str | None = None,
) -> tuple[List[Sample], int, int]:
    samples: List[Sample] = []
    files = [p for p in sorted(data_dir.rglob("*")) if p.is_file()]
    total_expected = len(files) * num_pairs
    processed = 0


    for idx, path in enumerate(files, start=1):
        raw = _read_document(path)
        if not raw:
            continue
        truncated = _truncate(raw)
        t0 = _now_ms()
        pairs = generate_pairs(truncated, path.name, num_pairs)
        dt = _now_ms() - t0
        for pair in pairs:
            samples.append(Sample(path.name, pair["question"], pair["answer"]))
            processed += 1
            if progress_callback and total_expected:
                progress_callback(min(processed, total_expected), total_expected, "dataset")

    return samples, processed, total_expected

def ask_application(question: str, chat_url: str, rid: str | None = None) -> str:
    payload = {"messages": [{"role": "user", "parts": [{"type": "text", "text": question}]}]}
    last_exc = None
    for attempt in range(1, ASK_RETRIES + 1):
        try:
            t0 = _now_ms()
            headers = {"Content-Type": "application/json"}
            if rid:
                headers["X-Request-ID"] = rid
            resp = requests.post(chat_url, json=payload, headers=headers, timeout=APP_CHAT_TIMEOUT)
            dt = _now_ms() - t0
            resp.raise_for_status()
            return resp.text.strip()
        except Exception as exc:
            last_exc = exc
            if attempt < ASK_RETRIES:
                _sleep_backoff(attempt, 0.7)
                continue
            # after the final retry, re-raise the exception
            raise

def _judge(system_prompt: str, question: str, ground_truth: str, candidate: str, rid: str | None = None) -> Dict[str, str]:
    last_exc = None
    for attempt in range(1, OPENAI_RETRIES + 1):
        try:
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(
                    {"question": question, "ground_truth": ground_truth, "candidate_answer": candidate},
                    ensure_ascii=False
                )},
            ]
            t0 = _now_ms()
            resp = client.chat.completions.create(model=JUDGE_MODEL, messages=messages, temperature=0)
            dt = _now_ms() - t0
            content = (resp.choices[0].message.content or "").strip()
            # Prefer JSON output
            try:
                data = json.loads(_strip_code_fences(content))
                decision = (data.get("decision") or data.get("DECISION") or "").strip().upper()
                reasoning = data.get("reasoning") or data.get("REASONING") or ""
                if decision:
                    return {"raw": content, "reasoning": reasoning, "decision": decision}
            except Exception:
                pass
            inner = _extract_inner_json_block(content)
            if inner:
                try:
                    data = json.loads(inner)
                    decision = (data.get("decision") or data.get("DECISION") or "").strip().upper()
                    reasoning = data.get("reasoning") or data.get("REASONING") or ""
                    if decision:
                        return {"raw": content, "reasoning": reasoning, "decision": decision}
                except Exception:
                    pass
            # Plain text fallback
            reasoning, decision = "", ""
            for line in content.splitlines():
                if line.upper().startswith("REASONING:"):
                    reasoning = line.split(":", 1)[-1].strip()
                elif line.upper().startswith("DECISION:"):
                    decision = line.split(":", 1)[-1].strip().upper()
            if not decision:
                m = re.search(r"DECISION:\s*(CORRECT|INCORRECT|RELEVANT|IRRELEVANT)", content, re.IGNORECASE)
                if m:
                    decision = m.group(1).upper()
            if not decision:
                decision = "UNKNOWN"
            return {"raw": content, "reasoning": reasoning, "decision": decision}
        except Exception as exc:
            last_exc = exc
            if attempt < OPENAI_RETRIES:
                _sleep_backoff(attempt, OPENAI_BACKOFF_BASE)
                continue
            raise

def evaluate_samples(
    samples: List[Sample],
    chat_url: str,
    rid: str | None = None,
    *,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
    progress_start: int = 0,
    progress_total: Optional[int] = None,
) -> Dict[str, object]:
    if not samples:
        return {"total": 0, "accuracy": 0.0, "relevance_rate": 0.0, "details": []}

    details = []
    correct = 0
    relevant = 0

    total = len(samples)

    processed = progress_start
    combined_total = progress_total or (progress_start + total)
    if combined_total == 0:
        combined_total = max(total, 1)

    for i, sample in enumerate(samples, start=1):
        step_t0 = _now_ms()
        try:
            candidate = ask_application(sample.question, chat_url, rid)
        except Exception as exc:
            # continue evaluation but mark result as unknown/irrelevant
            candidate = f"[ERROR calling app chat] {repr(exc)}"

        correctness = _judge(
            "ROLE: Strict evaluator. OUTPUT: JSON ONLY, no prose/markdown/code fences/comments.\n"
            'Schema: {"reasoning":"<<=50 words>","decision":"CORRECT|INCORRECT"}\n'
            "CRITERIA:\n"
            "- Return CORRECT only if candidate contains all key facts from the ground truth without contradiction.\n"
            "- Stylistic rephrasing allowed; fabrication not allowed.\n"
            "- Keep reasoning concise (<= 50 words).",
            sample.question, sample.answer, candidate, rid
        )
        relevance = _judge(
            "ROLE: Relevance judge. OUTPUT: JSON ONLY, no prose/markdown/code fences/comments.\n"
            'Schema: {"reasoning":"<<=50 words>","decision":"RELEVANT|IRRELEVANT"}\n'
            "CRITERIA:\n"
            "- Return RELEVANT only if the candidate directly answers the user's query and stays on topic.\n"
            "- Otherwise return IRRELEVANT.\n"
            "- Keep reasoning concise (<= 50 words).",
            sample.question, sample.answer, candidate, rid
        )

        if correctness["decision"] == "CORRECT":
            correct += 1
        if relevance["decision"] == "RELEVANT":
            relevant += 1

        step_ms = _now_ms() - step_t0
        details.append({
            "source": sample.source,
            "question": sample.question,
            "ground_truth": sample.answer,
            "candidate": candidate,
            "correctness": correctness,
            "relevance": relevance,
            "latency_ms": step_ms,
        })

        processed += 1
        if progress_callback:
            progress_callback(min(processed, combined_total), combined_total, "evaluation")

    return {
        "total": total,
        "correct": correct,
        "accuracy": correct / total if total else 0.0,
        "relevant": relevant,
        "relevance_rate": relevant / total if total else 0.0,
        "details": details,
    }

def evaluate(
    data_dir: Path | None = None,
    chat_url: str | None = None,
    num_pairs: int | None = None,
    write_dataset: bool = False,
    rid: str | None = None,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
    dataset_filename: str | None = None,
) -> Dict[str, object]:
    data_dir = Path(data_dir or DEFAULT_MOVIE_DATA_DIR)
    chat_url = chat_url or DEFAULT_APP_CHAT_URL
    num_pairs = int(num_pairs or DEFAULT_GOLDEN_QUESTIONS)

    if not data_dir.exists():
        raise RuntimeError(f"Data directory not found: {data_dir}")


    samples, produced_pairs, expected_total = build_golden_dataset(
        data_dir,
        num_pairs,
        progress_callback=progress_callback,
        rid=rid,
    )

    dataset_output = {
        "samples": [
            {"source": s.source, "question": s.question, "answer": s.answer}
            for s in samples
        ]
    }

    if write_dataset:
        dataset_path = Path(dataset_filename or os.getenv("GOLDEN_DATASET_PATH", "golden_dataset.json"))
        dataset_path.write_text(
            json.dumps(dataset_output, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    else:
        dataset_path = None

    total_pairs = expected_total or produced_pairs or len(samples)
    if total_pairs <= 0:
        total_pairs = len(samples) or 1

    t0 = _now_ms()
    summary = evaluate_samples(
        samples,
        chat_url,
        rid,
        progress_callback=progress_callback,
        progress_start=produced_pairs,
        progress_total=total_pairs,
    )
    dt = _now_ms() - t0
    if write_dataset:
        summary["dataset_path"] = str(dataset_path) if dataset_path else None
    summary["dataset_size"] = len(dataset_output.get("samples", []))
    return summary


@celery_app.task(bind=True, name="tasks.evaluate_job")
def evaluate_job(self, job_id: str | None = None):
    rid = job_id or uuid.uuid4().hex

    def progress(step: int, total: int, phase: str):
        total = max(total, 1)
        self.update_state(state="PROGRESS", meta={"i": step, "of": total, "phase": phase})

    try:
        set_rid_for_thread(rid)
        summary = evaluate(
            write_dataset=True,
            rid=rid,
            progress_callback=progress,
            dataset_filename=f"golden_dataset_{rid}.json",
        )
        summary["rid"] = rid
        return summary
    except Exception as exc:
        raise

@router.post("/evaluate-job")
def start_evaluation_job(request: Request):
    rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex
    set_rid_for_thread(rid)
    task = evaluate_job.apply_async(kwargs={"job_id": rid}, queue="evalq")
    return {"job_id": task.id}


@router.get("/evaluate-job/{job_id}")
def evaluation_job_status(job_id: str):
    result = AsyncResult(job_id, app=celery_app)
    state = result.state

    if state == "PENDING":
        return {"status": "PENDING"}
    if state in {"STARTED", "RETRY"}:
        return {"status": "STARTED"}
    if state == "PROGRESS":
        meta = result.info if isinstance(result.info, dict) else {}
        return {"status": "PROGRESS", "progress": meta}
    if state == "SUCCESS":
        return {"status": "SUCCESS", "result": result.result}

    error_info = result.info
    if isinstance(error_info, Exception):
        error_text = repr(error_info)
    else:
        error_text = str(error_info) if error_info is not None else "Unknown error"
    return {"status": "FAILURE", "error": error_text}


@router.post("/evaluate-single-turn")
def evaluate_single_turn(request: Request):
    # Propagate incoming RID or create a new one
    rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex
    set_rid_for_thread(rid)

    try:
        summary = evaluate(write_dataset=True, rid=rid)
        return summary
    except Exception as exc:
        # Do not fail silently; surface error + RID
        return {"error": repr(exc), "rid": rid}
