import { inngest } from "@/inngest/client";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sandboxId } = body;

    if (!sandboxId) {
      return NextResponse.json(
        { error: "sandboxId is required" },
        { status: 400 }
      );
    }

    await inngest.send({
      name: "render/invoked",
      data: {
        sandboxId,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error triggering Inngest function:", error);
    return NextResponse.json(
      { error: "Failed to trigger function" },
      { status: 500 }
    );
  }
}
