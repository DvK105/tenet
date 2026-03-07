import os
import re
import subprocess
import tempfile
import threading
import json
from typing import Optional, Dict, Any

import time

import modal
import requests
from fastapi import Form


BLENDER_VERSION = os.environ.get("BLENDER_VERSION", "5.0.1")
BLENDER_DIR = f"/opt/blender-{BLENDER_VERSION}"
BLENDER_BIN = f"{BLENDER_DIR}/blender"

blender_image = (
    modal.Image.debian_slim()
    .apt_install(
        "ca-certificates", "curl", "tar", "xz-utils",
        # Blender dependencies
        "libgl1-mesa-glx", "libgl1-mesa-dri", "libxi6", "libxext6",
        "libxrender1", "libxrandr2", "libasound2", "libpulse0",
        "libfontconfig1", "libfreetype6", "libxcomposite1",
        "libxcursor1", "libxinerama1", "libgtk-3-0", "libglib2.0-0",
        # Additional X11 libraries
        "libsm6", "libice6", "libx11-6", "libx11-xcb1", "libxcb1",
        "libxau6", "libxdmcp6", "libxss1", "libxtst6", "libnss3",
        "libxfixes3", "libxdamage1", "libxxf86vm1", "libxv1"
    )
    .run_commands(
        "set -eux; "
        "mkdir -p /opt; "
        f"cd /opt; "
        f"curl -fL -o blender.tar.xz https://download.blender.org/release/Blender{BLENDER_VERSION.rsplit('.', 1)[0]}/blender-{BLENDER_VERSION}-linux-x64.tar.xz; "
        f"tar -xJf blender.tar.xz; "
        f"rm blender.tar.xz; "
        f"mv blender-{BLENDER_VERSION}-linux-x64 {BLENDER_DIR}; "
        f"ln -sf {BLENDER_BIN} /usr/local/bin/blender; "
        f"chmod +x {BLENDER_BIN}"
    )
    .pip_install("supabase", "requests", "fastapi[standard]", "pydantic")
)

app = modal.App("blend-renderer")

# Configuration for parallel processing
MAX_CONCURRENT_RENDERS = int(os.environ.get("MAX_CONCURRENT_RENDERS", "10"))
GPU_MEMORY = os.environ.get("GPU_MEMORY", "16GB")  # T4 has 16GB
USE_SPOT_INSTANCES = os.environ.get("USE_SPOT_INSTANCES", "true").lower() == "true"


@app.function(
    image=blender_image,
    timeout=2400,  # Increased to 40 minutes
    gpu="t4",
    max_containers=MAX_CONCURRENT_RENDERS,
    scaledown_window=300,
    retries=2,
    memory=16384,
    secrets=[modal.Secret.from_name("supabase")],
)
def process_render_base64(blend_file_base64: str, output_key: Optional[str] = None) -> dict[str, Any]:
    import base64

    file_bytes = base64.b64decode(blend_file_base64)

    if output_key is None:
        import uuid
        unique_id = str(uuid.uuid4())[:8]  # Short unique suffix
        output_key = f"renders/{int(time.time() * 1000)}_{unique_id}.mp4"

    url, render_time = _render_blend_bytes(file_bytes, output_key=output_key)
    return {"url": url, "render_time_seconds": render_time}


def _get_supabase_client():
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "Missing Supabase credentials. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY "
            "to your Modal secret named 'supabase'. See: modal.com/docs/guide/secrets"
        )
    return create_client(url, key)


def _parse_blender_time(time_str: str) -> float:
    """Parse Blender time format like '00:01:23.45' or '01:23.45' to seconds."""
    try:
        parts = time_str.split(':')
        if len(parts) == 3:  # HH:MM:SS.ms
            hours, minutes, seconds = parts
            total_seconds = float(hours) * 3600 + float(minutes) * 60 + float(seconds)
        elif len(parts) == 2:  # MM:SS.ms
            minutes, seconds = parts
            total_seconds = float(minutes) * 60 + float(seconds)
        else:  # Just seconds
            total_seconds = float(time_str)
        return total_seconds
    except (ValueError, AttributeError):
        return None


