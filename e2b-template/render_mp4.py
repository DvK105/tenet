import bpy
import json
import sys
import os
import signal
import time

# Set up signal handlers to output JSON on crash
def signal_handler(signum, frame):
    """Output error JSON when receiving a signal (like SIGSEGV)"""
    error_result = {
        "success": False,
        "error": f"Process terminated by signal {signum}",
        "error_type": "SignalError"
    }
    try:
        print(json.dumps(error_result), file=sys.stderr)
        sys.stderr.flush()
    except:
        pass
    sys.exit(128 + signum)

# Register signal handlers for common crash signals
signal.signal(signal.SIGSEGV, signal_handler)
signal.signal(signal.SIGABRT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# Get blend file path from command line args
# Blender passes its own args, so the blend file is typically the last arg
# Format: blender --background --python script.py -- /path/to/file.blend
blend_file = None
for i, arg in enumerate(sys.argv):
    if arg == '--' and i + 1 < len(sys.argv):
        blend_file = sys.argv[i + 1]
        break

# Default path if not provided
if not blend_file:
    blend_file = "/tmp/uploaded.blend"

output_path = "/tmp/output.mp4"
progress_path = "/tmp/render_progress.json"


def _read_existing_progress():
    try:
        if os.path.exists(progress_path):
            with open(progress_path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        return None
    return None


def _write_progress(payload):
    try:
        with open(progress_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
            f.flush()
    except Exception:
        pass


def _ensure_started_at():
    existing = _read_existing_progress() or {}
    started_at = existing.get("startedAt")
    if started_at is None:
        started_at = time.time()
    return started_at

try:
    # Open the blend file
    if not os.path.exists(blend_file):
        raise FileNotFoundError(f"Blend file not found: {blend_file}")
    
    # For complex files, try to read metadata without fully loading
    # Use similar strategies as extract_frames.py
    opened = False
    strategies = [
        # Most minimal: skip UI, scripts, textures, sounds, and recover data
        {"filepath": blend_file, "load_ui": False, "use_scripts": False, "use_embedded_data": False},
        # Skip UI and scripts
        {"filepath": blend_file, "load_ui": False, "use_scripts": False},
        # Skip UI only
        {"filepath": blend_file, "load_ui": False},
        # Default (last resort)
        {"filepath": blend_file}
    ]
    
    for strategy in strategies:
        try:
            # Clear the scene first to avoid conflicts
            bpy.ops.wm.read_homefile(app_template="")
            bpy.ops.wm.open_mainfile(**strategy)
            opened = True
            break
        except Exception as e:
            # If it's a critical error, don't try next strategy
            if "Segmentation" in str(e) or "fault" in str(e).lower():
                raise
            # Try next strategy
            continue
    
    if not opened:
        raise RuntimeError("Failed to open blend file with any strategy")
    
    # Get scene information
    scene = bpy.context.scene

    started_at = _ensure_started_at()
    frame_start = int(scene.frame_start)
    frame_end = int(scene.frame_end)
    frame_count = int(frame_end - frame_start + 1)

    def on_render_init(_scene):
        _write_progress({
            "status": "rendering",
            "frameStart": frame_start,
            "frameEnd": frame_end,
            "frameCount": frame_count,
            "currentFrame": int(_scene.frame_current),
            "framesDone": max(0, int(_scene.frame_current) - frame_start),
            "startedAt": started_at,
            "updatedAt": time.time(),
        })

    def on_render_post(_scene):
        current_frame = int(_scene.frame_current)
        frames_done = max(0, current_frame - frame_start + 1)
        _write_progress({
            "status": "rendering",
            "frameStart": frame_start,
            "frameEnd": frame_end,
            "frameCount": frame_count,
            "currentFrame": current_frame,
            "framesDone": frames_done,
            "startedAt": started_at,
            "updatedAt": time.time(),
        })

    def on_render_cancel(_scene):
        _write_progress({
            "status": "cancelled",
            "frameStart": frame_start,
            "frameEnd": frame_end,
            "frameCount": frame_count,
            "currentFrame": int(_scene.frame_current),
            "framesDone": max(0, int(_scene.frame_current) - frame_start),
            "startedAt": started_at,
            "updatedAt": time.time(),
        })

    bpy.app.handlers.render_init.clear()
    bpy.app.handlers.render_post.clear()
    bpy.app.handlers.render_cancel.clear()
    bpy.app.handlers.render_init.append(on_render_init)
    bpy.app.handlers.render_post.append(on_render_post)
    bpy.app.handlers.render_cancel.append(on_render_cancel)
    
    # Configure render settings for MP4 output
    # Respect existing Blender file settings (resolution, FPS, frame range)
    render = scene.render
    
    # Set output format to FFmpeg video
    render.image_settings.file_format = 'FFMPEG'
    
    # Configure FFmpeg settings for MP4
    render.ffmpeg.format = 'MPEG4'
    render.ffmpeg.codec = 'H264'
    
    # High quality settings
    # Quality: 90-100% (using bitrate mode for better control)
    render.ffmpeg.constant_rate_factor = 'HIGH'  # High quality preset
    render.ffmpeg.ffmpeg_preset = 'MEDIUM'  # Balance between quality and speed
    
    # Use existing resolution from the file
    # render.resolution_x and render.resolution_y are already set from the file
    
    # Use existing FPS from the file
    # scene.render.fps is already set from the file
    
    # Use existing frame range from the file
    # scene.frame_start and scene.frame_end are already set from the file
    
    # Set output path
    render.filepath = output_path
    
    # Enable multi-threading for encoding
    render.threads_mode = 'AUTO'
    
    # Render the animation
    print(f"Starting render: {scene.frame_start} to {scene.frame_end} frames at {render.fps} FPS", file=sys.stderr)
    print(f"Resolution: {render.resolution_x}x{render.resolution_y}", file=sys.stderr)
    print(f"Output: {output_path}", file=sys.stderr)
    
    # Render animation (this will create the MP4 file)
    bpy.ops.render.render(animation=True)
    
    # Verify output file was created
    if not os.path.exists(output_path):
        raise FileNotFoundError(f"Output file was not created: {output_path}")
    
    # Get file size for verification
    file_size = os.path.getsize(output_path)
    
    result = {
        "success": True,
        "output_path": output_path,
        "file_size": file_size,
        "frame_start": frame_start,
        "frame_end": frame_end,
        "frame_count": frame_count,
        "fps": int(render.fps),
        "resolution": {
            "x": render.resolution_x,
            "y": render.resolution_y
        }
    }

    _write_progress({
        "status": "completed",
        "frameStart": frame_start,
        "frameEnd": frame_end,
        "frameCount": frame_count,
        "currentFrame": frame_end,
        "framesDone": frame_count,
        "startedAt": started_at,
        "updatedAt": time.time(),
    })
    
    # Output JSON to stderr
    print(json.dumps(result), file=sys.stderr)
    sys.exit(0)
    
except KeyboardInterrupt:
    error_result = {
        "success": False,
        "error": "Process interrupted",
        "error_type": "KeyboardInterrupt"
    }
    print(json.dumps(error_result), file=sys.stderr)
    sys.stderr.flush()
    sys.exit(130)
except SystemExit:
    # Re-raise to preserve exit code
    raise
except Exception as e:
    error_result = {
        "success": False,
        "error": str(e),
        "error_type": type(e).__name__
    }
    try:
        print(json.dumps(error_result), file=sys.stderr)
        sys.stderr.flush()
    except:
        # If even stderr fails, try stdout as last resort
        try:
            print(json.dumps(error_result), file=sys.stdout)
            sys.stdout.flush()
        except:
            pass
    sys.exit(1)
