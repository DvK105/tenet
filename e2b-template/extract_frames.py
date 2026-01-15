import bpy
import json
import sys
import os

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

try:
    # Open the blend file
    if not os.path.exists(blend_file):
        raise FileNotFoundError(f"Blend file not found: {blend_file}")
    
    # For complex files, try to read metadata without fully loading
    # First, try to get basic info using Blender's file reading without scene loading
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
    
    # Get scene information quickly with extensive error handling
    scene = bpy.context.scene
    
    # Try to get frame info with multiple fallbacks
    try:
        frame_start = int(scene.frame_start) if hasattr(scene, 'frame_start') else 1
    except:
        frame_start = 1
    
    try:
        frame_end = int(scene.frame_end) if hasattr(scene, 'frame_end') else 250
    except:
        frame_end = 250
    
    # Ensure valid range
    if frame_start > frame_end:
        frame_start, frame_end = 1, 250
    
    frame_count = max(1, frame_end - frame_start + 1)
    
    try:
        fps = int(scene.render.fps) if hasattr(scene, 'render') and hasattr(scene.render, 'fps') else 24
    except:
        fps = 24
    
    result = {
        "frame_start": frame_start,
        "frame_end": frame_end,
        "frame_count": frame_count,
        "fps": fps
    }
    
    # Output JSON to stderr to avoid Blender's stdout warnings interfering
    # This ensures clean JSON output that can be parsed reliably
    print(json.dumps(result), file=sys.stderr)
    sys.exit(0)
    
except Exception as e:
    error_result = {
        "error": str(e),
        "error_type": type(e).__name__
    }
    print(json.dumps(error_result), file=sys.stderr)
    sys.exit(1)
