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
    
    bpy.ops.wm.open_mainfile(filepath=blend_file)
    
    # Get scene information
    scene = bpy.context.scene
    frame_start = scene.frame_start
    frame_end = scene.frame_end
    frame_count = frame_end - frame_start + 1
    
    result = {
        "frame_start": int(frame_start),
        "frame_end": int(frame_end),
        "frame_count": int(frame_count),
        "fps": scene.render.fps
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
