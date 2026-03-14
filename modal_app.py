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


@app.function(image=blender_image, timeout=120)
@modal.fastapi_endpoint(method="POST")
def estimate_render_time(request: dict):
    """Estimate render time for a blend file without actually rendering."""
    import base64
    
    try:
        blend_file_base64 = request.get("blend_file_base64")
        if not blend_file_base64:
            return {"error": "Missing blend_file_base64 in request"}
        
        file_bytes = base64.b64decode(blend_file_base64)
        job_id = f"estimate_{int(time.time())}"
        
        with tempfile.TemporaryDirectory() as tmpdir:
            os.chdir(tmpdir)
            
            # Write blend file to disk
            blend_path = os.path.join(tmpdir, "scene.blend")
            with open(blend_path, "wb") as f:
                f.write(file_bytes)
            
            # Analyze scene complexity
            complexity = _analyze_blend_file_complexity(blend_path, job_id)
            estimated_time = complexity.get('estimated_total_time', 600)
            
            # Calculate accuracy based on complexity factors
            accuracy_score = _calculate_accuracy_score(complexity)
            
            return {
                "estimated_time_seconds": estimated_time,
                "estimated_time_formatted": _format_time_estimate(estimated_time),
                "complexity_score": complexity.get('complexity_score', 1.0),
                "total_frames": complexity.get('frames', 1),
                "resolution": complexity.get('resolution', '1920x1080'),
                "samples": complexity.get('samples', 128),
                "engine": complexity.get('engine', 'CYCLES'),
                "accuracy_score": accuracy_score,
                "accuracy_description": _get_accuracy_description(accuracy_score)
            }
            
    except Exception as e:
        return {"error": f"Failed to estimate render time: {str(e)}"}


def _calculate_accuracy_score(complexity: Dict[str, Any]) -> float:
    """Calculate accuracy score for the estimate (0-1, higher is more accurate)."""
    score = 0.8  # Base accuracy
    
    # Reduce accuracy for complex scenes
    complexity_score = complexity.get('complexity_score', 1.0)
    if complexity_score > 20:
        score -= 0.3  # Very complex scenes are harder to estimate
    elif complexity_score > 10:
        score -= 0.2
    elif complexity_score > 5:
        score -= 0.1
    
    # Increase accuracy for simple scenes
    if complexity_score < 2:
        score += 0.1
    
    # Adjust for render engine
    engine = complexity.get('engine', 'CYCLES')
    if engine == 'CYCLES':
        score -= 0.1  # Cycles is more variable than Eevee
    
    return max(0.3, min(0.95, score))  # Clamp between 30% and 95%


def _get_accuracy_description(score: float) -> str:
    """Get human-readable accuracy description."""
    if score >= 0.8:
        return "High accuracy - usually within ±20%"
    elif score >= 0.6:
        return "Medium accuracy - usually within ±50%"
    else:
        return "Low accuracy - could vary significantly"


def _format_time_estimate(seconds: float) -> str:
    """Format time estimate in human-readable format."""
    if seconds < 60:
        return f"~{int(seconds)} seconds"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"~{minutes}m {secs}s"
    else:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        return f"~{hours}h {minutes}m"


