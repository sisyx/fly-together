function all() {
  const audio = document.getElementById("audio");
  const fileInput = document.getElementById("fileInput");
  const uploadSection = document.getElementById("uploadSection");
  const playPauseBtn = document.getElementById("playPauseBtn");
  const playIcon = document.getElementById("playIcon");
  const pauseIcon = document.getElementById("pauseIcon");
  const seekBar = document.getElementById("seekBar");
  const currentTimeEl = document.getElementById("currentTime");
  const durationEl = document.getElementById("duration");
  const volumeBar = document.getElementById("volumeBar");
  const trackNameEl = document.getElementById("trackName");
  const usersCountEl = document.getElementById("usersCount");
  const roleBadgeEl = document.getElementById("roleBadge");
  const connectionStatus = document.getElementById("connectionStatus");
  const statusText = connectionStatus.querySelector(".status-text");
  const handOverWrap = document.getElementById("handOverWrap");
  const handOverLabel = document.getElementById("handOverLabel");
  const handOverList = document.getElementById("handOverList");
  const savedList = document.getElementById("savedList");
  const savedEmpty = document.getElementById("savedEmpty");
  const coverBackdrop = document.getElementById("coverBackdrop");
  const nowPlayingCover = document.getElementById("nowPlayingCover");
  const nowPlayingPlaceholder = document.getElementById(
    "nowPlayingPlaceholder",
  );
  const nowPlayingImg = document.getElementById("nowPlayingImg");
  const nowPlayingName = document.getElementById("nowPlayingName");
  const nowPlayingArtist = document.getElementById("nowPlayingArtist");
  const nowPlayingSection = document.getElementById("nowPlayingSection");
  const trackArtistEl = document.getElementById("trackArtist");
  const libraryCount = document.getElementById("libraryCount");
  const waveformCanvas = document.getElementById("waveformCanvas");
  const loginGate = document.getElementById("loginGate");
  const loginForm = document.getElementById("loginForm");
  const displayNameInput = document.getElementById("displayNameInput");
  const loginError = document.getElementById("loginError");
  const userBadge = document.getElementById("userBadge");
  const userNameEl = document.getElementById("userName");
  const userAvatar = document.getElementById("userAvatar");

  const POSITION_SYNC_INTERVAL_MS = 2500;
  const SEEK_SYNC_THRESHOLD = 1.5;

  let socket = null;
  let isHost = false;
  let hostId = null;
  let hostRequestIds = [];
  let positionSyncTimer = null;
  let isSeekingBySync = false;

  let audioContext = null;
  let analyser = null;
  let waveformInitialized = false;
  let wasPlayingBeforeHidden = false;
  const WAVEFORM_POINT_COUNT = 96;
  const waveformData = new Uint8Array(128);
  const USER_NAME_KEY = "fly-together-display-name";
  let currentUserName = "";

  function storedUserName() {
    try {
      return (localStorage.getItem(USER_NAME_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function saveUserName(name) {
    try {
      localStorage.setItem(USER_NAME_KEY, name);
    } catch {
      // The room still works when storage is disabled.
    }
  }

  function updateUserBadge(name) {
    currentUserName = name;
    if (userNameEl) userNameEl.textContent = name || "Guest";
    if (userAvatar) userAvatar.textContent = name ? name.charAt(0).toUpperCase() : "?";
  }

  function openLogin() {
    if (!loginGate || !displayNameInput) return;
    loginGate.hidden = false;
    document.body.classList.add("login-open");
    displayNameInput.value = currentUserName;
    if (loginError) loginError.textContent = "";
    requestAnimationFrame(() => displayNameInput.focus());
  }

  function closeLogin() {
    if (!loginGate) return;
    loginGate.hidden = true;
    document.body.classList.remove("login-open");
  }

  function setupLogin() {
    const savedName = storedUserName();
    updateUserBadge(savedName);
    if (savedName) closeLogin();
    else openLogin();

    loginForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = displayNameInput.value.trim().replace(/\s+/g, " ");
      if (name.length < 2) {
        if (loginError) loginError.textContent = "Please enter at least two characters.";
        displayNameInput.focus();
        return;
      }
      updateUserBadge(name);
      saveUserName(name);
      closeLogin();
      refreshSavedList();
    });

    userBadge?.addEventListener("click", openLogin);
  }

  function setupVisibilityHandling() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        wasPlayingBeforeHidden = audio.src && !audio.paused;
      } else {
        if (audioContext?.state === "suspended") {
          audioContext.resume().catch(() => {});
        }
        if (wasPlayingBeforeHidden && audio.src && audio.paused) {
          initWaveform();
          if (audioContext?.state === "suspended") {
            audioContext
              .resume()
              .then(() => {
                audio.play().catch(() => {});
                if (socket) socket.emit("play");
              })
              .catch(() => {});
          } else {
            audio.play().catch(() => {});
            if (socket) socket.emit("play");
          }
          wasPlayingBeforeHidden = false;
        }
      }
    });
  }

  function initWaveform() {
    if (waveformInitialized || !audio.src) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioContext = new Ctx();
      const source = audioContext.createMediaElementSource(audio);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.62;
      analyser.minDecibels = -82;
      analyser.maxDecibels = -28;
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      waveformInitialized = true;
    } catch (e) {
      console.warn("Waveform init failed", e);
    }
  }

  function drawWaveform(timestamp = 0) {
    if (!waveformCanvas) {
      requestAnimationFrame(drawWaveform);
      return;
    }
    const ctx = waveformCanvas.getContext("2d");
    if (!ctx) {
      requestAnimationFrame(drawWaveform);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const rect = waveformCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const pixelWidth = Math.round(w * dpr);
    const pixelHeight = Math.round(h * dpr);
    if (waveformCanvas.width !== pixelWidth || waveformCanvas.height !== pixelHeight) {
      waveformCanvas.width = pixelWidth;
      waveformCanvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const active = analyser && audio.src && !audio.paused;
    if (active) {
      analyser.getByteFrequencyData(waveformData);
    }

    const cx = w / 2;
    const cy = h / 2;
    const baseRadius = Math.min(w, h) * 0.425;
    const maxWave = Math.min(w, h) * 0.06;
    const points = [];

    for (let i = 0; i < WAVEFORM_POINT_COUNT; i++) {
      const progress = i / WAVEFORM_POINT_COUNT;
      const angle = progress * Math.PI * 2 - Math.PI / 2;
      const foldedProgress = progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
      const dataIndex = Math.min(
        waveformData.length - 1,
        Math.floor(foldedProgress * 64),
      );
      const frequency = active ? waveformData[dataIndex] / 255 : 0;
      const organicRipple =
        Math.sin(angle * 5 + timestamp * 0.0017) * (active ? 2.6 : 0.7) +
        Math.sin(angle * 9 - timestamp * 0.0011) * (active ? 1.4 : 0.35);
      const radius =
        baseRadius +
        organicRipple +
        (active ? Math.pow(frequency, 0.72) * maxWave : 0);
      points.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }

    const drawLoop = (offset, color, width) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1 + offset, 1 + offset);
      ctx.translate(-cx, -cy);
      ctx.beginPath();
      const first = points[0];
      const last = points[points.length - 1];
      ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
      for (let i = 0; i < points.length; i++) {
        const point = points[i];
        const next = points[(i + 1) % points.length];
        ctx.quadraticCurveTo(
          point.x,
          point.y,
          (point.x + next.x) / 2,
          (point.y + next.y) / 2,
        );
      }
      ctx.closePath();
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    };

    drawLoop(0.012, "rgba(23, 23, 19, 0.2)", 1);
    drawLoop(
      0,
      active ? "rgba(240, 82, 56, 0.92)" : "rgba(23, 23, 19, 0.38)",
      active ? 2.2 : 1.25,
    );
    requestAnimationFrame(drawWaveform);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function setConnectionStatus(connected) {
    connectionStatus.classList.toggle("connected", connected);
    connectionStatus.classList.toggle("disconnected", !connected);
    statusText.textContent = connected ? "Connected" : "Disconnected";
  }

  function setRole(host) {
    isHost = host;
    roleBadgeEl.textContent = isHost ? "Host" : "Listener";
    roleBadgeEl.className = "role-badge " + (isHost ? "host" : "listener");
    if (uploadSection) uploadSection.style.visibility = "visible";
    if (handOverWrap) handOverWrap.style.display = isHost ? "block" : "none";
    updateHandOverUI();
  }

  function updateUsersCount(count) {
    usersCountEl.textContent =
      count === 1 ? "1 listener" : `${count} listeners`;
  }

  function updateHandOverUI() {
    if (!handOverLabel || !handOverList) return;
    const count = hostRequestIds.length;
    handOverLabel.textContent =
      count === 0
        ? "No requests to be host"
        : count === 1
          ? "1 person wants to be host"
          : `${count} people want to be host`;
    handOverList.textContent = "";
    hostRequestIds.forEach((id, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-secondary btn-hand-over";
      btn.textContent = `Hand over to requester ${i + 1}`;
      btn.addEventListener("click", () => {
        if (socket) socket.emit("hand-over-host", id);
      });
      handOverList.appendChild(btn);
    });
  }

  function setCover(coverDataUrl) {
    if (!coverDataUrl && lastCoverObjectUrl) {
      URL.revokeObjectURL(lastCoverObjectUrl);
      lastCoverObjectUrl = null;
    }
    if (coverBackdrop) {
      if (coverDataUrl) {
        coverBackdrop.style.backgroundImage = `url(${coverDataUrl})`;
        coverBackdrop.classList.add("has-cover");
      } else {
        coverBackdrop.style.backgroundImage = "";
        coverBackdrop.classList.remove("has-cover");
      }
    }
    if (nowPlayingImg && nowPlayingPlaceholder) {
      if (coverDataUrl) {
        nowPlayingImg.onerror = () => {
          setCover(null);
        };
        nowPlayingImg.src = coverDataUrl;
        nowPlayingImg.hidden = false;
        nowPlayingPlaceholder.hidden = true;
      } else {
        nowPlayingImg.onerror = null;
        nowPlayingImg.removeAttribute("src");
        nowPlayingImg.hidden = true;
        nowPlayingPlaceholder.hidden = false;
      }
    }
  }

  function loadTrack(url, name, artist, coverDataUrl, autoPlay) {
    const displayName = name || "Current track";
    const displayArtist = artist || "Unknown artist";
    trackNameEl.textContent = displayName;
    if (trackArtistEl) trackArtistEl.textContent = displayArtist;
    if (nowPlayingName) nowPlayingName.textContent = displayName;
    if (nowPlayingArtist) nowPlayingArtist.textContent = displayArtist;
    setCover(coverDataUrl || null);
    audio.src = url || "";
    seekBar.value = 0;
    seekBar.style.setProperty("--progress", "0%");
    currentTimeEl.textContent = "0:00";
    durationEl.textContent = "0:00";
    playPauseBtn.disabled = !url;
    if (url) {
      audio.load();
      if (autoPlay) {
        initWaveform();
        if (audioContext?.state === "suspended") audioContext.resume();
        audio.play().catch(() => {});
        if (socket) socket.emit("play");
      }
    }
  }

  async function fetchSavedTracks() {
    try {
      const res = await fetch("/api/saved");
      const data = await res.json();
      return data.saved || [];
    } catch {
      return [];
    }
  }

  const playIconSvg =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const downloadIconSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const removeIconSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  const heartIconSvg =
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>';

  function applyLikeState(button, likes) {
    if (!button) return;
    const safeLikes = Array.isArray(likes) ? likes : [];
    const liked = safeLikes.some(
      (name) =>
        typeof name === "string" &&
        name.toLowerCase() === currentUserName.toLowerCase(),
    );
    button.classList.toggle("is-liked", liked);
    button.setAttribute("aria-pressed", String(liked));
    button.title = liked ? "Unlike this song" : "Like this song";
    const count = button.querySelector(".like-count");
    if (count) count.textContent = String(safeLikes.length);
  }

  function renderSavedList(tracks) {
    if (!savedList || !savedEmpty) return;
    if (libraryCount) {
      const count = tracks.length;
      libraryCount.textContent = `${String(count).padStart(2, "0")} ${count === 1 ? "track" : "tracks"}`;
    }
    const scrollY = window.scrollY;
    savedList.innerHTML = "";
    if (tracks.length === 0) {
      savedEmpty.style.display = "block";
      return;
    }
    savedEmpty.style.display = "none";
    // Newest first
    const sorted = [...tracks].sort((a, b) => {
      const aAt = a.savedAt ? new Date(a.savedAt).getTime() : 0;
      const bAt = b.savedAt ? new Date(b.savedAt).getTime() : 0;
      return bAt - aAt;
    });
    sorted.forEach((t) => {
      const card = document.createElement("div");
      card.className = "saved-card";
      const coverUrl = t?.metadata.coverUrl || null;
      const name =
        t?.metadata?.title || t.originalName || t.filename || "Track";
      const artist = t?.metadata?.artist || "Unknown Artist";
      const likes = Array.isArray(t.likes) ? t.likes : [];
      const safeName = name
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
      const safeArtist = artist
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
      const coverMarkup = coverUrl
        ? `<img src="${coverUrl}" class="saved-card-cover-icon" alt="" />`
        : '<span class="saved-card-cover-fallback" aria-hidden="true">♪</span>';
      card.innerHTML = `
        <div class="saved-card-cover-wrap">
          <div class="saved-card-cover">
              ${coverMarkup}
          </div>
          <button type="button" class="btn saved-card-play-overlay" title="Set as current track for everyone" aria-label="Play">
            ${playIconSvg}
          </button>
        </div>
        <div class="saved-card-body">
          <div class="saved-card-body-left">
          <div class="saved-item-name" title="${safeName}">${safeName}</div>
          <div class="saved-item-artist" title="${safeArtist}">${safeArtist}</div>
          </div>
          <div class="saved-item-actions"></div>
        </div>
      `;
      const actions = card.querySelector(".saved-item-actions");
      const playBtn = card.querySelector(".saved-card-play-overlay");
      playBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const r = await fetch(`/api/saved/${t.id}/set-current`, {
            method: "POST",
          });
          const track = await r.json();
          const coverUrl = track?.metadata.coverUrl || null;
          const name =
            track?.metadata?.title ||
            track.originalName ||
            track.filename ||
            "Track";
          const artist = track?.metadata?.artist || "Unknown Artist";
          if (track.url) loadTrack(track.url, name, artist, coverUrl, true);
        } catch (e) {
          console.error(e);
        }
      });

      const downloadLink = document.createElement("a");
      downloadLink.href = `/api/saved/${t.id}/download`;
      downloadLink.download = t.originalName || "track";
      downloadLink.className = "btn btn-saved-action btn-saved-download";
      downloadLink.title = "Download file";
      downloadLink.setAttribute("aria-label", `Download ${name}`);
      downloadLink.innerHTML = downloadIconSvg;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-saved-action btn-saved-remove";
      removeBtn.title = "Remove from saved list";
      removeBtn.setAttribute("aria-label", `Delete ${name}`);
      removeBtn.innerHTML = removeIconSvg;
      removeBtn.addEventListener("click", async () => {
        try {
          const r = await fetch(`/api/saved/${t.id}`, { method: "DELETE" });
          if (r.ok) await refreshSavedList();
        } catch (e) {
          console.error(e);
        }
      });

      const likeBtn = document.createElement("button");
      likeBtn.type = "button";
      likeBtn.className = "btn btn-saved-action btn-saved-like";
      likeBtn.dataset.trackId = t.id;
      likeBtn.innerHTML = `${heartIconSvg}<span class="like-count">${likes.length}</span>`;
      applyLikeState(likeBtn, likes);
      likeBtn.addEventListener("click", async () => {
        if (!currentUserName) {
          openLogin();
          return;
        }
        likeBtn.disabled = true;
        try {
          const response = await fetch(`/api/saved/${t.id}/like`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: currentUserName }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Could not update like");
          applyLikeState(likeBtn, result.likes);
        } catch (error) {
          console.error(error);
        } finally {
          likeBtn.disabled = false;
        }
      });

      actions.appendChild(likeBtn);
      actions.appendChild(downloadLink);
      actions.appendChild(removeBtn);
      savedList.appendChild(card);
    });
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollY);
    });
  }

  async function refreshSavedList() {
    const tracks = await fetchSavedTracks();
    renderSavedList(tracks);
  }

  function applyPlaybackState(playing, currentTime) {
    if (isSeekingBySync) return;
    if (
      Number.isFinite(currentTime) &&
      Math.abs(audio.currentTime - currentTime) > SEEK_SYNC_THRESHOLD
    ) {
      audio.currentTime = currentTime;
      seekBar.value = audio.duration ? (currentTime / audio.duration) * 100 : 0;
      currentTimeEl.textContent = formatTime(currentTime);
    }
    if (playing && audio.src && audio.paused) {
      audio.play().catch(() => {});
    } else if (!playing && !audio.paused) {
      audio.pause();
    }
  }

  function startPositionSync() {
    stopPositionSync();
    positionSyncTimer = setInterval(() => {
      if (!socket || !isHost || !audio.src) return;
      if (audio.readyState >= 2) {
        socket.emit("position", {
          currentTime: audio.currentTime,
          duration: audio.duration,
        });
      }
    }, POSITION_SYNC_INTERVAL_MS);
  }

  function stopPositionSync() {
    if (positionSyncTimer) {
      clearInterval(positionSyncTimer);
      positionSyncTimer = null;
    }
  }

  function initSocket() {
    if (typeof io === "undefined") {
      setConnectionStatus(false);
      statusText.textContent =
        "Socket.IO not loaded — open the app at http://localhost:3000 (not file:// or another server)";
      return;
    }
    const opts = {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 20,
      timeout: 10000,
      transports: ["polling", "websocket"],
    };
    try {
      socket = io(opts);
    } catch (err) {
      console.error("Socket.IO init failed:", err);
      setConnectionStatus(false);
      statusText.textContent = "Connection failed (check console)";
      return;
    }
    socket.on("connect_error", (err) => {
      console.error("Socket connect_error:", err.message);
      setConnectionStatus(false);
      statusText.textContent =
        "Connection failed — use the same URL as the server (e.g. http://localhost:3000)";
    });

    socket.on("connect", () => setConnectionStatus(true));
    socket.on("disconnect", () => setConnectionStatus(false));
    socket.on("connect_error", () => setConnectionStatus(false));

    socket.on("role", (data) => {
      isHost = data.isHost;
      hostId = data.hostId;
      setRole(data.isHost);
      if (data.isHost) startPositionSync();
      else stopPositionSync();
    });

    socket.on("state-sync", (data) => {
      if (data.track) {
        const track = data.track;
        const coverUrl = track?.metadata.coverUrl || null;
        const name =
          track?.metadata?.title ||
          track.originalName ||
          track.filename ||
          "Track";
        const artist = track?.metadata?.artist || "Unknown Artist";
        loadTrack(data.track.url, name, artist, coverUrl, true);
      }
      applyPlaybackState(data.playing, data.currentTime);
      if (data.duration) {
        durationEl.textContent = formatTime(data.duration);
        if (audio.duration) seekBar.max = 100;
      }
    });

    socket.on("track-changed", (track) => {
      const coverUrl = track?.metadata.coverUrl || null;
      const name =
        track?.metadata?.title ||
        track.originalName ||
        track.filename ||
        "Track";
      const artist = track?.metadata?.artist || "Unknown Artist";
      if (track) loadTrack(track.url, name, artist, coverUrl, true);
    });

    socket.on("play", (data) => {
      if (audio.src) {
        if (Number.isFinite(data?.currentTime)) {
          isSeekingBySync = true;
          audio.currentTime = data.currentTime;
          if (audio.duration)
            seekBar.value = (data.currentTime / audio.duration) * 100;
          currentTimeEl.textContent = formatTime(data.currentTime);
          setTimeout(() => {
            isSeekingBySync = false;
          }, 100);
        }
        if (audioContext?.state === "suspended") audioContext.resume();
        audio.play().catch(() => {});
      }
    });

    socket.on("pause", (data) => {
      if (Number.isFinite(data?.currentTime)) {
        isSeekingBySync = true;
        audio.currentTime = data.currentTime;
        if (audio.duration)
          seekBar.value = (data.currentTime / audio.duration) * 100;
        currentTimeEl.textContent = formatTime(data.currentTime);
        setTimeout(() => {
          isSeekingBySync = false;
        }, 100);
      }
      audio.pause();
    });
    socket.on("seek", (time) => {
      isSeekingBySync = true;
      audio.currentTime = time;
      if (audio.duration) seekBar.value = (time / audio.duration) * 100;
      currentTimeEl.textContent = formatTime(time);
      setTimeout(() => {
        isSeekingBySync = false;
      }, 100);
    });

    socket.on("position-sync", (data) => {
      if (isHost) return;
      if (
        Number.isFinite(data.currentTime) &&
        Math.abs(audio.currentTime - data.currentTime) > SEEK_SYNC_THRESHOLD
      ) {
        isSeekingBySync = true;
        audio.currentTime = data.currentTime;
        if (audio.duration)
          seekBar.value = (data.currentTime / audio.duration) * 100;
        currentTimeEl.textContent = formatTime(data.currentTime);
        setTimeout(() => {
          isSeekingBySync = false;
        }, 100);
      }
      if (Number.isFinite(data.duration)) {
        durationEl.textContent = formatTime(data.duration);
      }
    });

    socket.on("users-count", updateUsersCount);
    socket.on("track-liked", ({ trackId, likes }) => {
      const button = savedList?.querySelector(
        `.btn-saved-like[data-track-id="${CSS.escape(String(trackId))}"]`,
      );
      applyLikeState(button, likes);
    });
  }

  let lastCoverObjectUrl = null;

  function toPictureMime(format) {
    if (!format || typeof format !== "string") return "image/jpeg";
    const f = format.toLowerCase().trim();
    if (f === "image/jpeg" || f === "image/jpg" || f === "jpeg" || f === "jpg")
      return "image/jpeg";
    if (f === "image/png" || f === "png") return "image/png";
    if (f === "image/gif" || f === "gif") return "image/gif";
    if (f.startsWith("image/")) return f;
    return "image/jpeg";
  }

  function extractCoverFromFile(file, onDone) {
    if (typeof jsmediatags === "undefined") {
      onDone(null);
      return;
    }
    jsmediatags.read(file, {
      onSuccess: (tag) => {
        const picture = tag.tags?.picture || tag.picture;
        if (!picture || !picture.data || !picture.data.length) {
          onDone(null);
          return;
        }
        const mime = toPictureMime(picture.format);
        const bytes =
          picture.data instanceof Uint8Array
            ? picture.data
            : new Uint8Array(picture.data);
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        if (lastCoverObjectUrl) URL.revokeObjectURL(lastCoverObjectUrl);
        lastCoverObjectUrl = url;
        onDone(url);
      },
      onError: () => onDone(null),
    });
  }

  // File upload (anyone can select a song)
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("audio", file);
    try {
      const res = await fetch("/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.url) {
        extractCoverFromFile(file, (coverDataUrl) => {
          loadTrack(
            data.url,
            data.metadata?.title || data.originalName || file.name,
            data.metadata?.artist || "Unknown artist",
            coverDataUrl || data.metadata?.coverUrl || null,
            true,
          );
        });
        await refreshSavedList();
      }
      if (!res.ok) throw new Error(data.error || "Upload failed");
    } catch (err) {
      console.error(err);
      trackNameEl.textContent = "Upload failed";
      if (nowPlayingName) nowPlayingName.textContent = "Upload failed";
    }
    fileInput.value = "";
  });

  // Play / Pause (anyone can control)
  playPauseBtn.addEventListener("click", () => {
    if (!audio.src || !socket) return;
    if (audio.paused) {
      initWaveform();
      if (audioContext?.state === "suspended") audioContext.resume();
      audio.play().catch(() => {});
      socket.emit("play");
    } else {
      audio.pause();
      socket.emit("pause");
    }
  });

  audio.addEventListener("play", () => {
    playIcon.classList.add("icon-hidden");
    pauseIcon.classList.remove("icon-hidden");
    nowPlayingSection?.classList.add("is-playing");
  });
  audio.addEventListener("pause", () => {
    pauseIcon.classList.add("icon-hidden");
    playIcon.classList.remove("icon-hidden");
    nowPlayingSection?.classList.remove("is-playing");
  });

  // Seek bar (anyone can control)
  seekBar.addEventListener("input", () => {
    if (!audio.duration || isSeekingBySync) return;
    const pct = Number(seekBar.value);
    seekBar.style.setProperty("--progress", `${pct}%`);
    const time = (pct / 100) * audio.duration;
    currentTimeEl.textContent = formatTime(time);
    audio.currentTime = time;
    if (socket) socket.emit("seek", time);
  });

  audio.addEventListener("timeupdate", () => {
    if (isSeekingBySync || !audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    if (Math.abs(pct - Number(seekBar.value)) > 0.5) {
      seekBar.value = pct;
      seekBar.style.setProperty("--progress", `${pct}%`);
    }
    currentTimeEl.textContent = formatTime(audio.currentTime);
  });

  audio.addEventListener("durationchange", () => {
    durationEl.textContent = formatTime(audio.duration);
  });

  // Volume
  volumeBar.addEventListener("input", () => {
    audio.volume = Number(volumeBar.value) / 100;
    volumeBar.style.setProperty("--progress", `${volumeBar.value}%`);
  });
  // Bootstrap
  setupLogin();
  setupVisibilityHandling();
  initSocket();
  refreshSavedList();
  drawWaveform();
}

all();
