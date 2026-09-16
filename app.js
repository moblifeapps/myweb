// ---------- Transport: WebSocket, works identically in the app's own WebView2 window and a
// regular browser tab pointed at the public site. Desktop mode connects straight to a local plain
// ws:// port passed via query string; browser mode first asks a fixed discovery beacon for the
// current wss:// port, since that port can vary if the usual one was already taken. ----------
let ws = null;
let wsReady = false;
const pendingMessages = [];

const _urlParams = new URLSearchParams(window.location.search);
const IS_DESKTOP = _urlParams.get('mode') === 'desktop' || window.__FORCE_DESKTOP === true;
const DISCOVERY_URL = 'http://127.0.0.1:49299/';
const WS_HOST = 'mywbsck.mlapplications.com';

function postToHost(action, payload) {
  const msg = { type: action, payload: payload || {} };
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    pendingMessages.push(msg); // flushed once the connection opens
  }
}

function connectWs(port, secure) {
  const url = secure ? `wss://${WS_HOST}:${port}/ws` : `ws://127.0.0.1:${port}/ws`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    wsReady = true;
    while (pendingMessages.length) ws.send(JSON.stringify(pendingMessages.shift()));
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    dispatchFromHost(msg.type, msg.payload);
  };

  ws.onclose = () => {
    wsReady = false;
    setTimeout(() => connectWs(port, secure), 2000); // basic reconnect - the app may still be starting up
  };

  ws.onerror = () => { /* onclose fires right after and handles reconnect */ };
}

function dispatchFromHost(action, payload) {
  switch (action) {
    case 'videoSelecting': onVideoSelecting(payload); break;
    case 'videoSelected': onVideoSelected(payload); break;
    case 'jobUpdated': onJobUpdated(payload); break;
    case 'queueData': onQueueData(payload); break;
    case 'historyData': onHistoryData(payload); break;
    case 'jobRemoved': onJobRemoved(payload); break;
    case 'historyEntryRemoved': onHistoryData_refresh(); break;
    case 'trimRotateResult': onTrimRotateResult(payload); break;
    case 'init_urls': break; // reserved - Settings/Help/Privacy links are still the hardcoded ones below for now
    case 'error':
      document.getElementById('selectVideoBtn').disabled = false;
      document.getElementById('videoLoadingInfo').classList.add('hidden');
      alert(payload.message);
      break;
  }
}

if (IS_DESKTOP) {
  const wsport = _urlParams.get('wsport') || window.__WS_LOCAL_PORT;
  connectWs(wsport, false);
} else {
  fetch(DISCOVERY_URL, { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      if (!data.wssAvailable) {
        document.body.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#a0a0a8;' +
          'font-family:Segoe UI,sans-serif">AI Video Upscaler+ is running, but browser mode isn\'t ' +
          'available right now (it couldn\'t obtain its security certificate - this usually clears up ' +
          'once it has a working internet connection). You can still use the app window in the meantime.</div>';
        return;
      }
      connectWs(data.wssPort, true);
    })
    .catch(() => {
      document.body.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#a0a0a8;' +
        'font-family:Segoe UI,sans-serif">Could not find AI Video Upscaler+ running on this PC.<br>' +
        'Open the app first, then reload this page.</div>';
    });
}

// ---------- Sidebar navigation ----------
document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'history') postToHost('getHistory');
  });
});

// Settings/Help/Privacy open in the user's actual default browser, not as in-app views - same
// pattern as ImTalking's external page links, just pointing at ai_videoupscaler_* instead of
// imtalking_* on the website. The C# host launches the real browser; this page never navigates.
const externalPageUrls = {
  settings: 'https://mlapplications.com/ai_videoupscaler_settings.html',
  help: 'https://mlapplications.com/ai_videoupscaler_help.html',
  privacy: 'https://mlapplications.com/ai_videoupscaler_privacy.html'
};

document.querySelectorAll('.nav-item[data-external]').forEach(btn => {
  btn.addEventListener('click', () => {
    const url = externalPageUrls[btn.dataset.external];
    if (url) postToHost('openExternalUrl', { url });
  });
});

