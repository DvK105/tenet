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
    
    # For complex files, use multiple strategies to open safely
    # Strategy 1: Try with minimal loading (fastest, safest for complex files)
    opened = False
    strategies = [
        # Skip UI, skip textures, skip sounds - fastest and most stable
        {"filepath": blend_file, "load_ui": False, "use_scripts": False},
        # Skip UI only
        {"filepath": blend_file, "load_ui": False},
        # Default (fallback)
        {"filepath": blend_file}
    ]
    
    for strategy in strategies:
        try:
            bpy.ops.wm.open_mainfile(**strategy)
            opened = True
            break
        except Exception:
            # Try next strategy
            continue
    
    if not opened:
        raise RuntimeError("Failed to open blend file with any strategy")
    
    # Get scene information quickly
    # Use try-except for each property to handle edge cases
    scene = bpy.context.scene
    
    try:
        frame_start = int(scene.frame_start)
    except:
        frame_start = 1
    
    try:
        frame_end = int(scene.frame_end)
    except:
        frame_end = 250  # Default fallback
    
    frame_count = frame_end - frame_start + 1
    
    try:
        fps = int(scene.render.fps)
    except:
        fps = 24  # Default fallback
    
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
