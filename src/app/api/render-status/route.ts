import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getRenderObjectUrl, getSupabaseRendersBucket, hasSupabaseConfig, isSupabaseBucketPublic, tryGetSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type SandboxProgress = {
  status?: "rendering" | "completed" | "cancelled";
  frameStart?: number;
  frameEnd?: number;
  frameCount?: number;
  currentFrame?: number;
  framesDone?: number;
  startedAt?: number;
  updatedAt?: number;
};

function decodeSandboxText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf-8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer).toString("utf-8");
  return Buffer.from(value as ArrayBuffer).toString("utf-8");
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const renderId = searchParams.get("renderId") ?? searchParams.get("sandboxId");

    if (!renderId) {
      return NextResponse.json(
        { error: "renderId is required" },
        { status: 400 }
      );
    }

    const startedAtMs = Date.now();
    const overallBudgetMs = 8_000;

    if (hasSupabaseConfig()) {
      try {
        const supabase = tryGetSupabaseAdmin();
        if (supabase) {
          const bucket = getSupabaseRendersBucket();
          const objectPath = `${renderId}.mp4`;

          const { data, error } = await withTimeout(
            supabase.storage.from(bucket).list("", {
              limit: 1,
              search: objectPath,
            }),
            4_000
          );

          if (!error && Array.isArray(data) && data.some((o) => o.name === objectPath)) {
            const url = await getRenderObjectUrl(objectPath);
            const fileSize = data.find((o) => o.name === objectPath)?.metadata?.size;
            return NextResponse.json({
              status: "completed",
              videoUrl: url,
              fileSize: typeof fileSize === "number" ? fileSize : undefined,
              progress: 100,
              etaSeconds: 0,
              storage: "supabase",
              publicBucket: isSupabaseBucketPublic(),
            });
          }
        }
      } catch {
        // ignore supabase errors and fall back to sandbox progress
      }
    }

    // Check if video file exists in public/renders directory
    const videoPath = join(process.cwd(), "public", "renders", `${renderId}.mp4`);
    const videoExists = existsSync(videoPath);

    if (videoExists) {
      // Get file stats for additional info (using stat instead of readFile for performance)
      try {
        const fileStats = await stat(videoPath);
        return NextResponse.json({
          status: "completed",
          videoUrl: `/renders/${renderId}.mp4`,
          fileSize: fileStats.size,
          progress: 100,
          etaSeconds: 0,
        });
      } catch {
        return NextResponse.json({
          status: "completed",
          videoUrl: `/renders/${renderId}.mp4`,
          progress: 100,
          etaSeconds: 0,
        });
      }
    } else {
      return NextResponse.json({
        status: "rendering",
      });
    }
  } catch (error) {
    console.error("Error checking render status:", error);
    return NextResponse.json(
      { error: "Failed to check render status" },
      { status: 500 }
    );
  }
}
