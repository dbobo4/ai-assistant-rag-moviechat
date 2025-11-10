"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type BucketPrecision = "hour" | "minute" | "second";

type MonitoringPoint = {
  bucket: string;
  origin: string;
  totalTokens: number;
  avgLatencyMs: number | null;
  totalLatencyMs: number;
  eventCount: number;
};

type OriginAggregate = {
  points: MonitoringPoint[];
  totals: {
    totalTokens: number;
    totalLatencyMs: number;
    totalEvents: number;
  };
};

type MonitoringResponse = {
  range: { since: string; days: number };
  bucketPrecision: BucketPrecision;
  points: MonitoringPoint[];
  origins?: Record<string, OriginAggregate>;
};

type ChartSeries = {
  origin: string;
  color: string;
  values: Array<{ time: number; value: number }>;
  totalTokens?: number;
  eventCount?: number;
  averageLatency?: number;
};

type MonitoringSummary = {
  buckets: number[];
  precision: BucketPrecision;
  totalTokens: number;
  totalEvents: number;
  originCount: number;
  averageLatency: number;
};

type OriginSectionData = {
  origin: string;
  title: string;
  description: string;
  color: string;
  hasData: boolean;
  summary: {
    totalTokens: number;
    totalEvents: number;
    averageLatency: number;
  };
  tokensChart: ChartView;
  latencyChart: ChartView;
};

type MonitoringViewModel = {
  summary: MonitoringSummary;
  sections: OriginSectionData[];
};

const COLOR_PALETTE = [
  "#60a5fa",
  "#34d399",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#fb7185",
  "#2dd4bf",
];

const RANGE_OPTIONS = [1, 3, 7, 14, 30];
const BUCKET_OPTIONS: { value: BucketPrecision; label: string }[] = [
  { value: "hour", label: "Per hour" },
  { value: "minute", label: "Per minute" },
  { value: "second", label: "Per second" },
];
const GRID_LINES = 4;
const ORIGIN_ORDER = ["chat", "upload"];
const ORIGIN_COPY: Record<
  string,
  {
    title: string;
    description: string;
  }
> = {
  chat: {
    title: "Chat monitoring",
    description: "Requests coming from the conversational assistant.",
  },
  upload: {
    title: "Upload monitoring",
    description: "Embedding jobs triggered by document uploads.",
  },
};

