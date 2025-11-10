import { NextRequest, NextResponse } from "next/server";
import { db, sql } from "@/lib/db/db";
import { monitoring } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MonitoringRecord = {
  id: number;
  createdAt: Date | null;
  origin: string;
  model: string | null;
  totalTokens: number | null;
  totalLatencyMs: number | null;
};

type IntegerParseResult = {
  value: number | null;
  error: string | null;
};

type AggregatedRow = {
  bucket: Date | string;
  origin: string;
  total_tokens: number | string | null;
  avg_latency_ms: number | string | null;
  total_latency_ms: number | string | null;
  event_count: number | string;
};

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

const DEFAULT_DAYS = 7;
const MAX_DAYS = 60;
type BucketPrecision = "hour" | "minute" | "second";
const BUCKET_OPTIONS: BucketPrecision[] = ["hour", "minute", "second"];
const BUCKET_SET = new Set<BucketPrecision>(BUCKET_OPTIONS);
const DEFAULT_BUCKET: BucketPrecision = "hour";

function getSearchParams(req: NextRequest) {
  try {
    return req.nextUrl.searchParams;
  } catch {
    const base =
      process.env.APP_BASE_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:3000";
    return new URL(req.url, base).searchParams;
  }
}

function normalizeBucket(value: string | null): BucketPrecision {
  if (!value) {
    return DEFAULT_BUCKET;
  }
  const normalized = value.toLowerCase();
  if (BUCKET_SET.has(normalized as BucketPrecision)) {
    return normalized as BucketPrecision;
  }
  return DEFAULT_BUCKET;
}

export async function GET(req: NextRequest) {
  const searchParams = getSearchParams(req);
  const rawDays = Number(searchParams.get("days"));
  const days =
    Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(Math.max(Math.trunc(rawDays), 1), MAX_DAYS)
      : DEFAULT_DAYS;

  const bucketPrecision = normalizeBucket(searchParams.get("bucket"));

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  try {
    const rows = await sql<AggregatedRow[]>`
      SELECT
        date_trunc(${bucketPrecision}, created_at::timestamptz) AS bucket,
        origin,
        SUM(COALESCE(total_tokens, 0)) AS total_tokens,
        AVG(COALESCE(total_latency_ms, 0)) AS avg_latency_ms,
        SUM(COALESCE(total_latency_ms, 0)) AS total_latency_ms,
        COUNT(*) AS event_count
      FROM monitoring
      WHERE created_at::timestamptz >= ${sinceIso}::timestamptz
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `;

    const points = rows.map((row) => {
      const bucketDate =
        row.bucket instanceof Date ? row.bucket : new Date(row.bucket);
      return {
        bucket: bucketDate.toISOString(),
        origin: row.origin,
        totalTokens: Number(row.total_tokens ?? 0),
        avgLatencyMs:
          row.avg_latency_ms === null || row.avg_latency_ms === undefined
            ? null
            : Number(row.avg_latency_ms),
        totalLatencyMs: Number(row.total_latency_ms ?? 0),
        eventCount: Number(row.event_count ?? 0),
      };
    });

    const originMap = new Map<string, OriginAggregate>();
    for (const point of points) {
      let aggregate = originMap.get(point.origin);
      if (!aggregate) {
        aggregate = {
          points: [],
          totals: {
            totalTokens: 0,
            totalLatencyMs: 0,
            totalEvents: 0,
          },
        };
        originMap.set(point.origin, aggregate);
      }

      aggregate.points.push(point);
      aggregate.totals.totalTokens += point.totalTokens ?? 0;
      aggregate.totals.totalLatencyMs += point.totalLatencyMs ?? 0;
      aggregate.totals.totalEvents += point.eventCount ?? 0;
    }

    const origins = Object.fromEntries(originMap);

    return NextResponse.json({
      range: {
        since: since.toISOString(),
        days,
      },
      bucketPrecision,
      points,
      origins,
    });
  } catch (error) {
    const errorInfo =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error ?? "Unknown error") };
    console.error("[monitoring] failed to load metrics", errorInfo);
    return NextResponse.json(
      { error: "Failed to load monitoring data" },
      { status: 500 }
    );
  }
}

function parseOrigin(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseOptionalInteger(value: unknown, field: string): IntegerParseResult {
  if (value === undefined || value === null || value === "") {
    return { value: null, error: null };
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return { value: null, error: `Field "${field}" must be a valid integer.` };
  }
  return { value: Math.trunc(num), error: null };
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const origin = parseOrigin(body?.origin ?? body?.source);
  if (!origin) {
    return NextResponse.json(
      { error: 'Field "origin" is required and must be a non-empty string.' },
      { status: 400 }
    );
  }

  const model = parseOptionalString(body?.model ?? body?.model_name);
  const tokensResult = parseOptionalInteger(
    body?.totalTokens ?? body?.total_tokens ?? body?.tokens,
    "total_tokens"
  );
  if (tokensResult.error) {
    return NextResponse.json({ error: tokensResult.error }, { status: 400 });
  }

  const latencyResult = parseOptionalInteger(
    body?.totalLatencyMs ?? body?.total_latency_ms ?? body?.latency,
    "total_latency_ms"
  );
  if (latencyResult.error) {
    return NextResponse.json({ error: latencyResult.error }, { status: 400 });
  }

  try {
    const [inserted] = await db
      .insert(monitoring)
      .values({
        origin,
        model,
        totalTokens: tokensResult.value,
        totalLatencyMs: latencyResult.value,
      })
      .returning({
        id: monitoring.id,
        createdAt: monitoring.createdAt,
        origin: monitoring.origin,
        model: monitoring.model,
        totalTokens: monitoring.totalTokens,
        totalLatencyMs: monitoring.totalLatencyMs,
      });

    if (!inserted) {
      throw new Error("Insert returned no rows");
    }

    const record: MonitoringRecord = {
      id: inserted.id,
      createdAt: inserted.createdAt,
      origin: inserted.origin,
      model: inserted.model,
      totalTokens: inserted.totalTokens,
      totalLatencyMs: inserted.totalLatencyMs,
    };

    return NextResponse.json({ status: "ok", record });
  } catch (error) {
    console.error("[monitoring] failed to insert row", error);
    return NextResponse.json(
      { error: "Failed to persist monitoring data" },
      { status: 500 }
    );
  }
}
