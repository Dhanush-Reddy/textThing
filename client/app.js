import { connectBridge } from "./bridge.js";

// ---- Room Configuration & Setup --------------------------------------------
let roomId = window.location.pathname.substring(1);
if (!roomId || roomId === "index.html") {
  // Generate random room id if none in path
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  roomId = Array.from({ length: 5 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
  window.history.replaceState(null, "", "/" + roomId);
}

// Update UI room labels
document.getElementById("room-banner-title").textContent = `Room ID: ${roomId}`;
document.getElementById("room-placeholder").textContent = roomId;

// Copy link logic
const shareBtn = document.getElementById("share-room-btn");
shareBtn.addEventListener("click", () => {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    const toast = document.getElementById("toast");
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2500);
  });
});

// ---- Tab Navigation --------------------------------------------------------
const tabButtons = document.querySelectorAll(".tab-btn");
const panels = document.querySelectorAll(".panel");

tabButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    tabButtons.forEach(b => b.classList.remove("active"));
    panels.forEach(p => p.classList.remove("active"));

    btn.classList.add("active");
    const targetPanel = document.getElementById(btn.dataset.tab);
    targetPanel.classList.add("active");
  });
});

// ---- Relay Server Config Configuration ------------------------------------
const configBtn = document.getElementById("config-btn");
const configPanel = document.getElementById("config-panel");
const relayUrlInput = document.getElementById("relay-url-input");
const saveConfigBtn = document.getElementById("save-config-btn");

// Load current configuration
relayUrlInput.value = localStorage.getItem("RELAY_URL") || "";

configBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  configPanel.style.display = configPanel.style.display === "block" ? "none" : "block";
});

document.addEventListener("click", (e) => {
  if (!configPanel.contains(e.target) && e.target !== configBtn) {
    configPanel.style.display = "none";
  }
});

saveConfigBtn.addEventListener("click", () => {
  const val = relayUrlInput.value.trim();
  if (val) {
    localStorage.setItem("RELAY_URL", val);
  } else {
    localStorage.removeItem("RELAY_URL");
  }
  configPanel.style.display = "none";
  showToast("Config saved! Reconnecting...");
  setTimeout(() => window.location.reload(), 800);
});

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// ---- File Size Formatter ----------------------------------------------------
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// ---- Global State variables -------------------------------------------------
let activeFile = null;
let isSending = false;

// Receiver State
const receivedChunks = new Map();
let incomingMeta = null;
let downloadBlobUrl = null;

const CHUNK_SIZE = 1024 * 1024; // Stable 1 MB binary chunks

// Helper function to read a slice of a file as a raw ArrayBuffer
function readSliceAsArrayBuffer(file, start, end) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file.slice(start, end));
  });
}

// ---- Initialize Socket.IO Bridge -------------------------------------------
const handlers = {
  onJoined: (state) => {
    updatePeerBadge(state?.peers || 1);
    
    // Check if there is an active transfer in the room already
    if (state && state.meta) {
      handleIncomingMeta(state.meta);
      if (state.chunks && state.chunks.length > 0) {
        state.chunks.forEach(chunk => handleIncomingChunk(chunk));
        checkCompleteness();
      }
    }
  },
  onMeta: (meta) => {
    handleIncomingMeta(meta);
  },
  onChunk: (chunk) => {
    handleIncomingChunk(chunk);
  },
  onDone: (payload) => {
    checkCompleteness(payload.total);
  },
  onReset: () => {
    resetReceiver();
    resetSender();
  },
  onResend: async (seqs) => {
    // Peer requested missing chunks — read dynamically from disk and stream them
    if (activeFile && isSending) {
      console.log("Resending chunks requested by peer:", seqs);
      const total = Math.ceil(activeFile.size / CHUNK_SIZE);
      
      for (const seq of seqs) {
        const start = seq * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, activeFile.size);
        try {
          const data = await readSliceAsArrayBuffer(activeFile, start, end);
          bridge.sendChunk({ seq, total, data });
        } catch (e) {
          console.error("Failed to resend chunk:", seq, e);
        }
      }
    }
  },
  onPeers: (peersCount) => {
    updatePeerBadge(peersCount);
  }
};

const bridge = connectBridge(roomId, handlers);

// Update status badges
function updatePeerBadge(count) {
  const badge = document.getElementById("room-badge");
  const text = document.getElementById("room-status-text");
  
  if (count > 1) {
    badge.classList.remove("disconnected");
    text.textContent = `${count} Devices Connected`;
  } else {
    badge.classList.add("disconnected");
    text.textContent = "Waiting for peer...";
  }
}

// ---- ENCODER (Sender) logic -------------------------------------------------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileCard = document.getElementById("file-card");
const fileNameLabel = document.getElementById("file-name");
const fileSizeLabel = document.getElementById("file-size");
const removeFileBtn = document.getElementById("remove-file-btn");

