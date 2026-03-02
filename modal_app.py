import os
import subprocess
import tempfile
from typing import Optional

import modal
import requests


blender_image = (
    modal.Image.debian_slim()
    .apt_install("blender")
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

        resp = requests.get(blend_url)
        resp.raise_for_status()

        blend_path = os.path.join(tmpdir, "scene.blend")
        with open(blend_path, "wb") as f:
            f.write(resp.content)

        # Run Blender in headless mode, rendering frame 1.
        subprocess.run(
            ["blender", "-b", blend_path, "-a"],
            check=True,
        )

        # Blender's default output for frame 1 is usually 0001.png in the CWD.
        output_path = os.path.join(tmpdir, "render.mp4")
        if not os.path.exists(output_path):
            raise FileNotFoundError("Expected Blender output render.mp4 was not found.")

        return _upload_render_to_supabase(output_path, output_key)


@app.function(image=blender_image, timeout=600)
@modal.web_endpoint(method="POST")
def render_http(blend_url: str, output_key: Optional[str] = None):
    url = render_blend_file.remote(blend_url, output_key=output_key)
    return {"image_url": url}

