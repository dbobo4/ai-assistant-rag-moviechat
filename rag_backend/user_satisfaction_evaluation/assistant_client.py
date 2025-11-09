# rag_backend/assistant_client.py
import os
import json
import re
import time
import uuid
import logging
import random
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Union

import requests
from openai import OpenAI

from .personas import PERSONAS, UserPersona
from .goals import GOALS, ConversationGoal

# ---- Logging setup -----------------------------------------------------------
LOG_LEVEL = os.getenv("USER_EVAL_LOG_LEVEL", "INFO").upper()
MAX_LOG_CHARS = int(os.getenv("USER_EVAL_LOG_TRUNC", "1200"))
RUN_ID = os.getenv("USER_EVAL_RUN_ID", str(uuid.uuid4())[:8])

logger = logging.getLogger("user_eval")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        fmt=f"[USER-EVAL][{RUN_ID}][%(levelname)s] %(asctime)s %(message)s",
        datefmt="%H:%M:%S",
    ))
    logger.addHandler(handler)
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

def _truncate_text(s: str, limit: int = MAX_LOG_CHARS) -> str:
    if s is None:
        return ""
    if len(s) <= limit:
        return s
    head = s[: limit // 2]
    tail = s[-limit // 2 :]
    return f"{head} ... <{len(s)-limit} chars omitted> ... {tail}"

def _shorten(obj: Any, limit: int = MAX_LOG_CHARS) -> Any:
    """Recursively truncate long strings in nested structures for safe logging."""
    if isinstance(obj, str):
        return _truncate_text(obj, limit)
    if isinstance(obj, dict):
        return {k: _shorten(v, limit) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return type(obj)(_shorten(v, limit) for v in obj)
    return obj

def _snapshot_convo(messages: List["Message"]) -> List[Dict[str, Any]]:
    """Compact snapshot of conversation state for logs."""
    snap: List[Dict[str, Any]] = []
    for i, m in enumerate(messages, start=1):
        snap.append({
            "idx": i,
            "role": m.role,
            "len": len(m.content or ""),
            "preview": _truncate_text(m.content or "", 300),
        })
    return snap

# ---- Output sanitizers -------------------------------------------------------
_ROLE_TAG_RE = re.compile(
    r'^\s*(?:\[\s*)?(?:USER|ASSISTANT|SYSTEM)\s*(?:\]\s*)?[:\-–]\s*',
    re.IGNORECASE
)

# strip outer quotes “...”, "..."
_OUTER_QUOTES_RE = re.compile(r'^\s*[\"“](.*?)[\"”]\s*$', re.DOTALL)

def _strip_leading_role_tags(text: str) -> str:
    t = (text or "").strip()
    # remove any number of leading role-prefixed tags
    prev = None
    while prev != t:
        prev = t
        t = _ROLE_TAG_RE.sub("", t, count=1).strip()
    # remove a single layer of wrapping quotes if present
    m = _OUTER_QUOTES_RE.match(t)
    if m and m.group(1).strip():
        t = m.group(1).strip()
    return t

# ---- Config ------------------------------------------------------------------
ASSISTANT_CHAT_URL = os.getenv("APP_CHAT_URL", "http://app:3000/api/chat")
USER_SIM_MODEL = os.getenv("USER_SIM_MODEL", os.getenv("OPENAI_USER_SIM_MODEL", "gpt-4o-mini"))
JUDGE_MODEL = os.getenv("JUDGE_MODEL", os.getenv("OPENAI_JUDGE_MODEL", "gpt-4o-mini"))
HTTP_TIMEOUT = int(os.getenv("USER_EVAL_HTTP_TIMEOUT", "60"))

# Initial-generation knobs (env-ben felülírható)
INITIAL_TEMP_BASE = float(os.getenv("USER_SIM_INITIAL_TEMP", "1.1"))
INITIAL_TOP_P_BASE = float(os.getenv("USER_SIM_INITIAL_TOP_P", "0.95"))
INITIAL_PRESENCE_BASE = float(os.getenv("USER_SIM_INITIAL_PRESENCE", "0.6"))
INITIAL_FREQUENCY_BASE = float(os.getenv("USER_SIM_INITIAL_FREQUENCY", "0.2"))
INITIAL_N = int(os.getenv("USER_SIM_INITIAL_N", "3"))  # több minta, poszt-szűrve

# ---- Core structures ---------------------------------------------------------
Role = Literal["user", "assistant"]

@dataclass
class Message:
    role: Role
    content: str

@dataclass
class ConversationState:
    messages: List[Message] = field(default_factory=list)

    def add(self, role: Role, content: str):
        self.messages.append(Message(role=role, content=content))
        logger.debug(
            "ConversationState.add",
            extra={"_": _shorten({"role": role, "content": content}, 600)}
        )
        logger.info("CONVO-SNAPSHOT (after add)", extra={"_": _shorten(_snapshot_convo(self.messages), 1000)})

    def to_next_messages_payload(self) -> List[Dict[str, Any]]:
        """
        Convert to the Next.js /api/chat expected shape:
        [{ role, parts: [{ type:'text', text: ... }] }, ...]
        """
        out: List[Dict[str, Any]] = []
        for m in self.messages:
            out.append({
                "role": m.role,
                "parts": [{"type": "text", "text": m.content}],
            })
        return out

# ---- User message generator from persona + goal ------------------------------
class UserUtteranceGenerator:
    def __init__(self, client: Optional[OpenAI] = None):
        self.client = client or OpenAI()

    # ---------- Diverse initial message ----------
    def generate_initial(self, persona: UserPersona, goal: ConversationGoal) -> str:
        """
        Diverse first USER message via soft cues + jittered sampling,
        and post-filtering to avoid overused anchors. Output is sanitized
        to remove any leading role tags.
        """
        style_cues = [
            "open decisively",
            "be curious and practical",
            "sound slightly skeptical",
            "be concise but concrete",
            "lean on personal taste a bit",
            "hint at a small time window",
            "prefer a fresh angle",
        ]
        task_cues = [
            "ask for a comparison",
            "request a short plan",
            "ask for a quick fact-check",
            "seek a few strong options",
            "ask how to dig deeper",
            "probe for pitfalls to avoid",
        ]
        genre_cues = [
            "sci-fi", "noir", "thriller", "drama", "rom-com",
            "animation", "documentary", "biopic", "mystery", "crime",
        ]
        avoid_overused = [
            "Inception", "INCEPTION", "Christopher Nolan", "Nolan",
            "Interstellar", "The Godfather", "Pulp Fiction", "Star Wars",
        ]
        film_anchors = [
            "Arrival", "Sicario", "Zodiac", "Prisoners", "Blade Runner 2049",
            "The Social Network", "Parasite", "Mad Max: Fury Road",
            "Whiplash", "Gone Girl", "Her", "Ex Machina",
            "La La Land", "Spotlight", "The Big Short",
            "Everything Everywhere All at Once", "Dune", "Oppenheimer",
        ]

        tone_bits = []
        if persona.patience < 0.35:
            tone_bits.append("impatient vibe")
        if persona.verbosity > 0.7:
            tone_bits.append("slightly wordier than average")
        if persona.clarity_of_communication < 0.4:
            tone_bits.append("a hint of ambiguity")
        if not tone_bits:
            tone_bits.append("neutral and focused")

        style = random.choice(style_cues)
        task = random.choice(task_cues)
        genre = random.choice(genre_cues)
        anchor = random.choice(film_anchors)
        nonce = uuid.uuid4().hex[:8]

        system_prompt = f"""
You are simulating a user in a dialogue with a Film Research Assistant.

Persona:
- {persona.name}: {persona.description}

User’s general vibe: {", ".join(tone_bits)}.
Inspiration cues (optional): style={style}, task={task}, genre={genre}, anchor={anchor}.
Session seed: {nonce}.
""".strip()

        user_prompt = f"""
The user wants to make progress toward this goal: “{goal.description}”
Domain: {goal.domain}; Complexity: {goal.complexity}.

Write a natural opening message consistent with the persona and the inspiration cues above.
Keep it organic; feel free to re-interpret the cues. Avoid meta-talk.
""".strip()

        def jitter(base: float, spread: float, lo: float, hi: float) -> float:
            return max(lo, min(hi, random.uniform(base - spread, base + spread)))

        temperature = jitter(INITIAL_TEMP_BASE, 0.25, 0.7, 1.6)
        top_p = jitter(INITIAL_TOP_P_BASE, 0.07, 0.80, 1.0)
        presence = jitter(INITIAL_PRESENCE_BASE, 0.25, 0.0, 1.2)
        freq = jitter(INITIAL_FREQUENCY_BASE, 0.20, 0.0, 1.0)
        n = max(1, min(8, INITIAL_N))

        logger.info("USER-SIM: generating INITIAL user message", extra={"_": {
            "model": USER_SIM_MODEL,
            "persona_id": persona.id,
            "goal_id": goal.id,
            "system_preview": _truncate_text(system_prompt, 600),
            "user_prompt_preview": _truncate_text(user_prompt, 600),
            "cues": {"style": style, "task": task, "genre": genre, "anchor": anchor},
            "nonce": nonce,
            "temp": temperature, "top_p": top_p, "presence": presence, "frequency": freq, "n": n,
        }})

        t0 = time.time()
        resp = self.client.chat.completions.create(
            model=USER_SIM_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            top_p=top_p,
            presence_penalty=presence,
            frequency_penalty=freq,
            n=n,
            max_tokens=120,
        )
        dt_ms = int((time.time() - t0) * 1000)

        candidates: List[str] = []
        for choice in resp.choices:
            txt = (choice.message.content or "").strip()
            if txt:
                candidates.append(txt)

        def mentions_avoid(x: str) -> bool:
            up = x.upper()
            return any(term.upper() in up for term in avoid_overused)

        diverse = [c for c in candidates if not mentions_avoid(c)]
        picked_raw = random.choice(diverse if diverse else candidates) if candidates else ""
        picked = _strip_leading_role_tags(picked_raw)

        logger.info("USER-SIM: INITIAL response received", extra={"_": {
            "elapsed_ms": dt_ms,
            "candidates": len(candidates),
            "filtered": len(diverse),
            "picked_preview": _truncate_text(picked, 600),
        }})
        return picked

    def generate(self, persona: UserPersona, goal: ConversationGoal, conversation: ConversationState) -> str:
        # A historyból kivesszük a "USER:" / "ASSISTANT:" előtagokat, csak a tartalmat adjuk oda.
        history_text = "\n".join([f"- {m.content}" for m in conversation.messages[-6:]])

        prompt = f"""
You are simulating the USER in a dialogue with a Film Research Assistant.

Persona:
- Name: {persona.name}
- Description: {persona.description}
- Patience: {persona.patience:.2f}
- Expertise: {persona.expertise:.2f}
- Verbosity: {persona.verbosity:.2f}
- Frustration Tolerance: {persona.frustration_tolerance:.2f}
- Clarity: {persona.clarity_of_communication:.2f}
- Technical Level: {persona.technical_level:.2f}

User's Goal:
- {goal.description}
- Domain: {goal.domain}
- Complexity: {goal.complexity}
- Success Criteria: {", ".join(goal.success_criteria)}

Conversation so far (recent excerpts):
{history_text if history_text else "(no prior messages)"}

Write the next USER message that naturally moves toward the goal.
""".strip()

        logger.info("USER-SIM: generating initial/next user message", extra={"_": {
            "model": USER_SIM_MODEL,
            "persona_id": persona.id,
            "goal_id": goal.id,
            "history_last6": _truncate_text(history_text, 800),
            "prompt_preview": _truncate_text(prompt, 1000),
        }})
        t0 = time.time()
        resp = self.client.chat_completions.create(  # type: ignore[attr-defined]
            # NOTE: Some SDKs use chat.completions.create; keep your original if needed:
            # self.client.chat.completions.create(...)
            model=USER_SIM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            top_p=0.95,
            presence_penalty=0.3,
            frequency_penalty=0.1,
            max_tokens=120,
        ) if hasattr(self.client, "chat_completions") else self.client.chat.completions.create(
            model=USER_SIM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            top_p=0.95,
            presence_penalty=0.3,
            frequency_penalty=0.1,
            max_tokens=120,
        )
        dt_ms = int((time.time() - t0) * 1000)
        content_raw = (resp.choices[0].message.content or "").strip()
        content = _strip_leading_role_tags(content_raw)
        logger.info("USER-SIM: response received", extra={"_": {
            "elapsed_ms": dt_ms,
            "output_len": len(content),
            "output_preview": _truncate_text(content, 600),
        }})
        return content

# ---- Call the assistant (Next.js /api/chat) ---------------------------------
def call_assistant(conversation: ConversationState) -> str:
    payload = {"messages": conversation.to_next_messages_payload()}
    logger.info("ASSISTANT CALL → /api/chat", extra={"_": {
        "url": ASSISTANT_CHAT_URL,
        "payload_messages": len(payload["messages"]),
        "payload_preview": _shorten(payload, 800),
    }})
    t0 = time.time()
    r = requests.post(ASSISTANT_CHAT_URL, json=payload, timeout=HTTP_TIMEOUT)
    elapsed_ms = int((time.time() - t0) * 1000)
    try:
        r.raise_for_status()
    except Exception as e:
        logger.error("ASSISTANT CALL failed", extra={"_": {
            "status": r.status_code if r is not None else "n/a",
            "error": str(e),
            "text_preview": _truncate_text(getattr(r, "text", "") or "", 1000),
        }})
        raise
    text = (r.text or "").strip()
    logger.info("ASSISTANT CALL ok", extra={"_": {
        "status": r.status_code,
        "elapsed_ms": elapsed_ms,
        "response_len": len(text),
        "response_preview": _truncate_text(text, 900),
    }})
    return text

# ---- Judge: single call returning per-turn metrics as JSON -------------------
class TurnJudge:
    def __init__(self, client: Optional[OpenAI] = None):
        self.client = client or OpenAI()

    def evaluate_turn(self, conversation: ConversationState, persona: UserPersona, goal: ConversationGoal) -> Dict[str, Any]:
        convo_text = "\n\n".join([f"{str(m.role).upper()}: {m.content}" for m in conversation.messages])
        rubric = """
You are an evaluator. Assess the ASSISTANT's performance from the USER's perspective.

Return STRICT JSON with keys:
{
  "user_satisfaction_score": 0|1|2|3,
  "clarity_score": 0|1|2|3,
  "relevance_score": 0|1|2|3,
  "completeness_score": 0|1|2|3,
  "frustration_incidents": integer >= 0,
  "goal_achieved": true|false,
  "reasoning": "brief rationale (1-3 sentences)"
}

Scoring (0..3):
- Satisfaction: perceived helpfulness & responsiveness.
- Clarity: structure, unambiguity, absence of fluff/hallucination.
- Relevance: alignment with the user's goal; avoids off-topic content.
- Completeness: answers without missing essentials.

Frustration incidents: count moments likely to frustrate the user
(e.g., irrelevant answers, needless deflection, repetitive refusal).
""".strip()
        prompt = f"""
Persona (user): {persona.name} — {persona.description}

Goal: {goal.description}
Success Criteria: {", ".join(goal.success_criteria)}
Domain: {goal.domain}; Complexity: {goal.complexity}

Conversation so far:
{convo_text}

{rubric}
Output JSON only.
""".strip()
        logger.info("JUDGE: evaluating turn", extra={"_": {
            "model": JUDGE_MODEL,
            "persona_id": persona.id,
            "goal_id": goal.id,
            "convo_chars": len(convo_text),
            "convo_preview": _truncate_text(convo_text, 1000),
            "prompt_preview": _truncate_text(prompt, 1000),
        }})
        t0 = time.time()
        resp = self.client.chat.completions.create(
            model=JUDGE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
        )
        dt_ms = int((time.time() - t0) * 1000)
        text = (resp.choices[0].message.content or "").strip()
        logger.info("JUDGE: raw response", extra={"_": {
            "elapsed_ms": dt_ms,
            "raw_len": len(text),
            "raw_preview": _truncate_text(text, 900),
        }})

        # Attempt robust JSON extraction
        parsed: Dict[str, Any]
        try:
            parsed = json.loads(text)
        except Exception:
            m = re.search(r"\{.*\}", text, flags=re.DOTALL)
            if not m:
                logger.warning("JUDGE: JSON not found; returning fallback default")
                return {
                    "user_satisfaction_score": 1,
                    "clarity_score": 1,
                    "relevance_score": 1,
                    "completeness_score": 1,
                    "frustration_incidents": 0,
                    "goal_achieved": False,
                    "reasoning": "Fallback default; could not parse judge JSON.",
                }
            try:
                parsed = json.loads(m.group(0))
            except Exception as e2:
                logger.warning("JUDGE: JSON invalid; returning fallback default", extra={"_": {"error": str(e2)}})
                return {
                    "user_satisfaction_score": 1,
                    "clarity_score": 1,
                    "relevance_score": 1,
                    "completeness_score": 1,
                    "frustration_incidents": 0,
                    "goal_achieved": False,
                    "reasoning": "Fallback default; invalid JSON.",
                }

        logger.info("JUDGE: parsed metrics (0..3 scale)", extra={"_": _shorten(parsed, 800)})
        return parsed

# ---- Orchestrator: full dialog + per-turn metrics ---------------------------
class AssistantConversationRunner:
    def __init__(self, user_gen: Optional[UserUtteranceGenerator] = None, judge: Optional[TurnJudge] = None):
        self.user_gen = user_gen or UserUtteranceGenerator()
        self.judge = judge or TurnJudge()

    def run_dialog(self, persona_id: str, goal_id: str, turns: int = 4) -> Dict[str, Any]:
        logger.info("RUN-START", extra={"_": {"persona_id": persona_id, "goal_id": goal_id, "turns": turns, "chat_url": ASSISTANT_CHAT_URL}})
        if persona_id not in PERSONAS:
            raise ValueError(f"Unknown persona_id: {persona_id}")
        if goal_id not in GOALS:
            raise ValueError(f"Unknown goal_id: {goal_id}")

        persona = PERSONAS[persona_id]
        goal = GOALS[goal_id]
        convo = ConversationState()
        per_turn_metrics: List[Dict[str, Any]] = []
        conversation_turns: List[Dict[str, Any]] = []

        # Initial user utterance (diverse)
        current_user_msg = self.user_gen.generate_initial(persona, goal)
        logger.info("INITIAL USER message generated", extra={"_": {
            "len": len(current_user_msg),
            "preview": _truncate_text(current_user_msg, 600),
        }})
        convo.add("user", current_user_msg)

        for turn_idx in range(1, turns + 1):
            logger.info(f"TURN {turn_idx} → assistant call", extra={"_": {
                "convo_size": len(convo.messages),
                "convo_snapshot": _shorten(_snapshot_convo(convo.messages), 1000),
            }})
            # Assistant response
            assistant_text = call_assistant(convo)
            logger.info(f"TURN {turn_idx} ← assistant response", extra={"_": {
                "len": len(assistant_text),
                "preview": _truncate_text(assistant_text, 900),
            }})
            convo.add("assistant", assistant_text)

            # Judge using full context so far
            raw_metrics = self.judge.evaluate_turn(convo, persona, goal)
            logger.info(f"TURN {turn_idx} JUDGE: raw (0..3) metrics", extra={"_": _shorten(raw_metrics, 800)})

            # Normalize to 0..100
            norm_metrics = dict(raw_metrics)  # copy
            for key in ["user_satisfaction_score", "clarity_score", "relevance_score", "completeness_score"]:
                value = norm_metrics.get(key)
                if isinstance(value, (int, float)):
                    norm_metrics[key] = float(value) / 3 * 100.0
            logger.info(f"TURN {turn_idx} JUDGE: normalized (%)", extra={"_": _shorten(norm_metrics, 800)})

            per_turn_metrics.append(norm_metrics)
            conversation_turns.append(
                {
                    "turn": turn_idx,
                    "user_message": current_user_msg,
                    "assistant_message": assistant_text,
                    "metrics": norm_metrics,
                }
            )

            if bool(norm_metrics.get("goal_achieved")):
                logger.info(f"EARLY-STOP at turn {turn_idx} (goal achieved)")
                break

            # Next user utterance (normal settings)
            current_user_msg = self.user_gen.generate(persona, goal, convo)
            logger.info(f"TURN {turn_idx} → next USER message", extra={"_": {
                "len": len(current_user_msg),
                "preview": _truncate_text(current_user_msg, 600),
            }})
            convo.add("user", current_user_msg)

        result = {
            "persona": persona.id,
            "goal": goal.id,
            "turns_requested": turns,
            "messages": [{"role": m.role, "content": m.content} for m in convo.messages],
            "per_turn_metrics": per_turn_metrics,
            "conversation_turns": conversation_turns,
        }
        logger.info("RUN-END summary", extra={"_": {
            "total_messages": len(convo.messages),
            "turns_recorded": len(conversation_turns),
            "per_turn_metrics_count": len(per_turn_metrics),
        }})
        return result
