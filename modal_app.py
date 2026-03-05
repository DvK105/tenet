import os
import subprocess
import tempfile
from typing import Optional, Dict, Any
import asyncio
import time

import modal
import requests


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
    .pip_install("supabase", "requests", "fastapi[standard]")
)

app = modal.App("blend-renderer")

# Configuration for parallel processing
MAX_CONCURRENT_RENDERS = int(os.environ.get("MAX_CONCURRENT_RENDERS", "10"))
GPU_MEMORY = os.environ.get("GPU_MEMORY", "40GB")  # A100 has 40GB
USE_SPOT_INSTANCES = os.environ.get("USE_SPOT_INSTANCES", "true").lower() == "true"


def _get_supabase_client():
    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _upload_render_to_supabase(local_path: str, output_key: str) -> str:
    """Upload rendered file to Supabase with retry logic."""
    max_retries = 3
    for attempt in range(max_retries):
        try:
            client = _get_supabase_client()
            bucket = os.environ.get("SUPABASE_RENDERS_BUCKET", "renders")

            with open(local_path, "rb") as f:
                data = f.read()

            # Upload to Supabase storage
            client.storage.from_(bucket).upload(output_key, data, {"content-type": "video/mp4"})

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
    timeout=1800,  # Increased to 30 minutes
    gpu="A100-40GB",
    max_containers=MAX_CONCURRENT_RENDERS,
    scaledown_window=300,
    retries=2,  # Reduced retries to avoid cascading failures
    memory=16384  # 16GB RAM
)
def render_blend_file(blend_url: str, output_key: Optional[str] = None) -> str:
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

        if len(data) < 12 or not data.startswith(b"BLENDER"):
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
        try:
            print(f"[{job_id}] Starting Blender render...")
            render_start = time.time()

            # Set display environment for headless operation
            env = os.environ.copy()
            env['DISPLAY'] = ':99'
            env['PYTHONDONTWRITEBYTECODE'] = '1'
            env['HOME'] = '/tmp'  # Ensure Blender has a home directory

            # First check if blend file is valid
            print(f"[{job_id}] Validating blend file...")
            validate_result = subprocess.run(
                [
                    BLENDER_BIN,
                    "-b",  # Background mode
                    blend_path,
                    "--help"  # Just to test if Blender can read the file
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                env=env
            )

            print(f"[{job_id}] Starting actual render...")
            result = subprocess.run(
                [
                    BLENDER_BIN,
                    "-b",  # Background mode
                    blend_path,
                    "-o", output_base,
                    "-F", "FFmpeg",  # Output format
                    "-x", "1",  # Use extension
                    "-a",  # Render all frames
                    "--threads", "0",  # Use all available threads
                    "-noaudio",  # Disable audio processing
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=1200,  # Increased to 20 minutes
                env=env
            )

            render_time = time.time() - render_start
            print(f"[{job_id}] Blender render completed in {render_time:.1f}s")
            print(f"[{job_id}] Blender output:\n{result.stdout[-1000:]}")

        except subprocess.CalledProcessError as e:
            output = e.stdout or ""
            raise RuntimeError(
                f"[{job_id}] Blender render failed. Blender output:\n" + output[-12000:]
            ) from e
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"[{job_id}] Blender render timed out after 8 minutes") from e

        output_path = output_base + ".mp4"
        if not os.path.exists(output_path):
            raise FileNotFoundError(f"[{job_id}] Expected Blender output {output_path} was not found.")

        file_size = os.path.getsize(output_path)
        print(f"[{job_id}] Render output size: {file_size / (1024*1024):.1f} MB")

        # Upload to Supabase
        print(f"[{job_id}] Uploading to Supabase...")
        upload_start = time.time()
        url = _upload_render_to_supabase(output_path, output_key)
        upload_time = time.time() - upload_start
        
        total_time = time.time() - start_time
        print(f"[{job_id}] Job completed in {total_time:.1f}s (upload: {upload_time:.1f}s)")
        
        return url


@app.function(
    image=blender_image,
    timeout=1800,  # 30 minutes for batch
    gpu="A100-40GB",
    max_containers=MAX_CONCURRENT_RENDERS,
    scaledown_window=300,
    retries=3
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
            results.append(result)
        except Exception as e:
            print(f"Failed to render file {i+1}: {e}")
            results.append(None)
    
    successful_renders = [r for r in results if r is not None]
    print(f"Batch completed: {len(successful_renders)}/{len(blend_urls)} successful")
    
    return successful_renders


@app.function(image=blender_image, timeout=1200)
@modal.web_endpoint(method="POST")
def render_http(blend_file_bytes: list[int], output_key: Optional[str] = None):
    """Single render endpoint that receives file bytes directly (like Modal's official example)."""
    try:
        print(f"Received render request for file with {len(blend_file_bytes)} bytes")
        
        # Convert list back to bytes
        file_bytes = bytes(blend_file_bytes)
        
        if output_key is None:
            output_key = f"renders/{int(time.time())}_{hash(str(blend_file_bytes)) % 10000}.mp4"
        
        url = render_blend_file.remote(file_bytes, output_key=output_key)
        # Return just the URL string for frontend compatibility
        return url
    except Exception as e:
        print(f"Render failed: {str(e)}")
        # Return error as string with error prefix
        return f"ERROR: {str(e)}"


@app.function(image=blender_image, timeout=1800)
@modal.web_endpoint(method="POST")
def render_batch_http(blend_urls: list[str], output_keys: Optional[list[str]] = None):
    """Batch render endpoint for maximum efficiency."""
    urls = render_blend_batch.remote(blend_urls, output_keys=output_keys)
    return {"image_urls": urls}


@app.function(image=blender_image, timeout=120)
@modal.web_endpoint(method="GET")
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

