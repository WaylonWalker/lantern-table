#!/usr/bin/env python3
"""Exercise the host-authoritative WSS multiplayer contract through the public service."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import select
import socket
import ssl
import sys
import time
from urllib.parse import quote, urlsplit

current_stage = "start"


class WebSocket:
    def __init__(self, base_url: str, room: str, peer: str, role: str):
        url = urlsplit(base_url)
        self.host = url.hostname or ""
        self.port = url.port or (443 if url.scheme in {"https", "wss"} else 80)
        self.secure = url.scheme in {"https", "wss"}
        raw = socket.create_connection((self.host, self.port), timeout=10)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=self.host) if self.secure else raw
        self.sock.settimeout(10)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = self.host if self.port in {80, 443} else f"{self.host}:{self.port}"
        path = f"/ws/room/{quote(room)}/{quote(peer)}?role={quote(role)}"
        request = (
            f"GET {path} HTTP/1.1\r\nHost: {host_header}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            f"Origin: {'https' if self.secure else 'http'}://{host_header}\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("Server closed during WebSocket handshake")
            response.extend(chunk)
            if len(response) > 16384:
                raise RuntimeError("WebSocket response headers exceeded 16 KiB")
        headers, self.pending = bytes(response).split(b"\r\n\r\n", 1)
        lines = headers.decode("latin1").split("\r\n")
        if " 101 " not in lines[0]:
            raise RuntimeError(f"WebSocket upgrade failed: {lines[0]}")
        response_headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            response_headers[name.lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if response_headers.get("sec-websocket-accept") != expected:
            raise RuntimeError("Server returned an invalid WebSocket accept value")
        self.closed = False

    def _read(self, count: int) -> bytes:
        out = bytearray()
        if self.pending:
            take = min(count, len(self.pending))
            out.extend(self.pending[:take])
            self.pending = self.pending[take:]
        while len(out) < count:
            chunk = self.sock.recv(count - len(out))
            if not chunk:
                raise RuntimeError("WebSocket closed unexpectedly")
            out.extend(chunk)
        return bytes(out)

    def send_json(self, message: dict):
        payload = json.dumps(message, separators=(",", ":")).encode()
        mask = os.urandom(4)
        length = len(payload)
        head = bytearray([0x81])
        if length < 126:
            head.append(0x80 | length)
        elif length < 65536:
            head.append(0x80 | 126)
            head.extend(length.to_bytes(2, "big"))
        else:
            head.append(0x80 | 127)
            head.extend(length.to_bytes(8, "big"))
        head.extend(mask)
        head.extend(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(head)

    def recv_json(self, timeout: float = 10) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.pending:
                ready, _, _ = select.select([self.sock], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    break
            first, second = self._read(2)
            opcode, length = first & 0x0F, second & 0x7F
            if length == 126:
                length = int.from_bytes(self._read(2), "big")
            elif length == 127:
                length = int.from_bytes(self._read(8), "big")
            masked = bool(second & 0x80)
            mask = self._read(4) if masked else b""
            payload = self._read(length)
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 9:
                self._send_control(10, payload)
                continue
            if opcode == 8:
                raise RuntimeError("Server closed WebSocket")
            if opcode != 1:
                continue
            return json.loads(payload)
        raise TimeoutError("Timed out waiting for a WebSocket application message")

    def _send_control(self, opcode: int, payload: bytes):
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(bytes([0x80 | opcode, 0x80 | len(payload)]) + mask + masked)

    def send_app(self, target: str, kind: str, **payload):
        self.send_json({"type": kind, "target": target, "payload": {"kind": kind, **payload}})

    def wait_for(self, predicate, timeout: float = 12) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.recv_json(max(0.1, deadline - time.monotonic()))
            if predicate(message):
                return message
        raise TimeoutError("Timed out waiting for expected application message")

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self._send_control(8, (1000).to_bytes(2, "big"))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def application_message(ws: WebSocket, kind: str, target: str, **payload):
    ws.send_app(target, kind, **payload)


def connect_ready(base_url: str, room: str, peer: str, role: str, attempts: int = 5):
    last_error = None
    for attempt in range(attempts):
        connection = WebSocket(base_url, room, peer, role)
        try:
            message = connection.wait_for(lambda item: item.get("type") in {"connected", "host_offline"}, timeout=6)
            if message.get("type") == "host_offline":
                connection.close()
                raise RuntimeError("Host registration was not visible to the player pod")
            return connection, message
        except (TimeoutError, RuntimeError) as exc:
            connection.close()
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.25)
    raise RuntimeError(f"Could not establish {role} WebSocket after {attempts} attempts: {last_error}")


def main() -> int:
    base_url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LANTERN_PUBLIC_URL", "https://dnd.waylonwalker.com")
    room = "WSS-" + secrets.token_hex(5).upper()
    host_peer = "host-" + secrets.token_hex(8)
    player_peer = "player-" + secrets.token_hex(8)
    require_cross_pod = os.environ.get("LANTERN_REQUIRE_CROSS_POD", "true").lower() not in {"0", "false", "no"}
    def progress(value: str):
        global current_stage
        current_stage = value
        if os.environ.get("LANTERN_SMOKE_VERBOSE"):
            print(f"WSS smoke: {value}", flush=True)
    host, host_pod_msg = connect_ready(base_url, room, host_peer, "host")
    player = None
    other_player = None
    try:
        progress("host connected")
        host_pod = host_pod_msg.get("pod", "")
        if not host_pod and require_cross_pod:
            raise RuntimeError("Server did not report the host pod; cannot prove cross-pod routing")

        # Connections are deliberately retried until the Service gives the player a different pod.
        for attempt in range(12 if require_cross_pod else 1):
            progress(f"player connection attempt {attempt + 1}")
            candidate, pod_msg = connect_ready(base_url, room, f"{player_peer}-{attempt}", "player")
            if pod_msg.get("pod") != host_pod or not require_cross_pod:
                player = candidate
                player_peer = f"{player_peer}-{attempt}"
                player_pod = pod_msg.get("pod", "")
                break
            candidate.close()
        if player is None:
            raise RuntimeError("Could not place host and player WebSockets on separate Lantern Table pods")

        progress("player connected")
        player.send_app("host", "hello", name="WSS smoke player", character="Smoke hero", sessionId="smoke-session-1", lastCanonicalSeq=0)
        host.wait_for(lambda m: m.get("type") == "hello" and m.get("sender") == player_peer)
        progress("hello reached host")
        snapshot_id = "snapshot-smoke-1"
        initial_state = {"campaign": {"name": "WSS protocol smoke", "canonicalSeq": 0}, "characters": []}
        host.send_app(player_peer, "snapshot", snapshotId=snapshot_id, seq=0, state=initial_state)
        snapshot = player.wait_for(lambda m: m.get("type") == "snapshot" and m.get("payload", {}).get("snapshotId") == snapshot_id)
        progress("snapshot reached player")
        if snapshot["payload"]["state"]["campaign"]["name"] != "WSS protocol smoke":
            raise RuntimeError("Player did not receive the host canonical snapshot")
        player.send_app("host", "snapshot_ack", snapshotId=snapshot_id, seq=0)
        host.wait_for(lambda m: m.get("type") == "snapshot_ack" and m.get("sender") == player_peer)
        host.send_app(player_peer, "snapshot_ack_received", snapshotId=snapshot_id, seq=0)
        player.wait_for(lambda m: m.get("type") == "snapshot_ack_received")
        progress("snapshot acknowledged")

        action_id = "action-smoke-1"
        player.send_app("host", "player_action", actionId=action_id, playerId=player_peer, text="I open the door")
        action = host.wait_for(lambda m: m.get("type") == "player_action" and m.get("sender") == player_peer)
        progress("action reached host")
        if action["payload"].get("actionId") != action_id:
            raise RuntimeError("Host received the wrong player action")
        event = {"type": "canonical_event", "seq": 1, "id": "evt_smoke_1", "eventType": "action", "payload": {"state": {**initial_state, "campaign": {"name": "WSS protocol smoke", "canonicalSeq": 1}}}}
        host.send_app("players", "canonical_event", **{key: value for key, value in event.items() if key != "type"})
        canonical = player.wait_for(lambda m: m.get("type") == "canonical_event" and m.get("payload", {}).get("seq") == 1)
        progress("canonical event reached player")
        last_seq = canonical["payload"]["seq"]

        other_peer = "player-b-" + secrets.token_hex(6)
        other_player = WebSocket(base_url, room, other_peer, "player")
        other_player.wait_for(lambda m: m.get("type") == "connected")
        player.send_app("players", "canonical_event", seq=99, id="evt_forged", eventType="forged", payload={"state": {"campaign": {"name": "forged"}}})
        try:
            leaked = other_player.recv_json(timeout=0.75)
            if leaked.get("type") == "canonical_event" and leaked.get("payload", {}).get("id") == "evt_forged":
                raise RuntimeError("Player A was able to send a canonical event to Player B")
        except TimeoutError:
            pass
        progress("player-to-player canonical writes rejected")
        other_player.close()
        host.wait_for(lambda m: m.get("type") == "presence" and m.get("event") == "left" and m.get("sender") == other_peer)

        player.close()
        host.wait_for(lambda m: m.get("type") == "presence" and m.get("event") == "left" and m.get("sender") == player_peer)
        progress("player disconnect observed")
        player = None
        for attempt in range(5):
            time.sleep(0.35)
            progress(f"reconnecting player socket attempt {attempt + 1}")
            try:
                player, _ = connect_ready(base_url, room, player_peer, "player", attempts=1)
                break
            except RuntimeError:
                continue
        if player is None:
            raise RuntimeError("Could not reconnect the player WebSocket")
        progress("reconnected player socket open")
        player.send_app("host", "hello", name="WSS smoke player", character="Smoke hero", sessionId="smoke-session-2", lastCanonicalSeq=last_seq)
        progress("reconnected hello sent")
        host.wait_for(lambda m: m.get("type") == "hello" and m.get("sender") == player_peer)
        progress("reconnected hello reached host")
        snapshot_id = "snapshot-smoke-reconnect"
        host.send_app(player_peer, "snapshot", snapshotId=snapshot_id, seq=1, state=event["payload"]["state"])
        player.wait_for(lambda m: m.get("type") == "snapshot" and m.get("payload", {}).get("snapshotId") == snapshot_id)
        player.send_app("host", "snapshot_ack", snapshotId=snapshot_id, seq=1)
        host.wait_for(lambda m: m.get("type") == "snapshot_ack" and m.get("sender") == player_peer)
        host.send_app(player_peer, "snapshot_ack_received", snapshotId=snapshot_id, seq=1)
        player.wait_for(lambda m: m.get("type") == "snapshot_ack_received")
        progress("reconnect snapshot acknowledged")

        # A skipped host sequence must request a fresh snapshot instead of being applied.
        host.send_app("players", "canonical_event", seq=3, id="evt_smoke_gap", eventType="action", payload={"state": {}})
        player.wait_for(lambda m: m.get("type") == "canonical_event" and m.get("payload", {}).get("seq") == 3)
        player.send_app("host", "resync_request", lastCanonicalSeq=1, expectedSeq=2, receivedSeq=3)
        host.wait_for(lambda m: m.get("type") == "resync_request" and m.get("sender") == player_peer)
        progress("sequence gap resync requested")
        resync_snapshot_id = "snapshot-smoke-resync"
        host.send_app(player_peer, "snapshot", snapshotId=resync_snapshot_id, seq=3, state=event["payload"]["state"])
        player.wait_for(lambda m: m.get("type") == "snapshot" and m.get("payload", {}).get("snapshotId") == "snapshot-smoke-resync")
        player.send_app("host", "snapshot_ack", snapshotId=resync_snapshot_id, seq=3)
        host.wait_for(lambda m: m.get("type") == "snapshot_ack" and m.get("sender") == player_peer and m.get("payload", {}).get("snapshotId") == resync_snapshot_id)
        host.send_app(player_peer, "snapshot_ack_received", snapshotId=resync_snapshot_id, seq=3)
        player.wait_for(lambda m: m.get("type") == "snapshot_ack_received" and m.get("payload", {}).get("snapshotId") == resync_snapshot_id)
        progress("resync snapshot acknowledged")

        print(json.dumps({"result": "passed", "room": room, "hostPod": host_pod, "playerPod": player_pod, "crossPodRouting": host_pod != player_pod, "snapshotAck": True, "actionRelayed": action_id, "canonicalEvent": canonical["payload"]["seq"], "playerReconnectFreshSnapshot": True, "sequenceGapResync": True}, indent=2))
        return 0
    finally:
        if player:
            player.close()
        if other_player:
            other_player.close()
        host.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"WSS multiplayer smoke failed during {current_stage}: {exc}", file=sys.stderr)
        raise SystemExit(1)
