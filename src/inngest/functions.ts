import { inngest } from "./client";
import { Sandbox } from "e2b";
import { readFile } from "fs/promises";
import { join } from "path";
import { writeFile } from "fs/promises";
import { mkdir } from "fs/promises";
import { getRenderObjectUrl, getSupabaseRendersBucket, hasSupabaseConfig, tryGetSupabaseAdmin } from "@/lib/supabase-admin";

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

type FrameData = {
  frameStart: number;
  frameEnd: number;
  frameCount: number;
  fps: number;
};

function safeFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function buildFrameChunks(frameStart: number, frameEnd: number, desiredChunks: number) {
  const frameCount = frameEnd - frameStart + 1;
  const chunks = clamp(desiredChunks, 1, frameCount);
  const chunkSize = Math.ceil(frameCount / chunks);
  const ranges: Array<{ index: number; start: number; end: number }>
    = [];

  for (let i = 0; i < chunks; i++) {
    const start = frameStart + i * chunkSize;
    const end = Math.min(frameEnd, start + chunkSize - 1);
    if (start > frameEnd) break;
    ranges.push({ index: i, start, end });
  }

  return ranges;
}

export const renderFunction = inngest.createFunction(
  { id: "render-function" },
  { event: "render/invoked" },
  async ({ event, step }) => {
    const sandboxId = event.data.sandboxId as string | undefined;
    const frameData = event.data.frameData as FrameData | undefined;
    const parallelChunks = event.data.parallelChunks as number | undefined;
    const parallelChunksSafe =
      typeof parallelChunks === "number" && Number.isFinite(parallelChunks) && parallelChunks >= 2
        ? Math.floor(parallelChunks)
        : undefined;

    if (!sandboxId) {
      throw new Error("sandboxId is required in event data");
    }

    const needsFrameDetection = !(
      frameData &&
      typeof frameData.frameStart === "number" &&
      typeof frameData.frameEnd === "number"
    );

    try {
      // Step 1: Verify the sandbox exists + has the Blender file.
      // IMPORTANT: Never return the Sandbox object from a step (it's not serializable across invocations).
      await step.run("verify-e2b-sandbox", async () => {
        const sbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 20_000,
        });
        console.log("Connected to existing E2B sandbox:", sbox.sandboxId);

        const files = await sbox.files.list("/tmp");
        const blenderFile = files.find((f) => f.name === "uploaded.blend");

        if (!blenderFile) {
          throw new Error("Blender file not found in sandbox");
        }

        console.log("Blender file found in sandbox:", blenderFile.name);
      });

      // Step 2: Upload render_mp4.py script to sandbox
      await step.run("upload-render-script", async () => {
        const scriptPath = join(process.cwd(), "e2b-template", "render_mp4.py");
        let scriptContent: string;
        try {
          scriptContent = await readFile(scriptPath, "utf-8");
        } catch (readError) {
          throw new Error(`Failed to read render_mp4.py script from ${scriptPath}: ${readError instanceof Error ? readError.message : String(readError)}`);
        }
        
        const scriptSandboxPath = "/tmp/render_mp4.py";
        const sbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 20_000,
        });
        await sbox.files.write(scriptSandboxPath, scriptContent);
        console.log("Uploaded render_mp4.py script to sandbox");
        return scriptSandboxPath;
      });

      if (parallelChunksSafe || needsFrameDetection) {
        await step.run("upload-extract-frames-script", async () => {
          const scriptPath = join(process.cwd(), "e2b-template", "extract_frames.py");
          let scriptContent: string;
          try {
            scriptContent = await readFile(scriptPath, "utf-8");
          } catch (readError) {
            throw new Error(`Failed to read extract_frames.py script from ${scriptPath}: ${readError instanceof Error ? readError.message : String(readError)}`);
          }

          const scriptSandboxPath = "/tmp/extract_frames.py";
          const sbox = await Sandbox.connect(sandboxId, {
            timeoutMs: 20_000,
          });
          await sbox.files.write(scriptSandboxPath, scriptContent);
          console.log("Uploaded extract_frames.py script to sandbox");
          return scriptSandboxPath;
        });
      }

      const effectiveFrameData = await step.run("resolve-frame-data", async () => {
        if (frameData && typeof frameData.frameStart === "number" && typeof frameData.frameEnd === "number") {
          return frameData;
        }

        const sbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 20_000,
        });

        const command = [
          "bash -lc",
          JSON.stringify(
            [
              "set -euo pipefail",
              "timeout 120 blender --background --factory-startup --disable-autoexec --python /tmp/extract_frames.py -- /tmp/uploaded.blend 2>&1",
            ].join("; ")
          ),
        ].join(" ");

        const result = await sbox.commands.run(command, { timeoutMs: 0 });
        const output = (result.stderr || "") + (result.stdout || "");
        const match = output.match(/\{[\s\S]*?\}/);
        if (!match) {
          throw new Error(`Failed to detect frame range. Output: ${output.slice(0, 1000)}`);
        }

        const parsed = JSON.parse(match[0]) as {
          frame_start?: number;
          frame_end?: number;
          frame_count?: number;
          fps?: number;
        };

        const fs = safeFiniteNumber(parsed.frame_start);
        const fe = safeFiniteNumber(parsed.frame_end);
        const fc = safeFiniteNumber(parsed.frame_count);
        const fps = safeFiniteNumber(parsed.fps);

        if (fs === undefined || fe === undefined) {
          throw new Error(`Invalid frame data: ${match[0]}`);
        }

        const frameCount = fc ?? (fe - fs + 1);
        return {
          frameStart: fs,
          frameEnd: fe,
          frameCount,
          fps: fps ?? 24,
        } satisfies FrameData;
      });

      if (parallelChunksSafe) {
        const chunkRanges = buildFrameChunks(effectiveFrameData.frameStart, effectiveFrameData.frameEnd, parallelChunksSafe);
        const startedAt = Math.floor(Date.now() / 1000);

        const chunkSandboxIds = await step.run("spawn-chunk-sandboxes", async () => {
          const source = await Sandbox.connect(sandboxId, {
            timeoutMs: 60_000,
          });
          const blendBytes = await source.files.read("/tmp/uploaded.blend");

          const renderScript = await source.files.read("/tmp/render_mp4.py");

          const ids: string[] = [];
          for (const range of chunkRanges) {
            const chunk = await Sandbox.create("blender-headless-template", {
              timeoutMs: 3600000,
            });
            await chunk.files.write("/tmp/uploaded.blend", blendBytes);
            await chunk.files.write("/tmp/render_mp4.py", renderScript);
            ids.push(chunk.sandboxId);
            console.log(`Spawned chunk sandbox ${chunk.sandboxId} for frames ${range.start}-${range.end}`);
          }
          return ids;
        });

        await step.run("start-parallel-renders", async () => {
          await Promise.all(
            chunkRanges.map(async (range, idx) => {
              const chunkId = chunkSandboxIds[idx];
              const sbox = await Sandbox.connect(chunkId, {
                timeoutMs: 20_000,
              });

              const command = [
                "bash -lc",
                JSON.stringify(
                  [
                    "set -euo pipefail",
                    "rm -f /tmp/output.mp4 /tmp/render_progress.json /tmp/render_stdout.log /tmp/render_stderr.log /tmp/render_pid.txt",
                    `nohup timeout 36000 env TENET_FRAME_START=${range.start} TENET_FRAME_END=${range.end} TENET_OUTPUT_PATH=/tmp/output.mp4 TENET_PROGRESS_PATH=/tmp/render_progress.json blender --background --factory-startup --disable-autoexec -t 0 --python /tmp/render_mp4.py -- /tmp/uploaded.blend >/tmp/render_stdout.log 2>/tmp/render_stderr.log </dev/null &`,
                    "echo $! > /tmp/render_pid.txt",
                    "echo STARTED",
                  ].join("; ")
                ),
              ].join(" ");

              await sbox.commands.run(command, { timeoutMs: 60_000 });
            })
          );
        });

        const maxPolls = 1200;
        let completed = false;
        for (let i = 0; i < maxPolls; i++) {
          const poll = await step.run(`poll-parallel-render-status-${i}`, async () => {
            const perChunk = await Promise.all(
              chunkSandboxIds.map(async (chunkId) => {
                const sbox = await Sandbox.connect(chunkId, {
                  timeoutMs: 20_000,
                });

                const files = await sbox.files.list("/tmp");
                const hasMp4 = files.some((f: { name: string }) => f.name === "output.mp4");

                let progress: RenderProgress | null = null;
                try {
                  const raw = await sbox.files.read("/tmp/render_progress.json");
                  const text = decodeSandboxText(raw);
                  progress = JSON.parse(text) as RenderProgress;
                } catch {
                  progress = null;
                }

                const done = progress?.status === "completed" || hasMp4;

                if (progress?.status === "cancelled") {
                  let stderrText = "";
                  try {
                    const rawErr = await sbox.files.read("/tmp/render_stderr.log");
                    stderrText = decodeSandboxText(rawErr).slice(0, 2000);
                  } catch {
                    // ignore
                  }
                  throw new Error(`Chunk render cancelled in sandbox ${chunkId}. Logs: ${stderrText}`);
                }

                return { done, progress };
              })
            );

            const framesDone = perChunk.reduce((acc, c) => acc + (c.progress?.framesDone ?? 0), 0);
            const frameCount = effectiveFrameData.frameCount;
            const overallProgress = clamp((framesDone / frameCount) * 100, 0, 100);
            const updatedAt = Math.floor(Date.now() / 1000);

            const overall: RenderProgress = {
              status: overallProgress >= 100 ? "completed" : "rendering",
              frameStart: effectiveFrameData.frameStart,
              frameEnd: effectiveFrameData.frameEnd,
              frameCount: effectiveFrameData.frameCount,
              currentFrame: effectiveFrameData.frameStart + Math.max(0, framesDone - 1),
              framesDone,
              startedAt,
              updatedAt,
            };

            const original = await Sandbox.connect(sandboxId, {
              timeoutMs: 20_000,
            });
            await original.files.write("/tmp/render_progress.json", JSON.stringify(overall));

            const doneAll = perChunk.every((c) => c.done);
            return { doneAll, overall };
          });

          completed = poll.doneAll;
          if (completed) break;
          await step.sleep(`wait-before-next-parallel-poll-${i}`, "4m30s");
        }

        if (!completed) {
          throw new Error("Parallel render did not complete within expected polling window");
        }

        await step.sleep("yield-before-merge", "1s");

        await step.run("merge-chunk-mp4s", async () => {
          const original = await Sandbox.connect(sandboxId, {
            timeoutMs: 60_000,
          });

          for (let i = 0; i < chunkSandboxIds.length; i++) {
            const chunkId = chunkSandboxIds[i];
            const chunk = await Sandbox.connect(chunkId, {
              timeoutMs: 60_000,
            });
            const bytes = await chunk.files.read("/tmp/output.mp4");
            await original.files.write(`/tmp/chunk_${i}.mp4`, bytes);
          }

          const listText = chunkSandboxIds
            .map((_, i) => `file '/tmp/chunk_${i}.mp4'`)
            .join("\n");
          await original.files.write("/tmp/concat_list.txt", listText);

          const concatCmd = [
            "bash -lc",
            JSON.stringify(
              [
                "set -euo pipefail",
                "rm -f /tmp/output.mp4",
                "ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i /tmp/concat_list.txt -c copy /tmp/output.mp4",
              ].join("; ")
            ),
          ].join(" ");

          try {
            await original.commands.run(concatCmd, { timeoutMs: 0 });
          } catch {
            const reencodeCmd = [
              "bash -lc",
              JSON.stringify(
                [
                  "set -euo pipefail",
                  "rm -f /tmp/output.mp4",
                  "ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i /tmp/concat_list.txt -c:v libx264 -preset medium -crf 18 -movflags +faststart /tmp/output.mp4",
                ].join("; ")
              ),
            ].join(" ");
            await original.commands.run(reencodeCmd, { timeoutMs: 0 });
          }

          await original.files.write(
            "/tmp/render_progress.json",
            JSON.stringify({
              status: "completed",
              frameStart: effectiveFrameData.frameStart,
              frameEnd: effectiveFrameData.frameEnd,
              frameCount: effectiveFrameData.frameCount,
              currentFrame: effectiveFrameData.frameEnd,
              framesDone: effectiveFrameData.frameCount,
              startedAt,
              updatedAt: Math.floor(Date.now() / 1000),
            } satisfies RenderProgress)
          );

          await Promise.all(
            chunkSandboxIds.map(async (chunkId) => {
              try {
                const chunk = await Sandbox.connect(chunkId, {
                  timeoutMs: 20_000,
                });
                await chunk.kill();
              } catch {
                // ignore
              }
            })
          );
        });

        // From here on, fall through to Step 5+ (download/store/cleanup) using the original sandbox output.mp4.
      }

      // Step 3: Start Blender render as a background process
      await step.run("start-blender-render", async () => {
        if (parallelChunksSafe) return;
        const scriptSandboxPath = "/tmp/render_mp4.py";
        const blendFilePath = "/tmp/uploaded.blend";

        const command = [
          "bash -lc",
          JSON.stringify(
            [
              "set -euo pipefail",
              "rm -f /tmp/output.mp4 /tmp/render_progress.json /tmp/render_stdout.log /tmp/render_stderr.log /tmp/render_pid.txt",
              `nohup timeout 36000 blender --background --factory-startup --disable-autoexec -t 0 --python ${scriptSandboxPath} -- ${blendFilePath} ` +
                ">/tmp/render_stdout.log 2>/tmp/render_stderr.log </dev/null &",
              "echo $! > /tmp/render_pid.txt",
              "echo STARTED",
            ].join("; ")
          ),
        ].join(" ");

        const sbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 20_000,
        });
        await sbox.commands.run(command, { timeoutMs: 60_000 });
        console.log("Started Blender render in background");
      });

      // Step 4: Poll progress until completion (each iteration is short + sleeps)
      const maxPolls = 1200;
      let lastProgress: RenderProgress | null = null;
      let completed = false;

      if (parallelChunksSafe) {
        completed = true;
      }

      for (let i = 0; i < maxPolls; i++) {
        if (parallelChunksSafe) break;
        const poll = await step.run(`poll-render-status-${i}`, async () => {
          const sbox = await Sandbox.connect(sandboxId, {
            timeoutMs: 20_000,
          });

          const files = await sbox.files.list("/tmp");
          const hasMp4 = files.some((f: { name: string }) => f.name === "output.mp4");

          let progress: RenderProgress | null = null;
          try {
            const raw = await sbox.files.read("/tmp/render_progress.json");
            const text = decodeSandboxText(raw);
            progress = JSON.parse(text) as RenderProgress;
          } catch {
            progress = null;
          }

          if (progress?.status === "cancelled") {
            let stderrText = "";
            try {
              const rawErr = await sbox.files.read("/tmp/render_stderr.log");
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

        // Yield control so each execution stays well under Vercel's 5-minute limit.
        await step.sleep(`wait-before-next-poll-${i}`, "4m30s");
      }

      if (!completed) {
        throw new Error("Render did not complete within expected polling window");
      }

      // Force a new serverless invocation before heavy work (download/write).
      await step.sleep("yield-before-download", "1s");

      // Step 5: Read MP4 file from sandbox
      const videoData = await step.run("read-mp4-file", async () => {
        const outputPath = "/tmp/output.mp4";
        const sbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 60_000,
        });
        const videoBytes = await sbox.files.read(outputPath);
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

      await step.sleep("yield-before-store", "1s");

      // Step 6: Store video file locally (temporary solution)
      // In production, upload to S3 or similar storage
      const videoPath = await step.run("store-video-file", async () => {
        // Ensure videoData is a Buffer
        let bufferToWrite: Buffer;
        if (Buffer.isBuffer(videoData)) {
          bufferToWrite = videoData;
        } else if (videoData && typeof videoData === "object" && "type" in videoData && (videoData as { type?: unknown }).type === "Buffer" && "data" in videoData) {
          const data = (videoData as { data?: unknown }).data;
          bufferToWrite = Buffer.from(Array.isArray(data) ? data : []);
        } else if (videoData instanceof Uint8Array) {
          bufferToWrite = Buffer.from(videoData);
        } else if (Array.isArray(videoData)) {
          bufferToWrite = Buffer.from(videoData);
        } else if (videoData instanceof ArrayBuffer) {
          bufferToWrite = Buffer.from(videoData);
        } else {
          bufferToWrite = Buffer.from(String(videoData), "binary");
        }

        if (hasSupabaseConfig()) {
          const supabase = tryGetSupabaseAdmin();
          if (!supabase) throw new Error("Supabase config missing");
          const bucket = getSupabaseRendersBucket();
          const objectPath = `${sandboxId}.mp4`;

          const { error } = await supabase.storage
            .from(bucket)
            .upload(objectPath, bufferToWrite, {
              contentType: "video/mp4",
              upsert: true,
            });

          if (error) {
            throw new Error(`Supabase upload failed: ${error.message}`);
          }

          const url = await getRenderObjectUrl(objectPath);
          videoCache.set(sandboxId, url);
          return url;
        }

        // Fallback to local write (not reliable on Vercel).
        const publicDir = join(process.cwd(), "public", "renders");
        try {
          await mkdir(publicDir, { recursive: true });
          const fileName = `${sandboxId}.mp4`;
          const filePath = join(publicDir, fileName);
          await writeFile(filePath, bufferToWrite);
          videoCache.set(sandboxId, `/renders/${fileName}`);
          console.log(`Stored video file: ${filePath}`);
          return `/renders/${fileName}`;
        } catch (e) {
          throw new Error(`No persistent storage configured (Supabase missing) and local write failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      });

      await step.sleep("yield-before-cleanup", "1s");

      // Step 7: Clean up sandbox
      await step.run("cleanup-sandbox", async () => {
        try {
          const sbox = await Sandbox.connect(sandboxId, {
            timeoutMs: 20_000,
          });
          await sbox.kill();
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
      // Best-effort sandbox cleanup on error
      try {
        const sbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 20_000,
        });
        await sbox.kill();
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }
);
