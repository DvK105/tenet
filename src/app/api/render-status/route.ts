import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

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
        });
      } catch {
        return NextResponse.json({
          status: "completed",
          videoUrl: `/renders/${sandboxId}.mp4`,
        });
      }
    } else {
      // Video not ready yet - could be rendering or queued
      // In a production system, you'd check Inngest function status
      // For now, we'll return "rendering" status
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
