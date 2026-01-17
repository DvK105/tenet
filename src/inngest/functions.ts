import { inngest } from "./client";
import { Sandbox } from "e2b";
import { readFile } from "fs/promises";
import { join } from "path";
import { writeFile } from "fs/promises";
import { mkdir } from "fs/promises";

// Simple in-memory cache for rendered videos (key: sandboxId, value: file path)
// In production, you'd want to use proper storage (S3, etc.)
const videoCache = new Map<string, string>();

function decodeSandboxText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf-8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer).toString("utf-8");
  return Buffer.from(value as ArrayBuffer).toString("utf-8");
}

type RenderProgress = {
  status?: "rendering" | "completed" | "cancelled";
  frameStart?: number;
  frameEnd?: number;
  frameCount?: number;
  currentFrame?: number;
  framesDone?: number;
  startedAt?: number;
  updatedAt?: number;
};

export const renderFunction = inngest.createFunction(
  { id: "render-function" },
  { event: "render/invoked" },
  async ({ event, step }) => {
    const sandboxId = event.data.sandboxId as string | undefined;
    const frameData = event.data.frameData as {
      frameStart: number;
      frameEnd: number;
      frameCount: number;
      fps: number;
    } | undefined;

    if (!sandboxId) {
      throw new Error("sandboxId is required in event data");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sandbox: any = null;

    try {
      // Step 1: Connect to existing sandbox
      const connectedSandbox = await step.run("connect-to-e2b-sandbox", async () => {
        const sbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 3600000, // 1 hour timeout
        });
        console.log("Connected to existing E2B sandbox:", sbox.sandboxId);
        
        // Verify the Blender file exists in the sandbox
        const files = await sbox.files.list("/tmp");
        const blenderFile = files.find((f) => f.name === "uploaded.blend");
        
        if (!blenderFile) {
          throw new Error("Blender file not found in sandbox");
        }
        
        console.log("Blender file found in sandbox:", blenderFile.name);
        return sbox;
      });
      sandbox = connectedSandbox;

      // Step 2: Upload render_mp4.py script to sandbox
      await step.run("upload-render-script", async () => {
        if (!sandbox) {
          throw new Error("Sandbox not connected");
        }
        const scriptPath = join(process.cwd(), "e2b-template", "render_mp4.py");
        let scriptContent: string;
        try {
          scriptContent = await readFile(scriptPath, "utf-8");
        } catch (readError) {
          throw new Error(`Failed to read render_mp4.py script from ${scriptPath}: ${readError instanceof Error ? readError.message : String(readError)}`);
        }
        
        const scriptSandboxPath = "/tmp/render_mp4.py";
        await sandbox.files.write(scriptSandboxPath, scriptContent);
        console.log("Uploaded render_mp4.py script to sandbox");
        return scriptSandboxPath;
      });

      // Step 3: Start Blender render as a background process
      await step.run("start-blender-render", async () => {
        if (!sandbox) {
          throw new Error("Sandbox not connected");
        }

        const scriptSandboxPath = "/tmp/render_mp4.py";
        const blendFilePath = "/tmp/uploaded.blend";

        const command = [
          "bash -lc",
          JSON.stringify(
            [
              "set -euo pipefail",
              "rm -f /tmp/output.mp4 /tmp/render_progress.json /tmp/render_stdout.log /tmp/render_stderr.log /tmp/render_pid.txt",
              `nohup timeout 36000 blender --background --factory-startup --disable-autoexec --python ${scriptSandboxPath} -- ${blendFilePath} ` +
                ">/tmp/render_stdout.log 2>/tmp/render_stderr.log </dev/null &",
              "echo $! > /tmp/render_pid.txt",
              "echo STARTED",
            ].join("; ")
          ),
        ].join(" ");

        await sandbox.commands.run(command, { timeoutMs: 60_000 });
        console.log("Started Blender render in background");
      });

      // Step 4: Poll progress until completion (each iteration is short + sleeps)
      const maxPolls = 1200;
      let lastProgress: RenderProgress | null = null;
      let completed = false;

      for (let i = 0; i < maxPolls; i++) {
        const poll = await step.run(`poll-render-status-${i}`, async () => {
          if (!sandbox) {
            throw new Error("Sandbox not connected");
          }

          const files = await sandbox.files.list("/tmp");
          const hasMp4 = files.some((f: { name: string }) => f.name === "output.mp4");

          let progress: RenderProgress | null = null;
          try {
            const raw = await sandbox.files.read("/tmp/render_progress.json");
            const text = decodeSandboxText(raw);
            progress = JSON.parse(text) as RenderProgress;
          } catch {
            progress = null;
          }

          if (progress?.status === "cancelled") {
            let stderrText = "";
            try {
              const rawErr = await sandbox.files.read("/tmp/render_stderr.log");
              stderrText = decodeSandboxText(rawErr).slice(0, 2000);
            } catch {
              // ignore
            }
            throw new Error(`Render cancelled in sandbox. Logs: ${stderrText}`);
          }

          if (progress?.status === "completed" || hasMp4) {
            return { done: true, progress };
          }

          return { done: false, progress };
        });

        lastProgress = poll.progress;
        completed = poll.done;
        if (completed) break;

        await step.sleep(`wait-before-next-poll-${i}`, "30s");
      }

      if (!completed) {
        throw new Error("Render did not complete within expected polling window");
      }

      // Step 5: Read MP4 file from sandbox
      const videoData = await step.run("read-mp4-file", async () => {
        if (!sandbox) {
          throw new Error("Sandbox not connected");
        }
        const outputPath = "/tmp/output.mp4";
        const videoBytes = await sandbox.files.read(outputPath);
        // Handle different return types from E2B SDK
        let buffer: Buffer;
        if (videoBytes && typeof videoBytes === 'object') {
          if ('byteLength' in videoBytes) {
            // It's an ArrayBuffer or ArrayBufferView
            buffer = Buffer.from(videoBytes as ArrayBuffer);
          } else if (Array.isArray(videoBytes)) {
            buffer = Buffer.from(videoBytes);
          } else {
            buffer = Buffer.from(String(videoBytes), 'binary');
          }
        } else if (typeof videoBytes === 'string') {
          buffer = Buffer.from(videoBytes, 'binary');
        } else {
          buffer = Buffer.from(String(videoBytes), 'binary');
        }
        console.log(`Read MP4 file: ${buffer.length} bytes`);
        return buffer;
      });

      // Step 6: Store video file locally (temporary solution)
      // In production, upload to S3 or similar storage
      const videoPath = await step.run("store-video-file", async () => {
        // Create public directory if it doesn't exist
        const publicDir = join(process.cwd(), "public", "renders");
        try {
          await mkdir(publicDir, { recursive: true });
        } catch {
          // Directory might already exist
        }

        // Store video file (videoData is a Buffer)
        const fileName = `${sandboxId}.mp4`;
        const filePath = join(publicDir, fileName);
        // Ensure videoData is a Buffer or Uint8Array
        // Handle serialized Buffer objects from Inngest step results
        let bufferToWrite: Buffer;
        if (Buffer.isBuffer(videoData)) {
          bufferToWrite = videoData;
        } else if (videoData && typeof videoData === 'object' && 'type' in videoData && videoData.type === 'Buffer' && 'data' in videoData && Array.isArray(videoData.data)) {
          // Handle serialized Buffer: { type: 'Buffer', data: number[] }
          bufferToWrite = Buffer.from(videoData.data);
        } else if (videoData instanceof Uint8Array) {
          bufferToWrite = Buffer.from(videoData);
        } else if (Array.isArray(videoData)) {
          bufferToWrite = Buffer.from(videoData);
        } else if (videoData instanceof ArrayBuffer) {
          bufferToWrite = Buffer.from(videoData);
        } else {
          // Fallback: try to convert to buffer
          bufferToWrite = Buffer.from(String(videoData), 'binary');
        }
        await writeFile(filePath, bufferToWrite);
        
        // Cache the path
        videoCache.set(sandboxId, `/renders/${fileName}`);
        
        console.log(`Stored video file: ${filePath}`);
        return `/renders/${fileName}`;
      });

      // Step 7: Clean up sandbox
      await step.run("cleanup-sandbox", async () => {
        if (!sandbox) {
          return;
        }
        try {
          await sandbox.kill();
          console.log("Sandbox cleaned up");
        } catch (error) {
          console.error("Error cleaning up sandbox:", error);
          // Don't throw - cleanup errors shouldn't fail the function
        }
      });

      return {
        success: true,
        videoUrl: videoPath,
        sandboxId,
        frameData: frameData || lastProgress,
      };
    } catch (error) {
      // Clean up sandbox on error
      if (sandbox) {
        try {
          await sandbox.kill();
        } catch {
          // Ignore cleanup errors
        }
      }
      throw error;
    }
  }
);