const sendBtn = document.getElementById("send-btn");
const sendStatusBox = document.getElementById("send-status-box");
const sendProgressPct = document.getElementById("send-progress-pct");
const sendProgressBar = document.getElementById("send-progress-bar");
const sendProgressLabel = document.getElementById("send-progress-label");
const sendStatChunks = document.getElementById("send-stat-chunks");
const sendStatSpeed = document.getElementById("send-stat-speed");
const sendStatState = document.getElementById("send-stat-state");

// Trigger file input
dropzone.addEventListener("click", () => fileInput.click());

// Drag & Drop
["dragenter", "dragover"].forEach(eventName => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  }, false);
});

["dragleave", "drop"].forEach(eventName => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  }, false);
});

dropzone.addEventListener("drop", (e) => {
  const dt = e.dataTransfer;
  const files = dt.files;
  if (files.length) handleFileSelect(files[0]);
});

fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFileSelect(e.target.files[0]);
});

function handleFileSelect(file) {
  activeFile = file;
  fileNameLabel.textContent = file.name;
  fileSizeLabel.textContent = `${formatBytes(file.size)} • ${file.type || 'unknown type'}`;
  
  // Show file card, hide dropzone
  dropzone.style.display = "none";
  fileCard.style.display = "flex";
  
  // Prepare encoding dynamically (no upfront file load into RAM)
  sendBtn.disabled = false;
  sendBtn.textContent = "Start Stream Transfer";
  sendStatState.textContent = "Ready";
  sendStatState.style.color = "var(--accent-emerald)";
}

removeFileBtn.addEventListener("click", () => {
  resetSender();
  bridge.reset(); // Alert receiver to reset
});

function resetSender() {
  activeFile = null;
  isSending = false;
  
  dropzone.style.display = "flex";
  fileCard.style.display = "none";
  sendStatusBox.style.display = "none";
  
  sendBtn.disabled = true;
  sendBtn.textContent = "Start Stream Transfer";
  sendBtn.classList.remove("success");
  
  fileInput.value = "";
}

// Transfer execution
sendBtn.addEventListener("click", async () => {
  if (!activeFile || isSending) return;
  
  isSending = true;
  sendBtn.disabled = true;
  sendStatusBox.style.display = "block";
  sendStatState.textContent = "Streaming";
  sendStatState.style.color = "var(--primary)";
  
  const total = Math.ceil(activeFile.size / CHUNK_SIZE);
  
  // Announce transfer metadata
  bridge.startTransfer({
    fileName: activeFile.name,
    mime: activeFile.type,
    size: activeFile.size,
    total: total
  });
  
  sendStatChunks.textContent = `0 / ${total}`;
  const startTime = Date.now();
  
  for (let seq = 0; seq < total; seq++) {
    if (!isSending) break; // Cancelled
    
    const start = seq * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, activeFile.size);
    
    try {
      // Read raw binary ArrayBuffer slice and stream it immediately
      const chunkData = await readSliceAsArrayBuffer(activeFile, start, end);
      bridge.sendChunk({
        seq: seq,
        total: total,
        data: chunkData
      });
    } catch (err) {
      console.error(err);
      showToast("Error streaming file: " + err.message);
      isSending = false;
      break;
    }
    
    // Update progress bars & UI statistics
    const progressPct = Math.round(((seq + 1) / total) * 100);
    sendProgressBar.style.width = `${progressPct}%`;
    sendProgressPct.textContent = `${progressPct}%`;
    sendStatChunks.textContent = `${seq + 1} / ${total}`;
    
    // Calculate transmission speed
    const elapsedSecs = (Date.now() - startTime) / 1000;
    const sentBytes = (seq + 1) * CHUNK_SIZE;
    const speedKbps = elapsedSecs > 0 ? (sentBytes / 1024) / elapsedSecs : 0;
    sendStatSpeed.textContent = `${speedKbps.toFixed(1)} KB/s`;
    
    // Tiny delay to keep browser render loop alive
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  
  if (isSending) {
    bridge.finish({ total });
    sendStatState.textContent = "Done";
    sendStatState.style.color = "var(--accent-emerald)";
    sendProgressLabel.textContent = "Stream complete!";
    sendBtn.textContent = "Transfer Completed Successfully";
    sendBtn.classList.add("success");
    showToast("File sent successfully!");
  }
});


