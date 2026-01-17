import { NextRequest, NextResponse } from "next/server";
import { getJobStatusService } from "@/services/job-status.service";

export const runtime = "nodejs";
export const maxDuration = 60;

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

    const jobStatusService = getJobStatusService();
    const status = await jobStatusService.checkStatus(renderId);

    return NextResponse.json(status);
  } catch (error) {
    console.error("Error checking render status:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to check render status";
    return NextResponse.json(
      { error: errorMessage, status: "error" as const },
      { status: 500 }
    );
  }
}
