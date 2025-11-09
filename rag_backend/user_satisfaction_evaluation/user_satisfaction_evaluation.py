# rag_backend/user_satisfaction_evaluation.py
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from celery.result import AsyncResult
from dataclasses import asdict

from .assistant_client import AssistantConversationRunner
from .personas import PERSONAS
from .goals import GOALS
from celery_app import celery_app

router = APIRouter()

def _summarize_metrics(per_turn: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not per_turn:
        return {
            "goal_achieved_rate": 0.0,
            "avg_satisfaction": 0.0,
            "avg_clarity": 0.0,
            "avg_relevance": 0.0,
            "avg_completeness": 0.0,
            "total_frustration": 0,
        }

    n = len(per_turn)

    def avg(key: str, default: float = 0.0) -> float:
        vals = []
        for m in per_turn:
            v = m.get(key, default)
            if isinstance(v, (int, float)):
                vals.append(float(v))
        return sum(vals) / n if vals else 0.0

    goal_hits = sum(1 for m in per_turn if bool(m.get("goal_achieved")))
    total_frustr = sum(int(m.get("frustration_incidents", 0)) for m in per_turn)

    return {
        "goal_achieved_rate": (goal_hits / n) * 100,
        "avg_satisfaction": avg("user_satisfaction_score"),
        "avg_clarity": avg("clarity_score"),
        "avg_relevance": avg("relevance_score"),
        "avg_completeness": avg("completeness_score"),
        "total_frustration": total_frustr,
    }

def _run_user_satisfaction(
    persona_id: str,
    goal_id: str,
    turns: int,
) -> Dict[str, Any]:
    runner = AssistantConversationRunner()
    result = runner.run_dialog(persona_id=persona_id, goal_id=goal_id, turns=turns)
    summary = _summarize_metrics(result["per_turn_metrics"])
    return {
        "persona": result["persona"],
        "goal": result["goal"],
        "turns_requested": result["turns_requested"],
        "summary": summary,
        "per_turn_metrics": result["per_turn_metrics"],
        "conversation": result["messages"],
        "conversation_turns": result.get("conversation_turns", []),
    }


def _validate_inputs(persona_id: str, goal_id: str, turns: int):
    if persona_id not in PERSONAS:
        raise HTTPException(status_code=400, detail=f"Unknown persona_id: {persona_id}")
    if goal_id not in GOALS:
        raise HTTPException(status_code=400, detail=f"Unknown goal_id: {goal_id}")
    if turns <= 0 or turns > 12:
        raise HTTPException(status_code=400, detail="turns must be in range 1..12")


@celery_app.task(bind=True, name="tasks.user_satisfaction_job")
def user_satisfaction_job(self, persona_id: str, goal_id: str, turns: int):
    result = _run_user_satisfaction(persona_id, goal_id, turns)
    self.update_state(state="SUCCESS", meta=result)
    return result


@router.post("/user-satisfaction-job")
def start_user_satisfaction_job(payload: Dict[str, Any]):
    persona_id = str(payload.get("persona_id", "clarification_cooperative"))
    goal_id = str(payload.get("goal_id", "specific-memory-recall"))
    turns = int(payload.get("turns", 4))
    _validate_inputs(persona_id, goal_id, turns)

    task = user_satisfaction_job.apply_async(
        kwargs={"persona_id": persona_id, "goal_id": goal_id, "turns": turns},
        queue="evalq",
    )
    return {"job_id": task.id}


@router.get("/user-satisfaction-job/{job_id}")
def user_satisfaction_status(job_id: str):
    result = AsyncResult(job_id, app=celery_app)
    state = result.state

    if state == "PENDING":
        return {"status": "PENDING"}
    if state in {"STARTED", "RETRY"}:
        return {"status": state}
    if state == "PROGRESS":
        meta = result.info if isinstance(result.info, dict) else {}
        return {"status": "PROGRESS", "progress": meta}
    if state == "SUCCESS":
        return {"status": "SUCCESS", "result": result.result}

    error_text = str(result.info) if result.info else "Unknown error"
    return {"status": "FAILURE", "error": error_text}


@router.post("/evaluate-user-satisfaction")
def evaluate_user_satisfaction(payload: Dict[str, Any]):
    persona_id = str(payload.get("persona_id", "clarification_cooperative"))
    goal_id = str(payload.get("goal_id", "specific-memory-recall"))
    turns = int(payload.get("turns", 4))
    _validate_inputs(persona_id, goal_id, turns)
    return _run_user_satisfaction(persona_id, goal_id, turns)


@router.get("/user-satisfaction/personas")
def list_personas():
    return {
        "personas": [
            {**data, "slug": data.get("id"), "id": key}
            for key, persona in PERSONAS.items()
            for data in (asdict(persona),)
        ]
    }


@router.get("/user-satisfaction/goals")
def list_goals():
    return {
        "goals": [
            {**data, "slug": data.get("id"), "id": key}
            for key, goal in GOALS.items()
            for data in (asdict(goal),)
        ]
    }
