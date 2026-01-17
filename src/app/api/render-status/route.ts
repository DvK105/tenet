import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { Sandbox } from "e2b";

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
        const sandbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 20_000,
        });

        let progressRaw: unknown;
        try {
          progressRaw = await sandbox.files.read("/tmp/render_progress.json");
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
