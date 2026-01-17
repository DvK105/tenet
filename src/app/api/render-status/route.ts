import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { Sandbox } from "e2b";
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
    const sandboxId = searchParams.get("sandboxId");

    if (!sandboxId) {
      return NextResponse.json(
        { error: "sandboxId is required" },
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
          const objectPath = `${sandboxId}.mp4`;

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
    const videoPath = join(process.cwd(), "public", "renders", `${sandboxId}.mp4`);
    const videoExists = existsSync(videoPath);

    if (videoExists) {
      // Get file stats for additional info (using stat instead of readFile for performance)
      try {
        const fileStats = await stat(videoPath);
        return NextResponse.json({
          status: "completed",
          videoUrl: `/renders/${sandboxId}.mp4`,
          fileSize: fileStats.size,
          progress: 100,
          etaSeconds: 0,
        });
      } catch {
        return NextResponse.json({
          status: "completed",
          videoUrl: `/renders/${sandboxId}.mp4`,
          progress: 100,
          etaSeconds: 0,
        });
      }
    } else {
      // Video not ready yet - attempt to read progress from the E2B sandbox.
      try {
        const elapsedMs = Date.now() - startedAtMs;
        const remainingMs = Math.max(0, overallBudgetMs - elapsedMs);
        if (remainingMs < 1_000) {
          return NextResponse.json({
            status: "rendering",
          });
        }

        const sandbox = await withTimeout(
          Sandbox.connect(sandboxId, {
            timeoutMs: Math.min(5_000, remainingMs),
          }),
          Math.min(5_500, remainingMs)
        );

        let progressRaw: unknown;
        try {
          const elapsedAfterConnectMs = Date.now() - startedAtMs;
          const remainingAfterConnectMs = Math.max(0, overallBudgetMs - elapsedAfterConnectMs);
          if (remainingAfterConnectMs < 500) {
            return NextResponse.json({
              status: "rendering",
            });
          }

          progressRaw = await withTimeout(
            sandbox.files.read("/tmp/render_progress.json"),
            Math.min(2_000, remainingAfterConnectMs)
          );
        } catch {
          return NextResponse.json({
            status: "rendering",
          });
        }

        const progressText = decodeSandboxText(progressRaw);

        const parsed = JSON.parse(progressText) as SandboxProgress;
        const frameCount = safeNumber(parsed.frameCount);
        const framesDone = safeNumber(parsed.framesDone);
        const startedAt = safeNumber(parsed.startedAt);
        const updatedAt = safeNumber(parsed.updatedAt);

        const progress =
          frameCount && framesDone !== undefined
            ? clamp((framesDone / frameCount) * 100, 0, 100)
            : undefined;

        let etaSeconds: number | undefined;
        if (frameCount && framesDone !== undefined && framesDone > 0 && startedAt && updatedAt && updatedAt > startedAt) {
          const elapsedSeconds = updatedAt - startedAt;
          const secondsPerFrame = elapsedSeconds / framesDone;
          const remainingFrames = Math.max(0, frameCount - framesDone);
          etaSeconds = clamp(secondsPerFrame * remainingFrames, 0, 36000);
        }

        const apiStatus: "rendering" | "completed" | "error" =
          parsed.status === "completed" ? "completed" : parsed.status === "cancelled" ? "error" : "rendering";

        return NextResponse.json({
          status: apiStatus,
          progress: apiStatus === "completed" ? 100 : progress,
          etaSeconds: apiStatus === "completed" ? 0 : etaSeconds,
          frameCount,
          framesDone,
        });
      } catch {
        return NextResponse.json({
          status: "rendering",
        });
      }
    }
  } catch (error) {
    console.error("Error checking render status:", error);
    return NextResponse.json(
      { error: "Failed to check render status" },
      { status: 500 }
    );
  }
}
