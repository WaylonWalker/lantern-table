#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.50,<2"]
# ///
"""Capture a read-only Lantern Table UI and source audit into a ZIP."""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = Path(os.environ.get("UI_AUDIT_OUTPUT_DIR", ROOT / "artifacts" / "ui-audit")).expanduser().resolve()
DEFAULT_URL = "http://127.0.0.1:8765/"
PROD_URL = "https://dnd.waylonwalker.com/"
TIMEOUT_MS = int(os.environ.get("UI_AUDIT_TIMEOUT_MS", "20000"))
SENSITIVE = re.compile(r"(?i)(authorization|cookie|token|secret|password|api[_-]?key|session|credential)")
SECRET_PATTERNS = [
    re.compile(r"(?i)\b(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{30,})\b"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/-]{16,}"),
    re.compile(r"(?i)(api[_-]?key|password|secret|token)\s*[:=]\s*['\"]([A-Za-z0-9_./+=-]{16,})['\"]"),
]
SOURCE_SUFFIXES = {".py", ".html", ".css", ".js", ".mjs", ".json", ".md", ".yaml", ".yml", ".toml", ".txt", ".svg"}
EXCLUDED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".uv", ".cache", "dist", "build", "target", "artifacts"}
EXCLUDED_NAMES = {".env", ".env.local", ".env.production", "secrets.yaml", "credentials.json", "cookies.json", "playwright/.auth"}
EXTRA_EXCLUDES = {item.strip().strip("/") for item in os.environ.get("UI_AUDIT_EXCLUDE", "").split(",") if item.strip()}
MAX_SOURCE_BYTES = int(os.environ.get("UI_AUDIT_MAX_SOURCE_BYTES", "1000000"))


def safe_url(url: str) -> str:
    parts = urlsplit(url)
    query = [(key, "[REDACTED]" if SENSITIVE.search(key) or SENSITIVE.search(value) else value) for key, value in parse_qsl(parts.query, keep_blank_values=True)]
    netloc = parts.hostname or ""
    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, urlencode(query), ""))


def redact(value: str) -> str:
    for pattern in SECRET_PATTERNS:
        value = pattern.sub(lambda m: (m.group(1) if m.lastindex else "") + "[REDACTED]", value)
    return value


def health(url: str) -> bool:
    for suffix in ("health/ready", "health/live", ""):
        target = url.rstrip("/") + ("/" + suffix if suffix else "")
        try:
            with urllib.request.urlopen(target, timeout=1) as response:
                if response.status < 400:
                    return True
        except Exception:
            pass
    return False


def source_files():
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT)
        if not path.is_file() or any(part in EXCLUDED_DIRS for part in rel.parts):
            continue
        if rel.as_posix() in EXCLUDED_NAMES or path.name.startswith(".env"):
            continue
        if rel.as_posix() in EXTRA_EXCLUDES or path.name in EXTRA_EXCLUDES or any(part in EXTRA_EXCLUDES for part in rel.parts):
            continue
        if path.suffix.lower() not in SOURCE_SUFFIXES:
            continue
        if path.stat().st_size > MAX_SOURCE_BYTES:
            continue
        # Only include repository-owned application, documentation, and tests.
        if rel.parts[0] not in {"assets", "scripts", "tests", "k8s"} and len(rel.parts) > 1:
            continue
        if path.name.startswith("codex-session") or path.name.startswith("lantern-table-next-"):
            continue
        if path.suffix.lower() == ".json" and any(word in path.name.lower() for word in ("credential", "cookie", "secret", "token")):
            continue
        yield path


def write_text(base: Path, rel: str, content: str):
    path = base / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def collect_source(stage: Path, git_info: dict):
    copied = []
    for path in source_files():
        raw = path.read_bytes()
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if any(pattern.search(content) for pattern in SECRET_PATTERNS):
            raise RuntimeError(f"Secret scan stopped packaging source file: {path.relative_to(ROOT)}")
        rel = path.relative_to(ROOT).as_posix()
        target = stage / "source" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        copied.append(rel)
    write_text(stage, "source/git-status.txt", git_info["status"])
    write_text(stage, "source/git-diff-stat.txt", git_info["diff_stat"])
    return copied


def scan_staged_text(stage: Path):
    for path in stage.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".txt", ".json", ".md", ".html", ".py", ".js", ".mjs", ".css", ".yaml", ".yml", ".toml"}:
            continue
        content = path.read_text(encoding="utf-8", errors="replace")
        if any(pattern.search(content) for pattern in SECRET_PATTERNS):
            raise RuntimeError(f"Secret scan stopped packaging staged file: {path.relative_to(stage)}")


