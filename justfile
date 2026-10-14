set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set dotenv-load := true

registry := env_var_or_default("REGISTRY", "registry.wayl.one")
image_name := env_var_or_default("IMAGE_NAME", "lantern-table")
commit := `git rev-parse --short HEAD 2>/dev/null || echo local`
timestamp := `date +%Y%m%d%H%M%S`
tag := env_var_or_default("TAG", commit + "-" + timestamp)
image := registry + "/" + image_name + ":" + tag
engine := env_var_or_default("CONTAINER_ENGINE", "podman")
namespace := env_var_or_default("NAMESPACE", "lantern-table")
app := "lantern-table"

# Show recipes.
default:
    @just --list

image:
    @echo "{{image}}"

# Run the host-side OAuth/AI companion locally.
companion:
    #!/usr/bin/env bash
    set -euo pipefail
    mise install
    mise exec -- env LANTERN_MODE=companion ./dnd_chatgpt_server.py

# Run a hot-reloading, single-player local app with the companion enabled.
serve:
    LANTERN_MODE=companion LANTERN_RELOAD=1 ./dnd_chatgpt_server.py

# Build the public signaling/UI image.
build:
    {{engine}} build --pull -t {{image}} .

push:
    {{engine}} push {{image}}

publish: build push

# Apply manifests directly. Prefer Argo after initial testing.
apply:
    kubectl apply -k k8s

# Full direct deploy: validate, publish a unique tag, apply, roll out, and smoke-test.
deploy: validate publish apply
    kubectl -n {{namespace}} set image deployment/{{app}} app={{image}}
    kubectl -n {{namespace}} rollout status deployment/{{app}} --timeout=240s
    just doctor

# Useful only when intentionally testing :latest.
deploy-latest:
    TAG=latest just publish
    kubectl apply -k k8s
    kubectl -n {{namespace}} rollout restart deployment/{{app}}
    kubectl -n {{namespace}} rollout status deployment/{{app}} --timeout=240s

# Create/update optional Cloudflare TURN credentials without writing them to Git.
turn-secret:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -z "${CLOUDFLARE_TURN_KEY_ID:-}" || -z "${CLOUDFLARE_TURN_API_TOKEN:-}" ]]; then
      cat <<'EOF'
    Cloudflare TURN setup:
      1. Open https://dash.cloudflare.com/ and select your account.
      2. Open Realtime -> TURN and create a TURN key.
      3. Copy the TURN Key ID and its generated key token.
         The token is shown only when the key is created. Keep it private.
      Docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/

    Press Enter when you have the Key ID and token ready to paste.
    EOF
      read -r -p "Ready? Press Enter to continue: " _
      if [[ -z "${CLOUDFLARE_TURN_KEY_ID:-}" ]]; then
        read -r -p "Paste TURN Key ID: " CLOUDFLARE_TURN_KEY_ID
      fi
      if [[ -z "${CLOUDFLARE_TURN_API_TOKEN:-}" ]]; then
        read -r -s -p "Paste TURN key token (hidden): " CLOUDFLARE_TURN_API_TOKEN
        printf '\n'
      fi
    fi
    test -n "${CLOUDFLARE_TURN_KEY_ID:-}" || { echo "TURN Key ID is required" >&2; exit 2; }
    test -n "${CLOUDFLARE_TURN_API_TOKEN:-}" || { echo "TURN key token is required" >&2; exit 2; }
    kubectl apply -f k8s/namespace.yaml >/dev/null
    kubectl -n {{namespace}} create secret generic lantern-table-turn \
      --from-literal=CLOUDFLARE_TURN_KEY_ID="$CLOUDFLARE_TURN_KEY_ID" \
      --from-literal=CLOUDFLARE_TURN_API_TOKEN="$CLOUDFLARE_TURN_API_TOKEN" \
      --dry-run=client -o yaml | kubectl apply -f -
    kubectl -n {{namespace}} rollout restart deployment/{{app}}
    kubectl -n {{namespace}} rollout status deployment/{{app}} --timeout=240s
    just doctor

