# rag_backend/assistant_client.py
import os
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

import requests
from openai import OpenAI

from .personas import PERSONAS, UserPersona
from .goals import GOALS, ConversationGoal

# ---- Config
ASSISTANT_CHAT_URL = os.getenv("APP_CHAT_URL", "http://app:3000/api/chat")
USER_SIM_MODEL = os.getenv("USER_SIM_MODEL", os.getenv("OPENAI_USER_SIM_MODEL", "gpt-4o-mini"))
JUDGE_MODEL = os.getenv("JUDGE_MODEL", os.getenv("OPENAI_JUDGE_MODEL", "gpt-4o-mini"))
HTTP_TIMEOUT = int(os.getenv("USER_EVAL_HTTP_TIMEOUT", "60"))

# ---- Core structures
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

# ---- User message generator from persona + goal
class UserUtteranceGenerator:
    def __init__(self, client: Optional[OpenAI] = None):
        self.client = client or OpenAI()

    def generate(self, persona: UserPersona, goal: ConversationGoal, conversation: ConversationState) -> str:
        history_text = "\n".join([f"{m.role.upper()}: {m.content}" for m in conversation.messages[-6:]])
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

Conversation so far (last turns):
{history_text if history_text else "(no prior messages)"}

Task:
Write ONLY the next USER message in 1-3 sentences that moves toward the goal,
reflecting the persona traits above. Be practical and direct. Avoid meta-explanations.
Return plain text only.
"""
        resp = self.client.chat.completions.create(
            model=USER_SIM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
        )
        return (resp.choices[0].message.content or "").strip()

# ---- Call the assistant (Next.js /api/chat)
def call_assistant(conversation: ConversationState) -> str:
    payload = {"messages": conversation.to_next_messages_payload()}
    r = requests.post(ASSISTANT_CHAT_URL, json=payload, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    # The endpoint returns text/plain
    return r.text.strip()

# ---- Judge: single call returning per-turn metrics as JSON
class TurnJudge:
    def __init__(self, client: Optional[OpenAI] = None):
        self.client = client or OpenAI()

    def evaluate_turn(self, conversation: ConversationState, persona: UserPersona, goal: ConversationGoal) -> Dict[str, Any]:
        convo_text = "\n\n".join([f"{m.role.upper()}: {m.content}" for m in conversation.messages])
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
"""
        prompt = f"""
Persona (user): {persona.name} — {persona.description}

Goal: {goal.description}
Success Criteria: {", ".join(goal.success_criteria)}
Domain: {goal.domain}; Complexity: {goal.complexity}

Conversation so far:
{convo_text}

{rubric}
Output JSON only.
"""
        resp = self.client.chat.completions.create(
            model=JUDGE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
        )
        text = (resp.choices[0].message.content or "").strip()

        # Attempt robust JSON extraction
        try:
            return json.loads(text)
        except Exception:
            m = re.search(r"\{.*\}", text, flags=re.DOTALL)
            if not m:
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
                return json.loads(m.group(0))
            except Exception:
                return {
                    "user_satisfaction_score": 1,
                    "clarity_score": 1,
                    "relevance_score": 1,
                    "completeness_score": 1,
                    "frustration_incidents": 0,
                    "goal_achieved": False,
                    "reasoning": "Fallback default; invalid JSON.",
                }

# ---- Orchestrator: full dialog + per-turn metrics
class AssistantConversationRunner:
    def __init__(self, user_gen: Optional[UserUtteranceGenerator] = None, judge: Optional[TurnJudge] = None):
        self.user_gen = user_gen or UserUtteranceGenerator()
        self.judge = judge or TurnJudge()

    def run_dialog(self, persona_id: str, goal_id: str, turns: int = 4) -> Dict[str, Any]:
        if persona_id not in PERSONAS:
            raise ValueError(f"Unknown persona_id: {persona_id}")
        if goal_id not in GOALS:
            raise ValueError(f"Unknown goal_id: {goal_id}")

        persona = PERSONAS[persona_id]
        goal = GOALS[goal_id]
        convo = ConversationState()
        per_turn_metrics: List[Dict[str, Any]] = []
        conversation_turns: List[Dict[str, Any]] = []

        # Initial user utterance (simulated)
        current_user_msg = self.user_gen.generate(persona, goal, convo)
        convo.add("user", current_user_msg)

        for turn_idx in range(1, turns + 1):
            # Assistant response
            assistant_text = call_assistant(convo)
            convo.add("assistant", assistant_text)

            # Judge using full context so far
            metrics = self.judge.evaluate_turn(convo, persona, goal)
            per_turn_metrics.append(metrics)
            conversation_turns.append(
                {
                    "turn": turn_idx,
                    "user_message": current_user_msg,
                    "assistant_message": assistant_text,
                    "metrics": metrics,
                }
            )

            # Optional early stop when goal achieved
            if bool(metrics.get("goal_achieved")):
                break

            # Next user utterance
            current_user_msg = self.user_gen.generate(persona, goal, convo)
            convo.add("user", current_user_msg)

        return {
            "persona": persona.id,
            "goal": goal.id,
            "turns_requested": turns,
            "messages": [{"role": m.role, "content": m.content} for m in convo.messages],
            "per_turn_metrics": per_turn_metrics,
            "conversation_turns": conversation_turns,
        }
