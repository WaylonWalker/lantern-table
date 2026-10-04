#!/usr/bin/env python3
"""Smoke test host-only audio cue relay and loop-state snapshot semantics."""
from __future__ import annotations

import secrets
import sys
import time

from wss_multiplayer_smoke import WebSocket, connect_ready


def main() -> int:
    base_url = sys.argv[1] if len(sys.argv) > 1 else "https://dnd.waylonwalker.com"
    room = "AUD-" + secrets.token_hex(5).upper()
    host_id, player_id, second_player_id = ("audio-" + secrets.token_hex(8) for _ in range(3))
    host, _ = connect_ready(base_url, room, host_id, "host")
    player = second = None
    try:
        player, _ = connect_ready(base_url, room, player_id, "player")
        second, _ = connect_ready(base_url, room, second_player_id, "player")

        # Ordinary players cannot ask the host to emit shared audio.
        forged_id = "forged-" + secrets.token_hex(5)
        player.send_app("host", "audio_cue", cueId="door.knock.heavy", channel="sfx", eventId=forged_id)
        deadline = time.monotonic() + 0.8
        while time.monotonic() < deadline:
            try:
                msg = host.recv_json(timeout=max(0.05, deadline - time.monotonic()))
            except TimeoutError:
                break
            if msg.get("type") == "audio_cue" and msg.get("payload", {}).get("eventId") == forged_id:
                raise RuntimeError("A player was able to send a shared audio cue to the host")

        # Host sends only a semantic ID; peers resolve it from their local catalog.
        event_id = "audio-" + secrets.token_hex(5)
        host.send_app("players", "audio_cue", cueId="door.knock.heavy", channel="sfx", eventId=event_id)
        delivered = player.wait_for(lambda msg: msg.get("type") == "audio_cue" and msg.get("payload", {}).get("eventId") == event_id)
        payload = delivered.get("payload", {})
        if payload.get("cueId") != "door.knock.heavy" or payload.get("channel") != "sfx":
            raise RuntimeError("Player received an invalid semantic audio cue")
        if any(key in payload for key in ("url", "file", "audio", "data")):
            raise RuntimeError("Audio cue unexpectedly contains an audio file or URL")
        second.wait_for(lambda msg: msg.get("type") == "audio_cue" and msg.get("payload", {}).get("eventId") == event_id)

        # Canonical snapshots carry current loops, while one-shot event history is absent.
        snapshot_id = "audio-snapshot-" + secrets.token_hex(4)
        shared = {
            "ambience": {"cueId": "ambience.cavern", "fadeMs": 900},
            "music": {"cueId": "music.battle", "fadeMs": 1200},
        }
        host.send_app("players", "snapshot", snapshotId=snapshot_id, seq=1, state={"sharedAudio": shared})
        snapshot = player.wait_for(lambda msg: msg.get("type") == "snapshot" and msg.get("payload", {}).get("snapshotId") == snapshot_id)
        synced = snapshot.get("payload", {}).get("state", {}).get("sharedAudio", {})
        if synced != shared:
            raise RuntimeError(f"Active ambience/music did not resync: {synced!r}")
        if "recentSfx" in snapshot.get("payload", {}).get("state", {}):
            raise RuntimeError("One-shot sound effects were included in reconnect state")

        print("Audio protocol smoke passed: host cue relayed, player cue rejected, loop state snapshot resynced.")
        return 0
    finally:
        for connection in (player, second, host):
            if connection:
                connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
