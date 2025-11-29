FROM e2bdev/base:latest

# Configuration - Update BLENDER_VERSION to get newer versions
# Check https://download.blender.org/release/ for available versions
ARG BLENDER_VERSION=4.5.0
ARG BLENDER_MAJOR_MINOR=4.5
ENV BLENDER_VERSION=4.5.0
ENV BLENDER_MAJOR_MINOR=4.5
ENV BLENDER_DIR=/opt/blender-4.5.0-linux-x64

# Switch to root for package installation
USER root

# Install system dependencies
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    wget xz-utils xvfb xauth ffmpeg \
    libxi6 libxxf86vm1 libxrender1 libxfixes3 \
    libgl1-mesa-glx libglu1-mesa libgles2-mesa \
    libxrandr2 libxext6 python3 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Download Blender - Use ENV variables which are available in RUN commands
RUN set -eux; \
    URL="https://download.blender.org/release/Blender${BLENDER_MAJOR_MINOR}/blender-${BLENDER_VERSION}-linux-x64.tar.xz"; \
    echo "Downloading Blender ${BLENDER_VERSION} from: $URL"; \
    wget --https-only --max-redirect=3 --no-verbose -O /tmp/blender.tar.xz "$URL" || \
    curl -fsSLo /tmp/blender.tar.xz --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 2 -L "$URL"

# Extract and install Blender
RUN mkdir -p /opt && \
    tar -xf /tmp/blender.tar.xz -C /opt && \
    rm -f /tmp/blender.tar.xz && \
    ln -sf ${BLENDER_DIR}/blender /usr/local/bin/blender

# Create render script directory and file
RUN mkdir -p /opt/blender && \
    echo 'import bpy' > /opt/blender/render.py && \
    echo 'bpy.ops.mesh.primitive_cube_add()' >> /opt/blender/render.py && \
    echo 'bpy.context.scene.render.filepath = "/tmp/test.png"' >> /opt/blender/render.py && \
    echo 'bpy.ops.render.render(write_still=True)' >> /opt/blender/render.py && \
    chmod +r /opt/blender/render.py

# Verify Blender installation (just check file exists, don't run it as it needs X11)
RUN test -f ${BLENDER_DIR}/blender && \
    test -x ${BLENDER_DIR}/blender && \
    ls -lh ${BLENDER_DIR}/blender && \
    test -L /usr/local/bin/blender && \
    echo "Blender ${BLENDER_VERSION} installed successfully"

# Switch back to default user
USER user

