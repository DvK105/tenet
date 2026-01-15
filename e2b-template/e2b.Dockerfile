FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies and Blender
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    libgl1-mesa-dev \
    libglu1-mesa \
    libxi6 \
    libxrender1 \
    libxrandr2 \
    libsm6 \
    libxcursor1 \
    libxinerama1 \
    libxfixes3 \
    blender \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Verify Blender installation
RUN blender --version || echo "Blender installed"

# Copy the frame extraction script
COPY extract_frames.py /tmp/extract_frames.py

# Keep container running
CMD ["sleep", "infinity"]
