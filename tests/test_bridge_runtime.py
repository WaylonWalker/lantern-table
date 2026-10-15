#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "fastapi>=0.118",
#   "httpx>=0.28",
#   "PyJWT[crypto]>=2.10",
#   "uvicorn>=0.37",
#   "qrcode>=8.0",
#   "redis>=6.0",
#   "websockets>=13.0",
# ]
# ///
"""Focused tests for Lantern Bridge's host-local model runtime slice."""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("lantern_bridge_test_target", ROOT / "dnd_chatgpt_server.py")
bridge = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(bridge)


class Response:
    def __init__(self, data=None, status_code=200, text="", headers=None):
        self.data = data or {}
        self.status_code = status_code
        self.is_success = status_code < 400
        self.is_error = status_code >= 400
        self.text = text
        self.headers = headers or {}

    def json(self):
        return self.data

    def raise_for_status(self):
        if self.is_error:
            raise httpx.HTTPStatusError("failed", request=None, response=None)

    async def aread(self):
        return self.text.encode()

    async def aiter_lines(self):
        for line in self.lines:
            yield line


class TestBridgeRuntime(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.mode = bridge.MODE
        bridge.MODE = "companion"
        bridge.managed_services.clear()
        bridge.benchmark_cache.clear()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=bridge.app), base_url="http://test")

    async def test_completed_response_text_can_be_recovered_without_stream_deltas(self):
        response={"output":[{"type":"message","content":[{"type":"output_text","text":"The cellar door opens."}]}]}
        self.assertEqual(bridge.response_output_text(response),"The cellar door opens.")
        self.assertEqual(bridge.response_output_text({"output":[]}),"")

    async def test_model_discovery_retries_http_520_and_hides_upstream_html(self):
        class FakeClient:
            attempts = 0
            responses = [
                Response(status_code=520, text="<!DOCTYPE html><title>520 error</title>"),
                Response(data={"models": [{"slug": "gpt-test"}]}),
            ]
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            async def get(self, *args, **kwargs):
                type(self).attempts += 1
                return self.responses.pop(0)

        with patch.object(bridge.httpx, "AsyncClient", FakeClient), patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            models = await bridge.list_models({"access_token": "test-token"})
        self.assertEqual(models, [{"slug": "gpt-test", "display_name": "gpt-test"}])
        self.assertEqual(FakeClient.attempts, 2)

        FakeClient.responses = [Response(status_code=520, text="<!DOCTYPE html><title>520 error</title>") for _ in range(3)]
        FakeClient.attempts = 0
        with patch.object(bridge.httpx, "AsyncClient", FakeClient), patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(HTTPException) as raised:
                await bridge.list_models({"access_token": "test-token"})
        self.assertEqual(raised.exception.status_code, 520)
        self.assertIn("after 3 attempts", raised.exception.detail)
        self.assertNotIn("<!DOCTYPE html>", raised.exception.detail)
        self.assertEqual(FakeClient.attempts, 3)

    async def asyncTearDown(self):
        await self.client.aclose()
        bridge.MODE = self.mode

    async def test_host_discovery_returns_local_providers(self):
        providers = [{"id": "ollama", "status": "not_running", "installed": True}]
        with patch.object(bridge, "bridge_providers", new=AsyncMock(return_value=providers)), patch.object(bridge, "current_creds", return_value=None):
            response = await self.client.get("/api/providers")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([p["id"] for p in response.json()["providers"]], ["chatgpt", "ollama"])

    async def test_run_shows_browser_guide_but_stays_pipeable_from_curl(self):
        browser = await self.client.get("/run", headers={"accept": "text/html"})
        self.assertEqual(browser.status_code, 200)
        self.assertIn("text/html", browser.headers["content-type"])
        self.assertIn("Run Lantern Bridge", browser.text)
        self.assertIn("just tui", browser.text)
        self.assertEqual(browser.headers.get("vary"), "Accept")

        command = await self.client.get("/run", headers={"accept": "*/*"})
        self.assertEqual(command.status_code, 200)
        self.assertTrue(command.text.startswith("#!/bin/sh"))
        self.assertIn("text/plain", command.headers["content-type"])
        self.assertIn("lantern-", command.text)

        direct = await self.client.get("/run.sh", headers={"accept": "text/html"})
        self.assertEqual(direct.status_code, 200)
        self.assertEqual(direct.text, command.text)

    async def test_tui_status_is_local_and_exposes_no_secrets(self):
        response = await self.client.get("/api/bridge/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["online"])
        self.assertEqual(payload["version"], 1)
        self.assertIn("dm", payload)
        self.assertIn("audio", payload)
        self.assertNotIn("credentials", payload)
        self.assertNotIn("access_token", json.dumps(payload))

    async def test_tui_party_projection_rejects_untrusted_origins_and_strips_notes(self):
        payload = {
            "role": "host", "campaign": "Test Campaign", "session": 3,
            "characters": [{"name": "Mira", "class": "Rogue", "level": 5,
                            "hp": 12, "max_hp": 25, "conditions": ["Poisoned"],
                            "notes": "PRIVATE DM NOTES"}],
        }
        headers = {"origin": "https://evil.example", "x-lantern-host-snapshot": "1"}
        denied = await self.client.post("/api/bridge/party", json=payload, headers=headers)
        self.assertEqual(denied.status_code, 403)
        headers["origin"] = "https://dnd.waylonwalker.com"
        allowed = await self.client.post("/api/bridge/party", json=payload, headers=headers)
        self.assertEqual(allowed.status_code, 200)
        status = (await self.client.get("/api/bridge/status")).json()
        self.assertEqual(status["party"]["characters"][0]["name"], "Mira")
        self.assertNotIn("PRIVATE DM NOTES", json.dumps(status))
        self.assertEqual(status["party"]["characters"][0]["hp"], 12)

    async def test_tui_dm_activity_tracks_stream_lifecycle_without_text(self):
        async def sample_events():
            yield 'event: meta\ndata: {"model":"example-model","phase":"thinking"}\n\n'
            yield 'event: delta\ndata: {"delta":"secret generated narration"}\n\n'
            yield 'event: done\ndata: {}\n\n'
        captured = [line async for line in bridge.bridge_track_dm(sample_events(), "ollama")]
        self.assertEqual(len(captured), 3)
        status = (await self.client.get("/api/bridge/status")).json()
        self.assertEqual(status["dm"]["phase"], "idle")
        self.assertEqual(status["dm"]["model"], "example-model")
        self.assertNotIn("secret generated narration", json.dumps(status))

    async def test_kitten_cuda_oom_is_recognized_for_cpu_retry(self):
        self.assertTrue(bridge.kitten_cuda_oom("OutOfMemoryError: CUDA out of memory. Tried to allocate 24.00 MiB"))
        self.assertFalse(bridge.kitten_cuda_oom("ImportError: KittenML dependencies are unavailable"))

    async def test_kitten_worker_restarts_with_cuda_hidden_after_oom(self):
        class Stdout:
            def __init__(self, line): self.line = line
            async def readline(self): return self.line

        class Process:
            def __init__(self, line):
                self.stdout=Stdout(line);self.stdin=object();self.returncode=None
            def terminate(self): self.returncode=-15
            async def wait(self): return self.returncode
            def kill(self): self.returncode=-9

        first=Process(b'{"ready":false,"error":"OutOfMemoryError: CUDA out of memory"}\n')
        second=Process(b'{"ready":true,"model":"KittenML/kitten-tts-2","weights":"emb4","device":"cpu","load_ms":125,"voices":["Victor"]}\n')
        bridge._kitten_process=None
        bridge._kitten_info.update(weights="emb4",voices=[])
        with patch.object(bridge.shutil,"which",return_value=None), patch.object(bridge.asyncio,"create_subprocess_exec",new=AsyncMock(side_effect=[first,second])) as spawn:
            result=await bridge.start_kitten_worker()
        self.assertTrue(result["loaded"])
        self.assertEqual(result["device"],"cpu")
        self.assertTrue(result["cpu_fallback"])
        self.assertEqual(spawn.await_count,2)
        self.assertEqual(spawn.await_args_list[0].kwargs["limit"],64*1024*1024)
        self.assertEqual(spawn.await_args_list[1].kwargs["env"]["CUDA_VISIBLE_DEVICES"],"")
        await bridge._stop_kitten_process()

    async def test_dm_contract_exposes_semantic_actor_speech(self):
        tool=next(item for item in bridge.DM_TOOLS if item.get("name")=="speak_line")
        props=tool["parameters"]["properties"]
        self.assertIn("stern",props["emotion"]["enum"])
        self.assertIn("sigh",props["parts"]["items"]["properties"]["event"]["enum"])
        instructions=bridge.dm_instructions({"campaign":"Test table","campaign_settings":{}})
        self.assertIn("For dialogue spoken by a known persistent NPC, call speak_line",instructions)
        self.assertIn("speaker_id=null",instructions)
        self.assertIn("Never write Kitten tags or markup in Markdown",instructions)

    async def test_kitten_preview_text_and_semantic_speech_share_runtime_endpoint(self):
        audio=b"RIFF-test-wave"
        result={"audio_b64":base64.b64encode(audio).decode(),"generation_ms":20,"audio_duration_ms":30}
        with tempfile.TemporaryDirectory() as cache_dir, patch.dict(bridge._kitten_info,{"loaded":True,"voices":["Victor"],"model":"KittenML/kitten-tts-2","weights":"emb4","device":"cpu","expression_mode":"inline-markup"}), patch.object(bridge,"_kitten_cache_dir",Path(cache_dir)), patch.object(bridge,"kitten_worker_request",new=AsyncMock(return_value=result)) as synth:
            response=await self.client.post("/api/kitten/synthesize",json={"text":"Preview this voice.","voice":"Victor","energy":0.8})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.content,audio)
        self.assertEqual(response.headers["X-Kitten-Expression-Mode"],"inline-markup")
        synth.assert_awaited_once()
        worker_payload=synth.await_args.args[0]
        self.assertEqual({key:value for key,value in worker_payload.items() if key!="correlation_id"},{"text":"Preview this voice.","voice":"Victor","energy":0.8,"preset":"stable"})
        self.assertTrue(worker_payload["correlation_id"])

    async def test_kitten_preset_defaults_to_stable_for_narration_and_expressive_for_actor_speech(self):
        audio=b"RIFF-test-wave"
        result={"audio_b64":base64.b64encode(audio).decode(),"generation_ms":20,"audio_duration_ms":30}
        with tempfile.TemporaryDirectory() as cache_dir, patch.dict(bridge._kitten_info,{"loaded":True,"voices":["Victor"],"model":"KittenML/kitten-tts-2","weights":"emb4","device":"cpu"}), patch.object(bridge,"_kitten_cache_dir",Path(cache_dir)), patch.object(bridge,"kitten_worker_request",new=AsyncMock(return_value=result)) as synth:
            narration=await self.client.post("/api/kitten/synthesize",json={"text":"Narrate this.","voice":"Victor"})
            actor=await self.client.post("/api/kitten/synthesize",json={"speech":{"parts":[{"type":"text","text":"Speak this."}]},"voice":"Victor"})
        self.assertEqual(narration.status_code,200)
        self.assertEqual(actor.status_code,200)
        self.assertEqual(synth.await_args_list[0].args[0]["preset"],"stable")
        self.assertEqual(synth.await_args_list[1].args[0]["preset"],"expressive")

    async def test_kitten_synthesis_waits_for_startup_catalogue_before_voice_validation(self):
        audio=b"RIFF-test-wave"
        result={"audio_b64":base64.b64encode(audio).decode(),"generation_ms":20,"audio_duration_ms":30}
        async def finish_startup():
            bridge._kitten_info.update(loaded=True,available=True,voices=["Victor"],model="KittenML/kitten-tts-2",weights="emb4",device="cpu",expression_mode="inline-markup")
            return bridge._kitten_info
        with tempfile.TemporaryDirectory() as cache_dir, patch.dict(bridge._kitten_info,{"loaded":False,"voices":[]}), patch.object(bridge,"_kitten_cache_dir",Path(cache_dir)), patch.object(bridge,"start_kitten_worker",new=AsyncMock(side_effect=finish_startup)) as start, patch.object(bridge,"kitten_worker_request",new=AsyncMock(return_value=result)) as synth:
            response=await self.client.post("/api/kitten/synthesize",json={"text":"Preview during startup.","voice":"Victor"})
        self.assertEqual(response.status_code,200)
        start.assert_awaited_once()
        synth.assert_awaited_once()

    async def test_discovery_does_not_start_any_runtime_and_marks_image_backends(self):
        async def stopped(name, *_args): return {"id": name, "status": "not_running", "models": []}
        with patch.object(bridge, "probe_http_runtime", new=AsyncMock(side_effect=stopped)), patch.object(bridge.shutil, "which", return_value=None), patch.object(bridge.asyncio, "create_subprocess_exec", new=AsyncMock()) as spawn:
            providers = await bridge.bridge_providers()
        spawn.assert_not_awaited()
        by_id = {item["id"]: item for item in providers}
        self.assertEqual(by_id["sd_cpp"]["kind"], "image")
        self.assertFalse(by_id["sd_cpp"]["advanced"])
        self.assertTrue(by_id["comfyui"]["advanced"])

    async def test_public_mode_never_probes_or_starts_local_runtime(self):
        bridge.MODE = "public"
        with patch.object(bridge, "bridge_providers", new=AsyncMock(side_effect=AssertionError("probed"))), patch.object(bridge, "hardware_snapshot", side_effect=AssertionError("probed")):
            self.assertEqual((await self.client.get("/api/providers")).json(), {"providers": [], "mode": "public"})
            self.assertFalse((await self.client.get("/api/hardware")).json()["available"])
            self.assertFalse((await self.client.get("/api/profiles")).json()["available"])
            self.assertEqual((await self.client.post("/api/providers/ollama/start")).status_code, 404)
            self.assertEqual((await self.client.post("/api/dm/stream", json={"provider": "ollama"})).status_code, 503)

    async def test_player_browser_source_guards_all_bridge_probes(self):
        source = (ROOT / "assets/app.js").read_text()
        self.assertIn("async function probeCompanion(show=true){if(rtc.role==='player'||joinIntent)return false", source)
        player_panel = source[source.index("if(rtc.role==='player'){panel.innerHTML=", source.index("function renderAI")):]
        self.assertNotIn("/api/providers", player_panel[:player_panel.index("const rows=")])

    async def test_normal_image_list_hides_comfyui_and_shows_sd_cpp(self):
        source = (ROOT / "assets/app.js").read_text()
        self.assertIn(".filter(p=>!p.advanced)", source)
        providers_source = (ROOT / "dnd_chatgpt_server.py").read_text()
        self.assertIn('probe_http_runtime("sd_cpp"', providers_source)
        self.assertIn('"advanced": True', providers_source)

    async def test_ollama_start_explicitly_runs_only_allowlisted_serve(self):
        process = SimpleNamespace(returncode=None, pid=456)
        not_running = {"id": "ollama", "status": "not_running", "models": []}
        connected = {"id": "ollama", "status": "connected", "models": []}
        with patch.object(bridge, "probe_http_runtime", new=AsyncMock(side_effect=[not_running, connected])), patch.object(bridge.shutil, "which", return_value="/usr/bin/ollama"), patch.object(bridge.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=process)) as spawn, patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            result = await bridge.start_allowlisted_service("ollama")
        self.assertEqual(result["status"], "connected")
        self.assertTrue(result["started"])
        spawn.assert_awaited_once_with("/usr/bin/ollama", "serve", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)

    async def test_ollama_start_reports_failed_process(self):
        process = SimpleNamespace(returncode=12, pid=457)
        not_running = {"id": "ollama", "status": "not_running", "models": []}
        with patch.object(bridge, "probe_http_runtime", new=AsyncMock(return_value=not_running)), patch.object(bridge.shutil, "which", return_value="/usr/bin/ollama"), patch.object(bridge.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=process)), patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(HTTPException) as error:
                await bridge.start_allowlisted_service("ollama")
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("exited during startup", error.exception.detail)

    async def test_model_enumeration_returns_ollama_ids_and_capabilities(self):
        provider = {"id": "ollama", "status": "connected", "models": [{"id": "qwen3.5:4b", "size": 4_000_000_000, "digest": "abc", "parameters": 4_000_000_000, "capabilities": ["tools"]}]}

        class FakeClient:
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            async def get(self, url): return Response({"models": [{"name": "qwen3.5:4b", "size_vram": 3_500_000_000, "context_length": 8192}]})

        with patch.object(bridge, "probe_http_runtime", new=AsyncMock(return_value=provider)), patch.object(bridge.httpx, "AsyncClient", FakeClient):
            result = await bridge.api_models("ollama")
        self.assertEqual(result["models"][0]["slug"], "qwen3.5:4b")
        self.assertTrue(result["models"][0]["tool_capable"])
        self.assertTrue(result["models"][0]["loaded"])
        self.assertEqual(result["models"][0]["size_vram"], 3_500_000_000)

    async def test_ollama_stream_normalizes_text_and_tool_calls(self):
        chunks = [
            {"message": {"content": "The door opens. "}, "done": False},
            {"message": {"tool_calls": [{"function": {"name": "set_next_moves", "arguments": {"moves": [{"label": "Look", "action": "inspect", "description": "Check the door"}]}}}]}, "done": True, "eval_count": 50, "eval_duration": 1_000_000_000, "load_duration": 2_000_000_000},
        ]

        class StreamResponse(Response):
            async def aiter_lines(self):
                for chunk in chunks:
                    yield json.dumps(chunk)

        class StreamContext:
            async def __aenter__(self): return StreamResponse()
            async def __aexit__(self, *args): return None

        class FakeClient:
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            def stream(self, *args, **kwargs): return StreamContext()

        with patch.object(bridge.httpx, "AsyncClient", FakeClient):
            events = [item async for item in bridge.ollama_dm_events({"messages": []}, "qwen3.5:4b")]
        self.assertTrue(any("event: delta" in item and "The door opens." in item for item in events))
        self.assertTrue(any("event: tool_status" in item for item in events))
        tool = next(item for item in events if "event: tool\n" in item)
        self.assertIn('"name":"set_next_moves"', tool)
        self.assertIn('"call_id"', tool)
        self.assertIn("event: done", events[-1])

    async def test_local_dm_route_selects_ollama_without_chatgpt_auth(self):
        models = [{"id": "qwen3.5:4b", "capabilities": ["tools"]}]

        async def empty_events(*args):
            yield "event: done\ndata: {}\n\n"

        request = SimpleNamespace(json=AsyncMock(return_value={"provider": "ollama", "model": "qwen3.5:4b", "profile": "auto"}))
        with patch.object(bridge, "ollama_models", new=AsyncMock(return_value=models)), patch.object(bridge, "prepare_ollama_model", new=AsyncMock()) as prepare, patch.object(bridge, "auth_creds", new=AsyncMock(side_effect=AssertionError("cloud auth used"))), patch.object(bridge, "ollama_dm_events", side_effect=empty_events) as stream:
            response = await bridge.api_dm_stream(request)
            _ = [part async for part in response.body_iterator]
        prepare.assert_awaited_once_with("qwen3.5:4b", "low")
        self.assertEqual(stream.call_args.args[0]["context"], 4096)
        stream.assert_called_once_with({"provider": "ollama", "model": "qwen3.5:4b", "profile": "auto", "context": 4096}, "qwen3.5:4b")

    async def test_measurement_changes_auto_profile_recommendation(self):
        hardware = {"gpu": [{"vram_total_mb": 8192, "vram_free_mb": 5000}], "ram_available_bytes": 24_000_000_000, "disk_free_bytes": 100_000_000_000}
        model = {"id": "qwen3.5:4b", "parameters": 3_000_000_000, "size": 2_000_000_000, "estimated": True}
        estimate = bridge.profile_plans([model], hardware)
        measured_model = {**model, "benchmark": {"tool_reliable": True, "decode_tokens_per_second": 42.0}}
        measured = bridge.profile_plans([measured_model], hardware)
        self.assertEqual(estimate["recommended"], "medium")
        self.assertEqual(measured["recommended"], "ultra")
        self.assertEqual(measured["profiles"][-1]["measurement"], "Measured")

    async def test_preparing_model_unloads_competing_ollama_model(self):
        target = {"id": "qwen3.5:8b", "parameters": 8_000_000_000, "size": 5_000_000_000, "loaded": False, "estimated": True}
        resident = {"id": "qwen3.5:4b", "parameters": 4_000_000_000, "size": 3_000_000_000, "size_vram": 4_000_000_000, "loaded": True, "loaded_context_length": 4096, "estimated": False}
        with patch.object(bridge, "ollama_models", new=AsyncMock(side_effect=[[target, resident], [target]])), patch.object(bridge, "hardware_snapshot", return_value={"gpu": [{"vram_total_mb": 8192, "vram_free_mb": 3000}], "ram_available_bytes": 24_000_000_000}), patch.object(bridge, "unload_ollama_model", new=AsyncMock()) as unload, patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            await bridge.prepare_ollama_model("qwen3.5:8b", "high")
        unload.assert_awaited_once_with("qwen3.5:4b")

    async def test_preparing_unsafe_model_is_rejected_before_loading(self):
        oversized = {"id": "oversized:30b", "parameters": 30_000_000_000, "size": 20_000_000_000, "loaded": False, "estimated": True}
        with patch.object(bridge, "ollama_models", new=AsyncMock(return_value=[oversized])), patch.object(bridge, "hardware_snapshot", return_value={"gpu": [{"vram_total_mb": 8192, "vram_free_mb": 500}], "ram_available_bytes": 5_000_000_000}), patch.object(bridge, "unload_ollama_model", new=AsyncMock()) as unload:
            with self.assertRaises(HTTPException) as error:
                await bridge.prepare_ollama_model("oversized:30b", "ultra")
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("beyond practical free GPU and RAM", error.exception.detail)
        unload.assert_not_awaited()

    async def test_benchmark_measures_tool_reliability_speed_and_caches_result(self):
        class FakeClient:
            posts = 0
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            async def post(self, url, json):
                type(self).posts += 1
                return Response({"message": {"tool_calls": [{"function": {"name": "lantern_probe", "arguments": {"value": "lantern-ready"}}}]}, "eval_count": 24, "eval_duration": 2_000_000_000, "load_duration": 1_000_000_000, "prompt_eval_duration": 250_000_000})

        request = SimpleNamespace(json=AsyncMock(return_value={"provider": "ollama", "model": "qwen3.5:4b"}))
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge, "BENCHMARK_PATH", Path(tmp) / "benchmarks.json"), patch.object(bridge, "ollama_models", new=AsyncMock(return_value=[{"id": "qwen3.5:4b", "digest": "digest", "quantization": "Q4_K_M"}])), patch.object(bridge, "hardware_snapshot", return_value={"gpu": [{"name": "RTX", "vram_total_mb": 8192, "vram_free_mb": 4000}]}), patch.object(bridge, "probe_http_runtime", new=AsyncMock(return_value={"version": "0.6.0"})), patch.object(bridge.httpx, "AsyncClient", FakeClient):
            measured = await bridge.api_benchmark(request)
            cached = await bridge.api_benchmark(request)
        self.assertEqual(measured["tool_reliability"], "1/1")
        self.assertEqual(measured["decode_tokens_per_second"], 12.0)
        self.assertEqual(measured["measurement"], "Measured")
        self.assertTrue(cached["cached"])
        self.assertEqual(FakeClient.posts, 1)

    async def test_live_free_vram_drives_profile_fit(self):
        model = {"id": "qwen3.5:4b", "parameters": 4_000_000_000, "size": 3_000_000_000, "estimated": True}
        constrained = {"gpu": [{"vram_total_mb": 8192, "vram_free_mb": 1000}], "ram_available_bytes": 24_000_000_000, "disk_free_bytes": 100_000_000_000}
        profile = bridge.profile_plans([model], constrained)
        self.assertEqual(profile["resources"]["gpu_total_gb"], 8.0)
        self.assertLess(profile["resources"]["gpu_free_gb"], 1.1)
        self.assertEqual(profile["profiles"][1]["fit"], "cpu_offload")
        self.assertEqual(profile["profiles"][1]["measurement"], "Estimated")

    async def test_chatgpt_stream_path_still_uses_responses_with_store_false(self):
        captured = {}

        class StreamResponse(Response):
            def __init__(self, status_code=200, text=""):
                super().__init__(status_code=status_code, text=text)
                self.lines = ["data: " + json.dumps({"type": "response.completed", "response": {"usage": {"input_tokens": 2, "output_tokens": 1}, "output": []}})]
            async def aiter_lines(self):
                for line in self.lines:
                    yield line

        class StreamContext:
            def __init__(self, response): self.response=response
            async def __aenter__(self): return self.response
            async def __aexit__(self, *args): return None

        class FakeClient:
            attempts = 0
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            def stream(self, method, url, **kwargs):
                type(self).attempts += 1
                captured.update(method=method, url=url, payload=kwargs["json"])
                response = StreamResponse(status_code=520, text="<!DOCTYPE html><title>520 error</title>") if type(self).attempts == 1 else StreamResponse()
                return StreamContext(response)

        request = SimpleNamespace(json=AsyncMock(return_value={"messages": []}))
        with patch.object(bridge, "auth_creds", new=AsyncMock(return_value={"access_token": "test-token"})), patch.object(bridge, "choose_model", new=AsyncMock(return_value="gpt-test")), patch.object(bridge.httpx, "AsyncClient", FakeClient), patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            response = await bridge.api_dm_stream(request)
            parts = [part async for part in response.body_iterator]
        self.assertEqual(captured["url"], f"{bridge.RESOURCE}/responses")
        self.assertEqual(captured["payload"]["store"], False)
        self.assertEqual(captured["payload"]["stream"], True)
        self.assertEqual(FakeClient.attempts, 2)
        self.assertTrue(any('event: done' in part for part in parts))


if __name__ == "__main__":
    unittest.main()
