const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Server } = require("socket.io");
const multer = require("multer");
const NodeID3 = require("node-id3");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const COVERS_DIR = path.join(__dirname, "covers");
const SAVED_TRACKS_FILE = path.join(__dirname, "saved-tracks.json");

for (const dir of [UPLOAD_DIR, COVERS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function updateMetadatas() {
  const files = loadSavedTracks();
  const updatedTracksList = [];
  files.forEach((file, idx) => {
    if (file?.metadata) {
      updatedTracksList.push(file);
    } else if (file?.filename && file?.originalName) {
      const filePath = path.join(UPLOAD_DIR, file.filename);
      const metadata = extractMetadata(filePath, file.originalName);
      updatedTracksList.push({ ...file, metadata });
      console.log(`processing ${idx + 1}/${files.length}`);
    }
  });
  updateSavedTracksFile(updatedTracksList);
}

function extractMetadata(filePath, originalName) {
  const ext = path.extname(filePath).toLowerCase();
  const meta = {
    title: path.basename(originalName, ext),
    artist: undefined,
    album: undefined,
    year: undefined,
    coverUrl: undefined,
  };

  if (ext !== ".mp3") return meta; // node-id3 only handles mp3

  let tags;
  try {
    tags = NodeID3.read(filePath);
  } catch (err) {
    console.warn("[metadata] Could not read tags for", filePath, err.message);
    return meta;
  }

  if (tags.title) meta.title = tags.title;
  if (tags.artist) meta.artist = tags.artist;
  if (tags.album) meta.album = tags.album;
  if (tags.year) meta.year = tags.year;

  // Extract embedded cover art
  const pic = tags.image; // { mime, type, description, imageBuffer }
  if (pic && pic.imageBuffer) {
    const coverFilename =
      path.basename(filePath, path.extname(filePath)) + ".jpg";
    const coverPath = path.join(COVERS_DIR, coverFilename);
    if (!fs.existsSync(coverPath)) {
      try {
        fs.writeFileSync(coverPath, pic.imageBuffer);
      } catch (err) {
        console.warn("[metadata] Could not save cover art:", err.message);
      }
    }
    meta.coverUrl = `/covers/${coverFilename}`;
  }

  return meta;
}

function loadSavedTracks() {
  try {
    const data = fs.readFileSync(SAVED_TRACKS_FILE, "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function updateSavedTracksFile(tracks, removePrevious = true) {
  fs.writeFileSync(SAVED_TRACKS_FILE, JSON.stringify(tracks, null, 2), "utf8");
}

function addCurrentTrackToSaved() {
  if (!state.track) return;
  const tracks = loadSavedTracks();
  if (tracks.some((t) => t.filename === state.track.filename)) return;
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    filename: state.track.filename,
    originalName: state.track.originalName,
    url: state.track.url,
    savedAt: new Date().toISOString(),
    metadata: state.track.metadata || {},
  };
  tracks.push(entry);
  updateSavedTracksFile(tracks);
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp3";
    cb(null, `track_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    if (/\.(mp3|wav|ogg|m4a)$/i.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error("Only mp3, wav, ogg, m4a are allowed"));
    }
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/covers", express.static(COVERS_DIR));

let state = {
  track: null, // { filename, originalName, url, metadata: { title, artist, album, year, coverUrl } }
  playing: false,
  currentTime: 0,
  duration: 0,
  metadata: {},
};

app.post("/upload", upload.single("audio"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const url = `/uploads/${req.file.filename}`;
    const metadata = extractMetadata(req.file.path, req.file.originalname);

    state.track = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      url,
      metadata,
    };
    state.currentTime = 0;
    state.playing = false;

    addCurrentTrackToSaved();
    io.emit("track-changed", state.track);

    res.json({ url, originalName: req.file.originalname, metadata });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/state", (req, res) => {
  res.json({
    track: state.track,
    playing: state.playing,
    currentTime: state.currentTime,
    duration: state.duration,
  });
});

app.get("/api/metadata/:filename", (req, res) => {
  const safe = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(UPLOAD_DIR, safe);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  const tracks = loadSavedTracks();
  const entry = tracks.find((t) => t.filename === safe);
  const originalName = entry ? entry.originalName : safe;
  const metadata = extractMetadata(filePath, originalName);
  res.json({ filename: safe, metadata });
});

app.get("/api/saved", (req, res) => {
  res.json({ saved: loadSavedTracks() });
});

app.delete("/api/saved/:id", (req, res) => {
  const tracks = loadSavedTracks();
  const index = tracks.findIndex((t) => t.id === req.params.id);
  if (index === -1)
    return res.status(404).json({ error: "Saved track not found" });
  tracks.splice(index, 1);
  updateSavedTracksFile(tracks);
  res.status(204).send();
});

app.post("/api/saved/:id/set-current", (req, res) => {
  const tracks = loadSavedTracks();
  const entry = tracks.find((t) => t.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Saved track not found" });

  const filePath = path.join(UPLOAD_DIR, entry.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Audio file no longer available" });
  }

  // Re-extract metadata in case it wasn't stored when the track was first saved
  const metadata =
    entry.metadata && Object.keys(entry.metadata).length > 0
      ? entry.metadata
      : extractMetadata(filePath, entry.originalName);

  state.track = {
    filename: entry.filename,
    originalName: entry.originalName,
    url: entry.url,
    metadata,
  };
  state.currentTime = 0;
  state.playing = false;

  addCurrentTrackToSaved();
  io.emit("track-changed", state.track);
  res.json(state.track);
});

app.get("/api/saved/:id/download", (req, res) => {
  const tracks = loadSavedTracks();
  const entry = tracks.find((t) => t.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Saved track not found" });

  const filePath = path.join(UPLOAD_DIR, entry.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Audio file no longer available" });
  }

  const safeName = entry.originalName.replace(/[^\w.\- ]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.sendFile(filePath);
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

io.on("connection", (socket) => {
  socket.emit("state-sync", {
    track: state.track,
    playing: state.playing,
    currentTime: state.currentTime,
    duration: state.duration,
    metadata: state.metadata,
  });

  io.emit("users-count", io.engine.clientsCount);

  // socket.on("play", () => {
  //   state.playing = true;
  //   socket.broadcast.emit("play");
  // });
  // socket.on("pause", () => {
  //   state.playing = false;
  //   socket.broadcast.emit("pause");
  // });

  socket.on("play", () => {
    state.playing = true;
    socket.broadcast.emit("play", { currentTime: state.currentTime });
  });
  socket.on("pause", () => {
    state.playing = false;
    socket.broadcast.emit("pause", { currentTime: state.currentTime });
  });

  socket.on("seek", (time) => {
    state.currentTime = Math.max(0, Number(time));
    socket.broadcast.emit("seek", state.currentTime);
  });

  socket.on("position", ({ currentTime, duration }) => {
    if (typeof currentTime === "number") state.currentTime = currentTime;
    if (typeof duration === "number") state.duration = duration;
    socket.broadcast.emit("position-sync", {
      currentTime: state.currentTime,
      duration: state.duration,
    });
  });

  socket.on("disconnect", () => {
    io.emit("users-count", io.engine.clientsCount);
  });
});

server.listen(PORT, "0.0.0.0", async () => {
  const localIP = getLocalIP();
  await updateMetadatas();
  console.log(`
  Fly Together
  -------------------------
  Local:   http://localhost:${PORT}
  LAN:     http://${localIP}:${PORT}
  -------------------------
  Share the LAN URL so friends can join.
`);
});

server.on("error", (err) => console.error("Server error:", err));
