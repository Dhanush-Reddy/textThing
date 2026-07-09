// bridge.js — drop this into your Netlify Text Bridge frontend.
//
// Load the Socket.IO client first (once, in your HTML <head>):
//   <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
//
// Then in your app:
//   import { connectBridge } from "./bridge.js";   // or paste the function inline
//
// The room id is your "/Dh" — read it however you already do (path or ?room=).

const RELAY_URL = window.RELAY_URL || 
                  localStorage.getItem("RELAY_URL") || 
                  "https://textthing.onrender.com"; // your Render URL



export function connectBridge(roomId, handlers = {}) {
  // Safely resolve socket.io client global to prevent ReferenceErrors
  const ioClient = (typeof window !== "undefined" && window.io) || (typeof io !== "undefined" ? io : null);
  if (!ioClient) {
    console.error("Socket.IO client library is not loaded. Ensure the local socket.io.min.js or CDN script is running.");
    return {
      socket: null,
      startTransfer: () => {},
      sendChunk: () => {},
      finish: () => {},
      reset: () => {},
      requestResend: () => {},
      disconnect: () => {}
    };
  }
  const socket = ioClient(RELAY_URL, { transports: ["websocket"] });


  socket.on("connect", () => {
    socket.emit("join", roomId, (state) => {
      handlers.onJoined && handlers.onJoined(state);
      if (state && state.meta) handlers.onMeta && handlers.onMeta(state.meta);
      (state && state.chunks ? state.chunks : []).forEach(
        (c) => handlers.onChunk && handlers.onChunk(c)
      );
    });
  });

  socket.on("meta", (m) => handlers.onMeta && handlers.onMeta(m));
  socket.on("chunk", (c) => handlers.onChunk && handlers.onChunk(c));
  socket.on("done", (d) => handlers.onDone && handlers.onDone(d));
  socket.on("reset", () => handlers.onReset && handlers.onReset());
  socket.on("resend", (seqs) => handlers.onResend && handlers.onResend(seqs));
  socket.on("peer-joined", (p) => handlers.onPeers && handlers.onPeers(p.peers));
  socket.on("peer-left", (p) => handlers.onPeers && handlers.onPeers(p.peers));
  socket.on("chunk-ack", (p) => handlers.onChunkAck && handlers.onChunkAck(p));


  return {
    socket,
    // ---- ENCODE tab ----
    startTransfer: (meta) => socket.emit("meta", meta),
    sendChunk: (chunk) => socket.emit("chunk", chunk),
    finish: (payload) => socket.emit("done", payload),
    reset: () => socket.emit("reset"),
    // ---- DECODE tab ----
    requestResend: (seqs) => socket.emit("resend", seqs),
    disconnect: () => socket.disconnect(),
  };
}

// ===========================================================================
// EXAMPLE — ENCODE tab: split your already-encoded text and stream it.
// ===========================================================================
//
// const bridge = connectBridge(roomId, {
//   onPeers: (n) => setStatus(n + " device(s) in room " + roomId),
// });
//
// async function shareEncodedText(encodedText, meta) {
//   const CHUNK = 32 * 1024;                      // 32 KB of text per chunk
//   const total = Math.ceil(encodedText.length / CHUNK);
//   bridge.startTransfer({ ...meta, total, length: encodedText.length });
//   for (let seq = 0; seq < total; seq++) {
//     bridge.sendChunk({ seq, total, data: encodedText.slice(seq * CHUNK, (seq + 1) * CHUNK) });
//     await new Promise((r) => setTimeout(r, 5));  // gentle pacing ("slow transfer")
//   }
//   bridge.finish({ total });
// }
//
// ===========================================================================
// EXAMPLE — DECODE tab: collect chunks, verify none missing, then download.
// ===========================================================================
//
// const received = new Map();
// let meta = null;
//
// const bridge = connectBridge(roomId, {
//   onMeta:  (m) => { meta = m; received.clear(); },
//   onChunk: (c) => { received.set(c.seq, c.data); setProgress(received.size, c.total); },
//   onDone:  ({ total }) => {
//     const missing = [];
//     for (let i = 0; i < total; i++) if (!received.has(i)) missing.push(i);
//     if (missing.length) { bridge.requestResend(missing); return; }   // fill gaps, no data loss
//     const encodedText = Array.from({ length: total }, (_, i) => received.get(i)).join("");
//     const fileBytes = yourDecodeFunction(encodedText);               // your existing decode
//     triggerDownload(fileBytes, meta.fileName, meta.mime);
//   },
//   onReset: () => received.clear(),
// });
