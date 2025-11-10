"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type EvaluationDetail = {
  source: string;
  question: string;
  ground_truth: string;
  candidate: string;
  correctness: { decision: string; reasoning: string };
  relevance: { decision: string; reasoning: string };
};

type EvaluationSummary = {
  total: number;
  correct: number;
  accuracy: number;
  relevant: number;
  relevance_rate: number;
  details: EvaluationDetail[];
};

type JobProgress = { i?: number; of?: number; phase?: string } | null;

type JobStatusResponse =
  | { status: "PENDING" | "STARTED" }
  | { status: "PROGRESS"; progress?: JobProgress }
  | { status: "SUCCESS"; result: EvaluationSummary }
  | { status: "FAILURE"; error?: string };

type RagDetail = {
  source_chunk_index: number;
  generated_query: string;
  retrieved_chunk_indices: number[];
  match: boolean;
  source_preview: string;
  result_preview: string;
};

type RagMetrics = {
  precision: number;
  recall: number;
  f1_score: number;
  total_queries: number;
  relevant_retrieved: number;
};

type RagSummary = {
  metrics: RagMetrics;
  details: RagDetail[];
};

type RagStatusResponse =
  | { status: "PENDING" | "STARTED" }
  | { status: "PROGRESS"; progress?: JobProgress }
  | { status: "SUCCESS"; result: RagSummary }
  | { status: "FAILURE"; error?: string };

type UserEvalSummary = {
  persona: string;
  goal: string;
  turns_requested: number;
  summary: {
    goal_achieved_rate: number;
    avg_satisfaction: number;
    avg_clarity: number;
    avg_relevance: number;
    avg_completeness: number;
    total_frustration: number;
  };
  per_turn_metrics: Array<Record<string, any>>;
  conversation_turns: Array<{
    turn: number;
    user_message: string;
    assistant_message: string;
    metrics: Record<string, any>;
  }>;
};

type UserEvalStatusResponse =
  | { status: "PENDING" | "STARTED" }
  | { status: "PROGRESS"; progress?: JobProgress }
  | { status: "SUCCESS"; result: UserEvalSummary }
  | { status: "FAILURE"; error?: string };

type PersonaOption = {
  id: string;
  name?: string;
  title?: string;
  label?: string;
  display_name?: string;
  description?: string;
  summary?: string;
  persona_name?: string;
  persona_description?: string;
  [key: string]: unknown;
};

type GoalOption = {
  id: string;
  name?: string;
  title?: string;
  label?: string;
  display_name?: string;
  description?: string;
  summary?: string;
  goal_description?: string;
  goal_name?: string;
  [key: string]: unknown;
};

type EvaluateMetadataResponse = {
  personas?: Record<string, PersonaOption> | Array<PersonaOption & { id?: string }>;
  goals?: Record<string, GoalOption> | Array<GoalOption & { id?: string }>;
};

type MetadataPayload<T extends Record<string, any>> =
  | Record<string, T>
  | Array<T & { id?: string }>;

function normalizeMetadata<T extends Record<string, any>>(
  input?: MetadataPayload<T>
): Array<T & { id: string }> {
  if (!input) return [];

  const items = Array.isArray(input)
    ? input
    : Object.entries(input).map(([id, value]) => ({ ...value, id }));

  return items
    .map((item) => {
      const id =
        item.id ??
        (item as { slug?: string }).slug ??
        (item as { key?: string }).key ??
        (item as { persona_id?: string }).persona_id ??
        (item as { goal_id?: string }).goal_id ??
        (item as { identifier?: string }).identifier;
      if (!id) {
        return null;
      }
      return { ...item, id };
    })
    .filter((item): item is T & { id: string } => Boolean(item));
}

function getPersonaLabel(persona: PersonaOption): string {
  return (
    (persona.name as string | undefined) ??
    (persona.title as string | undefined) ??
    (persona.display_name as string | undefined) ??
    (persona.label as string | undefined) ??
    (persona.persona_name as string | undefined) ??
    persona.id
  );
}

function getPersonaDescription(persona: PersonaOption): string | undefined {
  return (
    (persona.description as string | undefined) ??
    (persona.summary as string | undefined) ??
    (persona.persona_description as string | undefined)
  );
}

