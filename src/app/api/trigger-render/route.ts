import { inngest } from "@/inngest/client";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    await inngest.send({
      name: "render/invoked",
      data: {},
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
