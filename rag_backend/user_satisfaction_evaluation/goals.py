# rag_backend/goals.py
from dataclasses import dataclass
from typing import Dict, List

@dataclass(frozen=True)
class ConversationGoal:
    id: str
    description: str
    success_criteria: List[str]
    domain: str
    complexity: str  # "simple" | "moderate" | "complex"

GOALS: Dict[str, ConversationGoal] = {
    "specific-memory-recall": ConversationGoal(
        id="specific-memory-recall",
        description="Request a specific stored film fact (e.g., a movie’s release year or lead actor).",
        success_criteria=[
            "Assistant immediately searches for relevant knowledge.",
            "Assistant provides the memory if found or clearly explains if not.",
            "No unnecessary clarification for a clear query.",
        ],
        domain="film",
        complexity="simple",
    ),
    "multi-turn-disambiguation": ConversationGoal(
        id="multi-turn-disambiguation",
        description="In a multi-turn dialog, clarify an ambiguous film request and deliver a precise answer.",
        success_criteria=[
            "Assistant asks at most one short clarification when critical info is missing.",
            "Assistant ultimately provides a precise answer to the original intent.",
            "Avoids speculation; relies only on tool-returned data.",
        ],
        domain="film",
        complexity="moderate",
    ),
    "preference-storage-accuracy": ConversationGoal(
        id="preference-storage-accuracy",
        description="Capture user film preference (favorite genre/actor) and echo it back accurately later.",
        success_criteria=[
            "Assistant detects that a preference statement was given.",
            "Stores it (addResource) and later recalls it consistently without distortion.",
            "Does not conflate differing preferences.",
        ],
        domain="film",
        complexity="moderate",
    ),
}