function getGoalLabel(goal: GoalOption): string {
  return (
    (goal.name as string | undefined) ??
    (goal.title as string | undefined) ??
    (goal.display_name as string | undefined) ??
    (goal.label as string | undefined) ??
    (goal.goal_name as string | undefined) ??
    goal.id
  );
}

function getGoalDescription(goal: GoalOption): string | undefined {
  return (
    (goal.description as string | undefined) ??
    (goal.summary as string | undefined) ??
    (goal.goal_description as string | undefined)
  );
}

const POLL_INTERVAL_MS = 2000;
const DEFAULT_RAG_SAMPLE = Number(process.env.NEXT_PUBLIC_RAG_LEVEL_SAMPLE_CHUNKS ?? "20");
const DEFAULT_RAG_TOPK = Number(process.env.NEXT_PUBLIC_RAG_LEVEL_TOP_K ?? "5");

export default function EvaluatePage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationSummary | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<JobProgress>(null);
  const jobIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [ragSampleSize, setRagSampleSize] = useState(DEFAULT_RAG_SAMPLE);
  const [ragTopK, setRagTopK] = useState(DEFAULT_RAG_TOPK);
  const [ragLoading, setRagLoading] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);
  const [ragStatus, setRagStatus] = useState<string | null>(null);
  const [ragProgress, setRagProgress] = useState<JobProgress>(null);
  const [ragResult, setRagResult] = useState<RagSummary | null>(null);
  const ragJobIdRef = useRef<string | null>(null);
  const ragAbortRef = useRef<AbortController | null>(null);
  const ragTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [fileCount, setFileCount] = useState(1);

  const [personaOptions, setPersonaOptions] = useState<PersonaOption[]>([]);
  const [goalOptions, setGoalOptions] = useState<GoalOption[]>([]);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [personaId, setPersonaId] = useState("clarification_cooperative");
  const [goalId, setGoalId] = useState("specific-memory-recall");
  const [turns, setTurns] = useState(4);
  const [userEvalLoading, setUserEvalLoading] = useState(false);
  const [userEvalError, setUserEvalError] = useState<string | null>(null);
  const [userEvalStatus, setUserEvalStatus] = useState<string | null>(null);
  const [userEvalProgress, setUserEvalProgress] = useState<JobProgress>(null);
  const [userEvalResult, setUserEvalResult] = useState<UserEvalSummary | null>(null);
  const userEvalJobRef = useRef<string | null>(null);
  const userEvalAbortRef = useRef<AbortController | null>(null);
  const userEvalTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const resetState = useCallback(() => {
    setResult(null);
    setError(null);
    setStatus(null);
    setProgress(null);
    setLoading(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    jobIdRef.current = null;
  }, []);

  useEffect(() => () => resetState(), [resetState]);

  const pollStatus = useCallback(async () => {
    const jobId = jobIdRef.current;
    if (!jobId) return;

    try {
      const controller = abortRef.current ?? new AbortController();
      abortRef.current = controller;
      const res = await fetch(`/api/evaluate/status?jobId=${encodeURIComponent(jobId)}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to fetch job status");
      }

      const data = (await res.json()) as JobStatusResponse;
      abortRef.current = null;
      setStatus(data.status);

      if (data.status === "PROGRESS" && "progress" in data) {
        setProgress(data.progress ?? null);
      }

      if (data.status === "SUCCESS" && "result" in data) {
        setResult(data.result);
        setLoading(false);
        setProgress(null);
        timeoutRef.current = null;
        abortRef.current = null;
        return;
      }

      if (data.status === "FAILURE" && "error" in data) {
        setError(data.error || "Evaluation failed");
        setLoading(false);
        setProgress(null);
        timeoutRef.current = null;
        abortRef.current = null;
        return;
      }

      timeoutRef.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      setLoading(false);
    }
  }, []);

  const startEvaluation = useCallback(async (options?: { fileCount?: number }) => {
    const normalizedCount = Math.max(1, Math.floor(options?.fileCount ?? 1));
    const response = await fetch("/api/evaluate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileCount: normalizedCount }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "Evaluation start failed");
    }
    const data = (await response.json()) as { jobId: string };
    return data.jobId;
  }, []);

  const runEvaluation = useCallback(async () => {
    resetState();
    setLoading(true);

    try {
      const jobId = await startEvaluation({ fileCount });
      jobIdRef.current = jobId;
      setStatus("PENDING");
      setProgress(null);
      pollStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      setLoading(false);
    }
  }, [fileCount, pollStatus, resetState, startEvaluation]);

  const resetRagState = useCallback(() => {
    setRagResult(null);
    setRagError(null);
    setRagStatus(null);
    setRagProgress(null);
    setRagLoading(false);
    if (ragTimeoutRef.current) {
      clearTimeout(ragTimeoutRef.current);
      ragTimeoutRef.current = null;
    }
    if (ragAbortRef.current) {
      ragAbortRef.current.abort();
      ragAbortRef.current = null;
    }
    ragJobIdRef.current = null;
  }, []);

  useEffect(() => () => resetRagState(), [resetRagState]);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    let retryTimer: NodeJS.Timeout | null = null;

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    async function loadMetadata() {
      const MAX_ATTEMPTS = 10;
      const RETRY_DELAY_MS = 5000;
      setMetaLoading(true);
      setMetaError(null);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch("/api/evaluate", {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || "Failed to load evaluation metadata");
          }
          const data = (await res.json()) as EvaluateMetadataResponse;
          if (!mounted) {
            return;
          }
          const personaList = normalizeMetadata(data.personas);
          const goalList = normalizeMetadata(data.goals);
          setPersonaOptions(personaList);
          setGoalOptions(goalList);
          setPersonaId((prev) => {
            if (personaList.length === 0) return prev;
            return personaList.some((option) => option.id === prev) ? prev : personaList[0].id;
          });
          setGoalId((prev) => {
            if (goalList.length === 0) return prev;
            return goalList.some((option) => option.id === prev) ? prev : goalList[0].id;
          });
          setMetaLoading(false);
          return;
        } catch (error) {
          const isAbort =
            (error as Error).name === "AbortError" || controller.signal.aborted || !mounted;
          if (isAbort) {
            clearRetryTimer();
            if (mounted) {
              setMetaLoading(false);
            }
            return;
          }

          if (attempt === MAX_ATTEMPTS) {
            if (mounted) {
              setMetaError("Failed to load persona/goal metadata: Failed to fetch");
              setMetaLoading(false);
            }
            return;
          }

          await new Promise<void>((resolve) => {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              resolve();
            }, RETRY_DELAY_MS);
          });
        }
      }
    }

    loadMetadata();

    return () => {
      mounted = false;
      clearRetryTimer();
      controller.abort();
    };
  }, []);

  const startRagEvaluation = useCallback(async () => {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "rag-level",
        sampleSize: ragSampleSize,
        topK: ragTopK,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "RAG-level evaluation start failed");
    }
    const data = (await response.json()) as { jobId: string };
    return data.jobId;
  }, [ragSampleSize, ragTopK]);

  const pollRagStatus = useCallback(async () => {
    const jobId = ragJobIdRef.current;
    if (!jobId) return;

    try {
      const controller = ragAbortRef.current ?? new AbortController();
      ragAbortRef.current = controller;
      const res = await fetch(`/api/evaluate/status?jobId=${encodeURIComponent(jobId)}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to fetch RAG eval status");
      }
      const data = (await res.json()) as RagStatusResponse;
      ragAbortRef.current = null;
      setRagStatus(data.status);

      if (data.status === "PROGRESS" && "progress" in data) {
        setRagProgress(data.progress ?? null);
      }

      if (data.status === "SUCCESS" && "result" in data) {
        setRagResult(data.result);
        setRagLoading(false);
        setRagProgress(null);
        ragTimeoutRef.current = null;
        ragAbortRef.current = null;
        return;
      }

      if (data.status === "FAILURE" && "error" in data) {
        setRagError(data.error || "RAG-level evaluation failed");
        setRagLoading(false);
        setRagProgress(null);
        ragTimeoutRef.current = null;
        ragAbortRef.current = null;
        return;
      }

      ragTimeoutRef.current = setTimeout(pollRagStatus, POLL_INTERVAL_MS);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setRagError(message);
      setRagLoading(false);
    }
  }, []);

  const runRagEvaluation = useCallback(async () => {
    resetRagState();
    setRagLoading(true);

    try {
      const jobId = await startRagEvaluation();
      ragJobIdRef.current = jobId;
      setRagStatus("PENDING");
      setRagProgress(null);
      pollRagStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setRagError(message);
      setRagLoading(false);
    }
  }, [pollRagStatus, resetRagState, startRagEvaluation]);

  const resetUserEvalState = useCallback(() => {
    setUserEvalResult(null);
    setUserEvalError(null);
    setUserEvalStatus(null);
    setUserEvalProgress(null);
    setUserEvalLoading(false);
    if (userEvalTimeoutRef.current) {
      clearTimeout(userEvalTimeoutRef.current);
      userEvalTimeoutRef.current = null;
    }
    if (userEvalAbortRef.current) {
      userEvalAbortRef.current.abort();
      userEvalAbortRef.current = null;
    }
    userEvalJobRef.current = null;
  }, []);

  useEffect(() => () => resetUserEvalState(), [resetUserEvalState]);

  const startUserEvaluation = useCallback(async () => {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "user-satisfaction",
        persona_id: personaId,
        goal_id: goalId,
        turns,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "User satisfaction evaluation start failed");
    }
    const data = (await response.json()) as { jobId: string };
    return data.jobId;
  }, [personaId, goalId, turns]);

  const pollUserEvalStatus = useCallback(async () => {
    const jobId = userEvalJobRef.current;
    if (!jobId) return;

    try {
      const controller = userEvalAbortRef.current ?? new AbortController();
      userEvalAbortRef.current = controller;
      const res = await fetch(`/api/evaluate/status?jobId=${encodeURIComponent(jobId)}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to fetch user eval status");
      }
      const data = (await res.json()) as UserEvalStatusResponse;
      userEvalAbortRef.current = null;
      setUserEvalStatus(data.status);

      if (data.status === "PROGRESS" && "progress" in data) {
        setUserEvalProgress(data.progress ?? null);
      }

      if (data.status === "SUCCESS" && "result" in data) {
        setUserEvalResult(data.result);
        setUserEvalLoading(false);
        setUserEvalProgress(null);
        userEvalTimeoutRef.current = null;
        userEvalAbortRef.current = null;
        return;
      }

      if (data.status === "FAILURE" && "error" in data) {
        setUserEvalError(data.error || "User satisfaction evaluation failed");
        setUserEvalLoading(false);
        setUserEvalProgress(null);
        userEvalTimeoutRef.current = null;
        userEvalAbortRef.current = null;
        return;
      }

      userEvalTimeoutRef.current = setTimeout(pollUserEvalStatus, POLL_INTERVAL_MS);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setUserEvalError(message);
      setUserEvalLoading(false);
    }
  }, []);

  const runUserEvaluation = useCallback(async () => {
    resetUserEvalState();
    setUserEvalLoading(true);

    try {
      const jobId = await startUserEvaluation();
      userEvalJobRef.current = jobId;
      setUserEvalStatus("PENDING");
      setUserEvalProgress(null);
      pollUserEvalStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setUserEvalError(message);
      setUserEvalLoading(false);
    }
  }, [pollUserEvalStatus, resetUserEvalState, startUserEvaluation]);

  return (
    <div className="evaluation-page">
      <div className="evaluation-header">
        <div className="evaluation-header-text">
          <h1>Single-turn Evaluation</h1>
          <p>
            Generate a golden dataset from the shared movie data and evaluate the chat responses. Results include
            correctness and relevance metrics.
          </p>
        </div>
        <div className="rag-inputs">
          <label>
            <span>Files to evaluate</span>
            <input
              type="number"
              min={1}
              value={fileCount}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (!Number.isFinite(nextValue) || nextValue <= 0) {
                  setFileCount(1);
                } else {
                  setFileCount(Math.floor(nextValue));
                }
              }}
            />
          </label>
          <button className="evaluation-button" onClick={runEvaluation} disabled={loading}>
            {loading ? "Running evaluation..." : "Start Single-turn evaluation"}
          </button>
        </div>
        {error && <div className="evaluation-error">Error: {error}</div>}
        {loading && status && (
          <div className="evaluation-progress">
            Status: {status}
            {progress?.i !== undefined && progress?.of ? (
              <span>
                {" "}- {progress.i}/{progress.of}
                {progress.phase ? ` (${progress.phase})` : ""}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {result && (
        <div className="evaluation-results">
          <div className="evaluation-summary">
            <div>
              <span className="summary-label">Total:</span> {result.total}
            </div>
            <div>
              <span className="summary-label">Correct:</span> {result.correct} (
              {(result.accuracy * 100).toFixed(1)}%)
            </div>
            <div>
              <span className="summary-label">Relevant:</span> {result.relevant} (
              {(result.relevance_rate * 100).toFixed(1)}%)
            </div>
          </div>

          <div className="evaluation-table-wrapper">
            <table className="evaluation-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Question</th>
                  <th>Ground truth</th>
                  <th>Candidate</th>
                  <th>Correctness</th>
                  <th>Relevance</th>
                </tr>
              </thead>
              <tbody>
                {result.details.map((detail, index) => (
                  <tr key={index}>
                    <td>{detail.source}</td>
                    <td>{detail.question}</td>
                    <td>{detail.ground_truth}</td>
                    <td>{detail.candidate}</td>
                    <td>
                      <div className="decision">
                        <span className="decision-label">{detail.correctness.decision}</span>
                        <span className="decision-reason">{detail.correctness.reasoning}</span>
                      </div>
                    </td>
                    <td>
                      <div className="decision">
                        <span className="decision-label">{detail.relevance.decision}</span>
                        <span className="decision-reason">{detail.relevance.reasoning}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="evaluation-section">
        <div className="evaluation-header rag-header">
          <div className="evaluation-header-text">
            <h1>RAG-level (Retriever) Evaluation</h1>
            <p>
              Validate the retriever by generating queries from random chunks and ensuring the original chunk appears in
              the top-K search results.
            </p>
          </div>
          <div className="rag-inputs">
            <label>
              <span>Sample size (chunks)</span>
              <input
                type="number"
                min={1}
                value={ragSampleSize}
                onChange={(event) => setRagSampleSize(Number(event.target.value))}
              />
            </label>
            <label>
              <span>Top-K</span>
              <input
                type="number"
                min={1}
                value={ragTopK}
                onChange={(event) => setRagTopK(Number(event.target.value))}
              />
            </label>
            <button className="evaluation-button" onClick={runRagEvaluation} disabled={ragLoading}>
              {ragLoading ? "Running RAG evaluation..." : "Start RAG-level evaluation"}
            </button>
          </div>
        </div>

        {ragError && <div className="evaluation-error">Error: {ragError}</div>}
        {ragLoading && ragStatus && (
          <div className="evaluation-progress">
            Status: {ragStatus}
            {ragProgress?.i !== undefined && ragProgress?.of ? (
              <span>
                {" "}- {ragProgress.i}/{ragProgress.of}
                {ragProgress.phase ? ` (${ragProgress.phase})` : ""}
              </span>
            ) : null}
          </div>
        )}

      {ragResult && (
        <div className="evaluation-results">
            <div className="evaluation-summary">
              <div>
                <span className="summary-label">Precision:</span>{" "}
                {(ragResult.metrics.precision * 100).toFixed(1)}%
              </div>
              <div>
                <span className="summary-label">Recall:</span> {(ragResult.metrics.recall * 100).toFixed(1)}%
              </div>
              <div>
                <span className="summary-label">F1 Score:</span> {(ragResult.metrics.f1_score * 100).toFixed(1)}%
              </div>
              <div>
                <span className="summary-label">Total queries:</span> {ragResult.metrics.total_queries}
              </div>
              <div>
                <span className="summary-label">Relevant retrieved:</span> {ragResult.metrics.relevant_retrieved}
              </div>
            </div>

            <div className="evaluation-table-wrapper">
              <table className="evaluation-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Chunk index</th>
                    <th>Generated query</th>
                    <th>Match</th>
                    <th>Retrieved indices</th>
                    <th>Source preview</th>
                    <th>Result preview</th>
                  </tr>
                </thead>
                <tbody>
                  {ragResult.details.map((detail, index) => (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>{detail.source_chunk_index}</td>
                      <td>{detail.generated_query}</td>
                      <td>
                        <span className={`decision-label ${detail.match ? "decision-correct" : "decision-incorrect"}`}>
                          {detail.match ? "✓" : "✗"}
                        </span>
                      </td>
                      <td>{detail.retrieved_chunk_indices.join(", ")}</td>
                      <td>{detail.source_preview}</td>
                      <td>{detail.result_preview}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="evaluation-section">
        <div className="evaluation-header rag-header">
          <div className="evaluation-header-text">
            <h1>User Satisfaction Evaluation</h1>
            <p>
              Simulate personas with specific goals, run multi-turn conversations, and judge the assistant from the
              user’s perspective.
            </p>
          </div>
          <div className="rag-inputs user-eval-inputs">
            <label>
              <span>Persona</span>
              <select
                value={personaId}
                onChange={(event) => setPersonaId(event.target.value)}
                disabled={metaLoading && personaOptions.length === 0}
              >
                {personaOptions.length === 0 ? (
                  <option value={personaId}>{metaLoading ? "Loading personas..." : personaId}</option>
                ) : (
                  personaOptions.map((persona) => (
                    <option
                      key={persona.id}
                      value={persona.id}
                      title={getPersonaDescription(persona) ?? ""}
                    >
                      {getPersonaLabel(persona)}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label>
              <span>Goal</span>
              <select
                value={goalId}
                onChange={(event) => setGoalId(event.target.value)}
                disabled={metaLoading && goalOptions.length === 0}
              >
                {goalOptions.length === 0 ? (
                  <option value={goalId}>{metaLoading ? "Loading goals..." : goalId}</option>
                ) : (
                  goalOptions.map((goal) => (
                    <option key={goal.id} value={goal.id} title={getGoalDescription(goal) ?? ""}>
                      {getGoalLabel(goal)}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label>
              <span>Turns</span>
              <input
                type="number"
                min={1}
                max={12}
                value={turns}
                onChange={(event) => setTurns(Number(event.target.value))}
              />
            </label>
            <button className="evaluation-button" onClick={runUserEvaluation} disabled={userEvalLoading}>
              {userEvalLoading ? "Running user evaluation..." : "Start User satisfaction evaluation"}
            </button>
          </div>
        </div>

        {metaError && (
          <div className="evaluation-error">Failed to load persona/goal metadata: {metaError}</div>
        )}

        {userEvalError && <div className="evaluation-error">Error: {userEvalError}</div>}
        {userEvalLoading && userEvalStatus && (
          <div className="evaluation-progress">
            Status: {userEvalStatus}
            {userEvalProgress?.i !== undefined && userEvalProgress?.of ? (
              <span>
                {" "}- {userEvalProgress.i}/{userEvalProgress.of}
                {userEvalProgress.phase ? ` (${userEvalProgress.phase})` : ""}
              </span>
            ) : null}
          </div>
        )}

        {userEvalResult && (
          <div className="evaluation-results">
            <div className="evaluation-summary">
              <div>
                <span className="summary-label">Goal achieved:</span>{" "}
                {userEvalResult.summary.goal_achieved_rate.toFixed(1)}%
              </div>
              <div>
                <span className="summary-label">Avg satisfaction:</span>{" "}
                {userEvalResult.summary.avg_satisfaction.toFixed(1)}%
              </div>
              <div>
                <span className="summary-label">Avg clarity:</span>{" "}
                {userEvalResult.summary.avg_clarity.toFixed(1)}%
              </div>
              <div>
                <span className="summary-label">Avg relevance:</span>{" "}
                {userEvalResult.summary.avg_relevance.toFixed(1)}%
              </div>
              <div>
                <span className="summary-label">Avg completeness:</span>{" "}
                {userEvalResult.summary.avg_completeness.toFixed(1)}%
              </div>
              <div>
                <span className="summary-label">Total frustration:</span>{" "}
                {userEvalResult.summary.total_frustration}
              </div>
            </div>

            <div className="evaluation-table-wrapper">
              <table className="evaluation-table">
                <thead>
                  <tr>
                    <th>Turn</th>
                    <th>User</th>
                    <th>Assistant</th>
                    <th>Satisfaction</th>
                    <th>Clarity</th>
                    <th>Relevance</th>
                    <th>Completeness</th>
                  </tr>
                </thead>
                <tbody>
                  {userEvalResult.conversation_turns.map((turn) => (
                    <tr key={turn.turn}>
                      <td>{turn.turn}</td>
                      <td>{turn.user_message}</td>
                      <td>{turn.assistant_message}</td>
                      <td>
                        {turn.metrics?.user_satisfaction_score !== undefined
                          ? `${Number(turn.metrics.user_satisfaction_score).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td>
                        {turn.metrics?.clarity_score !== undefined
                          ? `${Number(turn.metrics.clarity_score).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td>
                        {turn.metrics?.relevance_score !== undefined
                          ? `${Number(turn.metrics.relevance_score).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td>
                        {turn.metrics?.completeness_score !== undefined
                          ? `${Number(turn.metrics.completeness_score).toFixed(2)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
