# Debian testing (trixie) ships hugin-tools 2024.x; bookworm is stuck on 2022.0.0.
# Use debian:sid-slim for nona 2025.0.1 if you need the absolute latest.
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    hugin-tools \
    imagemagick \
    perl \
    libimage-exiftool-perl \
    libmath-round-perl \
    curl \
    zip \
    python3 \
    python3-pip \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY slize.pl process.py stitch.py tile_render.py server.py ./
RUN chmod +x /app/slize.pl

ENV PORT=8080
ENV WORK_DIR=/tmp/globus-jobs
EXPOSE 8080

CMD ["python3", "server.py"]