// ---------- Add video flow ----------
let pendingVideoPath = null;
let pendingVideoInfo = null;
let previewRotation = 0; // 0/90/180/270, cycled by the rotate button
let trimStartSeconds = 0;
let trimEndSeconds = 0; // 0 means "not set / to the end"

document.getElementById('selectVideoBtn').addEventListener('click', () => {
  if (!wsReady) {
    alert('Not connected to AI Video Upscaler+ yet. Please wait a moment and try again - ' +
      'if this persists, make sure the app is running.');
    return;
  }
  postToHost('selectVideo');
});

function onVideoSelecting(payload) {
  document.getElementById('selectVideoBtn').disabled = true;
  document.getElementById('pendingSettings').classList.add('hidden');
  document.getElementById('previewPanel').classList.add('hidden');
  document.getElementById('videoLoadingInfo').classList.remove('hidden');
}

// Video preview/trim/rotate now happens in a native WPF window (VideoEditorWindow), not here - it
// uses FFmpeg's own decoder directly, so it isn't limited by whatever codecs Chromium's <video>
// element happens to support. This page just shows a thumbnail/summary and launches that window.
function onVideoSelected(payload) {
  document.getElementById('selectVideoBtn').disabled = false;
  document.getElementById('videoLoadingInfo').classList.add('hidden');

  pendingVideoPath = payload.path;
  pendingVideoInfo = payload;
  previewRotation = 0;
  trimStartSeconds = 0;
  trimEndSeconds = 0;

  document.getElementById('previewFilename').textContent = payload.name;

  const thumb = document.getElementById('previewThumb');
  if (payload.thumbnailDataUri) {
    thumb.src = payload.thumbnailDataUri;
    thumb.classList.remove('hidden');
  } else {
    thumb.classList.add('hidden');
  }

  const details = [];
  if (payload.width && payload.height) details.push(`${payload.width}\u00d7${payload.height}`);
  if (payload.fps) details.push(`${Math.round(payload.fps)} fps`);
  if (payload.codec) details.push(payload.codec.toUpperCase());
  if (payload.duration) details.push(formatDuration(payload.duration));
  if (payload.fileSizeBytes) details.push(formatBytes(payload.fileSizeBytes));
  document.getElementById('previewDetails').textContent = details.join(' \u00b7 ');

  updateEditSummary();
  document.getElementById('previewPanel').classList.remove('hidden');
}

document.getElementById('openEditorBtn').addEventListener('click', () => {
  postToHost('openTrimRotateEditor', { path: pendingVideoPath });
});

function onTrimRotateResult(payload) {
  if (payload.cancelled) return;
  previewRotation = payload.rotation || 0;
  trimStartSeconds = payload.trimStartSeconds || 0;
  trimEndSeconds = payload.trimEndSeconds || 0;
  updateEditSummary();
}

function updateEditSummary() {
  const parts = [];
  if (previewRotation) parts.push(`rotate ${previewRotation}\u00b0`);
  if (trimEndSeconds > trimStartSeconds) parts.push(`trim ${formatDuration(trimStartSeconds)}\u2013${formatDuration(trimEndSeconds)}`);
  document.getElementById('editSummary').textContent = parts.length ? parts.join(' \u00b7 ') : 'No edits';
}

document.getElementById('cancelPreviewBtn').addEventListener('click', () => {
  pendingVideoPath = null;
  pendingVideoInfo = null;
  document.getElementById('previewPanel').classList.add('hidden');
});

document.getElementById('continueToSettingsBtn').addEventListener('click', () => {
  document.getElementById('previewPanel').classList.add('hidden');

  document.getElementById('pendingFilename').textContent = pendingVideoInfo.name;

  const thumb = document.getElementById('pendingThumb');
  if (pendingVideoInfo.thumbnailDataUri) {
    thumb.src = pendingVideoInfo.thumbnailDataUri;
    thumb.classList.remove('hidden');
  } else {
    thumb.classList.add('hidden');
  }

  const details = [];
  if (pendingVideoInfo.width && pendingVideoInfo.height) details.push(`${pendingVideoInfo.width}\u00d7${pendingVideoInfo.height}`);
  if (pendingVideoInfo.fps) details.push(`${Math.round(pendingVideoInfo.fps)} fps`);
  if (pendingVideoInfo.codec) details.push(pendingVideoInfo.codec.toUpperCase());
  if (pendingVideoInfo.duration) details.push(formatDuration(pendingVideoInfo.duration));
  if (pendingVideoInfo.fileSizeBytes) details.push(formatBytes(pendingVideoInfo.fileSizeBytes));
  if (previewRotation) details.push(`rotate ${previewRotation}\u00b0`);
  if (trimEndSeconds > trimStartSeconds) details.push(`trimmed to ${formatDuration(trimEndSeconds - trimStartSeconds)}`);
  document.getElementById('sourceDetails').textContent = details.join(' \u00b7 ');

  document.getElementById('pendingSettings').classList.remove('hidden');
});

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

