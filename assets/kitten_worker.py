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
import os
import uuid


def audit(event: str, **fields: object) -> None:
    """Write opt-in, content-free measurements to a local JSONL file."""
    path = os.environ.get("LANTERN_TTS_AUDIT_LOG")
    if not path:
        return
    record = {"event": event, "mono_ns": time.perf_counter_ns(), **fields}
    try:
        with open(path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")
    except OSError:
        pass


def emit(value: dict) -> None:
    sys.__stdout__.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.__stdout__.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", default="emb4", choices=("packed", "emb4", "full"))
    parser.add_argument("--model", default="KittenML/kitten-tts-2")
    args = parser.parse_args()
    process_started = time.perf_counter_ns()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy as np
            import torch
            from kittenml import KittenTTS
            started = time.perf_counter_ns()
            download_ms = None
            if os.environ.get("LANTERN_TTS_AUDIT_LOG"):
                # Opt-in only: split Hugging Face snapshot resolution from model
                # initialization while reusing KittenML's own file selection.
                from huggingface_hub import snapshot_download
                from kittenml.get_model import _kitten2_files
                from kittenml.repo import resolve_repo
                local_dir, repo_id, config = resolve_repo(args.model)
                download_started = time.perf_counter_ns()
                if local_dir is None:
                    if args.model == "KittenML/kitten-tts-2":
                        local_dir = snapshot_download(repo_id=repo_id, allow_patterns=_kitten2_files(config, weights=args.weights))
                    else:
                        local_dir = snapshot_download(repo_id=repo_id)
                download_ms = round((time.perf_counter_ns() - download_started) / 1e6, 3)
                model = KittenTTS(str(local_dir), weights=args.weights) if args.model == "KittenML/kitten-tts-2" else KittenTTS(str(local_dir))
                model_init_ms = round((time.perf_counter_ns() - download_started) / 1e6, 3) - download_ms
                load_ms = round((time.perf_counter_ns() - started) / 1e6, 3)
            else:
                model = KittenTTS(args.model, weights=args.weights) if args.model == "KittenML/kitten-tts-2" else KittenTTS(args.model)
                model_init_ms = round((time.perf_counter_ns() - started) / 1e6, 3)
                load_ms = model_init_ms
            # Report the device selected by KittenTTS itself. CUDA availability is
            # useful context, but does not establish where model inference runs.
            actual_device = str(getattr(model, "device", "unknown"))
            parameters = inspect.signature(model.generate).parameters.values()
            parameter_names = {parameter.name for parameter in parameters}
            has_var_kwargs = any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters)
            supports_preset = "preset" in parameter_names or has_var_kwargs
            supports_speed = "speed" in parameter_names or has_var_kwargs
            warmup_started = time.perf_counter_ns()
            warmup_error = None
            try:
                # Pay the one-time CUDA/kernel initialization cost during startup.
                warmup_options = {"voice": model.available_voices[0]}
                if supports_preset:
                    warmup_options["preset"] = "stable"
                if supports_speed:
                    warmup_options["speed"] = 1.0
                model.generate("Ready when you are.", **warmup_options)
                warmup_ms = round((time.perf_counter_ns() - warmup_started) / 1e6, 3)
            except Exception as exc:
                warmup_ms = round((time.perf_counter_ns() - warmup_started) / 1e6, 3)
                warmup_error = f"{type(exc).__name__}: {exc}"
        audit("worker_ready", startup_ms=round((time.perf_counter_ns()-process_started)/1e6, 3), model_download_ms=download_ms, model_init_ms=model_init_ms, model_load_ms=load_ms, warmup_ms=warmup_ms, cuda_available=torch.cuda.is_available(), device=actual_device, weights=args.weights, torch_threads=torch.get_num_threads(), torch_interop_threads=torch.get_num_interop_threads())
        emit({"ready": True, "voices": list(model.available_voices), "model": args.model, "weights": args.weights if args.model == "KittenML/kitten-tts-2" else None, "device": actual_device, "cuda_available": torch.cuda.is_available(), "model_download_ms": download_ms, "model_init_ms": model_init_ms, "load_ms": load_ms, "warmup_ms": warmup_ms, "warmup_error": warmup_error, "torch_threads": torch.get_num_threads(), "torch_interop_threads": torch.get_num_interop_threads(), "sample_rate": int(model.sample_rate), "expression_mode": "expressive-preset" if supports_preset else "plain", "supports_energy_speed": supports_speed})
    except Exception as exc:
        emit({"ready": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1

    for line in sys.stdin:
        try:
            request = json.loads(line)
            correlation_id = str(request.get("correlation_id") or uuid.uuid4())[:80]
            text, voice = str(request.get("text", "")), str(request.get("voice", ""))
            if not text or len(text) > 6000 or voice not in model.available_voices:
                raise ValueError("Text (up to 6000 characters) and a valid Kitten voice are required")
            energy = min(1.0, max(0.0, float(request.get("energy", 0.5))))
            preset = str(request.get("preset", "stable"))
            if preset not in {"stable", "expressive"}:
                raise ValueError("Preset must be stable or expressive")
            speed = 0.85 + 0.3 * energy
            started = time.perf_counter_ns()
            audit("inference_start", correlation_id=correlation_id, characters=len(text), device=actual_device)
            with contextlib.redirect_stdout(sys.stderr):
                options = {"voice": voice}
                if supports_speed:
                    options["speed"] = speed
                if supports_preset:
                    options["preset"] = preset
                audio = np.asarray(model.generate(text, **options), dtype=np.float32).reshape(-1)
            inference_end = time.perf_counter_ns()
            generation_ms = round((inference_end - started) / 1e6, 3)
            clipped = np.clip(audio, -1, 1)
            wav = io.BytesIO()
            wav_started = time.perf_counter_ns()
            with wave.open(wav, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(int(model.sample_rate))
                output.writeframes((clipped * 32767).astype("<i2").tobytes())
            wav_bytes = wav.getvalue()
            wav_ms = round((time.perf_counter_ns()-wav_started)/1e6, 3)
            b64_started = time.perf_counter_ns()
            audio_b64 = base64.b64encode(wav_bytes).decode("ascii")
            b64_ms = round((time.perf_counter_ns()-b64_started)/1e6, 3)
            emit({"ok": True, "correlation_id": correlation_id, "audio_b64": audio_b64, "generation_ms": generation_ms, "wav_encode_ms": wav_ms, "base64_encode_ms": b64_ms, "wav_bytes": len(wav_bytes), "audio_duration_ms": round(len(audio) / model.sample_rate * 1000), "sample_rate": int(model.sample_rate), "device": actual_device, "speed": round(speed, 3), "preset": preset})
            audit("inference_complete", correlation_id=correlation_id, characters=len(text), inference_ms=generation_ms, wav_encode_ms=wav_ms, base64_encode_ms=b64_ms, wav_bytes=len(wav_bytes), audio_duration_ms=round(len(audio) / model.sample_rate * 1000), device=actual_device)
        except Exception as exc:
            emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
