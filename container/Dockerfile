# Debian testing (trixie) ships hugin-tools 2024.x; bookworm is stuck on 2022.0.0.
# Use debian:sid-slim for nona 2025.0.1 if you need the absolute latest.
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    hugin-tools \
    imagemagick \
    librsvg2-bin \
    perl \
    libimage-exiftool-perl \
    libmath-round-perl \
    curl \
    zip \
    python3 \
    python3-pip \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    # SVG-first pipeline fits on standard-1 (4 GiB); allow SVG read for montage.
    && sed -i \
      -e 's/name="memory" value="[^"]*"/name="memory" value="2GiB"/' \
      -e 's/name="map" value="[^"]*"/name="map" value="4GiB"/' \
      -e 's/name="area" value="[^"]*"/name="area" value="500MP"/' \
      -e 's/name="disk" value="[^"]*"/name="disk" value="6GiB"/' \
      -e 's/rights="none" pattern="SVG"/rights="read|write" pattern="SVG"/' \
      -e 's/rights="none" pattern="MSVG"/rights="read|write" pattern="MSVG"/' \
      -e 's/rights="none" pattern="MVG"/rights="read|write" pattern="MVG"/' \
      /etc/ImageMagick-7/policy.xml

WORKDIR /app

COPY requirements.txt .
# --ignore-installed: Debian ships typing_extensions without a pip RECORD; plain
# install tries to uninstall it and fails (uninstall-no-record-file).
RUN pip3 install --no-cache-dir --break-system-packages --ignore-installed -r requirements.txt

COPY slize.pl process.py stitch.py tile_render.py distort.py svg_map.py svg_warp.py job_queue.py server.py ./
RUN chmod +x /app/slize.pl

ENV PORT=8080
ENV WORK_DIR=/tmp/globus-jobs
EXPOSE 8080

CMD ["python3", "server.py"]
