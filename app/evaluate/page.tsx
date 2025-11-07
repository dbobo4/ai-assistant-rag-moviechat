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

  const startEvaluation = useCallback(async () => {
    const response = await fetch("/api/evaluate/start", { method: "POST" });
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
      const jobId = await startEvaluation();
      jobIdRef.current = jobId;
      setStatus("PENDING");
      setProgress(null);
      pollStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      setLoading(false);
    }
  }, [pollStatus, resetState, startEvaluation]);

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
        <button className="evaluation-button" onClick={runEvaluation} disabled={loading}>
          {loading ? "Running evaluation..." : "Start Single-turn evaluation"}
        </button>
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
    </div>
  );
}
