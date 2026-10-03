#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "fastapi>=0.118",
#   "uvicorn>=0.37",
#   "httpx>=0.28",
#   "PyJWT[crypto]>=2.10",
#   "redis>=6.0",
#   "qrcode>=8.0",
# ]
# ///
"""Lantern Table — local-first D&D with Sign in with ChatGPT.

Run:
    chmod +x dnd_chatgpt_server.py
    ./dnd_chatgpt_server.py
Then open http://127.0.0.1:8765

Campaign state, drawings, and attached image bytes remain in the browser. In companion mode
this helper stores only ChatGPT OAuth credentials under ~/.config/lantern-table/chatgpt.json
(0600 on Unix). Public mode is a disposable signaling/static service and stores no campaign data.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
import jwt
import uvicorn
import qrcode
import qrcode.image.svg
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

try:
    import redis.asyncio as redis
except Exception:
    redis = None
from jwt import PyJWKClient

HOST = "127.0.0.1"  # OAuth loopback host required by the current open-source ChatGPT sign-in flow.
MODE = os.environ.get("LANTERN_MODE", "companion").lower()  # companion or public
BIND_HOST = os.environ.get("LANTERN_BIND", "0.0.0.0" if MODE == "public" else HOST)
PORT = int(os.environ.get("LANTERN_PORT", "8765"))
APP_NAME = "Lantern Table"
RESOURCE = "https://api.openai.com/v1"
AUTH_URL = "https://auth.openai.com/api/accounts/authorize"
TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
JWKS_URL = "https://auth.openai.com/.well-known/jwks.json"
ISSUER = "https://auth.openai.com"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
REDIRECT_URI = f"http://{HOST}:{PORT}/auth/callback"

HERE = Path(__file__).resolve().parent
HTML = HERE / "dnd_localfirst_demo.html"
ASSETS = HERE / "assets"
CONFIG_DIR = Path.home() / ".config" / "lantern-table"
CRED_PATH = CONFIG_DIR / "chatgpt.json"
HOST_PATH = CONFIG_DIR / "host.json"

app = FastAPI(title=APP_NAME)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://dnd.waylonwalker.com",
        "http://127.0.0.1:8765",
        "http://localhost:8765",
        *[o.strip() for o in os.environ.get("LANTERN_CORS_ORIGINS", "").split(",") if o.strip()],
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def private_network_access(request: Request, call_next):
    """Allow the HTTPS hosted UI to reach the loopback companion in browsers using PNA."""
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network") == "true" or MODE == "companion":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response
if ASSETS.exists():
    app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")
pending: dict[str, str] = {}
draining = False
REDIS_URL = os.environ.get("REDIS_URL")
redis_client = redis.from_url(REDIS_URL, decode_responses=True) if (redis and REDIS_URL) else None
local_room_peers: dict[str, dict[str, WebSocket]] = {}
turn_cache: dict[str, Any] = {"expires": 0, "iceServers": None}


def allowed_return_origins() -> set[str]:
    values = {
        "http://127.0.0.1:8765",
        "http://localhost:8765",
        os.environ.get("LANTERN_PUBLIC_ORIGIN", "https://dnd.waylonwalker.com").rstrip("/"),
    }
    for raw in (os.environ.get("LANTERN_CORS_ORIGINS", ""), os.environ.get("LANTERN_RETURN_ORIGINS", "")):
        values.update(v.strip().rstrip("/") for v in raw.split(",") if v.strip())
    return values


def validated_return_to(raw: str | None) -> str:
    """Return a safe UI URL for post-OAuth navigation. Never allow arbitrary open redirects."""
    if not raw:
        return f"http://{HOST}:{PORT}/"
    try:
        parts = urlsplit(raw)
    except ValueError:
        return f"http://{HOST}:{PORT}/"
    if parts.scheme not in {"http", "https"} or not parts.netloc or parts.username or parts.password:
        return f"http://{HOST}:{PORT}/"
    origin = f"{parts.scheme}://{parts.netloc}".rstrip("/")
    if origin not in allowed_return_origins():
        return f"http://{HOST}:{PORT}/"
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, parts.fragment))


def auth_return_url(return_to: str) -> str:
    parts = urlsplit(return_to)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["lantern_auth"] = "connected"
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", urlencode(query), parts.fragment))


async def redis_available() -> bool:
    if not redis_client:
        return False
    try:
        return bool(await redis_client.ping())
    except Exception:
        return False

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def atomic_private_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    if os.name != "nt":
        os.chmod(tmp, 0o600)
    tmp.replace(path)
    if os.name != "nt":
        os.chmod(path, 0o600)


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def host_id() -> str:
    saved = load_json(HOST_PATH)
    if saved and saved.get("ext_agent_host_id"):
        return saved["ext_agent_host_id"]
    value = f"urn:uuid:{uuid.uuid4()}"
    atomic_private_json(HOST_PATH, {"ext_agent_host_id": value})
    return value


def current_creds() -> dict[str, Any] | None:
    return load_json(CRED_PATH)


def verify_id_token(token: str, client_id: str, nonce: str) -> dict[str, Any]:
    jwk_client = PyJWKClient(JWKS_URL)
    signing_key = jwk_client.get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256", "ES256"],
        audience=client_id,
        issuer=ISSUER,
        options={"require": ["exp", "iss", "aud", "sub"]},
    )
    if claims.get("nonce") != nonce:
        raise HTTPException(400, "OIDC nonce mismatch")
    return claims


async def refresh_if_needed(creds: dict[str, Any]) -> dict[str, Any]:
    if time.time() < float(creds.get("expires_at", 0)) - 90:
        return creds
    refresh_token = creds.get("refresh_token")
    if not refresh_token:
        raise HTTPException(401, "ChatGPT session expired; sign in again")
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "client_id": creds["client_id"],
                "refresh_token": refresh_token,
                "resource": RESOURCE,
            },
        )
    if r.is_error:
        raise HTTPException(401, f"Could not refresh ChatGPT session: {r.text[:240]}")
    tok = r.json()
    creds.update(tok)
    creds["expires_at"] = time.time() + int(tok.get("expires_in", 3600))
    creds["saved_at"] = time.time()
    atomic_private_json(CRED_PATH, creds)
    return creds


async def auth_creds() -> dict[str, Any]:
    if MODE == "public":
        raise HTTPException(503, "AI inference runs through the host device companion")
    creds = current_creds()
    if not creds:
        raise HTTPException(401, "Connect ChatGPT first")
    if "chatgpt.tokens.use.direct" not in creds.get("scopes", []):
        raise HTTPException(403, "ChatGPT plan usage was not granted")
    return await refresh_if_needed(creds)


async def list_models(creds: dict[str, Any]) -> list[dict[str, str]]:
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{RESOURCE}/models",
            headers={"Authorization": f"Bearer {creds['access_token']}"},
        )
    if r.is_error:
        raise HTTPException(r.status_code, r.text[:500])
    raw = r.json()
    models = raw.get("models", raw.get("data", []))
    visible = [m for m in models if m.get("visibility", "list") == "list"]
    return [
        {
            "slug": m.get("slug") or m.get("id"),
            "display_name": m.get("display_name") or m.get("slug") or m.get("id"),
        }
        for m in visible
        if m.get("slug") or m.get("id")
    ]


async def choose_model(creds: dict[str, Any], requested: str | None) -> str:
    if requested:
        return requested
    models = await list_models(creds)
    if not models:
        raise HTTPException(400, "No eligible models were returned for this ChatGPT account")
    return models[0]["slug"]


def sse(event: str, data: Any) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


DM_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "set_next_moves",
        "description": "Set 2-5 concrete suggested player moves shown as buttons. Call exactly once near the end of every DM turn.",
        "parameters": {
            "type": "object",
            "properties": {"moves": {"type": "array", "minItems": 2, "maxItems": 5, "items": {"type": "object", "properties": {"label": {"type": "string"}, "action": {"type": "string"}, "description": {"type": "string"}}, "required": ["label", "action", "description"], "additionalProperties": False}}},
            "required": ["moves"], "additionalProperties": False,
        }, "strict": True,
    },
    {
        "type": "function", "name": "request_roll",
        "description": "Ask for a roll only when uncertainty materially affects the outcome. The app rolls locally.",
        "parameters": {"type": "object", "properties": {"label": {"type": "string"}, "ability": {"type": "string", "enum": ["STR","DEX","CON","INT","WIS","CHA","NONE"]}, "dc": {"type": "integer", "minimum": 1, "maximum": 35}, "reason": {"type": "string"}}, "required": ["label","ability","dc","reason"], "additionalProperties": False}, "strict": True,
    },
    {
        "type": "function", "name": "set_character_mechanics",
        "description": "Set or correct authoritative mechanical character values. Use for starting HP/AC/level after quick creation or when rules/advancement change them; players do not directly edit these fields.",
        "parameters": {"type": "object", "properties": {"character_name": {"type": "string"}, "hp": {"type": ["integer","null"]}, "max_hp": {"type": ["integer","null"]}, "armor_class": {"type": ["integer","null"]}, "level": {"type": ["integer","null"]}, "reason": {"type": "string"}}, "required": ["character_name","hp","max_hp","armor_class","level","reason"], "additionalProperties": False}, "strict": True,
    },
    {
        "type": "function", "name": "render_card",
        "description": "Show a rich card for an important NPC, monster, item, quest, clue, faction, or location.",
        "parameters": {"type": "object", "properties": {"card_type": {"type": "string", "enum": ["npc","monster","item","quest","clue","location","faction"]}, "title": {"type": "string"}, "subtitle": {"type": "string"}, "markdown": {"type": "string"}}, "required": ["card_type","title","subtitle","markdown"], "additionalProperties": False}, "strict": True,
    },
    {
        "type": "function", "name": "propose_state_patch",
        "description": "Propose a small durable campaign update. Local host state is authoritative and may validate or approve the patch.",
        "parameters": {"type": "object", "properties": {"reason": {"type": "string"}, "scene_title": {"type": ["string","null"]}, "scene_description": {"type": ["string","null"]}, "journal_append": {"type": ["string","null"]}, "character_name": {"type": ["string","null"]}, "hp_delta": {"type": ["integer","null"]}, "quest_title": {"type": ["string","null"]}, "quest_note": {"type": ["string","null"]}, "loot_name": {"type": ["string","null"]}, "loot_description": {"type": ["string","null"]}}, "required": ["reason","scene_title","scene_description","journal_append","character_name","hp_delta","quest_title","quest_note","loot_name","loot_description"], "additionalProperties": False}, "strict": True,
    },
    {
        "type": "function", "name": "set_atmosphere",
        "description": "Transition the players' presentation theme and optional environmental effects when the location, weather, danger, or emotional beat meaningfully changes. Prefer continuity; do not change themes every turn.",
        "parameters": {"type": "object", "properties": {
            "theme": {"type": "string", "enum": ["lantern","default-dark","default-light","ayu-dark","ayu-light","ayu-mirage","rose-pine","rose-pine-moon","rose-pine-dawn","catppuccin-mocha","catppuccin-macchiato","catppuccin-frappe","catppuccin-latte","dracula","nord-dark","nord-light","gruvbox-dark","gruvbox-light","tokyo-night","tokyo-night-storm","tokyo-night-day","everforest-dark","everforest-light","kanagawa-dark","kanagawa-light","solarized-dark","solarized-light","github-dark","github-light","one-dark","one-light","monokai","modus-vivendi","modus-operandi","matte-black","black-gold","ash","autumn","berry-nebula","christmas","winter-frost","serika-dark","serika-light","whitesur-dark","whitesur-light","rhiannon-night","2bit-demichrome","blessing","diwali","graphite-dark","graphite-light","halloween","hanukkah","ink","inkpink","kanagawa-dragon","kanagawa-lotus","kanagawa-wave","lava-gb","lunar-new-year","midnight-ablaze","mist-gb","night-owl","night-owl-light","nintendo-gameboy","oil-6","pico-8","pitch-black","pollen8","rust-gold-8","slso8","st-patricks-day","summer-beach","sweet","twilight-5","valentine","vinik24","white-gold"]},
            "effects": {"type": "array", "maxItems": 4, "items": {"type": "string", "enum": ["none","snow","rain","dust","embers","fireflies","fog","lantern","bubbles","water","underwater","aurora","storm","stars"]}},
            "intensity": {"type": "number", "minimum": 0, "maximum": 1},
            "transition_ms": {"type": "integer", "minimum": 250, "maximum": 8000},
            "reason": {"type": "string"}
        }, "required": ["theme","effects","intensity","transition_ms","reason"], "additionalProperties": False}, "strict": True,
    },
    {
        "type": "function", "name": "suggest_visual_prompt",
        "description": "When a scene, character, object, map, or handout would benefit from art, provide a polished image prompt for the player to copy into their preferred image generator. Do not imply Lantern Table generated the image.",
        "parameters": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["scene","map","character","object","handout"]}, "title": {"type": "string"}, "prompt": {"type": "string"}, "suggested_aspect_ratio": {"type": "string", "enum": ["1:1","3:2","2:3","16:9"]}}, "required": ["kind","title","prompt","suggested_aspect_ratio"], "additionalProperties": False}, "strict": True,
    },
]


async def _room_publish(room: str, message: dict[str, Any]) -> None:
    if redis_client:
        await redis_client.publish(f"lantern:room:{room}", json.dumps(message, separators=(",", ":")))
        return
    peers = local_room_peers.get(room, {})
    target = message.get("target")
    for route_id, ws in list(peers.items()):
        peer_id = route_id.split(":", 1)[1] if route_id.startswith("host:") else route_id
        if peer_id == message.get("sender"):
            continue
        if target not in (None, "*", peer_id):
            continue
        try:
            await ws.send_json(message)
        except Exception:
            pass


async def _host_online(room: str) -> bool:
    if redis_client:
        return bool(await redis_client.get(f"lantern:room:{room}:host"))
    return any(pid.startswith("host:") for pid in local_room_peers.get(room, {}))


@app.get("/api/config")
async def api_config():
    redis_ok = await redis_available() if MODE == "public" and REDIS_URL else False
    return {
        "mode": MODE,
        "public_origin": os.environ.get("LANTERN_PUBLIC_ORIGIN", "https://dnd.waylonwalker.com"),
        "companion_origin": os.environ.get("LANTERN_COMPANION_ORIGIN", "http://127.0.0.1:8765"),
        "signaling": MODE == "public",
        "signaling_healthy": (redis_ok if REDIS_URL else True),
        "multi_replica": bool(REDIS_URL and redis_ok),
        "draining": draining,
    }


@app.get("/api/qr.svg")
async def api_qr_svg(text: str):
    if not text or len(text) > 1024:
        raise HTTPException(400, "invalid QR payload")
    image = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=7, border=2)
    import io
    buf = io.BytesIO()
    image.save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@app.get("/favicon.ico")
async def favicon():
    icon = ASSETS / "icons" / "game" / "dungeon-gate.svg"
    if icon.exists():
        return FileResponse(icon, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})
    return Response(status_code=204)


@app.get("/download/companion.py")
async def download_companion():
    return FileResponse(Path(__file__).resolve(), media_type="text/x-python", filename="lantern_table_companion.py")


@app.get("/api/ice")
async def api_ice():
    now = time.time()
    if turn_cache.get("iceServers") and now < float(turn_cache.get("expires", 0)) - 120:
        return {"iceServers": turn_cache["iceServers"], "source": "cloudflare-turn-cache"}
    key_id = os.environ.get("CLOUDFLARE_TURN_KEY_ID")
    api_token = os.environ.get("CLOUDFLARE_TURN_API_TOKEN")
    if key_id and api_token:
        url = f"https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.post(url, headers={"Authorization": f"Bearer {api_token}", "Content-Type": "application/json"}, json={"ttl": 86400})
            if not r.is_error:
                servers = r.json().get("iceServers") or []
                turn_cache.update({"iceServers": servers, "expires": now + 86400})
                return {"iceServers": servers, "source": "cloudflare-turn"}
        except Exception:
            pass
    return {"iceServers": [{"urls": ["stun:stun.cloudflare.com:3478"]}], "source": "cloudflare-stun"}


@app.post("/internal/drain")
async def internal_drain(request: Request):
    global draining
    client = request.client.host if request.client else ""
    if client not in {"127.0.0.1", "::1"}:
        raise HTTPException(403, "loopback only")
    draining = True
    # Broadcast to known Redis rooms via a short-lived drain channel. Clients silently reconnect.
    if redis_client:
        await redis_client.publish("lantern:drain", json.dumps({"type": "server_draining", "retry_after_ms": 400}))
    else:
        for room in list(local_room_peers):
            await _room_publish(room, {"type": "server_draining", "sender": "server", "target": "*", "retry_after_ms": 400})
    return {"draining": True}


@app.websocket("/ws/room/{room}/{peer_id}")
async def ws_room(websocket: WebSocket, room: str, peer_id: str):
    if draining:
        await websocket.close(code=1013, reason="server draining")
        return
    if MODE == "public" and REDIS_URL and not await redis_available():
        await websocket.accept()
        await websocket.send_json({"type": "service_unavailable", "message": "Table signaling is starting; please retry shortly."})
        await websocket.close(code=1013, reason="signaling backend unavailable")
        return
    role = websocket.query_params.get("role", "player")
    room = "".join(c for c in room.upper() if c.isalnum() or c == "-")[:24]
    peer_id = peer_id[:96]
    if not room or not peer_id:
        await websocket.close(code=1008, reason="invalid room")
        return
    if role != "host" and not await _host_online(room):
        await websocket.accept()
        await websocket.send_json({"type": "host_offline"})
        await websocket.close(code=4004, reason="host offline")
        return
    await websocket.accept()
    route_id = f"host:{peer_id}" if role == "host" else peer_id
    connection_id = uuid.uuid4().hex
    connection_marker = f"{peer_id}:{connection_id}"
    if redis_client:
        if role == "host":
            await redis_client.set(f"lantern:room:{room}:host", connection_marker, ex=43200)
        await redis_client.set(f"lantern:room:{room}:peer:{peer_id}", f"{role}:{connection_id}", ex=43200)
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(f"lantern:room:{room}", "lantern:drain")
    else:
        local_room_peers.setdefault(room, {})[route_id] = websocket
        pubsub = None

    async def relay_pubsub():
        if not pubsub:
            return
        try:
            async for item in pubsub.listen():
                if item.get("type") != "message":
                    continue
                try:
                    msg = json.loads(item.get("data") or "{}")
                except Exception:
                    continue
                if item.get("channel") == "lantern:drain":
                    await websocket.send_json(msg)
                    continue
                if msg.get("sender") == peer_id:
                    continue
                target = msg.get("target", "*")
                if target not in {"*", peer_id}:
                    continue
                await websocket.send_json(msg)
        except Exception:
            return

    relay_task = asyncio.create_task(relay_pubsub()) if pubsub else None
    await _room_publish(room, {"type": "presence", "event": "joined", "sender": peer_id, "target": "*", "role": role})
    try:
        while True:
            data = await websocket.receive_json()
            if redis_client:
                await redis_client.expire(f"lantern:room:{room}:peer:{peer_id}", 43200)
                if role == "host":
                    await redis_client.expire(f"lantern:room:{room}:host", 43200)
            msg = {"type": data.get("type", "signal"), "sender": peer_id, "target": data.get("target", "*"), "payload": data.get("payload")}
            await _room_publish(room, msg)
    except WebSocketDisconnect:
        pass
    finally:
        if relay_task:
            relay_task.cancel()
        if pubsub:
            try:
                await pubsub.unsubscribe()
                await pubsub.close()
            except Exception:
                pass
        if redis_client:
            peer_key = f"lantern:room:{room}:peer:{peer_id}"
            peer_value = await redis_client.get(peer_key)
            if peer_value == f"{role}:{connection_id}":
                await redis_client.delete(peer_key)
            if role == "host":
                host_key = f"lantern:room:{room}:host"
                current = await redis_client.get(host_key)
                if current == connection_marker:
                    await redis_client.delete(host_key)
        else:
            local_room_peers.get(room, {}).pop(route_id, None)
        await _room_publish(room, {"type": "presence", "event": "left", "sender": peer_id, "target": "*", "role": role})


@app.get("/health/live")
async def health_live():
    return {"status": "ok"}


@app.get("/health/ready")
async def health_ready():
    if draining:
        return JSONResponse({"status": "draining"}, status_code=503)
    if MODE == "public" and REDIS_URL and not await redis_available():
        return JSONResponse({"status": "waiting-for-valkey", "mode": MODE}, status_code=503)
    return {"status": "ready", "mode": MODE, "multi_replica": bool(REDIS_URL)}


@app.get("/")
async def index():
    if not HTML.exists():
        raise HTTPException(500, f"Missing {HTML.name}; keep it beside this script")
    return FileResponse(HTML)


@app.get("/auth/start")
async def auth_start(return_to: str | None = None):
    if MODE == "public":
        raise HTTPException(409, "ChatGPT sign-in runs on the host device companion, not the public signaling service")
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    pending.clear()
    pending.update(state=state, nonce=nonce, verifier=verifier, return_to=validated_return_to(return_to))

    existing = current_creds()
    client_id = existing.get("client_id") if existing else "dynamic_agent_client"
    params = {
        "client_id": client_id,
        "ext_agent_host_id": host_id(),
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "resource": RESOURCE,
        "state": state,
        "nonce": nonce,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
    }
    if existing:
        if existing.get("id_token"):
            params["id_token_hint"] = existing["id_token"]
        if existing.get("email"):
            params["login_hint"] = existing["email"]
    else:
        params["agent_name_hint"] = APP_NAME
    return RedirectResponse(str(httpx.URL(AUTH_URL, params=params)))


@app.get("/auth/callback")
async def auth_callback(request: Request):
    if MODE == "public":
        raise HTTPException(409, "OAuth callback belongs on the host device companion")
    q = request.query_params
    if q.get("state") != pending.get("state"):
        raise HTTPException(400, "OAuth state mismatch")
    if q.get("error"):
        raise HTTPException(400, f"ChatGPT authorization denied: {q.get('error')}")
    code = q.get("code")
    if not code:
        raise HTTPException(400, "Missing authorization code")

    existing = current_creds()
    callback_client = q.get("client_id")
    client_id = callback_client or (existing or {}).get("client_id")
    if not client_id or client_id == "dynamic_agent_client":
        raise HTTPException(400, "Registration did not return an issued client_id")
    if existing and callback_client and callback_client != existing.get("client_id"):
        raise HTTPException(400, "Unexpected client_id for returning ChatGPT account")

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "code_verifier": pending["verifier"],
                "redirect_uri": REDIRECT_URI,
                "resource": RESOURCE,
            },
        )
    if r.is_error:
        raise HTTPException(r.status_code, f"Token exchange failed: {r.text[:400]}")
    tok = r.json()
    claims = verify_id_token(tok["id_token"], client_id, pending["nonce"])
    scopes = tok.get("scope", q.get("scope", "")).split()
    record = {
        "email": claims.get("email"),
        "name": claims.get("name"),
        "issuer": claims.get("iss"),
        "subject": claims.get("sub"),
        "client_id": client_id,
        "ext_agent_host_id": host_id(),
        "id_token": tok.get("id_token"),
        "access_token": tok.get("access_token"),
        "refresh_token": tok.get("refresh_token"),
        "token_type": tok.get("token_type", "Bearer"),
        "expires_in": int(tok.get("expires_in", 3600)),
        "expires_at": time.time() + int(tok.get("expires_in", 3600)),
        "scopes": scopes,
        "saved_at": time.time(),
    }
    atomic_private_json(CRED_PATH, record)
    return_to = auth_return_url(pending.get("return_to") or f"http://{HOST}:{PORT}/")
    pending.clear()
    return RedirectResponse(return_to)


@app.get("/auth/logout")
async def auth_logout():
    try:
        CRED_PATH.unlink()
    except FileNotFoundError:
        pass
    return RedirectResponse("/")


@app.get("/api/session")
async def api_session():
    if MODE == "public":
        return {"connected": False, "mode": "public", "companion_required": True, "image_generation": False}
    creds = current_creds()
    image_enabled = False
    if not creds:
        return {"connected": False, "mode": MODE, "image_generation": False}
    return {
        "connected": True,
        "mode": MODE,
        "email": creds.get("email"),
        "name": creds.get("name"),
        "plan_usage": "chatgpt.tokens.use.direct" in creds.get("scopes", []),
        "image_generation": False,
        "image_provider": None,
    }


@app.get("/api/models")
async def api_models():
    creds = await auth_creds()
    return {"models": await list_models(creds)}


def build_history(body: dict[str, Any]) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    opening = str(body.get("opening_request") or "").strip()
    if opening:
        history.append({"role": "user", "content": f"[TABLE DIRECTIVE — do not quote this instruction] {opening}"})
    for message in body.get("messages", [])[-20:]:
        if message.get("who") == "System":
            continue
        role = "assistant" if message.get("kind") == "dm" else "user"
        text = str(message.get("text", "")).strip()
        if text:
            history.append({"role": role, "content": text})
    return history


def dm_instructions(body: dict[str, Any]) -> str:
    settings = body.get("campaign_settings", {})
    return f"""You are the Dungeon Master for a collaborative tabletop fantasy RPG named {body.get('campaign', 'Lantern Table')}.

