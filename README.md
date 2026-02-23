# Fly Together

A synchronized music listening web app. One person (the **host**) uploads and controls playback; everyone else stays in sync in real time over the same network.

## Features

- **Host / Listener roles**: First person to join is the host; only the host can upload and control play/pause/seek.
- **Real-time sync**: Play, pause, and seek are broadcast to all clients. Playback position is synced every ~2.5 seconds to avoid drift.
- **File upload**: Host uploads audio (MP3, WAV, OGG, M4A, max 50MB). Files are stored temporarily on the server and served to all clients.
- **Clean UI**: Track name, play/pause, seek bar, volume, listener count, and host/listener badge.

## Requirements

- Node.js 18+
- All listeners on the same LAN (or use port forwarding for remote friends)

## Setup & run

```bash
npm install
npm start
```

The server listens on **port 3000** by default. Set `PORT` to change it:

```bash
PORT=4000 npm start
```

On startup you’ll see:

- **Local**: `http://localhost:3000` — use this on the machine running the server.
- **LAN**: `http://<your-LAN-IP>:3000` — share this URL so others on your Wi‑Fi can join.

## Usage

1. **Host**: Open the app (e.g. from the LAN URL). You’ll see “Host” and the upload area. Choose an audio file, then use play/pause and the seek bar as usual.
2. **Listeners**: Open the same LAN URL in a browser. You’ll see “Listener”; playback follows the host. No upload or control buttons.
3. If the host leaves, the next connected client becomes the new host.

## Tech stack

- **Backend**: Express, Socket.IO, Multer (uploads to a temp directory).
- **Frontend**: Vanilla HTML/CSS/JS, Socket.IO client, HTML5 Audio.

## Project layout

```
fly-together/
├── server.js          # Express + Socket.IO server, uploads, sync state
├── public/
│   ├── index.html     # Single-page UI
│   ├── app.js         # Socket.IO client, audio element, sync logic
│   └── style.css      # Styling
├── package.json
└── README.md
```

Uploaded files are stored in the system temp directory (e.g. `/tmp/fly-together-uploads` on Linux). They are not removed automatically; clear that folder if you need to free space.

## Troubleshooting

- **“Disconnected”**: Check that the server is running and that your firewall allows port 3000. On the host machine, use the LAN URL as well if you’re testing from the same device.
- **No audio**: Ensure the file format is supported (MP3, WAV, OGG, M4A) and under 50MB. Try another browser if one fails to play.
- **Out of sync**: Position sync runs every 2–3 seconds; a short delay after seek is normal. If drift persists, refresh the page to re-sync.