export default function MonitoringPage() {
  const [days, setDays] = useState(7);
  const [bucketPrecision, setBucketPrecision] = useState<BucketPrecision>("hour");
  const [data, setData] = useState<MonitoringResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          days: String(days),
          bucket: bucketPrecision,
        });
        const res = await fetch(`/api/monitoring?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Failed to load monitoring data");
        }
        const json = (await res.json()) as MonitoringResponse;
        setData(json);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load monitoring data");
      } finally {
        setLoading(false);
      }
    },
    [days, bucketPrecision]
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData, refreshIndex]);

  const monitoringView = useMemo<MonitoringViewModel | null>(() => {
    if (!data || data.points.length === 0) {
      return null;
    }

    const bucketSet = new Set<number>();
    data.points.forEach((point) => {
      bucketSet.add(new Date(point.bucket).getTime());
    });
    const buckets = Array.from(bucketSet).sort((a, b) => a - b);
    const precision = data.bucketPrecision;

    const totalTokens = data.points.reduce((sum, point) => sum + point.totalTokens, 0);
    const totalEvents = data.points.reduce((sum, point) => sum + point.eventCount, 0);
    const totalLatencyMs = data.points.reduce(
      (sum, point) => sum + point.totalLatencyMs,
      0
    );
    const averageLatency = totalEvents > 0 ? totalLatencyMs / totalEvents : 0;

    const detectedOrigins = new Set<string>(data.points.map((point) => point.origin));
    ORIGIN_ORDER.forEach((origin) => detectedOrigins.add(origin));
    const sortedOrigins = Array.from(detectedOrigins).sort((a, b) => {
      const idxA = ORIGIN_ORDER.indexOf(a);
      const idxB = ORIGIN_ORDER.indexOf(b);
      if (idxA === -1 && idxB === -1) {
        return a.localeCompare(b);
      }
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });

    const sections: OriginSectionData[] = sortedOrigins
      .map((origin, idx) => {
        const aggregate = data.origins?.[origin];
        const originPoints =
          aggregate?.points ?? data.points.filter((point) => point.origin === origin);
        const totals =
          aggregate?.totals ?? {
            totalTokens: originPoints.reduce((sum, point) => sum + point.totalTokens, 0),
            totalLatencyMs: originPoints.reduce(
              (sum, point) => sum + point.totalLatencyMs,
              0
            ),
            totalEvents: originPoints.reduce((sum, point) => sum + point.eventCount, 0),
          };
        const color = COLOR_PALETTE[idx % COLOR_PALETTE.length];
        const hasData = originPoints.length > 0;

        const valueByBucket = new Map<number, number>();
        const latencyByBucket = new Map<number, number>();
        originPoints.forEach((point) => {
          const bucketTime = new Date(point.bucket).getTime();
          valueByBucket.set(bucketTime, point.totalTokens);
          latencyByBucket.set(bucketTime, point.avgLatencyMs ?? 0);
        });

        const tokenValues = buckets.map((bucket) => ({
          time: bucket,
          value: valueByBucket.get(bucket) ?? 0,
        }));
        const latencyValues = buckets.map((bucket) => ({
          time: bucket,
          value: latencyByBucket.get(bucket) ?? 0,
        }));

        const tokensMaxValue = Math.max(1, ...tokenValues.map((v) => v.value));
        const latencyMaxValue = Math.max(1, ...latencyValues.map((v) => v.value));

        const copy = getOriginCopy(origin);
        const averageLatencyByOrigin =
          totals.totalEvents > 0 ? totals.totalLatencyMs / totals.totalEvents : 0;

        const tokensChart: ChartView = {
          buckets,
          precision,
          series: [
            {
              origin,
              color,
              values: tokenValues,
              totalTokens: totals.totalTokens,
              eventCount: totals.totalEvents,
            },
          ],
          maxValue: tokensMaxValue,
          axisTitle: `${copy.title} — tokens (${formatPrecisionLabel(precision)})`,
          yFormatter: (value) => formatNumber(value),
        };

        const latencyChart: ChartView = {
          buckets,
          precision,
          series: [
            {
              origin,
              color,
              values: latencyValues,
              averageLatency: averageLatencyByOrigin,
            },
          ],
          maxValue: latencyMaxValue,
          axisTitle: `${copy.title} — latency (ms)`,
          yFormatter: (value) => formatLatency(value, { withUnit: true }),
        };

        return {
          origin,
          title: copy.title,
          description: copy.description,
          color,
          hasData,
          summary: {
            totalTokens: totals.totalTokens,
            totalEvents: totals.totalEvents,
            averageLatency: averageLatencyByOrigin,
          },
          tokensChart,
          latencyChart,
        };
      })
      .filter((section) => section.hasData || ORIGIN_ORDER.includes(section.origin));

    return {
      summary: {
        buckets,
        precision,
        totalTokens,
        totalEvents,
        originCount: new Set(data.points.map((point) => point.origin)).size,
        averageLatency,
      },
      sections,
    };
  }, [data]);

  const handleRefresh = useCallback(() => setRefreshIndex((prev) => prev + 1), []);

  return (
    <div className="evaluation-page monitoring-page">
      <div className="evaluation-section">
        <div className="evaluation-header">
          <div className="evaluation-header-text">
            <h1>Monitoring Dashboard</h1>
            <p>
              Track token usage per origin (chat vs. upload) and catch anomalies in latency or
              request volume.
            </p>
          </div>
          <div className="rag-inputs monitoring-controls">
            <label>
              <span>Range (days)</span>
              <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                {RANGE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    Last {option} day{option === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Resolution</span>
              <select
                value={bucketPrecision}
                onChange={(event) => setBucketPrecision(event.target.value as BucketPrecision)}
              >
                {BUCKET_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button className="evaluation-button" onClick={handleRefresh} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {error && <div className="evaluation-error">{error}</div>}
        {!error && loading && (
          <div className="evaluation-results">Loading monitoring data…</div>
        )}

        {!error && !loading && monitoringView === null && (
          <div className="evaluation-results">No monitoring data available for this range.</div>
        )}

        {!error && monitoringView && (
          <>
            <div className="evaluation-summary monitoring-summary">
              <div>
                <span className="summary-label">Total tokens</span>
                {formatNumber(monitoringView.summary.totalTokens)}
              </div>
              <div>
                <span className="summary-label">Total events</span>
                {formatNumber(monitoringView.summary.totalEvents)}
              </div>
              <div>
                <span className="summary-label">Origins</span>
                {monitoringView.summary.originCount}
              </div>
              <div>
                <span className="summary-label">Range</span>
                Last {days} day{days === 1 ? "" : "s"}
              </div>
              <div>
                <span className="summary-label">Resolution</span>
                {formatPrecisionLabel(monitoringView.summary.precision)}
              </div>
              <div>
                <span className="summary-label">Avg latency</span>
                {formatLatency(monitoringView.summary.averageLatency)}
              </div>
            </div>

            {monitoringView.sections.length === 0 && (
              <div className="evaluation-results">
                No per-origin sections available for this range.
              </div>
            )}

            {monitoringView.sections.length > 0 && (
              <div
                className="monitoring-origin-sections"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "2rem",
                  width: "100%",
                  marginTop: "1.5rem",
                }}
              >
                {monitoringView.sections.map((section) => (
                  <MonitoringOriginSection key={section.origin} section={section} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type ChartView = {
  buckets: number[];
  precision: BucketPrecision;
  series: ChartSeries[];
  maxValue: number;
  axisTitle: string;
  yFormatter: (value: number) => string;
};

type ChartCardProps = {
  chart: ChartView;
  variant: "tokens" | "latency";
};

type OriginSectionProps = {
  section: OriginSectionData;
};

function MonitoringOriginSection({ section }: OriginSectionProps) {
  const accent = section.color;
  const borderColor = hexToRgba(accent, 0.45);
  const glowColor = hexToRgba(accent, 0.35);
  const panelBackground = `linear-gradient(135deg, ${hexToRgba(
    accent,
    0.35
  )}, rgba(15,23,42,0.93))`;

  return (
    <section
      className="monitoring-origin-section"
      style={{
        width: "100%",
        padding: "2rem",
        borderRadius: "28px",
        background: panelBackground,
        border: `1px solid ${borderColor}`,
        boxShadow: `0 25px 60px ${glowColor}`,
        color: "#f8fafc",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: "0",
          borderRadius: "inherit",
          opacity: 0.12,
          background: `radial-gradient(circle at top right, ${hexToRgba(
            accent,
            0.75
          )}, transparent 55%)`,
          pointerEvents: "none",
        }}
      />
      <div
        className="monitoring-origin-header"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1.5rem",
          justifyContent: "space-between",
          alignItems: "flex-start",
          width: "100%",
        }}
      >
        <div style={{ flex: "1 1 280px", position: "relative", zIndex: 1 }}>
          <div
            style={{
              width: "60px",
              height: "4px",
              borderRadius: "999px",
              backgroundColor: accent,
              marginBottom: "1rem",
            }}
          />
          <h2 style={{ margin: 0, color: "#f8fafc" }}>{section.title}</h2>
          <p style={{ marginTop: "0.5rem", color: "rgba(226,232,240,0.85)" }}>
            {section.description}
          </p>
        </div>
        <div
          className="monitoring-origin-stats"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "1.5rem",
            minWidth: "220px",
            position: "relative",
            zIndex: 1,
          }}
        >
          <div>
            <span className="summary-label">Tokens</span>
            {formatNumber(section.summary.totalTokens)}
          </div>
          <div>
            <span className="summary-label">Events</span>
            {formatNumber(section.summary.totalEvents)}
          </div>
          <div>
            <span className="summary-label">Avg latency</span>
            {formatLatency(section.summary.averageLatency)}
          </div>
        </div>
      </div>

      {!section.hasData && (
        <div
          className="evaluation-results"
          style={{
            marginTop: "1.5rem",
            borderRadius: "16px",
            textAlign: "center",
            position: "relative",
            zIndex: 1,
          }}
        >
          No {section.title.toLowerCase()} data for this range.
        </div>
      )}

      <div
        className="monitoring-chart-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          gap: "1.5rem",
          width: "100%",
          marginTop: "1.5rem",
          position: "relative",
          zIndex: 1,
        }}
      >
        <MonitoringChartCard chart={section.tokensChart} variant="tokens" />
        <MonitoringChartCard chart={section.latencyChart} variant="latency" />
      </div>
    </section>
  );
}

function MonitoringChartCard({ chart, variant }: ChartCardProps) {
  return (
    <div
      className="evaluation-results monitoring-chart-card"
      style={{
        width: "100%",
        borderRadius: "20px",
        boxShadow: "0 18px 45px rgba(15,23,42,0.18)",
        margin: "0 auto",
        minHeight: "420px",
      }}
    >
      <MonitoringChart chart={chart} />
      <MonitoringLegend series={chart.series} variant={variant} />
    </div>
  );
}

type ChartProps = {
  chart: ChartView;
};

function MonitoringChart({ chart }: ChartProps) {
  const innerWidth = 720;
  const innerHeight = 320;
  const margin = { top: 32, right: 40, bottom: 96, left: 96 };
  const width = innerWidth + margin.left + margin.right;
  const height = innerHeight + margin.top + margin.bottom;
  const xTickRotation = -32;
  const axisLabelStyle = { fontSize: "9px" };

  const maxValue = chart.maxValue === 0 ? 1 : chart.maxValue;
  const bucketCount = chart.buckets.length;
  const xStep = bucketCount > 1 ? innerWidth / (bucketCount - 1) : 0;

  const toX = (index: number) =>
    margin.left + (bucketCount > 1 ? index * xStep : innerWidth / 2);
  const toY = (value: number) =>
    margin.top + innerHeight - (Math.min(1, value / maxValue) * innerHeight || 0);

  const formatBucketLabel = (timestamp: number) => {
    const date = new Date(timestamp);
    if (chart.precision === "second") {
      return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
    if (chart.precision === "minute") {
      return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
    });
  };

  const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const yTicks = [...Array(GRID_LINES + 1)].map((_, idx) =>
    (maxValue / GRID_LINES) * idx
  );

  return (
    <div className="monitoring-chart" style={{ padding: "1rem", width: "100%" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        style={{ width: "100%", height: "auto" }}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          {chart.series.map((serie) => (
            <linearGradient
              key={serie.origin}
              id={`grad-${slugify(serie.origin)}`}
              x1="0%"
              y1="0%"
              x2="0%"
              y2="100%"
            >
              <stop offset="0%" stopColor={serie.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={serie.color} stopOpacity={0.05} />
            </linearGradient>
          ))}
        </defs>

        {yTicks.map((tick, idx) => {
          const y = margin.top + innerHeight - (tick / maxValue) * innerHeight;
          return (
            <g key={`y-grid-${tick}`}>
              <line
                x1={margin.left}
                y1={y}
                x2={margin.left + innerWidth}
                y2={y}
                stroke="#1f2937"
                strokeWidth={idx === 0 ? 2 : 1}
                strokeOpacity={idx === 0 ? 0.8 : 0.3}
              />
              <text
                x={margin.left - 12}
                y={y + 4}
                textAnchor="end"
                className="monitoring-axis-label"
                style={axisLabelStyle}
              >
                {chart.yFormatter(tick)}
              </text>
            </g>
          );
        })}

        {chart.series.map((serie) => {
          if (serie.values.length === 0) {
            return null;
          }

          const linePath = serie.values
            .map((point, index) => `${index === 0 ? "M" : "L"}${toX(index)},${toY(point.value)}`)
            .join(" ");

          const areaPath = `${serie.values
            .map((point, index) => `${index === 0 ? "M" : "L"}${toX(index)},${toY(point.value)}`)
            .join(" ")}${bucketCount > 1 ? ` L ${toX(bucketCount - 1)} ${margin.top + innerHeight}` : ` L ${
            margin.left + innerWidth
          } ${margin.top + innerHeight}`} L ${bucketCount > 1 ? toX(0) : margin.left + innerWidth / 2} ${
            margin.top + innerHeight
          } Z`;

          const gradientId = `grad-${slugify(serie.origin)}`;

          return (
            <g key={serie.origin}>
              <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
              <path
                d={linePath}
                fill="none"
                stroke={serie.color}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {chart.buckets.map((bucket, index) => {
          const x = toX(index);
          return (
            <g key={bucket} transform={`translate(${x}, ${margin.top + innerHeight})`}>
              <line y2={12} stroke="#1f2937" strokeWidth={1} />
              <text
                y={32}
                textAnchor="end"
                className="monitoring-axis-label monitoring-axis-label-x"
                transform={`rotate(${xTickRotation})`}
                dy="0.35em"
                style={axisLabelStyle}
              >
                {formatBucketLabel(bucket)}
              </text>
            </g>
          );
        })}

        <line
          x1={margin.left}
          y1={margin.top + innerHeight}
          x2={margin.left + innerWidth}
          y2={margin.top + innerHeight}
          stroke="#1f2937"
          strokeWidth={2}
        />
        <line
          x1={margin.left}
          y1={margin.top}
          x2={margin.left}
          y2={margin.top + innerHeight}
          stroke="#1f2937"
          strokeWidth={2}
        />
      </svg>
      <div className="monitoring-axis-title">{chart.axisTitle}</div>
    </div>
  );
}

type LegendProps = {
  series: ChartSeries[];
  variant: "tokens" | "latency";
};

function MonitoringLegend({ series, variant }: LegendProps) {
  return (
    <div className="monitoring-legend">
      {series.map((serie) => (
        <div key={serie.origin} className="monitoring-legend-item">
          <span className="legend-swatch" style={{ backgroundColor: serie.color }} />
          <div>
            <div className="legend-title">{serie.origin}</div>
            <div className="legend-metrics">
              {variant === "tokens"
                ? `${formatNumber(serie.totalTokens ?? 0)} tokens • ${formatNumber(
                    serie.eventCount ?? 0
                  )} events`
                : `${formatLatency(serie.averageLatency ?? 0)} avg latency`}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = normalizeHex(hex);
  const bigint = parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function normalizeHex(hex: string) {
  const value = hex?.trim().replace("#", "") ?? "60a5fa";
  if (value.length === 3) {
    return value
      .split("")
      .map((char) => char + char)
      .join("");
  }
  if (value.length !== 6 || Number.isNaN(Number.parseInt(value, 16))) {
    return "60a5fa";
  }
  return value;
}

function getOriginCopy(origin: string) {
  const fallbackTitle = `${capitalizeWord(origin)} monitoring`;
  const fallbackDescription = `Requests grouped under "${origin}".`;
  return ORIGIN_COPY[origin] ?? { title: fallbackTitle, description: fallbackDescription };
}

function capitalizeWord(value: string) {
  if (!value) {
    return "";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatLatency(value: number, options?: { withUnit?: boolean }) {
  const useSeconds = value >= 1000;
  const formatted = useSeconds
    ? (value / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })
    : value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (options?.withUnit === false) {
    return formatted;
  }
  return `${formatted} ${useSeconds ? "s" : "ms"}`;
}

function formatPrecisionLabel(precision: BucketPrecision) {
  if (precision === "second") return "per second";
  if (precision === "minute") return "per minute";
  return "per hour";
}