document.getElementById('strengthSlider').addEventListener('input', (e) => {
  document.getElementById('strengthValue').textContent = e.target.value + '%';
});

document.getElementById('cancelAddBtn').addEventListener('click', () => {
  pendingVideoPath = null;
  pendingVideoInfo = null;
  document.getElementById('pendingSettings').classList.add('hidden');
});

document.getElementById('addToQueueBtn').addEventListener('click', () => {
  if (!pendingVideoPath) return;
  const targetHeight = parseInt(document.getElementById('targetHeightSelect').value, 10);
  const strength = parseInt(document.getElementById('strengthSlider').value, 10) / 100;
  const targetFps = parseInt(document.getElementById('targetFpsSelect').value, 10);

  postToHost('enqueueJob', {
    inputPath: pendingVideoPath,
    targetHeight,
    gfpganStrength: strength,
    targetFps,
    sourceWidth: pendingVideoInfo?.width || 0,
    sourceHeight: pendingVideoInfo?.height || 0,
    sourceFps: pendingVideoInfo?.fps || 0,
    sourceCodec: pendingVideoInfo?.codec || null,
    sourceDurationSeconds: pendingVideoInfo?.duration || 0,
    fileSizeBytes: pendingVideoInfo?.fileSizeBytes || 0,
    thumbnailDataUri: pendingVideoInfo?.thumbnailDataUri || null,
    manualRotation: previewRotation || null,
    trimStartSeconds: trimStartSeconds,
    trimEndSeconds: trimEndSeconds
  });

  pendingVideoPath = null;
  pendingVideoInfo = null;
  previewRotation = 0;
  trimStartSeconds = 0;
  trimEndSeconds = 0;
  document.getElementById('pendingSettings').classList.add('hidden');
});

// ---------- Queue rendering ----------
const jobs = new Map(); // id -> job

function onJobUpdated(job) {
  jobs.set(job.id, job);
  renderQueue();
}

function onQueueData(jobList) {
  jobList.forEach(j => jobs.set(j.id, j));
  renderQueue();
}