PLAY STYLE
- Write the spoken/narrated part of every turn as clean Markdown. Use short headings, emphasis, blockquotes, lists, and tables only when they improve playability.
- Be vivid but interactive: usually 2-6 short paragraphs. Never decide a player character's thoughts, dialogue, or choices.
- Respect the campaign controls: {json.dumps(settings, ensure_ascii=False)}
- The campaign is intentionally lazy-built. Invent only what is needed now, preserve established facts, and let the table add detail later.
- Do not fabricate dice results. Use request_roll only when uncertainty matters.
- Players own character identity/background, but mechanical fields (HP, max HP, AC, level, conditions, location) are game-authoritative. Use set_character_mechanics to establish/correct starting stats and propose_state_patch for damage/healing.
- Treat local host state as authoritative.

UI AND GAME TOOLS
- Always call set_next_moves exactly once per DM turn with 2-5 concrete options. Players may still type anything.
- Use render_card for important NPCs, monsters, clues, items, factions, quests, or locations when a compact reference helps.
- Use propose_state_patch for durable changes. When applying HP changes, name the affected character. Keep patches small and explain why.
- Use set_character_mechanics when a new quick-start character needs authoritative starting HP/AC/level. Do this early in the opening if the sheet still has placeholder mechanics.
- Use suggest_visual_prompt when art would materially help. Lantern Table does not generate images; provide a polished prompt for the user to copy elsewhere.

