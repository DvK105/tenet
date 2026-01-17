import { NextRequest } from "next/server";
import { getJobStatusService } from "@/services/job-status.service";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const renderIds = searchParams.getAll("renderId");

  if (renderIds.length === 0) {
    return new Response("No renderIds provided", { status: 400 });
  }

  // Set up SSE headers
  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const jobStatusService = getJobStatusService();

      // Send initial connection message
      controller.enqueue(encoder.encode(": connected\n\n"));

      const pollInterval = 5000; // Poll every 5 seconds
      let isActive = true;

      const poll = async () => {
        if (!isActive) return;

        try {
          const statusMap = await jobStatusService.checkStatusBatch(renderIds);

          // Send updates for each render
          for (const [renderId, status] of statusMap.entries()) {
            const event = {
              type:
                status.status === "completed"
                  ? "completed"
                  : status.status === "error"
                    ? "error"
                    : "progress",
              renderId,
              data: {
                status: status.status,
                progress: status.progress,
                etaSeconds: status.etaSeconds,
                videoUrl: status.videoUrl,
                errorMessage: status.errorMessage,
              },
            };

            const message = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(message));
          }

          // Check if all renders are completed
          const allCompleted = Array.from(statusMap.values()).every(
            (s) => s.status === "completed" || s.status === "error"
          );

          if (allCompleted) {
            // Keep connection open for a bit longer in case of late updates, then close
            setTimeout(() => {
              isActive = false;
              controller.close();
            }, 10000);
            return;
          }

          // Schedule next poll
          setTimeout(poll, pollInterval);
        } catch (error) {
          console.error("Error in SSE poll:", error);
          // Continue polling even on error
          setTimeout(poll, pollInterval);
        }
      };

      // Start polling
      poll();

      // Cleanup on client disconnect
      request.signal.addEventListener("abort", () => {
        isActive = false;
        controller.close();
      });
    },
  });

  return new Response(stream, { headers });
}
