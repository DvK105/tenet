# Tenet v2 (Blender Render Engine)

Tenet is a Next.js app that lets you upload a `.blend` file and renders it to an MP4 using Blender running inside E2B sandboxes. Rendering is orchestrated asynchronously via Inngest so web requests stay fast and don’t time out.

## High-level architecture

- **Web app**: Next.js App Router UI.
- **Orchestration**: Inngest function `render/invoked`.
- **Compute**: E2B sandbox template `blender-headless-template` (Ubuntu + Blender + ffmpeg).
- **Output**: Final MP4 is stored under `public/renders/<sandboxId>.mp4` and served at `/renders/<sandboxId>.mp4`.

## Request / render flow

1. **Upload** (`src/app/api/upload-blender/route.ts`)
   - Creates an E2B sandbox (`Sandbox.create("blender-headless-template")`).
   - Uploads the `.blend` to `/tmp/uploaded.blend`.
   - Sends an Inngest event `render/invoked` with `{ sandboxId, frameData?, parallelChunks? }`.

2. **Render orchestration** (`src/inngest/functions.ts`)
   - Uploads `e2b-template/render_mp4.py` to the sandbox.
   - Resolves frame range (either from provided `frameData` or by running `e2b-template/extract_frames.py`).
   - Runs Blender headlessly to produce `/tmp/output.mp4`.
   - Downloads the MP4 and writes it to `public/renders/<sandboxId>.mp4`.
   - Kills the sandbox (best-effort cleanup).

3. **Progress / status polling** (`src/app/api/render-status/route.ts`)
   - If `public/renders/<sandboxId>.mp4` exists: returns `completed` with `videoUrl`.
   - Otherwise reads `/tmp/render_progress.json` from the sandbox and returns `rendering` + `progress` + `etaSeconds`.

4. **Manual trigger (optional)** (`src/app/api/trigger-render/route.ts`)
   - Sends the `render/invoked` event when you already have a `sandboxId`.

## Parallel rendering (optional)

To reduce wall-clock render time while keeping per-frame quality unchanged, you can split a render into chunks across multiple sandboxes.

- **How to enable**: call upload with `parallelChunks`:
  - `POST /api/upload-blender?parallelChunks=10`

- **What happens**:
  - The frame range is split into N contiguous ranges.
  - Each chunk sandbox renders only its range.
  - Chunk MP4s are copied back into the original sandbox and merged with `ffmpeg` using concat.
  - If stream-copy concat fails, Tenet falls back to a re-encode merge to guarantee a valid output.

## Blender scripts

- `e2b-template/render_mp4.py`
  - Loads the `.blend` and renders an animation to MP4.
  - Writes progress to a JSON file so the web app can compute progress/ETA.

- `e2b-template/extract_frames.py`
  - Opens the `.blend` and prints detected `frame_start`, `frame_end`, `fps` as JSON.

## Script environment variables

`render_mp4.py` supports the following environment variables:

- **`TENET_FRAME_START`**: override start frame for chunk rendering.
- **`TENET_FRAME_END`**: override end frame for chunk rendering.
- **`TENET_OUTPUT_PATH`**: output mp4 path (default `/tmp/output.mp4`).
- **`TENET_PROGRESS_PATH`**: progress json path (default `/tmp/render_progress.json`).
- **`TENET_ENABLE_CYCLES_GPU=1`**: best-effort attempt to enable Cycles GPU device (only applies if the file uses Cycles).

## Development

Run the dev server:

```bash
npm run dev
```

Open `http://localhost:3000`.