ATMOSPHERE TOOL
Use set_atmosphere only on meaningful environmental/emotional transitions, not every turn. Player devices may opt out. Choose for readability first, mood second. A theme is a scene-lighting cue, not a reward animation. Preserve a theme across nearby rooms unless mood or environment materially changes.

Theme families and suggested story use:
- Hearth / refuge / human warmth: lantern, black-gold, white-gold, gruvbox-dark/light, autumn. Pair lantern + dust; embers only when fire is present.
- Crypt / horror / oppressive darkness: dracula, ash, matte-black, pitch-black, rose-pine-moon, halloween. Pair fog/dust/lantern; use storm only for actual weather or a supernatural shock.
- Winter / ice / exposed mountains: winter-frost, nord-dark/light, graphite-dark/light. Pair snow/fog; keep intensity low during dialogue.
- Forest / earth / old natural magic: everforest-dark/light, kanagawa-wave/dragon/lotus, mist-gb. Pair fireflies/dust/fog.
- Rain / city / ship / nocturnal travel: tokyo-night-storm, tokyo-night, night-owl, nord-dark. Pair rain and occasional storm.
- Ocean / flooded ruins / reflective shores: rose-pine-moon, berry-nebula, kanagawa-wave, summer-beach. Use water for shore/reflection; underwater + bubbles only when actually submerged.
- Arcane / dream / cosmic / planar: berry-nebula, catppuccin-mocha/macchiato/frappe, rose-pine, inkpink, sweet, twilight-5. Pair stars/aurora/fireflies.
- Bright daylight / social / hopeful: ayu-light, rose-pine-dawn, github-light, catppuccin-latte, serika-light, modus-operandi, whitesur-light, graphite-light, white-gold, summer-beach. Prefer no effects or very subtle dust.
- Combat / fire / destruction / urgency: autumn, black-gold, gruvbox-dark, ayu-dark, midnight-ablaze, lava-gb, rust-gold-8. Pair embers/dust; never use constant flashing.
- Machinery / strange technology / glitch: tokyo-night, one-dark, graphite-dark, matte-black, 2bit-demichrome, pico-8, nintendo-gameboy, slso8. Usually use no weather; stars/aurora only for explicitly digital/cosmic scenes.
- Ceremony / festival / celebration: diwali, lunar-new-year, christmas, hanukkah, st-patricks-day, valentine, blessing. Use effects that match the fiction rather than the palette name.
- Retro / surreal / stylized one-off scenes: oil-6, pollen8, vinik24, mist-gb, lava-gb, 2bit-demichrome, pico-8, slso8. Use sparingly so they feel intentional.
- Rhiannon-night is literary/celestial: near-black with warm cream, blush/lavender/gold feeling; use for magical, intimate, reflective scenes and soft starlight.