@app.function(
    image=blender_image,
    timeout=86400,  # Set to 24 hours maximum for very complex scenes
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


def _analyze_blend_file_complexity(blend_path: str, job_id: str) -> Dict[str, Any]:
    """Analyze blend file to estimate render complexity and adjust timeout."""
    try:
        env = os.environ.copy()
        env['DISPLAY'] = ':99'
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        
        # Get scene information
        result = subprocess.run(
            [
                BLENDER_BIN, "-b", blend_path,
                "--python-expr", """
import bpy
scene = bpy.context.scene
print(f"FRAMES:{scene.frame_end - scene.frame_start + 1}")
print(f"RESOLUTION:{scene.render.resolution_x}x{scene.render.resolution_y}")
print(f"FPS:{scene.render.fps}")
print(f"SAMPLES:{getattr(scene.cycles, 'samples', getattr(scene.eevee, 'taa_render_samples', 128))}")
print(f"ENGINE:{scene.render.engine}")
"""
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            env=env
        )
        
        output = result.stdout
        complexity_info = {}
        
        # Parse scene information
        for line in output.split('\n'):
            if line.startswith('FRAMES:'):
                complexity_info['frames'] = int(line.split(':')[1])
            elif line.startswith('RESOLUTION:'):
                complexity_info['resolution'] = line.split(':')[1]
            elif line.startswith('FPS:'):
                complexity_info['fps'] = int(line.split(':')[1])
            elif line.startswith('SAMPLES:'):
                complexity_info['samples'] = int(line.split(':')[1])
            elif line.startswith('ENGINE:'):
                complexity_info['engine'] = line.split(':')[1]
        
        # Calculate complexity score and estimated time
        frames = complexity_info.get('frames', 1)
        resolution_parts = complexity_info.get('resolution', '1920x1080').split('x')
        resolution_x = int(resolution_parts[0])
        resolution_y = int(resolution_parts[1])
        samples = complexity_info.get('samples', 128)
        engine = complexity_info.get('engine', 'CYCLES')
        
        # Base time per frame (seconds) - rough estimates
        base_time_per_frame = 0.5  # Base time
        resolution_factor = (resolution_x * resolution_y) / (1920 * 1080)  # Resolution scaling
        sample_factor = samples / 128  # Sample scaling
        engine_factor = 3.0 if engine == 'CYCLES' else 1.0  # Cycles is slower
        
        # Add conservative multiplier for Zstandard compressed files (often more complex)
        compression_multiplier = 1.5  # Zstd files tend to be more complex scenes
        
        estimated_time_per_frame = base_time_per_frame * resolution_factor * sample_factor * engine_factor * compression_multiplier
        estimated_total_time = frames * estimated_time_per_frame
        
        # Apply more conservative sanity checks
        if estimated_total_time < 30:  # Less than 30 seconds seems too optimistic
            estimated_total_time = 180  # Minimum 3 minutes
        elif estimated_total_time > 3600:  # More than 1 hour per frame seems excessive
            estimated_total_time = 2400  # Cap at 40 minutes per frame
        
        complexity_info.update({
            'estimated_time_per_frame': estimated_time_per_frame,
            'estimated_total_time': estimated_total_time,
            'complexity_score': frames * resolution_factor * sample_factor * engine_factor,
            'compression_multiplier': compression_multiplier
        })
        
        print(f"[{job_id}] Scene analysis: {complexity_info}")
        return complexity_info
        
    except Exception as e:
        print(f"[{job_id}] Failed to analyze scene complexity: {e}")
        # Return conservative defaults
        return {
            'frames': 1,
            'resolution': '1920x1080',
            'fps': 24,
            'samples': 128,
            'engine': 'CYCLES',
            'estimated_total_time': 600,  # 10 minutes default
            'complexity_score': 1.0
        }


def _get_render_progress(call_id: str) -> Optional[Dict[str, Any]]:
    """Get render progress from Supabase storage."""
    try:
        client = _get_supabase_client()
        bucket = os.environ.get("SUPABASE_RENDERS_BUCKET", "renders")
        key = f"progress/{call_id}.json"
        
        # Try to download the progress file
        response = client.storage.from_(bucket).download(key)
        if response:
            progress_data = json.loads(response.decode('utf-8'))
            
            # Add human-readable ETA
            if progress_data.get("eta_seconds") is not None:
                eta_seconds = progress_data["eta_seconds"]
                if eta_seconds > 0:
                    # Convert to human-readable format
                    if eta_seconds < 60:
                        progress_data["eta_formatted"] = f"{int(eta_seconds)}s"
                    elif eta_seconds < 3600:
                        minutes = int(eta_seconds // 60)
                        seconds = int(eta_seconds % 60)
                        progress_data["eta_formatted"] = f"{minutes}m {seconds}s"
                    else:
                        hours = int(eta_seconds // 3600)
                        minutes = int((eta_seconds % 3600) // 60)
                        progress_data["eta_formatted"] = f"{hours}h {minutes}m"
                    
                    # Add estimated completion time
                    import datetime
                    completion_time = datetime.datetime.now() + datetime.timedelta(seconds=eta_seconds)
                    progress_data["estimated_completion"] = completion_time.isoformat()
            
            # Add progress percentage
            if progress_data.get("frames_done") and progress_data.get("total_frames"):
                frames_done = progress_data["frames_done"]
                total_frames = progress_data["total_frames"]
                progress_data["progress_percent"] = round((frames_done / total_frames) * 100, 1)
            
            return progress_data
    except Exception as e:
        print(f"[progress] Failed to get progress for {call_id}: {e}")
        return None


def _detect_stuck_render(progress_state: Dict[str, Any], elapsed_seconds: float, total_frames: int) -> bool:
    """Detect if a render is stuck based on progress patterns."""
    frames_done = progress_state.get("frames_done", 0)
    last_frames_done = progress_state.get("last_frames_done", 0)
    last_check_time = progress_state.get("last_check_time", 0.0)
    
    # Update progress tracking
    progress_state["last_frames_done"] = frames_done
    progress_state["last_check_time"] = elapsed_seconds
    
    # If no progress for more than 10 minutes and we've rendered at least one frame
    if frames_done > 0 and frames_done == last_frames_done and (elapsed_seconds - last_check_time) > 600:
        return True
    
    # If still on first frame after more than 30 minutes
    if frames_done == 0 and elapsed_seconds > 1800 and total_frames > 1:
        return True
    
    return False


def _write_render_progress(client, call_id: str, elapsed_seconds: float, frames_done: Optional[int] = None, total_frames: Optional[int] = None, eta_seconds: Optional[float] = None, blender_remaining: Optional[str] = None, blender_elapsed: Optional[str] = None, estimate_source: Optional[str] = None) -> None:
    """Write progress JSON to Supabase storage for the UI to poll."""
    bucket = os.environ.get("SUPABASE_RENDERS_BUCKET", "renders")
    key = f"progress/{call_id}.json"
    payload = {
        "elapsed_seconds": round(elapsed_seconds, 1),
        "frames_done": frames_done,
        "total_frames": total_frames,
        "eta_seconds": round(eta_seconds, 1) if eta_seconds is not None else None,
        "blender_remaining": blender_remaining,
        "blender_elapsed": blender_elapsed,
        "estimate_source": estimate_source,
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

        # Analyze scene complexity to determine appropriate timeout
        complexity = _analyze_blend_file_complexity(blend_path, job_id)
        estimated_time = complexity.get('estimated_total_time', 600)
        
        # Use intelligent timeout system - only timeout if truly stuck or excessive frames
        # Check for excessive frame count (>500 frames)
        total_frames = complexity.get('frames', 1)
        if total_frames > 500:
            dynamic_timeout = 86400  # 24 hours for very high frame counts
        else:
            # For normal frame counts, use a very long base timeout to avoid false timeouts
            # We'll rely on progress monitoring to detect stuck renders
            dynamic_timeout = 43200  # 12 hours base timeout
            
            # Only add extra time for very complex scenes
            if complexity.get('complexity_score', 1.0) > 20:
                dynamic_timeout = 86400  # 24 hours for extremely complex scenes
        
        print(f"[{job_id}] Scene complexity score: {complexity.get('complexity_score', 1.0):.1f}")
        print(f"[{job_id}] Total frames: {total_frames}")
        print(f"[{job_id}] Using intelligent timeout: {dynamic_timeout}s (estimated: {estimated_time:.1f}s)")

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
                    "--render-anim",
                    "--fps-base", "1",
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=dynamic_timeout,
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
    """Upload rendered file to Supabase with retry logic and better error handling."""
    max_retries = 5  # Increased retries for upload issues
    for attempt in range(max_retries):
        try:
            client = _get_supabase_client()
            bucket = os.environ.get("SUPABASE_RENDERS_BUCKET", "renders")

            with open(local_path, "rb") as f:
                data = f.read()

            # Upload to Supabase storage
            # Strip 'renders/' prefix if present to avoid double path
            clean_key = output_key
            if clean_key.startswith("renders/"):
                clean_key = clean_key[len("renders/"):]

            # Check if file already exists and handle it
            try:
                client.storage.from_(bucket).upload(clean_key, data, {"content-type": "video/mp4", "upsert": "true"})
            except Exception as upload_error:
                # If upload fails due to file existing, try to delete and re-upload
                if "already exists" in str(upload_error) or "409" in str(upload_error):
                    print(f"[upload] File already exists, deleting and re-uploading...")
                    try:
                        client.storage.from_(bucket).remove([clean_key])
                        time.sleep(1)  # Brief pause before re-upload
                        client.storage.from_(bucket).upload(clean_key, data, {"content-type": "video/mp4"})
                    except Exception as delete_error:
                        print(f"[upload] Delete failed: {delete_error}")
                        # If delete fails, try upsert instead
                        client.storage.from_(bucket).upload(clean_key, data, {"content-type": "video/mp4", "upsert": "true"})
                else:
                    raise upload_error

            # Create a signed URL so the app can display the image
            expires_in = int(os.environ.get("SUPABASE_RENDER_URL_TTL_SECONDS", "86400"))
            signed = client.storage.from_(bucket).create_signed_url(clean_key, expires_in)
            return signed["signed_url"]
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            # Longer wait times for upload issues
            wait_time = min(30, 2 ** attempt + 5)  # Cap at 30 seconds
            print(f"[upload] Attempt {attempt + 1} failed, retrying in {wait_time}s: {e}")
            time.sleep(wait_time)


@app.function(
    image=blender_image,
    timeout=86400,  # Set to 24 hours maximum for very complex scenes
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

        # Analyze scene complexity to determine appropriate timeout
        complexity = _analyze_blend_file_complexity(blend_path, job_id)
        estimated_time = complexity.get('estimated_total_time', 600)
        
        # Use intelligent timeout system - only timeout if truly stuck or excessive frames
        # Check for excessive frame count (>500 frames)
        total_frames = complexity.get('frames', 1)
        if total_frames > 500:
            dynamic_timeout = 86400  # 24 hours for very high frame counts
        else:
            # For normal frame counts, use a very long base timeout to avoid false timeouts
            # We'll rely on progress monitoring to detect stuck renders
            dynamic_timeout = 43200  # 12 hours base timeout
            
            # Only add extra time for very complex scenes
            if complexity.get('complexity_score', 1.0) > 20:
                dynamic_timeout = 86400  # 24 hours for extremely complex scenes
        
        print(f"[{job_id}] Scene complexity score: {complexity.get('complexity_score', 1.0):.1f}")
        print(f"[{job_id}] Total frames: {total_frames}")
        print(f"[{job_id}] Using intelligent timeout: {dynamic_timeout}s (estimated: {estimated_time:.1f}s)")

        # Run Blender in headless mode with optimized settings
        output_base = os.path.join(tmpdir, "render")
        render_start = time.time()
        call_id = getattr(modal, "current_function_call_id", lambda: None)()
        progress_state = {"frames_done": 0, "total_frames": None, "last_write": 0.0}
        progress_lock = threading.Lock()
        blender_stdout_lines: list[str] = []

        def _read_stdout(pipe):
            for line in iter(pipe.readline, ""):
                blender_stdout_lines.append(line)
                line = line.strip()
                
                # Parse Blender-style output: Fra:123, Frame 123/456, or Saved ...
                m = re.search(r"Fra:\s*(\d+)", line, re.IGNORECASE)
                if m:
                    with progress_lock:
                        progress_state["frames_done"] = max(progress_state["frames_done"], int(m.group(1)))
                else:
                    m = re.search(r"Frame\s+(\d+)(?:/(\d+))?", line, re.IGNORECASE)
                    if m:
                        with progress_lock:
                            progress_state["frames_done"] = max(progress_state["frames_done"], int(m.group(1)))
                            if m.lastindex >= 2 and m.group(2):
                                progress_state["total_frames"] = int(m.group(2))
                
                # Parse Blender's time estimation: "Time: 00:01:23.45" or "Remaining: 00:00:45.12"
                time_match = re.search(r"Time:\s*(\d{2}:\d{2}:\d{2}\.\d{2})", line, re.IGNORECASE)
                remaining_match = re.search(r"Remaining:\s*(\d{2}:\d{2}:\d{2}\.\d{2})", line, re.IGNORECASE)
                
                if time_match or remaining_match:
                    with progress_lock:
                        if time_match:
                            # Blender shows elapsed time
                            progress_state["blender_elapsed"] = time_match.group(1)
                        if remaining_match:
                            # Blender shows remaining time - this is what we want!
                            progress_state["blender_remaining"] = remaining_match.group(1)
                            progress_state["blender_estimate_source"] = "blender"

        def _progress_loop():
            while True:
                time.sleep(5)
                if not call_id:
                    continue
                try:
                    client = _get_supabase_client()
                except Exception:
                    continue
                with progress_lock:
                    elapsed = time.time() - render_start
                    fd = progress_state["frames_done"]
                    tf = progress_state["total_frames"]
                    
                    # Check if render is stuck
                    if tf and _detect_stuck_render(progress_state, elapsed, tf):
                        print(f"[{job_id}] Render appears to be stuck - no progress for too long")
                        # Kill process if stuck
                        if 'proc' in locals() and proc.poll() is None:
                            proc.kill()
                        return
                    
                    # Use Blender's own time estimation if available
                    blender_remaining = progress_state.get("blender_remaining")
                    blender_elapsed = progress_state.get("blender_elapsed")
                    estimate_source = progress_state.get("blender_estimate_source")
                    
                    # Convert Blender time format to seconds
                    eta_seconds = None
                    if blender_remaining:
                        try:
                            # Parse HH:MM:SS.ms format
                            time_parts = blender_remaining.split(':')
                            hours = int(time_parts[0])
                            minutes = int(time_parts[1])
                            seconds = float(time_parts[2])
                            eta_seconds = hours * 3600 + minutes * 60 + seconds
                        except:
                            pass
                    elif tf and tf > 0 and fd > 0 and fd <= tf:
                        # Fallback to calculation if Blender doesn't provide estimate
                        eta = (elapsed / fd) * (tf - fd)
                        eta_seconds = eta
                    
                _write_render_progress(client, call_id, elapsed, fd if fd else None, tf, eta_seconds, 
                                  blender_remaining, blender_elapsed, estimate_source)

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

            print(f"[{job_id}] Starting actual render...")
            proc = subprocess.Popen(
                [
                    BLENDER_BIN, "-b", blend_path,
                    "-o", output_base,
                    "-F", "FFmpeg", "-x", "1", "-a",
                    "--threads", "0", "-noaudio",
                    "--render-anim",
                    "--fps-base", "1",
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

            try:
                proc.wait(timeout=dynamic_timeout)  # Use dynamic timeout
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                raise RuntimeError(f"[{job_id}] Blender render timed out after {dynamic_timeout}s (estimated: {estimated_time:.1f}s)")

            if proc.returncode != 0:
                out = "".join(blender_stdout_lines)[-12000:]
                raise RuntimeError(f"[{job_id}] Blender render failed (exit {proc.returncode}). Output:\n{out}")

            render_time = time.time() - render_start
            print(f"[{job_id}] Blender render completed in {render_time:.1f}s")
            print(f"[{job_id}] Blender output:\n" + "".join(blender_stdout_lines[-50:]))

        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"[{job_id}] Blender render error: {e}") from e

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
            tail = "".join(blender_stdout_lines)[-12000:] if "blender_stdout_lines" in locals() else ""
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
        upload_start = time.time()
        url = _upload_render_to_supabase(output_path, output_key)
        upload_time = time.time() - upload_start
        
        total_time = time.time() - start_time
        print(f"[{job_id}] Job completed in {total_time:.1f}s (upload: {upload_time:.1f}s)")
        
        return {"url": url, "render_time_seconds": render_time}


@app.function(
    image=blender_image,
    timeout=86400,  # Set to 24 hours maximum for very complex scenes
    gpu="l4",
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


# Removed render_from_url_http endpoint - not used by current UI


@app.function(image=blender_image, timeout=120)
@modal.fastapi_endpoint(method="GET")
def render_progress_http(call_id: str = "", callId: str = ""):
    """Get detailed render progress including ETA. Accepts call_id or callId query param."""
    cid = call_id or callId
    if not cid:
        return {"status": "error", "error": "Missing call_id or callId"}
    
    try:
        progress = _get_render_progress(cid)
        if progress:
            return {
                "status": "success",
                "progress": progress
            }
        else:
            return {"status": "no_progress", "message": "No progress data available"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"status": "error", "error": str(e)}


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
        # For running renders, try to get progress information
        try:
            progress = _get_render_progress(cid)
            if progress:
                return {
                    "status": "running",
                    "progress": progress
                }
        except Exception:
            pass  # Fallback to basic running status
        return {"status": "running"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"status": "error", "error": str(e)}


# Removed render_batch_http endpoint - not used by current UI


# Removed get_status endpoint - not essential for core functionality