function renderQueue() {
  const list = document.getElementById('queueList');
  const empty = document.getElementById('queueEmpty');
  const active = Array.from(jobs.values()).filter(j => j.status !== 'Completed');

  if (active.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = active.map(renderJobCard).join('');

  active.forEach(job => {
    const cancelBtn = document.getElementById('cancel-' + job.id);
    if (cancelBtn) cancelBtn.addEventListener('click', () => postToHost('cancelJob', { jobId: job.id }));

    const clearBtn = document.getElementById('clear-' + job.id);
    if (clearBtn) clearBtn.addEventListener('click', () => postToHost('removeJob', { jobId: job.id }));
  });
}

function onJobRemoved(payload) {
  jobs.delete(payload.jobId);
  renderQueue();
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

function renderJobCard(job) {
  const name = job.inputPath ? job.inputPath.split('\\').pop() : '';
  const isActive = ['Queued', 'Extracting', 'Processing', 'Encoding'].includes(job.status);
  const isDone = ['Cancelled', 'Failed'].includes(job.status);
  const statusClass = 'status-' + job.status.toLowerCase();

  const metaParts = [];
  if (job.sourceWidth && job.sourceHeight) metaParts.push(`${job.sourceWidth}\u00d7${job.sourceHeight}`);
  if (job.sourceFps) metaParts.push(`${Math.round(job.sourceFps)} fps`);
  if (job.sourceCodec) metaParts.push(job.sourceCodec.toUpperCase());
  if (job.fileSizeBytes) metaParts.push(formatBytes(job.fileSizeBytes));

  const thumb = job.thumbnailDataUri
    ? `<img class="job-thumb" src="${job.thumbnailDataUri}" alt="">`
    : `<div class="job-thumb job-thumb-placeholder"></div>`;

  return `
    <div class="job-card${isActive ? ' job-card-active' : ''}">
      <div class="job-card-row">
        ${thumb}
        <div class="job-card-body">
          <div class="job-card-top">
            <div class="job-name">${name}</div>
            <div class="job-status ${statusClass}">${job.status}</div>
          </div>
          ${metaParts.length ? `<div class="job-source-meta">${metaParts.join(' &middot; ')}</div>` : ''}
          <div class="progress-bar-outer${isActive ? ' progress-bar-active' : ''}">
            <div class="progress-bar-inner" style="width:${job.progressPercent || 0}%"></div>
          </div>
          <div class="job-meta">${job.statusDetail ? job.statusDetail : (job.progressPercent || 0) + '%'}${job.targetHeight ? ' &middot; target ' + job.targetHeight + 'p' : ' &middot; native 4x'}</div>
          ${job.errorMessage ? `<div class="job-error">${job.errorMessage}</div>` : ''}
          <div class="job-actions">
            ${isActive ? `<button class="cancel-btn" id="cancel-${job.id}">Cancel</button>` : ''}
            ${isDone ? `<button class="cancel-btn" id="clear-${job.id}">Clear</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

// ---------- History rendering ----------
function onHistoryData_refresh() {
  postToHost('getHistory');
}

function onHistoryData(historyList) {
  const list = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');

  if (!historyList || historyList.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = historyList.map(renderHistoryCard).join('');

  historyList.forEach(job => {
    const playBtn = document.getElementById('play-' + job.id);
    if (playBtn) playBtn.addEventListener('click', () => postToHost('playVideo', { path: job.outputPath }));

    const folderBtn = document.getElementById('folder-' + job.id);
    if (folderBtn) folderBtn.addEventListener('click', () => postToHost('openFolder', { path: job.outputPath }));

    const clearBtn = document.getElementById('clearhist-' + job.id);
    if (clearBtn) clearBtn.addEventListener('click', () => postToHost('removeHistoryEntry', { jobId: job.id }));
  });
}

function renderHistoryCard(job) {
  const name = job.inputPath ? job.inputPath.split('\\').pop() : '';
  const elapsed = job.elapsed ? formatElapsed(job.elapsed) : '';
  const thumb = job.thumbnailDataUri
    ? `<img class="job-thumb" src="${job.thumbnailDataUri}" alt="">`
    : `<div class="job-thumb job-thumb-placeholder"></div>`;

  const detailParts = [];
  if (job.outputWidth && job.outputHeight) detailParts.push(`${job.outputWidth}\u00d7${job.outputHeight}`);
  if (job.outputFps) detailParts.push(`${Math.round(job.outputFps)} fps`);
  if (job.outputCodec) detailParts.push(job.outputCodec.toUpperCase());
  if (job.outputFileSizeBytes) detailParts.push(formatBytes(job.outputFileSizeBytes));

  return `
    <div class="job-card">
      <div class="job-card-row">
        ${thumb}
        <div class="job-card-body">
          <div class="job-card-top">
            <div class="job-name">${name}</div>
            <div class="job-status status-completed">${job.status}</div>
          </div>
          ${detailParts.length ? `<div class="job-source-meta">${detailParts.join(' &middot; ')}</div>` : ''}
          <div class="job-meta">${elapsed ? 'Took ' + elapsed + ' &middot; ' : ''}${job.outputPath}</div>
          <div class="job-actions">
            <button class="cancel-btn" id="play-${job.id}">&#9654; Play</button>
            <button class="cancel-btn" id="folder-${job.id}">Open Folder</button>
            <button class="cancel-btn" id="clearhist-${job.id}">Clear</button>
          </div>
        </div>
      </div>
    </div>`;
}

function formatElapsed(elapsed) {
  // System.TimeSpan serializes as "hh:mm:ss.fffffff"
  const parts = elapsed.split(':');
  if (parts.length < 3) return elapsed;
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10), s = Math.round(parseFloat(parts[2]));
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------- Initial load ----------
postToHost('getQueue');