Effect semantics:
- snow: falling outdoor/ruined snow; rain: visible rainfall; dust: motes/age/sunbeams; embers: nearby heat/fire; fireflies: living magic/forest dusk; fog: obscured depth; lantern: warm local light; bubbles: submerged water; water: reflective/rippled surface; underwater: full-screen caustic/submerged feel; aurora: magical sky/planar glow; storm: rain plus brief lightning; stars: celestial/void ambience.
- Do not stack more than 2-3 effects unless it is a brief climax. Never use storm merely to make combat exciting.
- Transitions should usually be 900-2400ms. Use intensity 0.15-0.45 normally; exceed 0.65 only for short dramatic moments. If players need to read dense cards, lower effects instead of increasing them.

CURRENT LOCAL STATE
Scene: {json.dumps(body.get('scene', {}), ensure_ascii=False)}
Characters: {json.dumps(body.get('characters', body.get('party', [])), ensure_ascii=False)}
Quests: {json.dumps(body.get('quests', []), ensure_ascii=False)}
Inventory: {json.dumps(body.get('inventory', []), ensure_ascii=False)}
Recent timeline: {json.dumps(body.get('timeline', [])[-20:], ensure_ascii=False)}
Recent journal: {str(body.get('journal', ''))[-5000:]}
"""


@app.post("/api/dm/stream")
async def api_dm_stream(request: Request):
    if MODE == "public":
        raise HTTPException(503, "Run the Lantern Table companion on the host device for ChatGPT-plan inference")
    creds = await auth_creds()
    body = await request.json()
    model = await choose_model(creds, body.get("model"))
    payload = {
        "model": model,
        "instructions": dm_instructions(body),
        "input": build_history(body),
        "tools": [
            {
                "type": "namespace",
                "name": "lantern",
                "description": "Lantern Table client-side game presentation and local-state tools.",
                "tools": DM_TOOLS,
            }
        ],
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "store": False,
        "stream": True,
    }

    async def events() -> AsyncIterator[str]:
        yield sse("meta", {"model": model, "phase": "thinking"})
        tool_calls: dict[int, dict[str, Any]] = {}
        sent_tools: set[str] = set()
        completed = False
        try:
            timeout = httpx.Timeout(180.0, connect=30.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST",
                    f"{RESOURCE}/responses",
                    headers={
                        "Authorization": f"Bearer {creds['access_token']}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                ) as r:
                    if r.is_error:
                        text = (await r.aread()).decode(errors="replace")
                        yield sse("error", {"message": text[:1200], "status": r.status_code})
                        return
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if not data or data == "[DONE]":
                            continue
                        try:
                            event = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        etype = event.get("type")
                        if etype == "response.output_text.delta":
                            delta = event.get("delta", "")
                            if delta:
                                yield sse("delta", {"delta": delta})
                        elif etype == "response.output_item.added":
                            item = event.get("item", {})
                            if item.get("type") == "function_call":
                                idx = int(event.get("output_index", len(tool_calls)))
                                tool_calls[idx] = dict(item)
                                yield sse("tool_status", {"name": item.get("name"), "status": "preparing"})
                        elif etype == "response.function_call_arguments.delta":
                            idx = int(event.get("output_index", -1))
                            if idx in tool_calls:
                                tool_calls[idx]["arguments"] = tool_calls[idx].get("arguments", "") + event.get("delta", "")
                        elif etype == "response.output_item.done":
                            item = event.get("item", {})
                            if item.get("type") == "function_call":
                                key = item.get("call_id") or item.get("id") or str(event.get("output_index"))
                                if key not in sent_tools:
                                    sent_tools.add(key)
                                    try:
                                        args = json.loads(item.get("arguments") or "{}")
                                    except json.JSONDecodeError:
                                        args = {"raw": item.get("arguments", "")}
                                    yield sse("tool", {"name": item.get("name"), "arguments": args, "call_id": key})
                        elif etype == "response.failed":
                            err = (event.get("response") or {}).get("error") or event.get("error") or {}
                            yield sse("error", {"message": err.get("message") or str(err), "code": err.get("code")})
                            return
                        elif etype == "response.incomplete":
                            yield sse("error", {"message": "The DM response was incomplete. Try again."})
                            return
                        elif etype == "response.completed":
                            completed = True
                            response = event.get("response", {})
                            usage = response.get("usage") or {}
                            # Fallback: emit any function calls present in the terminal response.
                            for item in response.get("output", []):
                                if item.get("type") != "function_call":
                                    continue
                                key = item.get("call_id") or item.get("id") or secrets.token_hex(4)
                                if key in sent_tools:
                                    continue
                                sent_tools.add(key)
                                try:
                                    args = json.loads(item.get("arguments") or "{}")
                                except json.JSONDecodeError:
                                    args = {"raw": item.get("arguments", "")}
                                yield sse("tool", {"name": item.get("name"), "arguments": args, "call_id": key})
                            yield sse("done", {"model": model, "usage": usage})
                            return
            if not completed:
                yield sse("error", {"message": "The DM stream ended before response.completed."})
        except httpx.HTTPError as exc:
            yield sse("error", {"message": f"OpenAI connection error: {exc}"})
        except Exception as exc:
            yield sse("error", {"message": f"DM stream error: {exc}"})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )



# Compatibility endpoint for old clients: returns a completed JSON response by consuming the stream.
@app.post("/api/dm")
async def api_dm_legacy(request: Request):
    raise HTTPException(410, "This build uses /api/dm/stream. Refresh the Lantern Table page.")


if __name__ == "__main__":
    print(f"Lantern Table: http://{BIND_HOST}:{PORT}")
    uvicorn.run(app, host=BIND_HOST, port=PORT, log_level="info")
