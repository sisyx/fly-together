(function () {
  const audio = document.getElementById('audio');
  const fileInput = document.getElementById('fileInput');
  const uploadSection = document.getElementById('uploadSection');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const seekBar = document.getElementById('seekBar');
  const currentTimeEl = document.getElementById('currentTime');
  const durationEl = document.getElementById('duration');
  const volumeBar = document.getElementById('volumeBar');
  const trackNameEl = document.getElementById('trackName');
  const usersCountEl = document.getElementById('usersCount');
  const roleBadgeEl = document.getElementById('roleBadge');
  const connectionStatus = document.getElementById('connectionStatus');
  const statusText = connectionStatus.querySelector('.status-text');
  const hostRequestWrap = document.getElementById('hostRequestWrap');
  const requestHostBtn = document.getElementById('requestHostBtn');
  const cancelRequestBtn = document.getElementById('cancelRequestBtn');
  const handOverWrap = document.getElementById('handOverWrap');
  const handOverLabel = document.getElementById('handOverLabel');
  const handOverList = document.getElementById('handOverList');
  const savedList = document.getElementById('savedList');
  const savedEmpty = document.getElementById('savedEmpty');
  const coverBackdrop = document.getElementById('coverBackdrop');
  const nowPlayingCover = document.getElementById('nowPlayingCover');
  const nowPlayingPlaceholder = document.getElementById('nowPlayingPlaceholder');
  const nowPlayingImg = document.getElementById('nowPlayingImg');
  const nowPlayingName = document.getElementById('nowPlayingName');
  const waveformCanvas = document.getElementById('waveformCanvas');

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
  const WAVEFORM_BAR_COUNT = 20;
  const waveformData = new Uint8Array(128);

  function initWaveform() {
    if (waveformInitialized || !audio.src) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioContext = new Ctx();
      const source = audioContext.createMediaElementSource(audio);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      analyser.minDecibels = -70;
      analyser.maxDecibels = -25;
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      waveformInitialized = true;
    } catch (e) {
      console.warn('Waveform init failed', e);
    }
  }

  function drawWaveform() {
    if (!waveformCanvas) {
      requestAnimationFrame(drawWaveform);
      return;
    }
    const ctx = waveformCanvas.getContext('2d');
    if (!ctx) {
      requestAnimationFrame(drawWaveform);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const rect = waveformCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (waveformCanvas.width !== w * dpr || waveformCanvas.height !== h * dpr) {
      waveformCanvas.width = w * dpr;
      waveformCanvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }
    ctx.clearRect(0, 0, w, h);

    if (analyser && audio.src && !audio.paused) {
      analyser.getByteFrequencyData(waveformData);
      const barCount = Math.min(WAVEFORM_BAR_COUNT, waveformData.length);
      const barWidth = w / barCount;
      const gap = Math.max(0.5, barWidth * 0.15);
      const barW = Math.max(1, barWidth - gap);
      for (let i = 0; i < barCount; i++) {
        const idx = i
        const value = waveformData[idx] / 255;
        const barH = Math.max(2, value * h);
        const x = i * barWidth + (barWidth - barW) / 2;
        const y = h - barH;
        const opacity = 0.25 + value * 0.5;
        ctx.fillStyle = `rgba(167, 139, 250, ${opacity})`;
        ctx.fillRect(x, y, barW, barH);
      }
    } else {
      ctx.fillStyle = 'rgba(167, 139, 250, 0.06)';
      ctx.fillRect(0, h - 1, w, 1);
    }
    requestAnimationFrame(drawWaveform);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function setConnectionStatus(connected) {
    connectionStatus.classList.toggle('connected', connected);
    connectionStatus.classList.toggle('disconnected', !connected);
    statusText.textContent = connected ? 'Connected' : 'Disconnected';
  }

  function setRole(host) {
    isHost = host;
    roleBadgeEl.textContent = isHost ? 'Host' : 'Listener';
    roleBadgeEl.className = 'role-badge ' + (isHost ? 'host' : 'listener');
    if (uploadSection) uploadSection.style.visibility = 'visible';
    if (hostRequestWrap) hostRequestWrap.style.display = isHost ? 'none' : 'block';
    if (handOverWrap) handOverWrap.style.display = isHost ? 'block' : 'none';
    updateHandOverUI();
  }

  function updateUsersCount(count) {
    usersCountEl.textContent = count === 1 ? '1 listener' : `${count} listeners`;
  }

  function updateHandOverUI() {
    if (!handOverLabel || !handOverList) return;
    const count = hostRequestIds.length;
    handOverLabel.textContent =
      count === 0
        ? 'No requests to be host'
        : count === 1
          ? '1 person wants to be host'
          : `${count} people want to be host`;
    handOverList.textContent = '';
    hostRequestIds.forEach((id, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary btn-hand-over';
      btn.textContent = `Hand over to requester ${i + 1}`;
      btn.addEventListener('click', () => {
        if (socket) socket.emit('hand-over-host', id);
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
        coverBackdrop.classList.add('has-cover');
      } else {
        coverBackdrop.style.backgroundImage = '';
        coverBackdrop.classList.remove('has-cover');
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
        nowPlayingImg.removeAttribute('src');
        nowPlayingImg.hidden = true;
        nowPlayingPlaceholder.hidden = false;
      }
    }
  }

  function loadTrack(url, name, coverDataUrl, autoPlay) {
    const displayName = name || 'Current track';
    trackNameEl.textContent = displayName;
    if (nowPlayingName) nowPlayingName.textContent = displayName;
    setCover(coverDataUrl || null);
    audio.src = url || '';
    seekBar.value = 0;
    currentTimeEl.textContent = '0:00';
    durationEl.textContent = '0:00';
    playPauseBtn.disabled = !url;
    if (url) {
      audio.load();
      if (autoPlay) {
        initWaveform();
        if (audioContext?.state === 'suspended') audioContext.resume();
        audio.play().catch(() => { });
        if (socket) socket.emit('play');
      }
    }
  }

  async function fetchSavedTracks() {
    try {
      const res = await fetch('/api/saved');
      const data = await res.json();
      return data.saved || [];
    } catch {
      return [];
    }
  }

  const playIconSvg = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const downloadIconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const removeIconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  function renderSavedList(tracks) {
    if (!savedList || !savedEmpty) return;
    const scrollY = window.scrollY;
    savedList.innerHTML = '';
    if (tracks.length === 0) {
      savedEmpty.style.display = 'block';
      return;
    }
    savedEmpty.style.display = 'none';
    // Newest first
    const sorted = [...tracks].sort((a, b) => {
      const aAt = a.savedAt ? new Date(a.savedAt).getTime() : 0;
      const bAt = b.savedAt ? new Date(b.savedAt).getTime() : 0;
      return bAt - aAt;
    });
    sorted.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'saved-card';
      const name = t.originalName || t.filename || 'Track';
      card.innerHTML = `
        <div class="saved-card-cover-wrap">
          <div class="saved-card-cover">
            <svg class="saved-card-cover-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
          <button type="button" class="btn saved-card-play-overlay" title="Set as current track for everyone" aria-label="Play">
            ${playIconSvg}
          </button>
        </div>
        <div class="saved-card-body">
          <div class="saved-item-name" title="${name.replace(/"/g, '&quot;')}">${name.replace(/</g, '&lt;')}</div>
          <div class="saved-item-actions"></div>
        </div>
      `;
      const actions = card.querySelector('.saved-item-actions');
      const playBtn = card.querySelector('.saved-card-play-overlay');
      playBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const r = await fetch(`/api/saved/${t.id}/set-current`, { method: 'POST' });
          const track = await r.json();
          if (track.url) loadTrack(track.url, track.originalName, null, true);
        } catch (e) { console.error(e); }
      });

      const downloadLink = document.createElement('a');
      downloadLink.href = `/api/saved/${t.id}/download`;
      downloadLink.download = t.originalName || 'track';
      downloadLink.className = 'btn btn-saved-action btn-saved-download';
      downloadLink.title = 'Download file';
      downloadLink.innerHTML = downloadIconSvg;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-saved-action btn-saved-remove';
      removeBtn.title = 'Remove from saved list';
      removeBtn.innerHTML = removeIconSvg;
      removeBtn.addEventListener('click', async () => {
        try {
          const r = await fetch(`/api/saved/${t.id}`, { method: 'DELETE' });
          if (r.ok) await refreshSavedList();
        } catch (e) { console.error(e); }
      });

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
    if (Number.isFinite(currentTime) && Math.abs(audio.currentTime - currentTime) > SEEK_SYNC_THRESHOLD) {
      audio.currentTime = currentTime;
      seekBar.value = audio.duration ? (currentTime / audio.duration) * 100 : 0;
      currentTimeEl.textContent = formatTime(currentTime);
    }
    if (playing && audio.src && audio.paused) {
      audio.play().catch(() => { });
    } else if (!playing && !audio.paused) {
      audio.pause();
    }
  }

  function startPositionSync() {
    stopPositionSync();
    positionSyncTimer = setInterval(() => {
      if (!socket || !isHost || !audio.src) return;
      if (audio.readyState >= 2) {
        socket.emit('position', {
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
    if (typeof io === 'undefined') {
      setConnectionStatus(false);
      statusText.textContent = 'Socket.IO not loaded — open the app at http://localhost:3000 (not file:// or another server)';
      return;
    }
    const opts = {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 20,
      timeout: 10000,
      transports: ['polling', 'websocket'],
    };
    try {
      socket = io(opts);
    } catch (err) {
      console.error('Socket.IO init failed:', err);
      setConnectionStatus(false);
      statusText.textContent = 'Connection failed (check console)';
      return;
    }
    socket.on('connect_error', (err) => {
      console.error('Socket connect_error:', err.message);
      setConnectionStatus(false);
      statusText.textContent = 'Connection failed — use the same URL as the server (e.g. http://localhost:3000)';
    });

    socket.on('connect', () => setConnectionStatus(true));
    socket.on('disconnect', () => setConnectionStatus(false));
    socket.on('connect_error', () => setConnectionStatus(false));

    socket.on('role', (data) => {
      isHost = data.isHost;
      hostId = data.hostId;
      setRole(data.isHost);
      if (data.isHost) startPositionSync();
      else stopPositionSync();
    });

    socket.on('state-sync', (data) => {
      if (data.track) {
        loadTrack(data.track.url, data.track.originalName);
      }
      applyPlaybackState(data.playing, data.currentTime);
      if (data.duration) {
        durationEl.textContent = formatTime(data.duration);
        if (audio.duration) seekBar.max = 100;
      }
    });

    socket.on('track-changed', (track) => {
      if (track) loadTrack(track.url, track.originalName);
    });

    socket.on('play', () => {
      if (audio.src) {
        if (audioContext?.state === 'suspended') audioContext.resume();
        audio.play().catch(() => { });
      }
    });

    socket.on('pause', () => audio.pause());

    socket.on('seek', (time) => {
      isSeekingBySync = true;
      audio.currentTime = time;
      if (audio.duration) seekBar.value = (time / audio.duration) * 100;
      currentTimeEl.textContent = formatTime(time);
      setTimeout(() => { isSeekingBySync = false; }, 100);
    });

    socket.on('position-sync', (data) => {
      if (isHost) return;
      if (Number.isFinite(data.currentTime) && Math.abs(audio.currentTime - data.currentTime) > SEEK_SYNC_THRESHOLD) {
        isSeekingBySync = true;
        audio.currentTime = data.currentTime;
        if (audio.duration) seekBar.value = (data.currentTime / audio.duration) * 100;
        currentTimeEl.textContent = formatTime(data.currentTime);
        setTimeout(() => { isSeekingBySync = false; }, 100);
      }
      if (Number.isFinite(data.duration)) {
        durationEl.textContent = formatTime(data.duration);
      }
    });

    socket.on('host-changed', (newHostId) => {
      hostId = newHostId;
      isHost = socket && socket.id === newHostId;
      setRole(isHost);
      if (isHost) startPositionSync();
      else stopPositionSync();
    });

    socket.on('host-requests', (ids) => {
      hostRequestIds = ids || [];
      const requested = socket && hostRequestIds.includes(socket.id);
      requestHostBtn.style.display = requested ? 'none' : 'inline-block';
      cancelRequestBtn.style.display = requested ? 'inline-block' : 'none';
      if (isHost) updateHandOverUI();
    });

    socket.on('users-count', updateUsersCount);
  }

  let lastCoverObjectUrl = null;

  function toPictureMime(format) {
    if (!format || typeof format !== 'string') return 'image/jpeg';
    const f = format.toLowerCase().trim();
    if (f === 'image/jpeg' || f === 'image/jpg' || f === 'jpeg' || f === 'jpg') return 'image/jpeg';
    if (f === 'image/png' || f === 'png') return 'image/png';
    if (f === 'image/gif' || f === 'gif') return 'image/gif';
    if (f.startsWith('image/')) return f;
    return 'image/jpeg';
  }

  function extractCoverFromFile(file, onDone) {
    if (typeof jsmediatags === 'undefined') {
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
        const bytes = picture.data instanceof Uint8Array ? picture.data : new Uint8Array(picture.data);
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
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('audio', file);
    try {
      const res = await fetch('/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.url) {
        extractCoverFromFile(file, (coverDataUrl) => {
          loadTrack(data.url, data.originalName || file.name, coverDataUrl, true);
        });
        await refreshSavedList();
      }
      if (!res.ok) throw new Error(data.error || 'Upload failed');
    } catch (err) {
      console.error(err);
      trackNameEl.textContent = 'Upload failed';
      if (nowPlayingName) nowPlayingName.textContent = 'Upload failed';
    }
    fileInput.value = '';
  });

  // Play / Pause (anyone can control)
  playPauseBtn.addEventListener('click', () => {
    if (!audio.src || !socket) return;
    if (audio.paused) {
      initWaveform();
      if (audioContext?.state === 'suspended') audioContext.resume();
      audio.play().catch(() => { });
      socket.emit('play');
    } else {
      audio.pause();
      socket.emit('pause');
    }
  });

  audio.addEventListener('play', () => {
    playIcon.classList.add('icon-hidden');
    pauseIcon.classList.remove('icon-hidden');
  });
  audio.addEventListener('pause', () => {
    pauseIcon.classList.add('icon-hidden');
    playIcon.classList.remove('icon-hidden');
  });

  // Seek bar (anyone can control)
  seekBar.addEventListener('input', () => {
    if (!audio.duration || isSeekingBySync) return;
    const pct = Number(seekBar.value);
    const time = (pct / 100) * audio.duration;
    currentTimeEl.textContent = formatTime(time);
    audio.currentTime = time;
    if (socket) socket.emit('seek', time);
  });

  audio.addEventListener('timeupdate', () => {
    if (isSeekingBySync || !audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    if (Math.abs(pct - Number(seekBar.value)) > 0.5) seekBar.value = pct;
    currentTimeEl.textContent = formatTime(audio.currentTime);
  });

  audio.addEventListener('durationchange', () => {
    durationEl.textContent = formatTime(audio.duration);
  });

  // Volume
  volumeBar.addEventListener('input', () => {
    audio.volume = Number(volumeBar.value) / 100;
  });

  // Host request / handover
  requestHostBtn.addEventListener('click', () => {
    if (socket) socket.emit('request-host');
  });
  cancelRequestBtn.addEventListener('click', () => {
    if (socket) socket.emit('cancel-host-request');
  });

  // Host vote: request to be host (listeners)
  if (requestHostBtn) {
    requestHostBtn.addEventListener('click', () => {
      if (socket) socket.emit('request-host');
    });
  }
  if (cancelRequestBtn) {
    cancelRequestBtn.addEventListener('click', () => {
      if (socket) socket.emit('cancel-host-request');
    });
  }

  // Bootstrap
  initSocket();
  refreshSavedList();
  drawWaveform();
})();