render:
    kubectl kustomize k8s

rollout:
    kubectl -n {{namespace}} rollout status deployment/{{app}} --timeout=240s

restart:
    kubectl -n {{namespace}} rollout restart deployment/{{app}}
    just rollout

status:
    kubectl -n {{namespace}} get deploy,po,svc,ingress,pdb -o wide

logs:
    kubectl -n {{namespace}} logs deployment/{{app}} -f --tail=200

logs-valkey:
    kubectl -n {{namespace}} logs deployment/lantern-valkey -f --tail=100

validate:
    python -m py_compile dnd_chatgpt_server.py
    uv run --script tests/test_bridge_runtime.py
    python -m py_compile scripts/check_websocket.py scripts/wss_multiplayer_smoke.py
    if command -v node >/dev/null; then node --check assets/app.js && node --check scripts/webrtc_smoke.mjs && node --check assets/rules5e.mjs && node --check assets/campaign-scenes.mjs && node --check assets/audio-core.mjs && node --check assets/audio-service.mjs && node --test tests/*.test.mjs; fi
    if command -v kubectl >/dev/null; then kubectl kustomize k8s >/dev/null; fi
    @echo "Lantern Table validation passed"

delete:
    kubectl delete -k k8s --ignore-not-found

# Production smoke test after a rollout.
doctor:
    @echo "== Kubernetes =="
    kubectl -n {{namespace}} get deploy,po,svc,ingress,pdb -o wide
    @echo "== Valkey =="
    kubectl -n {{namespace}} exec deployment/lantern-valkey -- valkey-cli ping
    @echo "== Public health =="
    curl -fsS https://dnd.waylonwalker.com/health/live; echo
    curl -fsS https://dnd.waylonwalker.com/health/ready; echo
    @echo "== WebSocket signaling upgrade =="
    python scripts/check_websocket.py "${LANTERN_PUBLIC_URL:-https://dnd.waylonwalker.com}"
    @echo "== Host-authoritative WSS gameplay protocol =="
    python scripts/wss_multiplayer_smoke.py "${LANTERN_PUBLIC_URL:-https://dnd.waylonwalker.com}"
    @echo "== Runtime config =="
    curl -fsS https://dnd.waylonwalker.com/api/config; echo
    @echo "Lantern Table doctor passed"

# Host-only semantic audio events and shared loop-state resync smoke test.
audio-protocol-smoke:
    python scripts/audio_protocol_smoke.py "${LANTERN_PUBLIC_URL:-https://dnd.waylonwalker.com}"

# Optional experimental WebRTC peer transport smoke test.
smoke-webrtc:
    node scripts/webrtc_smoke.mjs

# Public host/player WebSocket gameplay protocol, including cross-pod routing.
smoke-multiplayer:
    python scripts/wss_multiplayer_smoke.py "${LANTERN_PUBLIC_URL:-https://dnd.waylonwalker.com}"

# Capture the local character experience and relevant source into a review ZIP.
ui-audit:
    uv run --script scripts/ui_audit.py

# Capture the public app without submitting changes or creating user data.
ui-audit-prod:
    UI_AUDIT_BASE_URL=https://dnd.waylonwalker.com/ uv run --script scripts/ui_audit.py

# Run repeatable synthetic TTS benchmarks and write local-only results to artifacts/tts-audit.
tts-audit:
    python scripts/tts_audit.py
    uv run --quiet --with kittenml --python 3.12 scripts/tts_audit_models.py
    if [[ -n "${LANTERN_KITTEN_CPP_BIN:-}" ]]; then python scripts/tts_audit_cpp.py; fi

# Compare the two latest audit manifests and journey outcomes.
ui-audit-compare:
    uv run --script scripts/ui_audit_compare.py
