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

const POLL_INTERVAL_MS = 2000;

export default function EvaluatePage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationSummary | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<JobProgress>(null);
  const jobIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  return (
    <div className="evaluation-page">
      <div className="evaluation-header">
        <h1>Single-turn Evaluation</h1>
        <p>
          Generate a golden dataset from the shared movie data and evaluate the chat
          responses. Results include correctness and relevance metrics.
        </p>
        <button className="evaluation-button" onClick={runEvaluation} disabled={loading}>
          {loading ? "Running evaluation..." : "Run evaluation"}
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
    </div>
  );
}