// ---- DECODER (Receiver) logic -----------------------------------------------
const decodeEmptyState = document.getElementById("decode-empty-state");
const receiveStatusBox = document.getElementById("receive-status-box");
const receiveFileName = document.getElementById("receive-file-name");
const receiveFileSize = document.getElementById("receive-file-size");
const receiveProgressPct = document.getElementById("receive-progress-pct");
const receiveProgressBar = document.getElementById("receive-progress-bar");
const receiveProgressLabel = document.getElementById("receive-progress-label");
const receiveStatChunks = document.getElementById("receive-stat-chunks");
const receiveStatCompleteness = document.getElementById("receive-stat-completeness");
const receiveStatState = document.getElementById("receive-stat-state");
const chunkVisualizer = document.getElementById("chunk-visualizer");
const downloadBtn = document.getElementById("download-btn");
const resetReceiveBtn = document.getElementById("reset-receive-btn");

function handleIncomingMeta(meta) {
  incomingMeta = meta;
  receivedChunks.clear();

  if (downloadBlobUrl) {
    URL.revokeObjectURL(downloadBlobUrl);
    downloadBlobUrl = null;
  }
  
  decodeEmptyState.style.display = "none";
  receiveStatusBox.style.display = "block";
  downloadBtn.style.display = "none";
  resetReceiveBtn.style.display = "block";
  
  receiveFileName.textContent = meta.fileName;
  receiveFileSize.textContent = `${formatBytes(meta.size)} • ${meta.mime || 'unknown type'}`;
  receiveStatState.textContent = "Streaming";
  receiveStatState.style.color = "var(--accent-cyan)";
  receiveProgressLabel.textContent = "Receiving binary chunks...";
  
  // Render clean dots grid
  chunkVisualizer.innerHTML = "";
  for (let i = 0; i < meta.total; i++) {
    const dot = document.createElement("div");
    dot.className = "chunk-dot";
    dot.id = `chunk-dot-${i}`;
    chunkVisualizer.appendChild(dot);
  }
  
  updateReceiverProgress(0, meta.total);
}

function handleIncomingChunk(chunk) {
  if (!incomingMeta) return;
  
  receivedChunks.set(chunk.seq, chunk.data);
  
  // Color the chunk box in the visualization grid
  const dot = document.getElementById(`chunk-dot-${chunk.seq}`);
  if (dot) {
    dot.className = "chunk-dot received";
  }
  
  updateReceiverProgress(receivedChunks.size, chunk.total);
}

function updateReceiverProgress(receivedCount, total) {
  const pct = Math.round((receivedCount / total) * 100);
  receiveProgressBar.style.width = `${pct}%`;
  receiveProgressPct.textContent = `${pct}%`;
  receiveStatChunks.textContent = `${receivedCount} / ${total}`;
  receiveStatCompleteness.textContent = `${pct}%`;
}

function checkCompleteness(totalCount) {
  const total = totalCount || incomingMeta?.total || 0;
  if (!total) return;
  
  const missing = [];
  for (let i = 0; i < total; i++) {
    if (!receivedChunks.has(i)) {
      missing.push(i);
      const dot = document.getElementById(`chunk-dot-${i}`);
      if (dot) dot.className = "chunk-dot missing";
    }
  }
  
  if (missing.length > 0) {
    receiveStatState.textContent = "Missing Chunks";
    receiveStatState.style.color = "var(--accent-rose)";
    receiveProgressLabel.textContent = `Missing ${missing.length} chunks. Requesting resend...`;
    bridge.requestResend(missing);
  } else {
    // Stream assembly complete
    receiveStatState.textContent = "Complete";
    receiveStatState.style.color = "var(--accent-emerald)";
    receiveProgressLabel.textContent = "Stream received fully! Ready to save.";
    
    // Enable download
    downloadBtn.style.display = "flex";
    downloadBtn.disabled = false;
  }
}

downloadBtn.addEventListener("click", () => {
  if (!incomingMeta) return;
  
  try {
    // Reassemble raw ArrayBuffer slices
    const total = incomingMeta.total;
    const chunksArray = [];
    for (let i = 0; i < total; i++) {
      chunksArray.push(receivedChunks.get(i));
    }
    
    const blob = new Blob(chunksArray, { type: incomingMeta.mime });
    downloadBlobUrl = URL.createObjectURL(blob);
    
    // Create temporary link and download
    const link = document.createElement("a");
    link.href = downloadBlobUrl;
    link.download = incomingMeta.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast("File downloaded successfully!");
  } catch (err) {
    console.error(err);
    showToast("Reassembly failed: " + err.message);
  }
});

resetReceiveBtn.addEventListener("click", () => {
  resetReceiver();
  resetSender();
  bridge.reset(); // Alert other peer to reset as well
});

function resetReceiver() {
  receivedChunks.clear();
  incomingMeta = null;

  if (downloadBlobUrl) {
    URL.revokeObjectURL(downloadBlobUrl);
    downloadBlobUrl = null;
  }
  
  decodeEmptyState.style.display = "flex";
  receiveStatusBox.style.display = "none";
  downloadBtn.style.display = "none";
  resetReceiveBtn.style.display = "none";
  
  chunkVisualizer.innerHTML = "";
}
