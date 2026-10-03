# Lantern Table Kubernetes deployment

This directory is tuned for the current WaylonWalker homelab conventions.

- namespace: `lantern-table`
- image: `registry.wayl.one/lantern-table:latest` (pin a release/Git SHA in Argo)
- existing image pull secret: `cluster-regcred`
- ingress class: `traefik`
- cert-manager issuer: `letsencrypt-dns`
- hostname: `dnd.waylonwalker.com`
- app replicas: 2
- signaling bus: ephemeral Valkey, persistence disabled

The service stores no campaign data. Valkey carries only temporary signaling presence/pubsub.

## Argo rollout behavior

The app Deployment uses a rolling strategy with `maxUnavailable: 0` and `maxSurge: 1`. Before termination, a pod marks itself draining so readiness fails and connected signaling browsers reconnect. Active WebRTC DataChannels continue independently of the signaling pod.

The old and new pod may overlap safely because room signaling routes through Valkey. Connection markers prevent an old pod from deleting a host presence key after that same browser has already reconnected to a new pod.

## TURN

Cloudflare STUN is always returned. TURN is optional and is only needed when peers cannot establish a direct path.

Do not commit `turn-secret.example.yaml` with real credentials. Prefer:

```bash
CLOUDFLARE_TURN_KEY_ID=... \
CLOUDFLARE_TURN_API_TOKEN=... \
just turn-secret
```

## GitOps

`just deploy` is for direct testing. Once this directory is copied into `homelab-argo`, publish the image, pin the tag in Git, and let Argo synchronize instead of mutating the Deployment imperatively.