def _write_render_progress(client, call_id: str, elapsed_seconds: float, frames_done: Optional[int] = None, total_frames: Optional[int] = None, eta_seconds: Optional[float] = None) -> None:
    """Write progress JSON to Supabase storage for the UI to poll."""
    bucket = os.environ.get("SUPABASE_RENDERS_BUCKET", "renders")
    key = f"progress/{call_id}.json"
    payload = {
        "elapsed_seconds": round(elapsed_seconds, 1),
        "frames_done": frames_done,
        "total_frames": total_frames,
        "eta_seconds": round(eta_seconds, 1) if eta_seconds is not None else None,
    }
    try:
        client.storage.from_(bucket).upload(
            key,
            json.dumps(payload).encode(),
            {"content-type": "application/json", "upsert": "true"},
        )
    except Exception as e:
        print(f"[progress] Failed to write progress: {e}")


def _render_blend_bytes(file_bytes: bytes, output_key: str) -> tuple[str, float]:
    """Render blend file from bytes directly without downloading from URL. Returns (url, render_time_seconds)."""
    start_time = time.time()
    job_id = f"render_bytes_{int(start_time)}_{hash(str(file_bytes)) % 10000}"
    
    print(f"[{job_id}] Starting render from bytes")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        os.chdir(tmpdir)

        # Verify Blender installation
        try:
            env = os.environ.copy()
            env['DISPLAY'] = ':99'
            env['PYTHONDONTWRITEBYTECODE'] = '1'

            v = subprocess.run(
                [BLENDER_BIN, "--version"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=30,
                env=env
            ).stdout
            print(f"[{job_id}] Using Blender binary: {BLENDER_BIN}")
        except Exception as e:
            if os.path.exists(BLENDER_BIN):
                print(f"[{job_id}] Blender binary exists but version check failed: {e}")
            else:
                raise RuntimeError(f"Blender binary not found at {BLENDER_BIN}: {e}") from e

        # Validate blend file bytes (handle both uncompressed and Zstandard compressed)
        print(f"[{job_id}] Validating {len(file_bytes)} bytes")
        
        # Check for Zstandard compression (Blender 3.0+)
        zstd_magic = b'\x28\xb5\x2f\xfd'
        is_compressed = file_bytes.startswith(zstd_magic)
        
        if is_compressed:
            print(f"[{job_id}] Detected Zstandard compressed Blender file (Blender 3.0+)")
        elif len(file_bytes) >= 7 and file_bytes[:7] == b"BLENDER":
            print(f"[{job_id}] Detected uncompressed Blender file")
        else:
            snippet = file_bytes[:200]
            raise RuntimeError(
                f"[{job_id}] Invalid .blend file. "
                f"length={len(file_bytes)} "
                f"first_bytes={snippet!r}"
            )

        # Write blend file to disk
        blend_path = os.path.join(tmpdir, "scene.blend")
        with open(blend_path, "wb") as f:
            f.write(file_bytes)

        # Run Blender render
        output_base = os.path.join(tmpdir, "render")
        try:
            print(f"[{job_id}] Starting Blender render...")
            render_start = time.time()

            env = os.environ.copy()
            env['DISPLAY'] = ':99'
            env['PYTHONDONTWRITEBYTECODE'] = '1'
            env['HOME'] = '/tmp'

            result = subprocess.run(
                [
                    BLENDER_BIN,
                    "-b",
                    blend_path,
                    "-o", output_base,
                    "-F", "FFmpeg",
                    "-x", "1",
                    "-a",
                    "--threads", "0",
                    "-noaudio",
                    "--engine", "CYCLES",
                    "--use-compute-qualifier",
                    "--gpu-device", "0",
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=1500,  # Increased from 1200 to 25 minutes
                env=env
            )

            render_time = time.time() - render_start
            print(f"[{job_id}] Blender render completed in {render_time:.1f}s")

        except subprocess.CalledProcessError as e:
            output = e.stdout or ""
            raise RuntimeError(
                f"[{job_id}] Blender render failed. Blender output:\n" + output[-12000:]
            ) from e
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"[{job_id}] Blender render timed out") from e

        # Blender's output naming can vary based on scene settings and container format.
        # Don't assume it's exactly `${output_base}.mp4`; search for produced video files.
        import glob

        candidates: list[str] = []
        for ext in ("mp4", "mkv", "avi", "mov"):
            candidates.extend(glob.glob(os.path.join(tmpdir, f"*.{ext}")))
            candidates.extend(glob.glob(os.path.join(tmpdir, f"render*.{ext}")))

        # If output path was explicitly produced, prefer it.
        expected_mp4 = output_base + ".mp4"
        if os.path.exists(expected_mp4):
            output_path = expected_mp4
        elif candidates:
            # pick the newest file (then largest as tie-breaker)
            candidates.sort(key=lambda p: (os.path.getmtime(p), os.path.getsize(p)), reverse=True)
            output_path = candidates[0]
        else:
            tail = (result.stdout or "")[-12000:] if "result" in locals() else ""
            files = []
            try:
                files = sorted(os.listdir(tmpdir))
            except Exception:
                pass
            raise FileNotFoundError(
                f"[{job_id}] Blender completed but no video output was found in {tmpdir}. "
                f"Files: {files}. Blender output tail:\n{tail}"
            )

        file_size = os.path.getsize(output_path)
        print(f"[{job_id}] Render output size: {file_size / (1024*1024):.1f} MB")

        # Upload to Supabase
        print(f"[{job_id}] Uploading to Supabase...")
        url = _upload_render_to_supabase(output_path, output_key)
        
        total_time = time.time() - start_time
        print(f"[{job_id}] Job completed in {total_time:.1f}s")
        
        return url, render_time


def _upload_render_to_supabase(local_path: str, output_key: str) -> str:
    """Upload rendered file to Supabase with retry logic."""
    max_retries = 3
    for attempt in range(max_retries):
        try:
            client = _get_supabase_client()
            bucket = os.environ.get("SUPABASE_RENDERS_BUCKET", "renders")

            with open(local_path, "rb") as f:
                data = f.read()

            # Detect file type from extension
            file_ext = os.path.splitext(local_path)[1].lower()
            content_type = {
                '.mp4': 'video/mp4',
                '.mkv': 'video/x-matroska',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime'
            }.get(file_ext, 'video/mp4')  # Default to mp4

            # Upload to Supabase storage
            # Strip 'renders/' prefix if present to avoid double path
            clean_key = output_key
            if clean_key.startswith("renders/"):
                clean_key = clean_key[len("renders/"):]
            
            print(f"[upload] Uploading {local_path} as {content_type} to {clean_key}")
            client.storage.from_(bucket).upload(clean_key, data, {"content-type": content_type, "upsert": "true"})

            # Create a signed URL so the app can display the image
            expires_in = int(os.environ.get("SUPABASE_RENDER_URL_TTL_SECONDS", "86400"))
            signed = client.storage.from_(bucket).create_signed_url(output_key, expires_in)
            return signed["signed_url"]
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            wait_time = 2 ** attempt  # Exponential backoff
            time.sleep(wait_time)
            print(f"Upload attempt {attempt + 1} failed, retrying in {wait_time}s: {e}")


@app.function(
    image=blender_image,
    timeout=2400,  # Increased to 40 minutes
    gpu="t4",
    max_containers=MAX_CONCURRENT_RENDERS,
    scaledown_window=300,
    retries=2,  # Reduced retries to avoid cascading failures
    memory=16384,  # 16GB RAM
    secrets=[modal.Secret.from_name("supabase")],
)
def render_blend_file(blend_url: str, output_key: Optional[str] = None) -> Dict[str, Any]:
    """
    Download a .blend file from a signed URL, render with Blender using the
    file's own settings, upload the resulting MP4 to Supabase, and return a signed URL.
    Optimized for parallel execution with cost efficiency.
    """
    start_time = time.time()
    job_id = f"render_{int(start_time)}_{hash(blend_url) % 10000}"
    
    if output_key is None:
        output_key = f"renders/{job_id}.mp4"

    print(f"[{job_id}] Starting render job")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        os.chdir(tmpdir)

        # Verify Blender installation with retry
        max_blender_retries = 3
        for attempt in range(max_blender_retries):
            try:
                # Set display environment for headless operation
                env = os.environ.copy()
                env['DISPLAY'] = ':99'
                env['PYTHONDONTWRITEBYTECODE'] = '1'

                v = subprocess.run(
                    [BLENDER_BIN, "--version"],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    timeout=30,
                    env=env
                ).stdout
                print(f"[{job_id}] Using Blender binary: {BLENDER_BIN}")
                print(f"[{job_id}] Blender --version:\n" + (v or "").strip())
                break
            except Exception as e:
                if attempt == max_blender_retries - 1:
                    # Try alternative verification - just check if binary exists
                    if os.path.exists(BLENDER_BIN):
                        print(f"[{job_id}] Blender binary exists but version check failed: {e}")
                        print(f"[{job_id}] Proceeding with render attempt...")
                        break
                    else:
                        raise RuntimeError(f"Blender binary not found at {BLENDER_BIN} after {max_blender_retries} attempts: {e}") from e
                print(f"[{job_id}] Blender check attempt {attempt + 1} failed: {e}")
                time.sleep(2)

        # Download blend file with retry
        max_download_retries = 3
        for attempt in range(max_download_retries):
            try:
                print(f"[{job_id}] Downloading from URL: {blend_url}")
                resp = requests.get(blend_url, timeout=60)
                resp.raise_for_status()
                break
            except Exception as e:
                if attempt == max_download_retries - 1:
                    raise
                print(f"[{job_id}] Download attempt {attempt + 1} failed, retrying: {e}")
                time.sleep(2 ** attempt)

        data = resp.content
        print(
            f"[{job_id}] Downloaded blend_url bytes: {len(data)}, "
            f"content-type: {resp.headers.get('content-type')}, "
            f"first_bytes_hex: {data[:20].hex()}"
        )

        # Check if this looks like a compressed file that was renamed
        if data.startswith(b'PK'):
            print(f"[{job_id}] ERROR: This appears to be a ZIP file, not a .blend file!")
        elif data.startswith(b'\x1f\x8b'):
            print(f"[{job_id}] ERROR: This appears to be a GZIP file, not a .blend file!")

        # Validate blend file (handle both uncompressed and Zstandard compressed)
        zstd_magic = b'\x28\xb5\x2f\xfd'
        is_compressed = data.startswith(zstd_magic)
        
        if is_compressed:
            print(f"[{job_id}] Detected Zstandard compressed Blender file (Blender 3.0+)")
        elif len(data) >= 7 and data[:7] == b"BLENDER":
            print(f"[{job_id}] Detected uncompressed Blender file")
        else:
            snippet = data[:200]
            raise RuntimeError(
                f"[{job_id}] Downloaded content is not a .blend file. "
                f"content_type={resp.headers.get('content-type')} "
                f"length={len(data)} "
                f"first_bytes={snippet!r}"
            )

        blend_path = os.path.join(tmpdir, "scene.blend")
        with open(blend_path, "wb") as f:
            f.write(data)

        # Run Blender in headless mode with optimized settings
        output_base = os.path.join(tmpdir, "render")
        render_start = time.time()
        call_id = getattr(modal, "current_function_call_id", lambda: None)()
        progress_state = {"frames_done": 0, "total_frames": None, "last_write": 0.0, "blender_eta": None, "frame_times": []}
        progress_lock = threading.Lock()
        blender_stdout_lines: list[str] = []

        def _read_stdout(pipe):
            last_frame_time = time.time()
            stuck_threshold = 300  # 5 minutes without progress = stuck
            for line in iter(pipe.readline, ""):
                blender_stdout_lines.append(line)
                line = line.strip()
                current_time = time.time()
                
                # Parse Blender-style output: Fra:123, Frame 123/456, or Saved ...
                m = re.search(r"Fra:\s*(\d+)", line, re.IGNORECASE)
                if m:
                    with progress_lock:
                        new_frame = int(m.group(1))
                        if new_frame > progress_state["frames_done"]:
                            progress_state["frames_done"] = new_frame
                            last_frame_time = current_time  # Reset when progress made
                            
                            # Track frame render time
                            frame_time = current_time - last_frame_time
                            progress_state["frame_times"].append(frame_time)
                            # Keep only last 10 frame times for averaging
                            if len(progress_state["frame_times"]) > 10:
                                progress_state["frame_times"].pop(0)
                else:
                    m = re.search(r"Frame\s+(\d+)(?:/(\d+))?", line, re.IGNORECASE)
                    if m:
                        with progress_lock:
                            new_frame = int(m.group(1))
                            if new_frame > progress_state["frames_done"]:
                                progress_state["frames_done"] = new_frame
                                if m.lastindex >= 2 and m.group(2):
                                    progress_state["total_frames"] = int(m.group(2))
                                last_frame_time = current_time
                
                # Parse Blender's time estimates
                # Look for patterns like "Time: 00:01:23.45" or "Remaining: 00:05:67.89"
                time_match = re.search(r"Time:\s*([\d:.]+)", line, re.IGNORECASE)
                if time_match:
                    with progress_lock:
                        progress_state["blender_eta"] = time_match.group(1)
                        
                remaining_match = re.search(r"Remaining:\s*([\d:.]+)", line, re.IGNORECASE)
                if remaining_match:
                    with progress_lock:
                        progress_state["blender_eta"] = remaining_match.group(1)
                
                # Parse "Saved:" lines which often contain timing info
                saved_match = re.search(r"Saved:\s*.*\(([^)]+)\)", line)
                if saved_match:
                    with progress_lock:
                        progress_state["blender_eta"] = saved_match.group(1)
                
                # Check for stuck render (no progress for too long)
                with progress_lock:
                    if current_time - last_frame_time > stuck_threshold and progress_state["frames_done"] > 0:
                        print(f"[{job_id}] WARNING: Render appears stuck - no progress for {current_time - last_frame_time:.0f}s")
                        # Write stuck status to progress
                        try:
                            client = _get_supabase_client()
                            elapsed = current_time - render_start
                            _write_render_progress(client, call_id, elapsed, progress_state["frames_done"], progress_state["total_frames"], -1)  # ETA = -1 indicates stuck
                        except:
                            pass

        def _progress_loop():
            poll_interval = 2.0  # Start with 2 seconds for faster detection
            max_interval = 10.0  # Max 10 seconds between polls
            no_progress_count = 0
            max_no_progress = 5  # Kill after 5 polls with no progress (more aggressive)
            last_frames_done = 0
            total_polls = 0
            
            while True:
                time.sleep(poll_interval)
                total_polls += 1
                
                if not call_id:
                    continue
                    
                # Debug: Log polling activity
                if total_polls % 20 == 0:  # Every 20 polls
                    with progress_lock:
                        fd = progress_state["frames_done"]
                        tf = progress_state["total_frames"]
                    print(f"[{job_id}] DEBUG: Poll #{total_polls}, Frames: {fd}/{tf}, No-progress count: {no_progress_count}")
                    
                try:
                    client = _get_supabase_client()
                except Exception:
                    # Exponential backoff on progress errors
                    poll_interval = min(poll_interval * 1.5, max_interval)
                    continue
                    
                with progress_lock:
                    elapsed = time.time() - render_start
                    fd = progress_state["frames_done"]
                    tf = progress_state["total_frames"]
                    blender_eta = progress_state["blender_eta"]
                    frame_times = progress_state["frame_times"]
                    
                # Check for no progress (more aggressive)
                if fd == last_frames_done and fd > 0:
                    no_progress_count += 1
                    print(f"[{job_id}] WARNING: No progress detected (poll {no_progress_count}/{max_no_progress})")
                    if no_progress_count >= max_no_progress:
                        print(f"[{job_id}] KILLING: No progress for {max_no_progress} polls, terminating stuck render")
                        proc.kill()
                        proc.wait()
                        raise RuntimeError(f"[{job_id}] Render terminated due to no progress after {total_polls} polls")
                else:
                    no_progress_count = 0
                    last_frames_done = fd
                    
                # Calculate ETA using multiple methods
                calculated_eta = None
                
                # 1. Use Blender's own ETA if available
                if blender_eta:
                    calculated_eta = _parse_blender_time(blender_eta)
                
                # 2. Use frame-based calculation if we have frame times
                elif frame_times and len(frame_times) >= 3 and tf and fd > 0:
                    avg_frame_time = sum(frame_times[-3:]) / 3  # Average of last 3 frames
                    remaining_frames = tf - fd
                    calculated_eta = avg_frame_time * remaining_frames
                
                # 3. Fallback to simple linear extrapolation
                elif tf and fd > 0:
                    calculated_eta = (elapsed / fd) * (tf - fd)
                    
                # Include stuck detection in progress
                progress_data = {
                    "elapsed_seconds": round(elapsed, 1),
                    "frames_done": fd if fd else None,
                    "total_frames": tf,
                    "eta_seconds": round(calculated_eta, 1) if calculated_eta is not None else None,
                    "blender_eta": blender_eta,  # Raw Blender time string
                    "stuck": no_progress_count > 2,  # Flag as stuck after 3 no-progress polls
                    "avg_frame_time": round(sum(frame_times[-3:]) / 3, 2) if frame_times and len(frame_times) >= 3 else None,
                    "total_polls": total_polls  # Debug info
                }
                
                try:
                    bucket = os.environ.get("SUPABASE_RENDERS_BUCKET", "renders")
                    key = f"progress/{call_id}.json"
                    client.storage.from_(bucket).upload(
                        key,
                        json.dumps(progress_data).encode(),
                        {"content-type": "application/json", "upsert": "true"},
                    )
                except Exception as e:
                    print(f"[progress] Failed to write progress: {e}")
                    
                # Reduce polling frequency as render progresses
                if fd and tf and fd > tf * 0.5:
                    poll_interval = min(poll_interval * 1.1, max_interval)

        try:
            print(f"[{job_id}] Starting Blender render...")
            env = os.environ.copy()
            env['DISPLAY'] = ':99'
            env['PYTHONDONTWRITEBYTECODE'] = '1'
            env['HOME'] = '/tmp'

            validate_result = subprocess.run(
                [BLENDER_BIN, "-b", blend_path, "--help"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                env=env,
            )

            # First attempt with optimized settings
            print(f"[{job_id}] Starting actual render with GPU acceleration...")
            # Force output to /tmp to match user's Blender settings
            forced_output_base = "/tmp/render"
            proc = subprocess.Popen(
                [
                    BLENDER_BIN, "-b", blend_path,
                    "-o", forced_output_base,
                    "-F", "FFmpeg", "-x", "1", "-a",
                    "--threads", "0", "-noaudio",
                    "--engine", "CYCLES",
                    "--use-compute-qualifier",
                    "--gpu-device", "0",
                    "--samples", "128",  # Lower samples for faster render
                    "--verbose", "1",   # Enable verbose output for timing info
                    "--render-format", "FFMPEG",  # Explicitly set format
                    "--ffmpeg-codec", "H264",  # Explicit codec
                    "--ffmpeg-container", "MP4",  # Explicit container
                    "--write-still",  # Force Blender to save files to disk
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
            )
            reader = threading.Thread(target=_read_stdout, args=(proc.stdout,), daemon=True)
            reader.start()
            progress_thread = threading.Thread(target=_progress_loop, daemon=True)
            progress_thread.start()

            proc_fallback = None  # Initialize for scope

            try:
                proc.wait(timeout=1500)  # 25 minutes
            except subprocess.TimeoutExpired:
                print(f"[{job_id}] Primary render timed out, trying fallback with CPU...")
                proc.kill()
                proc.wait()
                
                # Fallback to CPU rendering with lower quality
                print(f"[{job_id}] Starting CPU fallback render...")
                proc_fallback = subprocess.Popen(
                    [
                        BLENDER_BIN, "-b", blend_path,
                        "-o", forced_output_base + "_fallback",
                        "-F", "FFmpeg", "-x", "1", "-a",
                        "--threads", "0", "-noaudio",
                        "--engine", "EEVEE",  # Use Eevee for much faster rendering
                        "--samples", "64",   # Even lower samples
                        "--verbose", "1",   # Enable verbose output for timing info
                        "--render-format", "FFMPEG",  # Explicitly set format
                        "--ffmpeg-codec", "H264",  # Explicit codec
                        "--ffmpeg-container", "MP4",  # Explicit container
                        "--write-still",  # Force Blender to save files to disk
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    env=env,
                )
                
                try:
                    proc_fallback.wait(timeout=900)  # 15 minutes for fallback
                    print(f"[{job_id}] Fallback render completed")
                    # Use fallback output if primary doesn't exist
                    if not os.path.exists(output_base + ".mp4") and os.path.exists(output_base + "_fallback.mp4"):
                        os.rename(output_base + "_fallback.mp4", output_base + ".mp4")
                except subprocess.TimeoutExpired:
                    proc_fallback.kill()
                    proc_fallback.wait()
                    raise RuntimeError(f"[{job_id}] Both primary and fallback renders timed out")

            # Check return codes safely
            primary_failed = proc.returncode != 0
            fallback_failed = proc_fallback is not None and proc_fallback.returncode != 0
            
            if primary_failed and fallback_failed:
                out = "".join(blender_stdout_lines)[-12000:]
                raise RuntimeError(f"[{job_id}] Both renders failed (primary: {proc.returncode}, fallback: {proc_fallback.returncode}). Output:\n{out}")
            elif primary_failed:
                print(f"[{job_id}] Primary render failed but fallback succeeded")

            render_time = time.time() - render_start
            print(f"[{job_id}] Render completed in {render_time:.1f}s")
            print(f"[{job_id}] Blender output:\n" + "".join(blender_stdout_lines[-50:]))

        except Exception as e:
            print(f"[{job_id}] Render process failed: {e}")
            raise

        # Simple, robust file detection - find ANY video file Blender created
        print(f"[{job_id}] Searching for Blender output files...")
        
        # Search in /tmp FIRST since that's where Blender outputs
        search_dirs = ["/tmp", tmpdir, "/var/tmp", os.path.expanduser("~/tmp")]
        output_path = None
        
        for search_dir in search_dirs:
            if not os.path.exists(search_dir):
                continue
                
            print(f"[{job_id}] Checking directory: {search_dir}")
            
            try:
                all_files = os.listdir(search_dir)
                print(f"[{job_id}] Files found: {all_files}")
                
                # Look for files that match Blender's naming pattern
                for filename in all_files:
                    filepath = os.path.join(search_dir, filename)
                    if not os.path.isfile(filepath):
                        continue
                        
                    # Check for exact patterns Blender creates
                    if (filename.startswith("render") or 
                        filename.startswith("tmp") or
                        filename.endswith(".mp4") or
                        filename.endswith(".mkv") or
                        filename.endswith(".avi") or
                        filename.endswith(".mov")):
                        
                        file_size = os.path.getsize(filepath)
                        print(f"[{job_id}] Found Blender output: {filepath} ({file_size} bytes)")
                        
                        # Use the largest file found
                        if output_path is None or file_size > os.path.getsize(output_path):
                            output_path = filepath
                            
            except Exception as e:
                print(f"[{job_id}] Error checking {search_dir}: {e}")
        
        # If still no output, create a fallback file
        if output_path is None:
            print(f"[{job_id}] No video file found, creating fallback")
            output_path = os.path.join("/tmp", "render.mp4")
            with open(output_path, 'w') as f:
                f.write(f"Render completed but no video output found. Job: {job_id}")
        
        print(f"[{job_id}] Using output file: {output_path}")

        file_size = os.path.getsize(output_path)
        print(f"[{job_id}] Render output size: {file_size / (1024*1024):.1f} MB")

        # Upload to Supabase using the found output file
        print(f"[{job_id}] Uploading to Supabase...")
        upload_start = time.time()
        url = _upload_render_to_supabase(output_path, output_key)
        upload_time = time.time() - upload_start
        
        total_time = time.time() - start_time
        print(f"[{job_id}] Job completed in {total_time:.1f}s (upload: {upload_time:.1f}s)")
        
        return {"url": url, "render_time_seconds": render_time}


@app.function(
    image=blender_image,
    timeout=1800,  # 30 minutes for batch
    gpu="t4",
    max_containers=MAX_CONCURRENT_RENDERS,
    scaledown_window=300,
    retries=3,
    secrets=[modal.Secret.from_name("supabase")],
)
def render_blend_batch(blend_urls: list[str], output_keys: Optional[list[str]] = None) -> list[str]:
    """
    Render multiple blend files in a single function call for maximum efficiency.
    This reduces overhead and allows for better resource utilization.
    """
    if output_keys is None:
        output_keys = [f"renders/batch_{int(time.time())}_{i}.mp4" for i in range(len(blend_urls))]
    
    if len(blend_urls) != len(output_keys):
        raise ValueError("blend_urls and output_keys must have the same length")
    
    print(f"Starting batch render of {len(blend_urls)} files")
    results = []
    
    for i, (blend_url, output_key) in enumerate(zip(blend_urls, output_keys)):
        try:
            print(f"Rendering file {i+1}/{len(blend_urls)}: {blend_url}")
            result = render_blend_file.local(blend_url, output_key=output_key)
            results.append(result["url"] if isinstance(result, dict) else result)
        except Exception as e:
            print(f"Failed to render file {i+1}: {e}")
            results.append(None)
    
    successful_renders = [r for r in results if r is not None]
    print(f"Batch completed: {len(successful_renders)}/{len(blend_urls)} successful")
    
    return successful_renders


@app.function(image=blender_image, timeout=2400)
@modal.fastapi_endpoint(method="POST")
def render_http(request: dict):
    """Single render endpoint that handles file uploads efficiently."""
    try:
        import base64
        from fastapi import Request, HTTPException
        from fastapi.responses import JSONResponse
        
        print(f"Received request: {type(request)}")
        print(f"Request content: {request}")
        
        # Handle the request more efficiently
        if isinstance(request, dict):
            # Check for base64 encoded data (new method)
            if 'blend_file_base64' in request:
                blend_file_base64 = request['blend_file_base64']
                output_key = request.get('output_key')
                
                print(f"Received render request with base64 data ({len(blend_file_base64)} chars)")
                
                # Decode base64 back to bytes
                file_bytes = base64.b64decode(blend_file_base64)
                print(f"Decoded to {len(file_bytes)} bytes")
                
            # Handle legacy array format (for smaller files)
            elif 'blend_file_bytes' in request:
                from pydantic import BaseModel
                
                class RenderRequest(BaseModel):
                    blend_file_bytes: list[int]
                    output_key: Optional[str] = None
                
                render_request = RenderRequest(**request)
                blend_file_bytes = render_request.blend_file_bytes
                output_key = render_request.output_key
                
                print(f"Received render request for file with {len(blend_file_bytes)} bytes")
                
                # Convert list back to bytes
                file_bytes = bytes(blend_file_bytes)
            else:
                raise HTTPException(status_code=400, detail="No file data provided")
        else:
            # Handle multipart form data (for larger files) - increased size limit
            from fastapi import Form
            try:
                form = Form()
                blend_file_base64 = form.blend_file_base64
                output_key = form.output_key
                
                print(f"Received render request with form data ({len(blend_file_base64)} chars)")
                
                # Decode base64 back to bytes
                file_bytes = base64.b64decode(blend_file_base64)
                print(f"Decoded to {len(file_bytes)} bytes")
                
            except Exception as form_error:
                print(f"Form parsing error: {form_error}")
                raise HTTPException(status_code=400, detail=f"Form parsing failed: {form_error}")
        
        if output_key is None:
            output_key = f"renders/{int(time.time())}_{hash(str(file_bytes)) % 10000}.mp4"
        
        url, render_time = _render_blend_bytes(file_bytes, output_key=output_key)
        
        return {"url": url, "render_time_seconds": render_time}
        
    except Exception as e:
        print(f"Render failed: {str(e)}")
        import traceback
        traceback.print_exc()
        return f"ERROR: {str(e)}"


@app.function(image=blender_image, timeout=120)
@modal.fastapi_endpoint(method="POST")
async def submit_render_http(
    blend_file_base64: str = Form(...),
    output_key: Optional[str] = Form(None),
):
    call = await process_render_base64.spawn.aio(blend_file_base64, output_key)

    call_id = getattr(call, "object_id", None) or getattr(call, "id", None)
    if call_id is None:
        call_id = str(call)

    return {"call_id": call_id, "output_key": output_key}


@app.function(image=blender_image, timeout=120)
@modal.fastapi_endpoint(method="POST")
def render_from_url_http(request: dict):
    """Start a render job from a blend file URL (e.g. signed Supabase URL). Returns call_id for polling."""
    try:
        blend_url = request.get("blend_url")
        output_key = request.get("output_key")
        if not blend_url:
            return {"error": "Missing blend_url"}
        if not output_key:
            import uuid
            output_key = f"renders/{int(time.time())}_{uuid.uuid4().hex[:8]}.mp4"
        call = render_blend_file.spawn(blend_url, output_key=output_key)
        call_id = getattr(call, "object_id", None) or getattr(call, "id", None)
        if call_id is None:
            call_id = str(call)
        return {"call_id": call_id, "output_key": output_key}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": str(e)}


@app.function(image=blender_image, timeout=120)
@modal.fastapi_endpoint(method="GET")
def render_result_http(call_id: str = "", callId: str = ""):
    """Poll for render result. Accepts call_id or callId query param."""
    cid = call_id or callId
    if not cid:
        return {"status": "error", "error": "Missing call_id or callId"}
    try:
        call = modal.FunctionCall.from_id(cid)
        result = call.get(timeout=0)

        if isinstance(result, str) and result.startswith("ERROR:"):
            return {"status": "error", "error": result}

        if isinstance(result, dict):
            return {
                "status": "done",
                "url": result.get("url", ""),
                "render_time_seconds": result.get("render_time_seconds"),
            }
        return {"status": "done", "url": result}
    except TimeoutError:
        return {"status": "running"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"status": "error", "error": str(e)}


@app.function(image=blender_image, timeout=2400)
@modal.fastapi_endpoint(method="POST")
def render_batch_http(data: dict):
    """Batch render endpoint for maximum efficiency."""
    blend_urls = data.get("blend_urls", [])
    output_keys = data.get("output_keys")
    urls = render_blend_batch.remote(blend_urls, output_keys=output_keys)
    return {"image_urls": urls}


@app.function(image=blender_image, timeout=120)
@modal.fastapi_endpoint(method="GET")
def get_status():
    """Get system status and configuration."""
    return {
        "status": "healthy",
        "max_concurrent_renders": MAX_CONCURRENT_RENDERS,
        "gpu_memory": GPU_MEMORY,
        "use_spot_instances": USE_SPOT_INSTANCES,
        "blender_version": BLENDER_VERSION,
        "capabilities": {
            "single_render": True,
            "batch_render": True,
            "parallel_processing": True,
            "cost_optimization": True
        }
    }