def stop_owned_process(process):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
    except KeyboardInterrupt:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
        raise


def git_data():
    def cmd(args):
        result = subprocess.run(["git", *args], cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return result.stdout.strip()
    return {"commit": cmd(["rev-parse", "HEAD"]) or "unknown", "branch": cmd(["branch", "--show-current"]), "status": cmd(["status", "--short"]), "diff_stat": cmd(["diff", "--stat"])}


def main() -> int:
    base_url = os.environ.get("UI_AUDIT_BASE_URL", DEFAULT_URL).strip()
    if not base_url.endswith("/"):
        base_url += "/"
    owned_process = None
    tempdir = tempfile.TemporaryDirectory(prefix="lantern-ui-audit-")
    stage = Path(tempdir.name) / "lantern-ui-audit"
    stage.mkdir()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    started_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    git = git_data()
    try:
        if not health(base_url):
            if os.environ.get("UI_AUDIT_BASE_URL"):
                raise RuntimeError(f"Configured server is not healthy: {safe_url(base_url)}")
            # Use the conventional port unless it is already occupied by an unhealthy server.
            parts = urlsplit(base_url)
            port = parts.port or 8765
            with socket.socket() as probe:
                port_available = probe.connect_ex((parts.hostname or "127.0.0.1", port)) != 0
            if not port_available:
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    port = probe.getsockname()[1]
                base_url = f"http://127.0.0.1:{port}/"
            launch_env = os.environ.copy()
            launch_env["LANTERN_PORT"] = str(port)
            owned_process = subprocess.Popen(["just", "serve"], cwd=ROOT, env=launch_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline and owned_process.poll() is None and not health(base_url):
                time.sleep(1)
            if not health(base_url):
                raise RuntimeError("Local app did not become healthy at http://127.0.0.1:8765/ within 90 seconds")

        from playwright.sync_api import sync_playwright
        journey_results, console_records, network_records = [], [], []
        browser_version = "unknown"
        with sync_playwright() as p:
            system_chromium = next((shutil.which(name) for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable") if shutil.which(name)), None)
            browser_executable = system_chromium or p.chromium.executable_path
            if not Path(browser_executable).exists():
                print("Installing Playwright Chromium for the audit...", file=sys.stderr)
                subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, timeout=600)
                browser_executable = p.chromium.executable_path
            browser = p.chromium.launch(headless=True, executable_path=browser_executable)
            browser_version = browser.version
            for viewport_name, width, height in (("desktop", 1440, 900), ("mobile", 390, 844)):
                context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1, is_mobile=width < 600, has_touch=width < 600)
                page = context.new_page()
                page.set_default_timeout(TIMEOUT_MS)
                page.on("console", lambda msg, vp=viewport_name: console_records.append({"viewport": vp, "type": msg.type, "text": redact(msg.text)}) if msg.type == "error" else None)
                page.on("pageerror", lambda err, vp=viewport_name: console_records.append({"viewport": vp, "type": "pageerror", "text": redact(str(err))}))
                page.on("requestfailed", lambda req, vp=viewport_name: network_records.append({"viewport": vp, "url": safe_url(req.url), "method": req.method, "failure": redact(req.failure or "unknown")}))
                try:
                    response = page.goto(base_url, wait_until="domcontentloaded", timeout=TIMEOUT_MS)
                    page.wait_for_selector("#appShell", state="attached", timeout=TIMEOUT_MS)
                    page.wait_for_function("!document.documentElement.classList.contains('booting')", timeout=TIMEOUT_MS)
                    page.wait_for_timeout(300)
                    initial = {"viewport": viewport_name, "width": width, "height": height, "status": "passed", "screens": []}
                    # Capture the real first-run wizard. It has no close control; dismissing
                    # the overlay in this isolated DOM lets us inspect existing views without
                    # clicking Open the table (which would mutate campaign state).
                    page.screenshot(path=str(stage / "screenshots" / viewport_name / "00-campaign-setup.png"), full_page=True)
                    initial["screens"].append({"journey": "campaign-setup", "route": page.url, "title": "First-run campaign setup wizard", "interaction": "Observed the first-run modal; did not press Open the table.", "screenshot": f"screenshots/{viewport_name}/00-campaign-setup.png"})
                    write_text(stage, f"browser/dom/{viewport_name}/00-campaign-setup.txt", page.locator("body").aria_snapshot())
                    page.locator("#wizard").evaluate("element => element.classList.add('hidden')")
                    nav_character = page.locator('.mobile-nav [data-view="character"]' if width < 600 else '.nav-list [data-view="character"]')
                    nav_character.click()
                    page.wait_for_selector("#characterForm", state="visible", timeout=TIMEOUT_MS)
                    page.wait_for_timeout(300)
                    page.screenshot(path=str(stage / "screenshots" / viewport_name / "01-character-sheet.png"), full_page=True)
                    initial["screens"].append({"journey": "character-sheet", "route": page.url, "title": "Player character sheet", "interaction": "Dismissed the first-run overlay in the isolated DOM, then used the Character navigation button.", "screenshot": f"screenshots/{viewport_name}/01-character-sheet.png"})
                    write_text(stage, f"browser/dom/{viewport_name}/01-character-sheet.txt", page.locator("body").aria_snapshot())
                    nav_people = page.locator('.mobile-nav [data-view="characters"]' if width < 600 else '.nav-list [data-view="characters"]')
                    if width < 600:
                        page.locator("#wizard").evaluate("element => element.classList.add('hidden')")
                        nav_people.evaluate("element => element.click()")
                    else:
                        nav_people.click()
                    page.wait_for_selector("#entityDirectory", state="visible", timeout=TIMEOUT_MS)
                    page.wait_for_timeout(250)
                    page.screenshot(path=str(stage / "screenshots" / viewport_name / "02-character-directory.png"), full_page=True)
                    initial["screens"].append({"journey": "character-directory", "route": page.url, "title": "People and character directory", "interaction": "Used the People navigation button; no records were edited.", "screenshot": f"screenshots/{viewport_name}/02-character-directory.png"})
                    write_text(stage, f"browser/dom/{viewport_name}/02-character-directory.txt", page.locator("body").aria_snapshot())
                    journey_results.append(initial)
                except Exception as exc:
                    journey_results.append({"viewport": viewport_name, "width": width, "height": height, "status": "failed", "reason": redact(f"{type(exc).__name__}: {exc}")})
                    try:
                        page.screenshot(path=str(stage / "screenshots" / viewport_name / "failure.png"), full_page=True)
                    except Exception:
                        pass
                finally:
                    context.close()
            browser.close()

        journeys = {"tested_url": safe_url(base_url), "browser": f"Chromium {browser_version}", "timestamp_utc": started_at, "authentication": "No sign-in required; fresh isolated browser context; no credentials or existing profile imported.", "journeys": journey_results}
        write_text(stage, "browser/journeys.json", json.dumps(journeys, indent=2) + "\n")
        write_text(stage, "browser/console.json", json.dumps(console_records, indent=2) + "\n")
        write_text(stage, "browser/network-errors.json", json.dumps(network_records, indent=2) + "\n")

        architecture = {
            "overview.md": "# Architecture overview\n\nLantern Table is a static HTML/CSS/JavaScript client served by FastAPI in `dnd_chatgpt_server.py`. The browser owns campaign and character state in localStorage/IndexedDB. The UI has no server-side account requirement for the local single-player experience.\n\nPrimary UI entry: `dnd_localfirst_demo.html`; behavior and state: `assets/app.js`; styling and tokens: `assets/app.css`; rules/session modules: `assets/*.mjs`.\n",
            "routes.md": "# Screens and routes\n\nThe app is a single-page interface. Navigation uses `data-view` buttons and `showView()` in `assets/app.js`; campaign/session deep links use URL fragments. There are no separate server routes for character screens. The audit records the actual base URL plus visible screen journey names in `browser/journeys.json`.\n\nCharacter-facing views: Character (owned sheet), People (entity directory), Campaign/Play (party context and campaign wizard).\n",
            "character-model.md": "# Character model\n\nCharacter state is initialized and normalized in `assets/app.js` (`CHARACTER_DEFAULTS`, `createRandomCharacter`, and `normalizeCharacter`). Campaign snapshots and the character index are stored in browser localStorage; portraits/drawings use IndexedDB. Sheet fields include identity, species/class/background, abilities and saves, skills, combat resources, inventory, features, spells, conditions, homebrew, notes, and voice preferences. The entity directory uses the campaign `entities` collection, with player characters linked by `entityId`.\n\nThe current app does not expose a dedicated standalone character builder or level-up wizard. A new campaign gets a generated character draft; the character sheet is then edited in place. These absences are documented in findings.\n",
        }
        for name, content in architecture.items():
            write_text(stage, f"architecture/{name}", content)
        limitations = "# Limitations and unavailable journeys\n\n- No dedicated character selection/list for multiple owned PCs was found. The People view is an entity directory, while the Character view edits the current local player's character.\n- No standalone character creation flow, race/class/background picker, or level-up flow exists in the current UI. Campaign setup creates a generated character; identity and mechanics are edited on the sheet.\n- The sheet has no explicit validation error dialog/state to trigger with safe synthetic input. No destructive reset/import action was used.\n- Multiplayer approval dialogs, host/player roles, and authenticated sessions require a second participant or existing session and were not attempted. The audit uses a fresh local browser context and never imports browser credentials.\n- Production audit is read-only: it navigates existing views and does not submit forms or mutate campaign data.\n"
        write_text(stage, "findings/limitations.md", limitations)
        copied = collect_source(stage, git)
        manifest = {"repository": "https://github.com/WaylonWalker/lantern-table", "commit": git["commit"], "branch": git["branch"], "dirty_worktree": bool(git["status"]), "git_status": git["status"], "tested_url": safe_url(base_url), "timestamp_utc": started_at, "browser": f"Chromium {browser_version}", "viewports": [{"name": n, "width": w, "height": h} for n, w, h in (("desktop", 1440, 900), ("mobile", 390, 844))], "source_files": copied, "exclusions": sorted(EXCLUDED_DIRS | EXCLUDED_NAMES | EXTRA_EXCLUDES), "source_size_limit_bytes": MAX_SOURCE_BYTES, "secret_scan": "All staged text scanned for common API tokens, bearer credentials, and literal credential assignments; no detected secret included", "authentication": "No authentication used; fresh isolated context", "production_read_only": base_url.startswith(PROD_URL), "journey_status": {item["viewport"]: item["status"] for item in journey_results}}
        write_text(stage, "manifest.json", json.dumps(manifest, indent=2) + "\n")
        readme = f"""# Lantern Table UI audit\n\nThis bundle captures the existing character experience for architecture and UX review. It was generated at {started_at} from `{safe_url(base_url)}` at commit `{git['commit']}`.\n\n## Start here\n\n1. Read `architecture/overview.md`, `architecture/routes.md`, and `architecture/character-model.md`.\n2. Open `browser/journeys.json` for status, viewport, route, and deterministic screenshot mapping.\n3. Review `screenshots/desktop/` and `screenshots/mobile/`.\n4. Inspect `source/dnd_localfirst_demo.html`, `source/assets/app.js`, and `source/assets/app.css` for character UI implementation.\n5. Read `findings/limitations.md` for flows that do not exist or were intentionally not exercised.\n\n## Screenshots\n\n- `00-campaign-setup.png`: first-run wizard; it blocks access to the app until opened.\n- `01-character-sheet.png`: current player character overview and complete editable sheet (abilities, skills, inventory, features, spells, conditions, notes).\n- `02-character-directory.png`: People/entity directory for player characters and NPCs.\n\nAfter capturing the wizard, the audit dismisses it in the isolated page DOM because there is no close control and opening the table would mutate local campaign state. It then uses visible application navigation. The browser uses an isolated profile with synthetic local state. No user database or saved browser session is read. Production mode performs navigation only. Console exceptions and failed network requests are in `browser/`; URLs and common credential patterns are redacted.\n"""
        write_text(stage, "README.md", readme)
        scan_staged_text(stage)
        stamp = started_at.replace(":", "").replace("-", "").replace("+00:00", "Z")
        zip_path = OUT_DIR / f"lantern-ui-audit-{git['commit'][:12]}-{stamp}.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=8) as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    archive.write(path, Path("lantern-ui-audit") / path.relative_to(stage))
        with zipfile.ZipFile(zip_path) as archive:
            bad = archive.testzip()
            if bad:
                raise RuntimeError(f"ZIP integrity check failed at {bad}")
        print(zip_path)
        return 0 if all(item["status"] == "passed" for item in journey_results) else 1
    except Exception as exc:
        print(f"ui-audit failed: {redact(f'{type(exc).__name__}: {exc}')}", file=sys.stderr)
        return 1
    finally:
        stop_owned_process(owned_process)
        tempdir.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
