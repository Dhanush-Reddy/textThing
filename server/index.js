// Text Bridge relay — a stripped-down version of CodeCollab's server/socket.js.
// Keeps ONLY the room-based relay. No WebRTC, no PeerJS, no video, no drawing.
// Two machines that join the same room id (e.g. "Dh") exchange encoded text chunks
// over a plain WebSocket the server relays — works on any network that allows HTTPS/WSS.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Lock this to your Netlify origin in Render env vars, e.g.
// CORS_ORIGIN=https://your-textbridge.netlify.app
const ORIGIN = process.env.CORS_ORIGIN || "*";

const io = new Server(server, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"] },
  maxHttpBufferSize: 25e6, // 25 MB per message (supports up to 20MB transmission chunks)
});


// health/landing routes (Render pings "/" and you can eyeball it in a browser)
app.get("/", (_req, res) => res.send("Text Bridge relay is running."));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- in-memory room buffer -------------------------------------------------
// Buffer each room's chunks so a decoder who joins slightly late still catches up.
// roomId -> { chunks: Map<seq, chunk>, total, meta, updatedAt }
const rooms = new Map();
const ROOM_TTL_MS = 1000 * 60 * 30; // forget an empty room after 30 min

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { chunks: new Map(), total: null, meta: null, updatedAt: Date.now() });
  }
  return rooms.get(id);
}

function peerCount(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size || 0;
}

// ---- socket handling -------------------------------------------------------
io.on("connection", (socket) => {
  // join a room (this is the "/Dh" logic — the id is the shared channel key)
  socket.on("join", (roomId, ack) => {
    if (!roomId) return;
    socket.join(roomId);
    socket.data.roomId = roomId;

    const room = getRoom(roomId);
    // replay any transfer already in progress so late joiners aren't stuck
    if (typeof ack === "function") {
      ack({
        peers: peerCount(roomId),
        meta: room.meta,
        total: room.total,
        chunks: [], // Do not cache chunks in server memory (avoids Out of Memory crashes)
      });
    }
    socket.to(roomId).emit("peer-joined", { peers: peerCount(roomId) });
  });

  // ENCODE side announces a new transfer (filename, size, total chunk count...)
  socket.on("meta", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    room.chunks.clear();
    room.meta = payload || null;
    room.total = payload && payload.total != null ? payload.total : null;
    room.updatedAt = Date.now();
    socket.to(roomId).emit("meta", payload);
  });

  // ENCODE side streams one text chunk: { seq, total, data }
  socket.on("chunk", (chunk) => {
    const roomId = socket.data.roomId;
    if (!roomId || !chunk) return;
    const room = getRoom(roomId);
    // Do not buffer chunks in server memory to ensure constant flat RAM usage.
    room.updatedAt = Date.now();
    socket.to(roomId).emit("chunk", chunk);
  });

  // ENCODE side signals "all chunks sent"
  socket.on("done", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    getRoom(roomId).updatedAt = Date.now();
    socket.to(roomId).emit("done", payload);
  });

  // DECODE side asks for missing chunks by seq — forwarded directly
  // to the encoder in case the buffer was cleared.
  socket.on("resend", (seqs) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    // Relay the resend request directly to the sender client
    socket.to(roomId).emit("resend", seqs);
  });
  // Relay chunk acknowledgements back to the sender
  socket.on("chunk-ack", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("chunk-ack", payload);
  });



  // clear a room to start a fresh transfer
  socket.on("reset", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    rooms.set(roomId, { chunks: new Map(), total: null, meta: null, updatedAt: Date.now() });
    io.to(roomId).emit("reset");
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit("peer-left", { peers: peerCount(roomId) });
  });
});

// drop stale, empty rooms so memory doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (peerCount(id) === 0 && now - room.updatedAt > ROOM_TTL_MS) rooms.delete(id);
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Text Bridge relay listening on :" + PORT));
