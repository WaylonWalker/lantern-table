set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set dotenv-load := true

registry := env_var_or_default("REGISTRY", "registry.wayl.one")
image_name := env_var_or_default("IMAGE_NAME", "lantern-table")
tag := env_var_or_default("TAG", `git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S`)
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
    LANTERN_MODE=companion ./dnd_chatgpt_server.py

# Build the public signaling/UI image.
build:
    {{engine}} build --pull -t {{image}} .

push:
    {{engine}} push {{image}}

publish: build push

# Apply manifests directly. Prefer Argo after initial testing.
apply:
    kubectl apply -k k8s

# Direct iteration path: publish, apply, and put this tag on the Deployment.
deploy: publish apply
    kubectl -n {{namespace}} set image deployment/{{app}} app={{image}}
    kubectl -n {{namespace}} rollout status deployment/{{app}} --timeout=240s

# Useful only when intentionally testing :latest.
deploy-latest:
    TAG=latest just publish
    kubectl apply -k k8s
    kubectl -n {{namespace}} rollout restart deployment/{{app}}
    kubectl -n {{namespace}} rollout status deployment/{{app}} --timeout=240s

# Create/update optional Cloudflare TURN credentials without writing them to Git.
turn-secret:
    kubectl apply -f k8s/namespace.yaml >/dev/null
    test -n "${CLOUDFLARE_TURN_KEY_ID:-}" || (echo "CLOUDFLARE_TURN_KEY_ID is required" >&2; exit 2)
    test -n "${CLOUDFLARE_TURN_API_TOKEN:-}" || (echo "CLOUDFLARE_TURN_API_TOKEN is required" >&2; exit 2)
    kubectl -n {{namespace}} create secret generic lantern-table-turn \
      --from-literal=CLOUDFLARE_TURN_KEY_ID="$CLOUDFLARE_TURN_KEY_ID" \
      --from-literal=CLOUDFLARE_TURN_API_TOKEN="$CLOUDFLARE_TURN_API_TOKEN" \
      --dry-run=client -o yaml | kubectl apply -f -

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
    if command -v node >/dev/null; then node --check assets/app.js; fi
    if command -v kubectl >/dev/null; then kubectl kustomize k8s >/dev/null; fi
    @echo "Lantern Table validation passed"

delete:
    kubectl delete -k k8s --ignore-not-found
