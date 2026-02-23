const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SAVED_TRACKS_FILE = path.join(__dirname, 'saved-tracks.json');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function loadSavedTracks() {
  try {
    const data = fs.readFileSync(SAVED_TRACKS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSavedTracks(tracks) {
  fs.writeFileSync(SAVED_TRACKS_FILE, JSON.stringify(tracks, null, 2), 'utf8');
}

// Add current track to saved list if not already there (by filename)
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
  };
  tracks.push(entry);
  saveSavedTracks(tracks);
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Multer config: store in /tmp, keep original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp3';
    const name = `track_${Date.now()}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp3|wav|ogg|m4a)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('Only mp3, wav, ogg, m4a are allowed'));
    }
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded audio files
app.use('/audio', express.static(UPLOAD_DIR));

// State: host socket id, current track, playback state
let state = {
  hostId: null,
  track: null,       // { filename, originalName, url }
  playing: false,
  currentTime: 0,
  duration: 0,
};

// Users who requested to become host (socket ids)
let hostRequests = new Set();

// Upload endpoint: any connected user can upload (everyone can select a song)
app.post('/upload', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const url = `/audio/${req.file.filename}`;
    state.track = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      url,
    };
    state.currentTime = 0;
    state.playing = false;
    addCurrentTrackToSaved();
    io.emit('track-changed', state.track);
    res.json({ url, originalName: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current state for new clients
app.get('/api/state', (req, res) => {
  res.json({
    hostId: state.hostId,
    track: state.track,
    playing: state.playing,
    currentTime: state.currentTime,
    duration: state.duration,
  });
});

// --- Saved tracks ---

// List all saved tracks
app.get('/api/saved', (req, res) => {
  res.json({ saved: loadSavedTracks() });
});

// Remove a track from the saved list (does not delete the file)
app.delete('/api/saved/:id', (req, res) => {
  const tracks = loadSavedTracks();
  const index = tracks.findIndex((t) => t.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Saved track not found' });
  }
  tracks.splice(index, 1);
  saveSavedTracks(tracks);
  res.status(204).send();
});

// Set a saved track as the current track (everyone will hear it)
app.post('/api/saved/:id/set-current', (req, res) => {
  const tracks = loadSavedTracks();
  const entry = tracks.find((t) => t.id === req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'Saved track not found' });
  }
  const filePath = path.join(UPLOAD_DIR, entry.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio file no longer available' });
  }
  state.track = {
    filename: entry.filename,
    originalName: entry.originalName,
    url: entry.url,
  };
  state.currentTime = 0;
  state.playing = false;
  addCurrentTrackToSaved();
  io.emit('track-changed', state.track);
  res.json(state.track);
});

// Download a saved track (attachment with original filename)
app.get('/api/saved/:id/download', (req, res) => {
  const tracks = loadSavedTracks();
  const entry = tracks.find((t) => t.id === req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'Saved track not found' });
  }
  const filePath = path.join(UPLOAD_DIR, entry.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio file no longer available' });
  }
  const safeName = entry.originalName.replace(/[^\w.\- ]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.sendFile(filePath);
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

io.on('connection', (socket) => {
  const isFirst = state.hostId === null;
  if (isFirst) {
    state.hostId = socket.id;
  }

  const isHost = state.hostId === socket.id;
  socket.emit('role', { isHost, hostId: state.hostId });
  socket.emit('state-sync', {
    track: state.track,
    playing: state.playing,
    currentTime: state.currentTime,
    duration: state.duration,
  });
  socket.emit('host-requests', Array.from(hostRequests));

  const count = io.engine.clientsCount;
  io.emit('users-count', count);

  // Playback: any user can control (shared controls)
  socket.on('play', () => {
    state.playing = true;
    socket.broadcast.emit('play');
  });

  socket.on('pause', () => {
    state.playing = false;
    socket.broadcast.emit('pause');
  });

  socket.on('seek', (time) => {
    const t = Math.max(0, Number(time));
    state.currentTime = t;
    socket.broadcast.emit('seek', t);
  });

  socket.on('position', (data) => {
    const { currentTime, duration } = data;
    if (typeof currentTime === 'number') state.currentTime = currentTime;
    if (typeof duration === 'number') state.duration = duration;
    socket.broadcast.emit('position-sync', { currentTime: state.currentTime, duration: state.duration });
  });

  // Host voting / handover
  socket.on('request-host', () => {
    if (state.hostId === socket.id) return;
    hostRequests.add(socket.id);
    io.emit('host-requests', Array.from(hostRequests));
  });

  socket.on('cancel-host-request', () => {
    hostRequests.delete(socket.id);
    io.emit('host-requests', Array.from(hostRequests));
  });

  socket.on('hand-over-host', (targetSocketId) => {
    if (state.hostId !== socket.id || !targetSocketId) return;
    const target = io.sockets.sockets.get(targetSocketId);
    if (!target) return;
    hostRequests.delete(targetSocketId);
    state.hostId = targetSocketId;
    socket.emit('role', { isHost: false, hostId: state.hostId });
    target.emit('role', { isHost: true, hostId: state.hostId });
    io.emit('host-changed', state.hostId);
    io.emit('host-requests', Array.from(hostRequests));
  });

  socket.on('disconnect', () => {
    hostRequests.delete(socket.id);
    if (state.hostId === socket.id) {
      state.hostId = null;
      const clients = Array.from(io.sockets.sockets.values()).filter((s) => s.id !== socket.id);
      // Prefer giving host to someone who requested it (vote for host)
      const next =
        clients.find((s) => hostRequests.has(s.id)) ||
        clients[0];
      if (next) {
        state.hostId = next.id;
        hostRequests.delete(next.id);
        next.emit('role', { isHost: true, hostId: state.hostId });
        io.emit('host-changed', state.hostId);
        io.emit('host-requests', Array.from(hostRequests));
      } else {
        io.emit('host-changed', null);
      }
    }
    io.emit('users-count', io.engine.clientsCount);
    io.emit('host-requests', Array.from(hostRequests));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`
  Fly Together — Sync Music
  -------------------------
  Local:   http://localhost:${PORT}
  LAN:     http://${localIP}:${PORT}
  -------------------------
  Share the LAN URL so friends can join.
`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});
