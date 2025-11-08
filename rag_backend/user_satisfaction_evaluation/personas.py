# rag_backend/personas.py
from dataclasses import dataclass
from typing import Dict

@dataclass(frozen=True)
class UserPersona:
    id: str
    name: str
    description: str
    patience: float                  # 0..1 – tolerance for delays/indirection
    expertise: float                 # 0..1 – domain knowledge level
    verbosity: float                 # 0..1 – how verbose the user is
    frustration_tolerance: float     # 0..1 – how much friction the user accepts
    clarity_of_communication: float  # 0..1 – how clearly the user communicates
    technical_level: float           # 0..1 – tendency to ask technical questions

PERSONAS: Dict[str, UserPersona] = {
    "clarification_cooperative": UserPersona(
        id="clarification-cooperative",
        name="Clarification Cooperative",
        description="Helpful user who provides good clarifications when asked.",
        patience=0.8,
        expertise=0.5,
        verbosity=0.6,
        frustration_tolerance=0.7,
        clarity_of_communication=0.8,
        technical_level=0.4,
    ),
    "impatient_minimalist": UserPersona(
        id="impatient-minimalist",
        name="Impatient Minimalist",
        description="Terse, impatient user. Wants quick, concrete answers.",
        patience=0.2,
        expertise=0.6,
        verbosity=0.2,
        frustration_tolerance=0.3,
        clarity_of_communication=0.6,
        technical_level=0.5,
    ),
    "curious_novice": UserPersona(
        id="curious-novice",
        name="Curious Novice",
        description="Curious beginner. Asks many questions, easily wanders, but cooperative.",
        patience=0.7,
        expertise=0.2,
        verbosity=0.8,
        frustration_tolerance=0.6,
        clarity_of_communication=0.5,
        technical_level=0.2,
    ),
}
