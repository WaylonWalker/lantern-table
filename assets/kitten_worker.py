#!/usr/bin/env python3
"""Managed stdio worker for the optional host-local KittenTTS 2 runtime."""
from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import inspect
import sys
import time
import wave


def emit(value: dict) -> None:
    sys.__stdout__.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.__stdout__.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", default="emb4", choices=("packed", "emb4", "full"))
    args = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy as np
            import torch
            from kittenml import KittenTTS
            started = time.perf_counter()
            model = KittenTTS("KittenML/kitten-tts-2", weights=args.weights)
            load_ms = round((time.perf_counter() - started) * 1000)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            parameters = inspect.signature(model.generate).parameters.values()
            parameter_names = {parameter.name for parameter in parameters}
            has_var_kwargs = any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters)
            supports_preset = "preset" in parameter_names or has_var_kwargs
            supports_speed = "speed" in parameter_names or has_var_kwargs
            warmup_started = time.perf_counter()
            warmup_error = None
            try:
                # Pay the one-time CUDA/kernel initialization cost during startup.
                model.generate("Ready when you are.", voice=model.available_voices[0], preset="stable")
                warmup_ms = round((time.perf_counter() - warmup_started) * 1000)
            except Exception as exc:
                warmup_ms = round((time.perf_counter() - warmup_started) * 1000)
                warmup_error = f"{type(exc).__name__}: {exc}"
        emit({"ready": True, "voices": list(model.available_voices), "model": "KittenML/kitten-tts-2", "weights": args.weights, "device": device, "load_ms": load_ms, "warmup_ms": warmup_ms, "warmup_error": warmup_error, "sample_rate": int(model.sample_rate), "expression_mode": "expressive-preset" if supports_preset else "inline-markup", "supports_energy_speed": supports_speed})
    except Exception as exc:
        emit({"ready": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1

    for line in sys.stdin:
        try:
            request = json.loads(line)
            text, voice = str(request.get("text", "")), str(request.get("voice", ""))
            if not text or len(text) > 6000 or voice not in model.available_voices:
                raise ValueError("Text (up to 6000 characters) and a valid Kitten voice are required")
            energy = min(1.0, max(0.0, float(request.get("energy", 0.5))))
            preset = str(request.get("preset", "stable"))
            if preset not in {"stable", "expressive"}:
                raise ValueError("Preset must be stable or expressive")
            speed = 0.85 + 0.3 * energy
            started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                options = {"voice": voice}
                if supports_speed:
                    options["speed"] = speed
                if supports_preset:
                    options["preset"] = preset
                audio = np.asarray(model.generate(text, **options), dtype=np.float32).reshape(-1)
            generation_ms = round((time.perf_counter() - started) * 1000)
            clipped = np.clip(audio, -1, 1)
            wav = io.BytesIO()
            with wave.open(wav, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(int(model.sample_rate))
                output.writeframes((clipped * 32767).astype("<i2").tobytes())
            emit({"ok": True, "audio_b64": base64.b64encode(wav.getvalue()).decode("ascii"), "generation_ms": generation_ms, "audio_duration_ms": round(len(audio) / model.sample_rate * 1000), "sample_rate": int(model.sample_rate), "device": device, "speed": round(speed, 3), "preset": preset})
        except Exception as exc:
            emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
