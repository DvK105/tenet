import { inngest } from "@/inngest/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { renderId, inputObjectPath, parallelChunks, frameData } = body;

    if (!renderId) {
      return NextResponse.json(
        { error: "renderId is required" },
        { status: 400 }
      );
    }

    if (!inputObjectPath) {
      return NextResponse.json(
        { error: "inputObjectPath is required" },
        { status: 400 }
      );
    }

    await inngest.send({
      name: "render/invoked",
      data: {
        renderId,
        inputObjectPath,
        parallelChunks,
        frameData,
      },
    });

    return NextResponse.json({ success: true, renderId });
  } catch (error) {
    console.error("Error triggering Inngest function:", error);
    return NextResponse.json(
      { error: "Failed to trigger function" },
      { status: 500 }
    );
  }
}
