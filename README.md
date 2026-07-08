# Text Bridge Relay

A minimal Socket.IO relay so two machines that open the **same room id** (your `/Dh`)
can pass encoded text between the **Encode** and **Decode** tabs — over plain WebSocket
(WSS), with **no WebRTC**. Works on networks that block P2P/TURN.

This is CodeCollab's `server/socket.js` idea stripped down to just the room relay:
no video, no PeerJS, no drawing, no code editor.

## What's here
- `server/index.js` — the relay (Express + Socket.IO).
- `client/bridge.js` — drop-in module for your Netlify frontend (+ encode/decode examples).
- `render.yaml` — optional Render blueprint.

## How the transfer works
1. Both machines join room `Dh` → `socket.emit("join", "Dh")`.
2. Encode tab: encode file → text, split into 32 KB chunks, send `meta` then each `chunk`, then `done`.
3. Server relays every message to the other machine in room `Dh` (and buffers chunks so a late joiner catches up).
4. Decode tab: collect chunks by `seq`, on `done` check for gaps (`resend` if any), reassemble, decode, download.

Nothing is lost: it's a reliable relay (not lossy UDP), and the `seq`/`total`/`resend` check guarantees completeness.

## Deploy to Render (free)
1. Push this folder to a GitHub repo.
2. Render dashboard → **New → Web Service** → connect the repo.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
   - Health check path: `/healthz`
4. Add env var `CORS_ORIGIN` = your Netlify URL (e.g. `https://your-textbridge.netlify.app`).
   Leave as `*` while testing.
5. Deploy. You get a URL like `https://textbridge-relay.onrender.com`.
6. Put that URL in `client/bridge.js` → `RELAY_URL`, and add the CDN script tag to your HTML:
   `<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>`

### Free-tier note
The free Render instance **sleeps after ~15 min idle**; the first connection then takes
~50s to wake. Fine for interviews/transfers. Keep it to **one instance** (the room buffer
is in memory — multiple instances wouldn't share state without Redis).

## Run locally
```bash
npm install
npm start        # http://localhost:3000  (set RELAY_URL to this in bridge.js to test)
```
