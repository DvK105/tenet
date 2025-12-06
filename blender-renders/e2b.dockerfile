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

# Install system dependencies (including Mesa/EGL for libEGL.so.1)
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    wget xz-utils xvfb xauth ffmpeg \
    libxi6 libxxf86vm1 libxrender1 libxfixes3 \
    libgl1-mesa-glx libglu1-mesa libgles2-mesa libegl1 libgbm1 \
    libxrandr2 libxext6 python3 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix

# Download, extract and install Blender in one step to reduce layers
RUN set -eux; \
    URL="https://download.blender.org/release/Blender${BLENDER_MAJOR_MINOR}/blender-${BLENDER_VERSION}-linux-x64.tar.xz"; \
    echo "Downloading Blender ${BLENDER_VERSION} from: $URL"; \
    mkdir -p /opt && \
    (wget --https-only --max-redirect=3 --no-verbose -O - "$URL" || \
     curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 2 -L "$URL") | \
    tar -xJ -C /opt && \
    ln -sf ${BLENDER_DIR}/blender /usr/local/bin/blender && \
    echo "Blender ${BLENDER_VERSION} installed successfully"

# Create render script directory and file, and verify Blender installation in one step
RUN mkdir -p /opt/blender && \
    printf 'import bpy\nbpy.ops.mesh.primitive_cube_add()\nbpy.context.scene.render.filepath = "/tmp/test.png"\nbpy.ops.render.render(write_still=True)\n' > /opt/blender/render.py && \
    chmod +r /opt/blender/render.py && \
    test -f ${BLENDER_DIR}/blender && \
    test -x ${BLENDER_DIR}/blender && \
    test -L /usr/local/bin/blender && \
    echo "Blender ${BLENDER_VERSION} installation verified"

# Switch back to default user
USER user

