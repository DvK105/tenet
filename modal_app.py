import os
import subprocess
import tempfile
from typing import Optional

import modal
import requests


BLENDER_VERSION = os.environ.get("BLENDER_VERSION", "5.0.1")
BLENDER_DIR = f"/opt/blender-{BLENDER_VERSION}"
BLENDER_BIN = f"{BLENDER_DIR}/blender"

blender_image = (
    modal.Image.debian_slim()
    .apt_install("ca-certificates", "curl", "tar", "xz-utils")
    .run_commands(
        "set -eux; "
        "mkdir -p /opt; "
        f"cd /opt; "
        f"curl -fL -o blender.tar.xz https://download.blender.org/release/Blender{BLENDER_VERSION.rsplit('.', 1)[0]}/blender-{BLENDER_VERSION}-linux-x64.tar.xz; "
        f"tar -xJf blender.tar.xz; "
        f"rm blender.tar.xz; "
        f"mv blender-{BLENDER_VERSION}-linux-x64 {BLENDER_DIR}; "
        f"ln -sf {BLENDER_BIN} /usr/local/bin/blender"
    )
    .pip_install("supabase", "requests","fastapi[standard]")
)

app = modal.App("blend-renderer")


def _get_supabase_client():
    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _upload_render_to_supabase(local_path: str, output_key: str) -> str:
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


@app.function(image=blender_image, 
              timeout=600, 
              gpu=modal.gpu.A100())
def render_blend_file(blend_url: str, output_key: Optional[str] = None) -> str:
    """
    Download a .blend file from a signed URL, render frame 1 with Blender using the
    file's own settings, upload the resulting PNG to Supabase, and return a signed URL.
    """
    if output_key is None:
        output_key = "renders/render.mp4"

    with tempfile.TemporaryDirectory() as tmpdir:
        os.chdir(tmpdir)

        try:
            v = subprocess.run(
                [BLENDER_BIN, "--version"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            ).stdout
            print("Using Blender binary:", BLENDER_BIN)
            print("Blender --version:\n" + (v or "").strip())
        except Exception as e:
            raise RuntimeError(f"Failed to run Blender at {BLENDER_BIN}: {e}") from e

        resp = requests.get(blend_url)
        resp.raise_for_status()

        data = resp.content
        print(
            "Downloaded blend_url bytes:",
            len(data),
            "content-type:",
            resp.headers.get("content-type"),
        )
        if len(data) < 12 or not data.startswith(b"BLENDER"):
            snippet = data[:200]
            raise RuntimeError(
                "Downloaded content is not a .blend file. "
                f"content_type={resp.headers.get('content-type')} "
                f"length={len(data)} "
                f"first_bytes={snippet!r}"
            )

        blend_path = os.path.join(tmpdir, "scene.blend")
        with open(blend_path, "wb") as f:
            f.write(data)

        # Run Blender in headless mode, rendering frame 1.
        output_base = os.path.join(tmpdir, "render")
        try:
            subprocess.run(
                [
                    BLENDER_BIN,
                    "-b",
                    blend_path,
                    "-o",
                    output_base,
                    "-F",
                    "FFmpeg",
                    "-x",
                    "1",
                    "-a",
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
        except subprocess.CalledProcessError as e:
            output = e.stdout or ""
            raise RuntimeError(
                "Blender render failed. Blender output:\n" + output[-12000:]
            ) from e

        output_path = output_base + ".mp4"
        if not os.path.exists(output_path):
            raise FileNotFoundError(f"Expected Blender output {output_path} was not found.")

        return _upload_render_to_supabase(output_path, output_key)


@app.function(image=blender_image, timeout=600)
@modal.web_endpoint(method="POST")
def render_http(blend_url: str, output_key: Optional[str] = None):
    url = render_blend_file.remote(blend_url, output_key=output_key)
    return {"image_url": url}

