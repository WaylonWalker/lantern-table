FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/lantern \
    LANTERN_BIND=0.0.0.0 \
    LANTERN_PORT=8765

RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin lantern \
    && mkdir -p /app /home/lantern/.config/lantern-table \
    && chown -R lantern:lantern /app /home/lantern

WORKDIR /app

# Install runtime dependencies at build time so the pod does not need to resolve
# Python dependencies when it starts.
RUN uv pip install --system \
    'fastapi>=0.118' \
    'uvicorn[standard]>=0.37' \
    'httpx>=0.28' \
    'PyJWT[crypto]>=2.10' \
    'redis>=6.0' \
    'qrcode>=8.0' \
    'websockets>=13.0'

# Fail the image build if Uvicorn cannot load its WebSocket protocol.
RUN python -c "import websockets; import uvicorn.protocols.websockets.websockets_impl"

COPY --chown=lantern:lantern dnd_chatgpt_server.py dnd_localfirst_demo.html manifest.webmanifest service-worker.js ./
COPY --chown=lantern:lantern assets ./assets
COPY --chown=lantern:lantern scripts/install-lantern.sh ./scripts/install-lantern.sh
COPY --chown=lantern:lantern CREDITS.md ./CREDITS.md

USER 1000:1000
EXPOSE 8765

CMD ["python", "/app/dnd_chatgpt_server.py"]
