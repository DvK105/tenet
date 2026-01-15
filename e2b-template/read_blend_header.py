#!/usr/bin/env python3
"""
Fallback script to read Blender file header and extract basic metadata
without fully loading the file. This is used when Blender crashes on file open.
"""
import struct
import json
import sys
import os

def read_blend_header(blend_file):
    """Read Blender file header to extract version and basic info"""
    try:
        with open(blend_file, 'rb') as f:
            # Blender file header is 12 bytes
            header = f.read(12)
            
            if len(header) < 12:
                return None
            
            # Check magic number (BLENDER)
            magic = header[:7]
            if magic != b'BLENDER':
                return None
            
            # Read pointer size and endianness
            pointer_size = 'V' if header[7] == ord('_') else 'v'  # 8 bytes vs 4 bytes
            endian = '<' if header[8] == ord('v') else '>'
            
            # Read version (3 bytes)
            version = header[9:12].decode('ascii', errors='ignore')
            
            # Try to read some basic blocks to find scene data
            # This is a simplified approach - full parsing would be more complex
            f.seek(0, 2)  # Seek to end
            file_size = f.tell()
            
            return {
                "version": version,
                "file_size": file_size,
                "pointer_size": "64-bit" if pointer_size == 'V' else "32-bit"
            }
    except Exception as e:
        return None

if __name__ == "__main__":
    blend_file = sys.argv[1] if len(sys.argv) > 1 else "/tmp/uploaded.blend"
    
    if not os.path.exists(blend_file):
        error = {"error": f"File not found: {blend_file}", "error_type": "FileNotFoundError"}
        print(json.dumps(error), file=sys.stderr)
        sys.exit(1)
    
    header_info = read_blend_header(blend_file)
    
    if header_info:
        # Provide default frame info based on file analysis
        # This is a fallback - not as accurate as opening the file
        result = {
            "frame_start": 1,
            "frame_end": 250,  # Common default
            "frame_count": 250,
            "fps": 24,
            "note": "Estimated values - file could not be fully opened",
            "blender_version": header_info.get("version", "unknown")
        }
        print(json.dumps(result), file=sys.stderr)
        sys.exit(0)
    else:
        error = {"error": "Could not read blend file header", "error_type": "ParseError"}
        print(json.dumps(error), file=sys.stderr)
        sys.exit(1)
