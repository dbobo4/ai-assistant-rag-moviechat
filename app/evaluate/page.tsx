"use client";

import { useState } from "react";

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

export default function EvaluatePage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationSummary | null>(null);

  async function runEvaluation() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/evaluate", { method: "POST" });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Evaluation failed");
      }

      const data = (await response.json()) as EvaluationSummary;
      setResult(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="evaluation-page">
      <div className="evaluation-header">
        <h1>Single-turn Evaluation</h1>
        <p>
          Generate a golden dataset from the shared movie data and evaluate the chat
          responses. Results include correctness and relevance metrics.
        </p>
        <button
          className="evaluation-button"
          onClick={runEvaluation}
          disabled={loading}
        >
          {loading ? "Running evaluation..." : "Run evaluation"}
        </button>
        {error && <div className="evaluation-error">Error: {error}</div>}
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
                        <span className="decision-label">
                          {detail.correctness.decision}
                        </span>
                        <span className="decision-reason">
                          {detail.correctness.reasoning}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="decision">
                        <span className="decision-label">
                          {detail.relevance.decision}
                        </span>
                        <span className="decision-reason">
                          {detail.relevance.reasoning}
                        </span>
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
