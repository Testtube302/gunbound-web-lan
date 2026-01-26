# Gunbound-like (Web) — LAN-only

This is the restarted project: **mobile browser clients**, **LAN-only**, hosted on your **Mac**.

## Why binding 0.0.0.0 is correct on macOS
- `0.0.0.0` means: listen on **all network interfaces** (Wi‑Fi, Ethernet).
- This is the standard way to make a local server reachable by phones on the same LAN.
- The server is still LAN-only because:
  - it’s only reachable on your private network IP,
  - and macOS firewall controls inbound access.

## Run
```bash
cd /Users/ryancallicoat/clawd/gunbound-web-lan
npm install
npm run dev
```

The terminal will print LAN URLs like:
`http://192.168.x.y:8787/`

Open that URL on each phone (same Wi‑Fi).

## Firewall note
The first time, macOS may prompt: “Do you want to allow incoming connections for node?”
Choose **Allow**.

## Next
MVP1 adds: ready-up, turn state machine, wind, projectiles, and hit detection.
