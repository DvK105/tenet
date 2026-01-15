FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies and Blender
# Using apt version for stability, but with additional libraries for complex files
# Also install coreutils for timeout command and FFmpeg for MP4 encoding
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    coreutils \
    libgl1-mesa-dev \
    libglu1-mesa \
    libxi6 \
    libxrender1 \
    libxrandr2 \
    libsm6 \
    libxcursor1 \
    libxinerama1 \
    libxfixes3 \
    libopenal1 \
    libsndfile1 \
    blender \
    ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Verify Blender installation
RUN blender --version || echo "Blender installed"

# Copy the frame extraction script and render script
COPY extract_frames.py /tmp/extract_frames.py
COPY render_mp4.py /tmp/render_mp4.py

# Keep container running
CMD ["sleep", "infinity"]
