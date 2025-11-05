import json
import os
import re
import sys
import time
import socket
import uuid
import threading
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

import requests
from fastapi import APIRouter, Request
from openai import OpenAI

# --------- LOGGING ---------
import logging

HOST = socket.gethostname()
LOG_LEVEL = os.getenv("EVAL_LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] [pid=%(process)d tid=%(thread)d host=%(hostname)s rid=%(rid)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

class _CtxFilter(logging.Filter):
    def __init__(self):
        super().__init__()
        self.hostname = HOST
        self.rid = "-"

    def filter(self, record):  # inject defaults
        if not hasattr(record, "hostname"):
            record.hostname = self.hostname
        if not hasattr(record, "rid"):
            record.rid = self.rid
        return True

_ctx_filter = _CtxFilter()
for h in logging.getLogger().handlers:
    h.addFilter(_CtxFilter())

def set_rid_for_thread(rid: str):
    # per-thread RID (egyszerű, de működő)
    class _RidFilter(logging.Filter):
        def filter(self, record):
            record.rid = rid
            record.hostname = HOST
            return True
    for h in logging.getLogger().handlers:
        # remove previous _RidFilter if any
        # (egyszerűsítés: nem tisztítjuk, nem lesz gond egy folyamaton belül)
        h.addFilter(_RidFilter())

log = logging.getLogger("rag.eval")

# --------- CONFIG ---------
router = APIRouter()

DEFAULT_APP_CHAT_URL = os.getenv("APP_CHAT_URL", "http://app:3000/api/chat")
DEFAULT_MOVIE_DATA_DIR = os.getenv("MOVIE_DATA_DIR", "/app/movie_data")
DEFAULT_GOLDEN_QUESTIONS = int(os.getenv("GOLDEN_PAIRS_PER_DOC", "5"))

DATASET_MODEL = os.getenv("DATASET_MODEL", os.getenv("OPENAI_DATASET_MODEL", "gpt-4o-mini"))
JUDGE_MODEL = os.getenv("JUDGE_MODEL", os.getenv("OPENAI_JUDGE_MODEL", "gpt-4o-mini"))

APP_CHAT_TIMEOUT = int(os.getenv("APP_CHAT_TIMEOUT", "180"))  # s
ASK_RETRIES = int(os.getenv("ASK_RETRIES", "2"))
OPENAI_RETRIES = int(os.getenv("OPENAI_RETRIES", "3"))
OPENAI_BACKOFF_BASE = float(os.getenv("OPENAI_BACKOFF_BASE", "0.8"))

# Az OPENAI_API_KEY-nek itt elérhetőnek kell lennie a konténer env-ben.
client = OpenAI()  # ha az env-ben van OPENAI_API_KEY, ez elég

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
    log.warning("Could not parse dataset pairs; raw (trunc) follows")
    log.warning(_truncate(text, 1000))
    return []

# --------- TIMERS ---------
def _now_ms():
    return int(time.time() * 1000)

def _sleep_backoff(attempt: int, base: float):
    # exponenciális + kicsi jitter
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
            log.warning(f"Unable to read {path}: {exc}")
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
            log.info("generate_pairs.call", extra={"rid":"-"})
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

            if len(normalized) != num_pairs:
                log.warning(
                    "generate_pairs.count_mismatch",
                    extra={"rid":"-"}
                )
                log.warning(json.dumps({
                    "file": file_name, "got": len(normalized), "expected": num_pairs,
                    "raw_trunc": _truncate(raw, 800)
                }, ensure_ascii=False))

            log.info(
                "generate_pairs.ok",
                extra={"rid":"-"}
            )
            return normalized
        except Exception as exc:
            last_exc = exc
            log.error(
                "generate_pairs.error",
                extra={"rid":"-"}
            )
            log.error("exc: " + repr(exc))
            if attempt < OPENAI_RETRIES:
                _sleep_backoff(attempt, OPENAI_BACKOFF_BASE)
                continue
            raise

def build_golden_dataset(data_dir: Path, num_pairs: int) -> List[Sample]:
    log.info("build_golden_dataset.start " + json.dumps({
        "data_dir": str(data_dir),
        "num_pairs": num_pairs
    }))
    samples: List[Sample] = []
    files = [p for p in sorted(data_dir.rglob("*")) if p.is_file()]
    log.info("build_golden_dataset.files " + json.dumps({
        "count": len(files),
        "names": [f.name for f in files][:50]  # limit log
    }))

    for idx, path in enumerate(files, start=1):
        raw = _read_document(path)
        if not raw:
            log.warning(f"skip_unreadable {path}")
            continue
        truncated = _truncate(raw)
        log.info("generate_pairs.begin " + json.dumps({
            "i": idx, "of": len(files), "file": path.name, "len_raw": len(raw), "len_trunc": len(truncated)
        }))
        t0 = _now_ms()
        pairs = generate_pairs(truncated, path.name, num_pairs)
        dt = _now_ms() - t0
        log.info("generate_pairs.end " + json.dumps({
            "file": path.name, "pairs": len(pairs), "ms": dt
        }))
        for pair in pairs:
            samples.append(Sample(path.name, pair["question"], pair["answer"]))

    log.info("build_golden_dataset.done " + json.dumps({"samples": len(samples)}))
    return samples

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
            log.info("ask_application.http", extra={"rid": rid or "-"})
            log.info(json.dumps({
                "url": chat_url,
                "status": resp.status_code,
                "elapsed_ms": dt,
                "len": int(resp.headers.get("content-length", "0") or "0"),
            }))
            resp.raise_for_status()
            return resp.text.strip()
        except Exception as exc:
            last_exc = exc
            log.error("ask_application.error " + json.dumps({
                "attempt": attempt, "max": ASK_RETRIES, "err": repr(exc)
            }))
            if attempt < ASK_RETRIES:
                _sleep_backoff(attempt, 0.7)
                continue
            # utolsó próbálkozás után dobjuk
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
            log.info("judge.ok " + json.dumps({"elapsed_ms": dt}), extra={"rid": rid or "-"})
            # JSON preferencia
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
                log.warning("judge.missing_decision; raw_trunc=" + _truncate(content, 800), extra={"rid": rid or "-"})
                decision = "UNKNOWN"
            return {"raw": content, "reasoning": reasoning, "decision": decision}
        except Exception as exc:
            last_exc = exc
            log.error("judge.error " + repr(exc), extra={"rid": rid or "-"})
            if attempt < OPENAI_RETRIES:
                _sleep_backoff(attempt, OPENAI_BACKOFF_BASE)
                continue
            raise

def evaluate_samples(samples: List[Sample], chat_url: str, rid: str | None = None) -> Dict[str, object]:
    if not samples:
        return {"total": 0, "accuracy": 0.0, "relevance_rate": 0.0, "details": []}

    details = []
    correct = 0
    relevant = 0

    total = len(samples)
    log.info("evaluate_samples.start " + json.dumps({"total": total}), extra={"rid": rid or "-"})

    for i, sample in enumerate(samples, start=1):
        step_t0 = _now_ms()
        try:
            candidate = ask_application(sample.question, chat_url, rid)
        except Exception as exc:
            log.error("ask_application.failed " + json.dumps({
                "i": i, "of": total, "source": sample.source, "err": repr(exc)
            }), extra={"rid": rid or "-"})
            # megyünk tovább, de jelöljük unknown/irrelevant
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
        if (i % 5 == 0) or (i == total):
            log.info("progress " + json.dumps({
                "i": i, "of": total,
                "correct": correct, "relevant": relevant,
                "last_step_ms": step_ms
            }), extra={"rid": rid or "-"})

        details.append({
            "source": sample.source,
            "question": sample.question,
            "ground_truth": sample.answer,
            "candidate": candidate,
            "correctness": correctness,
            "relevance": relevance,
            "latency_ms": step_ms,
        })

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
) -> Dict[str, object]:
    data_dir = Path(data_dir or DEFAULT_MOVIE_DATA_DIR)
    chat_url = chat_url or DEFAULT_APP_CHAT_URL
    num_pairs = int(num_pairs or DEFAULT_GOLDEN_QUESTIONS)

    if not data_dir.exists():
        raise RuntimeError(f"Data directory not found: {data_dir}")

    log.info("evaluate.begin " + json.dumps({
        "data_dir": str(data_dir), "chat_url": chat_url,
        "num_pairs": num_pairs,
        "dataset_model": DATASET_MODEL, "judge_model": JUDGE_MODEL
    }), extra={"rid": rid or "-"})

    samples = build_golden_dataset(data_dir, num_pairs)

    if write_dataset:
        dataset_output = {"samples": [{"source": s.source, "question": s.question, "answer": s.answer} for s in samples]}
        Path(os.getenv("GOLDEN_DATASET_PATH", "golden_dataset.json")).write_text(
            json.dumps(dataset_output, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        log.info("golden_dataset.written", extra={"rid": rid or "-"})

    t0 = _now_ms()
    summary = evaluate_samples(samples, chat_url, rid)
    dt = _now_ms() - t0
    log.info("evaluate.done " + json.dumps({"elapsed_ms": dt, **{k: summary.get(k) for k in ("total","accuracy","relevance_rate")}}),
             extra={"rid": rid or "-"})
    return summary

@router.post("/evaluate-single-turn")
def evaluate_single_turn(request: Request):
    # Propagált vagy új RID
    rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex
    set_rid_for_thread(rid)

    log.info("HTTP /evaluate-single-turn invoked " + json.dumps({
        "rid": rid, "env": {
            "APP_CHAT_URL": DEFAULT_APP_CHAT_URL,
            "MOVIE_DATA_DIR": DEFAULT_MOVIE_DATA_DIR,
            "GOLDEN_PAIRS_PER_DOC": DEFAULT_GOLDEN_QUESTIONS,
            "APP_CHAT_TIMEOUT": APP_CHAT_TIMEOUT
        }
    }), extra={"rid": rid})

    try:
        summary = evaluate(write_dataset=True, rid=rid)
        log.info("summary " + json.dumps({
            "total": summary.get("total"),
            "accuracy": summary.get("accuracy"),
            "relevance_rate": summary.get("relevance_rate")
        }), extra={"rid": rid})
        return summary
    except Exception as exc:
        # NE álljon meg csendben; dobjunk 500-at részletes loggal
        log.error("evaluate.failed " + repr(exc), extra={"rid": rid})
        log.error(traceback.format_exc(), extra={"rid": rid})
        return {"error": repr(exc), "rid": rid}

if __name__ == "__main__":
    rid = uuid.uuid4().hex
    set_rid_for_thread(rid)
    try:
        summary = evaluate(write_dataset=True, rid=rid)
        log.info("CLI run summary " + json.dumps({
            "total": summary.get("total"),
            "accuracy": summary.get("accuracy"),
            "relevance_rate": summary.get("relevance_rate")
        }), extra={"rid": rid})
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    except Exception as exc:
        log.error(f"[ERROR] {exc}")
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
