import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { getSandboxService } from "@/services/sandbox.service";
import { getBlenderService } from "@/services/blender.service";
import { BlenderError } from "@/lib/errors/render-errors";
import { blenderConfig } from "@/config/blender.config";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let sandbox = null;

  try {
    const shouldExtractFrames = request.nextUrl.searchParams.get("extractFrames") === "1";
    const parallelChunksParam = request.nextUrl.searchParams.get("parallelChunks");
    const parallelChunks = parallelChunksParam ? Number.parseInt(parallelChunksParam, 10) : undefined;
    const parallelChunksSafe =
      typeof parallelChunks === "number" && Number.isFinite(parallelChunks) && parallelChunks >= 2
        ? parallelChunks
        : undefined;

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Validate file type
    if (!file.name.toLowerCase().endsWith(".blend")) {
      return NextResponse.json({ error: "Only .blend files are supported" }, { status: 400 });
    }

    // Read file into memory
    const bytes = await file.arrayBuffer();

    // Create E2B sandbox
    const sandboxService = getSandboxService();
    sandbox = await sandboxService.create({
      timeoutMs: 3600000, // 1 hour timeout
    });

    // Upload Blender file to sandbox
    await sandboxService.uploadFile(sandbox, blenderConfig.sandbox.uploadedBlendPath, bytes);

    // Default behavior: return quickly and trigger render asynchronously
    if (!shouldExtractFrames) {
      try {
        await inngest.send({
          name: "render/invoked",
          data: {
            sandboxId: sandbox.sandboxId,
            parallelChunks: parallelChunksSafe,
          },
        });
        console.log("Auto-triggered render function for sandbox:", sandbox.sandboxId);
      } catch (inngestError) {
        console.error("Failed to trigger Inngest render function:", inngestError);
      }

      return NextResponse.json({
        success: true,
        sandboxId: sandbox.sandboxId,
      });
    }

    // Extract frames using Blender service
    const blenderService = getBlenderService();
    const frameData = await blenderService.extractFrames(sandbox);

    // Auto-trigger Inngest render function after successful frame detection
    try {
      await inngest.send({
        name: "render/invoked",
        data: {
          sandboxId: sandbox.sandboxId,
          frameData,
          parallelChunks: parallelChunksSafe,
        },
      });
      console.log("Auto-triggered render function for sandbox:", sandbox.sandboxId);
    } catch (inngestError) {
      // Log error but don't fail the upload - frame detection was successful
      console.error("Failed to trigger Inngest render function:", inngestError);
    }

    // Return frame data and sandbox ID
    return NextResponse.json({
      success: true,
      frameData,
      sandboxId: sandbox.sandboxId,
    });
  } catch (error) {
    console.error("Error processing Blender file:", error);

    // Clean up sandbox if it was created
    if (sandbox) {
      try {
        const sandboxService = getSandboxService();
        await sandboxService.kill(sandbox);
      } catch (killError) {
        console.error("Error killing sandbox:", killError);
      }
    }

    // Format error response
    if (error instanceof BlenderError) {
      return NextResponse.json(
        {
          error: error.message,
          errorType: error.errorType,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to process Blender file",
      },
      { status: 500 }
    );
  }
}
