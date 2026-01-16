import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { Sandbox } from "e2b";

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
          timeoutMs: 10_000,
        });

        let progressRaw: unknown;
        try {
          progressRaw = await sandbox.files.read("/tmp/render_progress.json");
        } catch {
          return NextResponse.json({
            status: "rendering",
          });
        }

        const progressText =
          typeof progressRaw === "string"
            ? progressRaw
            : Buffer.isBuffer(progressRaw)
              ? progressRaw.toString("utf-8")
              : Buffer.from(progressRaw as ArrayBuffer).toString("utf-8");

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

        return NextResponse.json({
          status: parsed.status === "cancelled" ? "error" : "rendering",
          progress,
          etaSeconds,
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
