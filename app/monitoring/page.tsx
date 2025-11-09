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

type MonitoringResponse = {
  range: { since: string; days: number };
  bucketPrecision: BucketPrecision;
  points: MonitoringPoint[];
};

type ChartSeries = {
  origin: string;
  color: string;
  values: Array<{ time: number; value: number }>;
  totalTokens?: number;
  eventCount?: number;
  averageLatency?: number;
};

type ChartData = {
  buckets: number[];
  precision: BucketPrecision;
  tokens: {
    series: ChartSeries[];
    maxValue: number;
    totalTokens: number;
    totalEvents: number;
  };
  latency: {
    series: ChartSeries[];
    maxValue: number;
    averageLatency: number;
  };
  originCount: number;
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

  const chartData = useMemo<ChartData | null>(() => {
    if (!data || data.points.length === 0) {
      return null;
    }

    const bucketSet = new Set<number>();
    const originSet = new Set<string>();

    data.points.forEach((point) => {
      bucketSet.add(new Date(point.bucket).getTime());
      originSet.add(point.origin);
    });

    const buckets = Array.from(bucketSet).sort((a, b) => a - b);
    const origins = Array.from(originSet).sort();

    const colorMap = new Map<string, string>();
    origins.forEach((origin, idx) => {
      colorMap.set(origin, COLOR_PALETTE[idx % COLOR_PALETTE.length]);
    });

    const tokenSeries: ChartSeries[] = origins.map((origin) => {
      const valueByBucket = new Map<number, number>();
      const eventsByBucket = new Map<number, number>();
      data.points
        .filter((point) => point.origin === origin)
        .forEach((point) => {
          const bucketTime = new Date(point.bucket).getTime();
          valueByBucket.set(bucketTime, point.totalTokens);
          eventsByBucket.set(bucketTime, point.eventCount);
        });

      const values = buckets.map((bucket) => ({
        time: bucket,
        value: valueByBucket.get(bucket) ?? 0,
      }));

      const totalTokens = values.reduce((sum, item) => sum + item.value, 0);
      const eventCount = Array.from(eventsByBucket.values()).reduce(
        (sum, count) => sum + count,
        0
      );

      return {
        origin,
        color: colorMap.get(origin) ?? "#fff",
        values,
        totalTokens,
        eventCount,
      };
    });

    const latencySeries: ChartSeries[] = origins.map((origin) => {
      const valueByBucket = new Map<number, number>();
      data.points
        .filter((point) => point.origin === origin)
        .forEach((point) => {
          const bucketTime = new Date(point.bucket).getTime();
          valueByBucket.set(bucketTime, point.avgLatencyMs ?? 0);
        });

      const values = buckets.map((bucket) => ({
        time: bucket,
        value: valueByBucket.get(bucket) ?? 0,
      }));

      const averageLatency = values.length
        ? values.reduce((sum, item) => sum + item.value, 0) / values.length
        : 0;

      return {
        origin,
        color: colorMap.get(origin) ?? "#fff",
        values,
        averageLatency,
      };
    });

    const tokensMaxValue = Math.max(
      1,
      ...tokenSeries.flatMap((serie) => serie.values.map((v) => v.value))
    );
    const latencyMaxValue = Math.max(
      1,
      ...latencySeries.flatMap((serie) => serie.values.map((v) => v.value))
    );

    const totalTokens = tokenSeries.reduce(
      (sum, serie) => sum + (serie.totalTokens ?? 0),
      0
    );
    const totalEvents = tokenSeries.reduce(
      (sum, serie) => sum + (serie.eventCount ?? 0),
      0
    );

    const latencyValues = latencySeries.flatMap((serie) =>
      serie.values.map((v) => v.value)
    );
    const averageLatency = latencyValues.length
      ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length
      : 0;

    return {
      buckets,
      precision: data.bucketPrecision,
      tokens: {
        series: tokenSeries,
        maxValue: tokensMaxValue,
        totalTokens,
        totalEvents,
      },
      latency: {
        series: latencySeries,
        maxValue: latencyMaxValue,
        averageLatency,
      },
      originCount: origins.length,
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

        {!error && !loading && chartData === null && (
          <div className="evaluation-results">No monitoring data available for this range.</div>
        )}

        {!error && chartData && (
          <>
            <div className="evaluation-summary monitoring-summary">
              <div>
                <span className="summary-label">Total tokens</span>
                {formatNumber(chartData.tokens.totalTokens)}
              </div>
              <div>
                <span className="summary-label">Total events</span>
                {formatNumber(chartData.tokens.totalEvents)}
              </div>
              <div>
                <span className="summary-label">Origins</span>
                {chartData.originCount}
              </div>
              <div>
                <span className="summary-label">Range</span>
                Last {days} day{days === 1 ? "" : "s"}
              </div>
              <div>
                <span className="summary-label">Resolution</span>
                {formatPrecisionLabel(chartData.precision)}
              </div>
              <div>
                <span className="summary-label">Avg latency</span>
                {formatLatency(chartData.latency.averageLatency)}
              </div>
            </div>

            <div
              className="monitoring-chart-grid"
              style={{
                display: "flex",
                gap: "2rem",
                flexWrap: "wrap",
                justifyContent: "center",
                width: "100%",
                marginTop: "1.5rem",
              }}
            >
              <MonitoringChartCard
                chart={{
                  buckets: chartData.buckets,
                  precision: chartData.precision,
                  series: chartData.tokens.series,
                  maxValue: chartData.tokens.maxValue,
                  axisTitle: `Total tokens per origin (${formatPrecisionLabel(chartData.precision)})`,
                  yFormatter: (value) => formatNumber(value),
                }}
                variant="tokens"
              />

              <MonitoringChartCard
                chart={{
                  buckets: chartData.buckets,
                  precision: chartData.precision,
                  series: chartData.latency.series,
                  maxValue: chartData.latency.maxValue,
                  axisTitle: "Average latency per origin (ms)",
                  yFormatter: (value) => formatLatency(value, { withUnit: true }),
                }}
                variant="latency"
              />
            </div>
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

function MonitoringChartCard({ chart, variant }: ChartCardProps) {
  return (
    <div
      className="evaluation-results monitoring-chart-card"
      style={{
        flex: "1 1 420px",
        width: "100%",
        maxWidth: "620px",
        borderRadius: "18px",
        boxShadow: "0 15px 45px rgba(0,0,0,0.4)",
        margin: "0 auto",
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
  const innerWidth = 560;
  const innerHeight = 250;
  const margin = { top: 24, right: 32, bottom: 72, left: 80 };
  const width = innerWidth + margin.left + margin.right;
  const height = innerHeight + margin.top + margin.bottom;

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
    <div className="monitoring-chart" style={{ padding: "1rem" }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
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
              <text y={28} textAnchor="middle" className="monitoring-axis-label">
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
