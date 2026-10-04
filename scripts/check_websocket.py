#!/usr/bin/env python3
"""Verify the public signaling endpoint completes a WebSocket upgrade."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import socket
import ssl
import sys
from urllib.parse import urlsplit


def read_exact(connection: socket.socket, count: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < count:
        chunk = connection.recv(count - len(chunks))
        if not chunk:
            raise RuntimeError("WebSocket closed before the response was complete")
        chunks.extend(chunk)
    return bytes(chunks)


def main() -> int:
    raw_url = sys.argv[1] if len(sys.argv) > 1 else "https://dnd.waylonwalker.com"
    url = urlsplit(raw_url)
    if url.scheme not in {"http", "https", "ws", "wss"} or not url.hostname:
        raise RuntimeError("URL must use http(s) or ws(s) and include a hostname")
    secure = url.scheme in {"https", "wss"}
    port = url.port or (443 if secure else 80)
    ws_scheme = "wss" if secure else "ws"
    room = "DOCTOR-" + secrets.token_hex(5).upper()
    peer = "doctor-" + secrets.token_hex(5)
    path = f"/ws/room/{room}/{peer}?role=player"
    host_header = url.hostname if port in {80, 443} else f"{url.hostname}:{port}"
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    origin = f"{'https' if secure else 'http'}://{host_header}"
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host_header}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Origin: {origin}\r\n\r\n"
    ).encode("ascii")

    with socket.create_connection((url.hostname, port), timeout=8) as raw:
        connection = ssl.create_default_context().wrap_socket(raw, server_hostname=url.hostname) if secure else raw
        connection.settimeout(8)
        connection.sendall(request)
        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = connection.recv(4096)
            if not chunk:
                raise RuntimeError("Server closed during the WebSocket handshake")
            response.extend(chunk)
            if len(response) > 16384:
                raise RuntimeError("WebSocket response headers exceeded 16 KiB")
        header_bytes, remaining = bytes(response).split(b"\r\n\r\n", 1)
        lines = header_bytes.decode("latin1").split("\r\n")
        if " 101 " not in lines[0]:
            raise RuntimeError(f"WebSocket upgrade failed: {lines[0]}")
        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            headers[name.lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if headers.get("sec-websocket-accept") != expected:
            raise RuntimeError("Server returned an invalid Sec-WebSocket-Accept value")

        frame = bytearray(remaining)
        while len(frame) < 2:
            frame.extend(read_exact(connection, 2 - len(frame)))
        opcode = frame[0] & 0x0F
        length = frame[1] & 0x7F
        if length == 126:
            while len(frame) < 4:
                frame.extend(read_exact(connection, 4 - len(frame)))
            length = int.from_bytes(frame[2:4], "big")
            offset = 4
        elif length == 127:
            while len(frame) < 10:
                frame.extend(read_exact(connection, 10 - len(frame)))
            length = int.from_bytes(frame[2:10], "big")
            offset = 10
        else:
            offset = 2
        while len(frame) < offset + length:
            frame.extend(read_exact(connection, offset + length - len(frame)))
        if opcode != 1:
            raise RuntimeError(f"Expected a text signaling frame, received opcode {opcode}")
        message = json.loads(bytes(frame[offset : offset + length]).decode("utf-8"))
        if message.get("type") != "host_offline":
            raise RuntimeError(f"Unexpected signaling response: {message.get('type')!r}")
        connection.close()

    print(f"WebSocket upgrade and signaling response passed ({ws_scheme}, room={room})")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"WebSocket smoke failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
