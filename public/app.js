(() => {
  // Application State
  let currentSessionId = 1;
  let sessions = [];
  let currentReports = null;
  let currentRoster = [];
  let currentGroups = [];
  let recentCheckins = [];
  let activeReportFilter = 'all';
  let activeReportGroup = '';
  let activeReportSearch = '';
  let pendingAttendee = null;
  let currentUser = null;
  let deferredInstallPrompt = null;
  let syncTimer = null;

  // Scanner state
  let videoStream = null;
  let isScanning = false;
  let scanBusy = false;
  let selectedCamera = null;
  const canvas = document.createElement('canvas');
  const canvasContext = canvas.getContext('2d', { willReadFrequently: true });

  // DOM Elements
  const video = document.querySelector('#video');
  const cameraEmpty = document.querySelector('#camera-empty');
  const scanReticle = document.querySelector('#scan-reticle');
  const startBtn = document.querySelector('#start');
  const stopBtn = document.querySelector('#stop');
  const againBtn = document.querySelector('#again');
  const cameraLabel = document.querySelector('#camera-label');
  const camerasSelect = document.querySelector('#cameras');
  const cameraStatus = document.querySelector('#camera-status');
  const sessionSelect = document.querySelector('#session-select');
  const toastContainer = document.querySelector('#toast-container');
  const syncStatusBadge = document.querySelector('#sync-status-badge');
  const syncStatusText = document.querySelector('#sync-status-text');
  const offlineBanner = document.querySelector('#offline-banner');

  // User & Header Elements
  const userDisplayName = document.querySelector('#user-display-name');
  const userRoleBadge = document.querySelector('#user-role-badge');
  const btnSwitchUser = document.querySelector('#btn-switch-user');
  const btnInstallPwa = document.querySelector('#btn-install-pwa');
  const btnOpenSessionModal = document.querySelector('#btn-open-session-modal');

  // Confirmation Modal Elements
  const modalConfirm = document.querySelector('#modal-confirm');
  const modalAvatar = document.querySelector('#modal-avatar');
  const modalPersonName = document.querySelector('#modal-person-name');
  const modalPersonId = document.querySelector('#modal-person-id');
  const modalPersonGroup = document.querySelector('#modal-person-group');
  const modalStatusBadge = document.querySelector('#modal-status-badge');
  const modalVerifierName = document.querySelector('#modal-verifier-name');
  const modalTimeInfo = document.querySelector('#modal-time-info');
  const modalConfirmBtn = document.querySelector('#modal-confirm-btn');
  const modalCancelBtn = document.querySelector('#modal-cancel-btn');
  const modalCloseBtn = document.querySelector('#modal-close-btn');

  // Login Modal Elements
  const modalLogin = document.querySelector('#modal-login');
  const formLogin = document.querySelector('#form-login');
  const loginUsernameInput = document.querySelector('#login-username');
  const loginPasswordInput = document.querySelector('#login-password');
  const modalLoginClose = document.querySelector('#modal-login-close');
  const modalLoginCancel = document.querySelector('#modal-login-cancel');

  // -------------------------------------------------------------
  // API HELPER
  // -------------------------------------------------------------
  function getAuthToken() {
    return localStorage.getItem('qrpass_auth_token') || '';
  }

  function setAuthToken(token) {
    if (token) {
      localStorage.setItem('qrpass_auth_token', token);
      document.cookie = `qrpass_token=${encodeURIComponent(token)}; path=/; max-age=2592000; SameSite=Lax`;
    } else {
      localStorage.removeItem('qrpass_auth_token');
      document.cookie = 'qrpass_token=; path=/; max-age=0; SameSite=Lax';
    }
  }

  async function api(path, options = {}) {
    const token = getAuthToken();
    const headers = {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    };

    const res = await fetch(path, {
      ...options,
      headers
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Toast Notification
  function showToast(message, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast-notice ${type}`;
    toast.textContent = message;
    toastContainer.append(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity 0.25s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  function formatTime(unixSec) {
    if (!unixSec) return '—';
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(unixSec * 1000));
  }

  function formatDate(unixSec) {
    if (!unixSec) return '—';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(unixSec * 1000));
  }

  // -------------------------------------------------------------
  // AUTHENTICATION & ROLE MANAGEMENT
  // -------------------------------------------------------------
  async function initAuth() {
    const token = getAuthToken();
    if (token) {
      try {
        const data = await api('/api/auth/me');
        if (data.user) {
          setUser(data.user);
          return;
        }
      } catch {
        setAuthToken('');
      }
    }

    // Default auto-login to supervisor1 for instant frictionless experience
    try {
      const loginRes = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'supervisor1', password: 'supervisor123' })
      });
      setAuthToken(loginRes.token);
      setUser(loginRes.user);
    } catch {
      // If default login fails, show login modal
      openLoginModal();
    }
  }

  function setUser(user) {
    currentUser = user;
    userDisplayName.textContent = user.displayName || user.username;
    userRoleBadge.textContent = (user.role || 'supervisor').toUpperCase();

    if (user.role === 'admin') {
      userRoleBadge.style.background = '#106356';
      document.querySelectorAll('.admin-only').forEach(el => el.hidden = false);
      if (btnOpenSessionModal) btnOpenSessionModal.hidden = false;
    } else {
      userRoleBadge.style.background = '#ff662a';
      document.querySelectorAll('.admin-only').forEach(el => el.hidden = true);
      if (btnOpenSessionModal) btnOpenSessionModal.hidden = true;

      // If user was on an admin tab, switch to scanner
      const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
      if (activeTab === 'roster' || activeTab === 'supervisors' || activeTab === 'settings') {
        switchTab('scanner');
      }
    }
  }

  function openLoginModal() {
    modalLogin.hidden = false;
    loginUsernameInput.focus();
  }

  function closeLoginModal() {
    modalLogin.hidden = true;
  }

  btnSwitchUser?.addEventListener('click', openLoginModal);
  modalLoginClose?.addEventListener('click', closeLoginModal);
  modalLoginCancel?.addEventListener('click', closeLoginModal);

  formLogin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = loginUsernameInput.value.trim();
    const password = loginPasswordInput.value.trim();
    if (!username || !password) return;

    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      setAuthToken(data.token);
      setUser(data.user);
      closeLoginModal();
      formLogin.reset();
      showToast(`Logged in as ${data.user.displayName}`, 'success');
      loadSessions();
      loadReports();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Quick Sign-in helpers
  document.querySelector('#btn-quick-login-sup1')?.addEventListener('click', async () => {
    loginUsernameInput.value = 'supervisor1';
    loginPasswordInput.value = 'supervisor123';
    formLogin.requestSubmit();
  });

  document.querySelector('#btn-quick-login-sup2')?.addEventListener('click', async () => {
    loginUsernameInput.value = 'supervisor2';
    loginPasswordInput.value = 'supervisor123';
    formLogin.requestSubmit();
  });

  document.querySelector('#btn-quick-login-admin')?.addEventListener('click', async () => {
    loginUsernameInput.value = 'admin';
    loginPasswordInput.value = 'admin123';
    formLogin.requestSubmit();
  });

  // -------------------------------------------------------------
  // NAVIGATION TABS
  // -------------------------------------------------------------
  function switchTab(tabName) {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(t => {
      if (t.dataset.tab === tabName) {
        t.classList.add('active');
        t.setAttribute('aria-selected', 'true');
      } else {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      }
    });

    document.querySelectorAll('main > section').forEach(sec => sec.hidden = true);
    const activeSec = document.querySelector(`#view-${tabName}`);
    if (activeSec) activeSec.hidden = false;

    if (tabName === 'reports') loadReports();
    if (tabName === 'roster') loadRoster();
    if (tabName === 'supervisors') loadSupervisors();
    if (tabName === 'settings') loadSettings();
  }

  function initTabs() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
      });
    });
  }

  // -------------------------------------------------------------
  // SESSIONS
  // -------------------------------------------------------------
  async function loadSessions() {
    try {
      const data = await api('/api/sessions');
      sessions = data.sessions || [];
      sessionSelect.innerHTML = '';
      sessions.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name}${s.is_active ? ' (Active)' : ''}`;
        if (s.is_active) {
          opt.selected = true;
          currentSessionId = s.id;
        }
        sessionSelect.append(opt);
      });
      if (sessions.length > 0 && !sessions.some(s => s.is_active)) {
        currentSessionId = sessions[0].id;
      }
    } catch (err) {
      console.warn('Failed to load sessions:', err);
    }
  }

  sessionSelect?.addEventListener('change', async () => {
    currentSessionId = Number(sessionSelect.value);
    showToast(`Switched event to "${sessionSelect.selectedOptions[0]?.text}"`, 'info');
    recentCheckins = [];
    renderRecentCheckins();
    loadReports();
  });

  // Modal: Create Session (Admin only)
  const sessionModal = document.querySelector('#modal-session');
  btnOpenSessionModal?.addEventListener('click', () => {
    sessionModal.hidden = false;
    document.querySelector('#session-name-input').focus();
  });
  document.querySelector('#modal-session-close')?.addEventListener('click', () => sessionModal.hidden = true);
  document.querySelector('#modal-session-cancel')?.addEventListener('click', () => sessionModal.hidden = true);

  document.querySelector('#form-create-session')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.querySelector('#session-name-input');
    const name = nameInput.value.trim();
    if (!name) return;
    try {
      await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      nameInput.value = '';
      sessionModal.hidden = true;
      showToast(`Event "${name}" created and set active!`, 'success');
      await loadSessions();
      loadReports();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // -------------------------------------------------------------
  // CAMERA SCANNER WITH EXPLICIT START & STOP CONTROLS
  // -------------------------------------------------------------
  async function updateCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      if (videoDevices.length > 1) {
        cameraLabel.hidden = false;
        camerasSelect.innerHTML = '';
        videoDevices.forEach((dev, idx) => {
          const opt = document.createElement('option');
          opt.value = dev.deviceId;
          opt.textContent = dev.label || `Camera ${idx + 1}`;
          camerasSelect.append(opt);
        });
        if (selectedCamera) camerasSelect.value = selectedCamera;
      } else {
        cameraLabel.hidden = true;
      }
    } catch {}
  }

  function stopCamera() {
    isScanning = false;
    if (videoStream) {
      videoStream.getTracks().forEach(track => track.stop());
      videoStream = null;
    }
    video.style.display = 'none';
    if (scanReticle) scanReticle.hidden = true;
    cameraEmpty.style.display = 'grid';
    startBtn.hidden = false;
    stopBtn.hidden = true;
    againBtn.hidden = true;
    cameraStatus.textContent = 'Camera is off.';
  }

  async function startCamera() {
    window.BadgeSounds?.unlock();
    stopCamera();
    scanBusy = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraStatus.textContent = 'Camera unavailable. Use manual lookup below.';
      return;
    }

    try {
      cameraStatus.textContent = 'Requesting camera access...';
      const constraints = {
        video: selectedCamera ? { deviceId: { exact: selectedCamera } } : { facingMode: 'environment' }
      };
      videoStream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = videoStream;
      await video.play();

      video.style.display = 'block';
      if (scanReticle) scanReticle.hidden = false;
      cameraEmpty.style.display = 'none';
      startBtn.hidden = true;
      stopBtn.hidden = false;
      againBtn.hidden = true;
      cameraStatus.textContent = 'Ready. Position attendee QR badge in frame.';
      isScanning = true;
      await updateCameras();
      requestAnimationFrame(scanFrame);
    } catch {
      stopCamera();
      cameraStatus.textContent = 'Camera access denied or unavailable. Use manual lookup below.';
    }
  }

  function scanFrame() {
    if (!isScanning) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && !scanBusy && modalConfirm.hidden) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = canvasContext.getImageData(0, 0, canvas.width, canvas.height);
      const qrCode = window.jsQR?.(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert'
      });

      if (qrCode && qrCode.data) {
        handleScannedCode(qrCode.data, 'camera');
      }
    }
    if (isScanning) {
      requestAnimationFrame(scanFrame);
    }
  }

  async function handleScannedCode(rawText, source = 'camera') {
    if (scanBusy) return;
    scanBusy = true;
    window.BadgeSounds?.unlock();

    try {
      cameraStatus.textContent = 'Verifying identifier in database...';
      const result = await api('/api/scan', {
        method: 'POST',
        body: JSON.stringify({
          raw: rawText,
          sessionId: currentSessionId,
          source
        })
      });

      if (!result.found) {
        window.BadgeSounds?.play('not_found');
        cameraStatus.textContent = `Identifier "${result.rawIdentifier}" is not registered in the roster.`;
        showToast(`Identifier "${result.rawIdentifier}" not found.`, 'error');
        setTimeout(() => { scanBusy = false; }, 1600);
        return;
      }

      openConfirmModal(result, source);
    } catch (err) {
      cameraStatus.textContent = 'Error processing scan.';
      showToast(err.message, 'error');
      setTimeout(() => { scanBusy = false; }, 1600);
    }
  }

  function openConfirmModal(scanResult, source) {
    pendingAttendee = {
      ...scanResult.person,
      sessionId: scanResult.sessionId || currentSessionId,
      alreadyPresent: scanResult.alreadyPresent,
      markedAt: scanResult.markedAt,
      source
    };

    const p = scanResult.person;
    modalPersonName.textContent = `${p.firstName} ${p.lastName}`;
    modalPersonId.textContent = p.identifierNumber;
    modalPersonGroup.textContent = p.groupName || 'General';

    const initials = `${p.firstName?.[0] || ''}${p.lastName?.[0] || ''}`.toUpperCase() || 'ID';
    modalAvatar.textContent = initials;

    modalVerifierName.textContent = currentUser?.displayName || 'Supervisor';

    if (scanResult.alreadyPresent) {
      window.BadgeSounds?.play('already_present');
      modalStatusBadge.className = 'attendee-status-badge already';
      modalStatusBadge.textContent = 'Already Checked In';
      modalTimeInfo.textContent = `Check-in recorded at ${formatTime(scanResult.markedAt)}`;
      modalConfirmBtn.textContent = 'Keep Present';
      modalConfirmBtn.className = 'btn-secondary btn-full';
    } else {
      window.BadgeSounds?.play('valid');
      modalStatusBadge.className = 'attendee-status-badge new';
      modalStatusBadge.textContent = 'Ready for Check-in';
      modalTimeInfo.textContent = `Event: ${sessionSelect.selectedOptions[0]?.text || 'Active Event'}`;
      modalConfirmBtn.textContent = 'Mark Present (Enter)';
      modalConfirmBtn.className = 'btn-full';
    }

    modalConfirm.hidden = false;
    modalConfirmBtn.focus();
  }

  function closeConfirmModal() {
    modalConfirm.hidden = true;
    pendingAttendee = null;
    cameraStatus.textContent = 'Ready for next badge.';
    setTimeout(() => { scanBusy = false; }, 400);
  }

  async function confirmMarkPresent() {
    if (!pendingAttendee) return;
    const { id, sessionId, firstName, lastName, identifierNumber, groupName, alreadyPresent, source } = pendingAttendee;

    if (!alreadyPresent) {
      try {
        const markRes = await api('/api/attendance/mark', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            personId: id,
            source: source || 'camera'
          })
        });
        window.BadgeSounds?.play('valid');
        showToast(`${firstName} ${lastName} marked present!`, 'success');

        const supervisorName = markRes.verifiedByName || currentUser?.displayName || 'Supervisor';

        // Add to recent check-ins table
        recentCheckins.unshift({
          firstName,
          lastName,
          identifierNumber,
          groupName,
          scannedAt: markRes.scannedAt,
          verifiedByName: supervisorName
        });
        renderRecentCheckins();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    closeConfirmModal();
  }

  modalConfirmBtn?.addEventListener('click', confirmMarkPresent);
  modalCancelBtn?.addEventListener('click', closeConfirmModal);
  modalCloseBtn?.addEventListener('click', closeConfirmModal);

  window.addEventListener('keydown', (e) => {
    if (!modalConfirm.hidden) {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmMarkPresent();
      } else if (e.key === 'Escape') {
        closeConfirmModal();
      }
    }
  });

  // Recent Check-ins Table
  function renderRecentCheckins() {
    const tbody = document.querySelector('#recent-table-body');
    const countEl = document.querySelector('#recent-count');
    countEl.textContent = `${recentCheckins.length} attendee${recentCheckins.length === 1 ? '' : 's'} checked in`;

    if (recentCheckins.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#6d8496;padding:24px;">No check-ins logged yet in this event. Start scanning above!</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    recentCheckins.slice(0, 12).forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(item.firstName)} ${escapeHtml(item.lastName)}</strong></td>
        <td><span class="tabular">${escapeHtml(item.identifierNumber)}</span></td>
        <td>${escapeHtml(item.groupName || 'General')}</td>
        <td class="tabular">${formatTime(item.scannedAt)}</td>
        <td><span class="supervisor-tag">👤 ${escapeHtml(item.verifiedByName || 'Supervisor')}</span></td>
        <td><span class="badge-status present">✓ Present</span></td>
      `;
      tbody.append(tr);
    });
  }

  // Paste / Manual lookup form
  document.querySelector('#paste-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const hexInput = document.querySelector('#hex');
    const val = hexInput.value.trim();
    if (!val) return;
    window.BadgeSounds?.unlock();
    handleScannedCode(val, 'paste');
    hexInput.value = '';
  });

  startBtn?.addEventListener('click', startCamera);
  stopBtn?.addEventListener('click', stopCamera);
  againBtn?.addEventListener('click', startCamera);
  camerasSelect?.addEventListener('change', () => {
    selectedCamera = camerasSelect.value;
    startCamera();
  });
  document.querySelector('#sound-enabled')?.addEventListener('change', () => window.BadgeSounds?.unlock());
  window.addEventListener('pagehide', stopCamera);

  // -------------------------------------------------------------
  // REPORTS VIEW (Group Attendance & Supervisor Attribution)
  // -------------------------------------------------------------
  async function loadReports(silent = false) {
    try {
      const data = await api(`/api/reports?sessionId=${currentSessionId}`);
      currentReports = data;
      renderReports();

      // If recentCheckins is empty, seed it from the most recent present attendees
      if (recentCheckins.length === 0 && data.groups) {
        const presents = [];
        data.groups.forEach(g => {
          g.members.forEach(m => {
            if (m.isPresent && m.scannedAt) {
              presents.push({
                firstName: m.firstName,
                lastName: m.lastName,
                identifierNumber: m.identifierNumber,
                groupName: m.groupName,
                scannedAt: m.scannedAt,
                verifiedByName: m.verifiedByName
              });
            }
          });
        });
        presents.sort((a, b) => b.scannedAt - a.scannedAt);
        recentCheckins = presents.slice(0, 15);
        renderRecentCheckins();
      }

      if (!silent) {
        flashSyncIndicator();
      }
    } catch (err) {
      console.warn('Failed to load reports:', err);
    }
  }

  function flashSyncIndicator() {
    if (syncStatusBadge) {
      syncStatusBadge.classList.add('syncing');
      setTimeout(() => syncStatusBadge.classList.remove('syncing'), 800);
    }
  }

  function renderReports() {
    if (!currentReports) return;
    const { session, total, present, missing, percent, groups, generatedAt } = currentReports;

    document.querySelector('#report-session-title').textContent = `${session?.name || 'Event'} — Attendance Report`;
    document.querySelector('#report-last-updated').textContent = `Live synced at ${formatTime(generatedAt)}`;

    document.querySelector('#kpi-total').textContent = total;
    document.querySelector('#kpi-present').textContent = present;
    document.querySelector('#kpi-missing').textContent = missing;
    document.querySelector('#kpi-percent').textContent = `${percent}%`;

    // Group cards
    const groupCardsContainer = document.querySelector('#group-cards-container');
    groupCardsContainer.innerHTML = '';

    const groupFilterSelect = document.querySelector('#report-group-filter');
    const currentSelectedGroup = groupFilterSelect.value;
    groupFilterSelect.innerHTML = '<option value="">All Groups</option>';

    groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.groupName;
      opt.textContent = `${g.groupName} (${g.present}/${g.total})`;
      if (opt.value === currentSelectedGroup) opt.selected = true;
      groupFilterSelect.append(opt);

      const card = document.createElement('div');
      card.className = `group-card ${activeReportGroup === g.groupName ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="group-card-top">
          <span class="group-card-title">${escapeHtml(g.groupName)}</span>
          <span class="group-card-counts">${g.present} / ${g.total} present</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${g.percent}%;"></div>
        </div>
        <div class="group-card-meta">
          <span>${g.percent}% attendance</span>
          <span>${g.missing} missing</span>
        </div>
      `;
      card.addEventListener('click', () => {
        if (activeReportGroup === g.groupName) {
          activeReportGroup = '';
          groupFilterSelect.value = '';
        } else {
          activeReportGroup = g.groupName;
          groupFilterSelect.value = g.groupName;
        }
        renderReportTable();
        renderReportsGroupCardHighlight();
      });
      groupCardsContainer.append(card);
    });

    renderReportTable();
  }

  function renderReportsGroupCardHighlight() {
    document.querySelectorAll('.group-card').forEach((card, idx) => {
      const g = currentReports?.groups[idx];
      if (g && g.groupName === activeReportGroup) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    });
  }

  function renderReportTable() {
    if (!currentReports) return;
    const tbody = document.querySelector('#report-table-body');
    tbody.innerHTML = '';

    let list = [];
    currentReports.groups.forEach(g => {
      if (!activeReportGroup || g.groupName === activeReportGroup) {
        list.push(...g.members);
      }
    });

    if (activeReportFilter === 'present') {
      list = list.filter(m => m.isPresent);
    } else if (activeReportFilter === 'missing') {
      list = list.filter(m => !m.isPresent);
    }

    if (activeReportSearch) {
      const q = activeReportSearch.toLowerCase();
      list = list.filter(m =>
        `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) ||
        String(m.identifierNumber).toLowerCase().includes(q)
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#6d8496;padding:24px;">No attendees match the selected filter.</td></tr>';
      return;
    }

    list.forEach(m => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(m.firstName)} ${escapeHtml(m.lastName)}</strong></td>
        <td><span class="tabular">${escapeHtml(m.identifierNumber)}</span></td>
        <td>${escapeHtml(m.groupName || 'General')}</td>
        <td>
          <span class="badge-status ${m.isPresent ? 'present' : 'missing'}">
            ${m.isPresent ? '✓ Present' : '○ Missing'}
          </span>
        </td>
        <td class="tabular">${m.isPresent ? formatTime(m.scannedAt) : '—'}</td>
        <td><span class="supervisor-tag">${m.isPresent ? `👤 ${escapeHtml(m.verifiedByName || 'Supervisor')}` : '—'}</span></td>
        <td>
          <button type="button" class="btn-sm ${m.isPresent ? 'btn-outline' : ''}" data-id="${m.id}">
            ${m.isPresent ? 'Mark Absent' : 'Mark Present'}
          </button>
        </td>
      `;

      tr.querySelector('button').addEventListener('click', async () => {
        try {
          const res = await api('/api/attendance/toggle', {
            method: 'POST',
            body: JSON.stringify({
              sessionId: currentSessionId,
              personId: m.id
            })
          });
          showToast(res.isPresent ? `Marked ${m.firstName} present` : `Marked ${m.firstName} absent`, 'info');
          loadReports();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      tbody.append(tr);
    });
  }

  // Filter handlers
  document.querySelectorAll('.segmented-control button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segmented-control button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeReportFilter = btn.dataset.filter;
      renderReportTable();
    });
  });

  document.querySelector('#report-group-filter')?.addEventListener('change', (e) => {
    activeReportGroup = e.target.value;
    renderReportsGroupCardHighlight();
    renderReportTable();
  });

  document.querySelector('#report-search')?.addEventListener('input', (e) => {
    activeReportSearch = e.target.value.trim();
    renderReportTable();
  });

  document.querySelector('#btn-refresh-report')?.addEventListener('click', () => {
    loadReports();
    showToast('Attendance report refreshed', 'info');
  });

  // Export CSV with Verified By supervisor attribution
  document.querySelector('#btn-export-csv')?.addEventListener('click', () => {
    if (!currentReports) return;
    let csv = 'First Name,Last Name,Identifier,Group,Status,Check-in Time,Verified By\r\n';
    currentReports.groups.forEach(g => {
      g.members.forEach(m => {
        const timeStr = m.isPresent && m.scannedAt ? new Date(m.scannedAt * 1000).toISOString() : '';
        const verifiedBy = m.isPresent ? (m.verifiedByName || 'Supervisor') : '';
        csv += `"${m.firstName}","${m.lastName}","${m.identifierNumber}","${m.groupName}","${m.isPresent ? 'Present' : 'Missing'}","${timeStr}","${verifiedBy}"\r\n`;
      });
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_report_${currentReports.session?.name || 'event'}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported report to CSV with supervisor audit trail', 'success');
  });

  // -------------------------------------------------------------
  // ROSTER VIEW (Admin Only)
  // -------------------------------------------------------------
  async function loadRoster() {
    try {
      const q = document.querySelector('#roster-search')?.value || '';
      const g = document.querySelector('#roster-group-filter')?.value || '';
      const data = await api(`/api/persons?search=${encodeURIComponent(q)}&group=${encodeURIComponent(g)}`);
      currentRoster = data.persons || [];
      currentGroups = data.groups || [];
      renderRoster();
    } catch (err) {
      console.warn('Failed to load roster:', err);
    }
  }

  function renderRoster() {
    const tbody = document.querySelector('#roster-table-body');
    const groupSelect = document.querySelector('#roster-group-filter');
    const curVal = groupSelect.value;

    groupSelect.innerHTML = '<option value="">All Groups</option>';
    currentGroups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      if (g === curVal) opt.selected = true;
      groupSelect.append(opt);
    });

    const datalist = document.querySelector('#group-suggestions');
    if (datalist) {
      datalist.innerHTML = '';
      currentGroups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g;
        datalist.append(opt);
      });
    }

    if (currentRoster.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#6d8496;padding:24px;">No attendees found. Click "+ Add Person" or "Bulk Import (CSV)" to add attendees.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    currentRoster.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</strong></td>
        <td><span class="tabular">${escapeHtml(p.identifierNumber)}</span></td>
        <td>${escapeHtml(p.groupName || 'General')}</td>
        <td>
          <button type="button" class="btn-sm btn-outline danger" style="padding:4px 8px;" title="Remove attendee">Delete</button>
        </td>
      `;
      tr.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Delete ${p.firstName} ${p.lastName} (${p.identifierNumber}) from the roster?`)) return;
        try {
          await api('/api/persons/delete', {
            method: 'POST',
            body: JSON.stringify({ id: p.id })
          });
          showToast(`Deleted ${p.firstName} ${p.lastName}`, 'info');
          loadRoster();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      tbody.append(tr);
    });
  }

  document.querySelector('#roster-search')?.addEventListener('input', debounce(loadRoster, 250));
  document.querySelector('#roster-group-filter')?.addEventListener('change', loadRoster);

  // Modal: Add Person
  const addPersonModal = document.querySelector('#modal-add-person');
  document.querySelector('#btn-open-add-person')?.addEventListener('click', () => {
    addPersonModal.hidden = false;
    document.querySelector('#add-first-name').focus();
  });
  document.querySelector('#modal-add-close')?.addEventListener('click', () => addPersonModal.hidden = true);
  document.querySelector('#modal-add-cancel')?.addEventListener('click', () => addPersonModal.hidden = true);

  document.querySelector('#form-add-person')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const firstName = document.querySelector('#add-first-name').value.trim();
    const lastName = document.querySelector('#add-last-name').value.trim();
    const identifierNumber = document.querySelector('#add-identifier').value.trim();
    const groupName = document.querySelector('#add-group').value.trim() || 'General';

    try {
      await api('/api/persons', {
        method: 'POST',
        body: JSON.stringify({ firstName, lastName, identifierNumber, groupName })
      });
      addPersonModal.hidden = true;
      document.querySelector('#form-add-person').reset();
      showToast(`Added ${firstName} ${lastName} (${identifierNumber})`, 'success');
      loadRoster();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Modal: Bulk Import
  const bulkModal = document.querySelector('#modal-bulk-import');
  const bulkTextarea = document.querySelector('#bulk-csv-text');
  const bulkFileInput = document.querySelector('#bulk-file-input');
  const bulkPreviewSummary = document.querySelector('#bulk-preview-summary');

  document.querySelector('#btn-open-bulk-import')?.addEventListener('click', () => {
    bulkModal.hidden = false;
    updateBulkPreview();
  });
  document.querySelector('#modal-bulk-close')?.addEventListener('click', () => bulkModal.hidden = true);
  document.querySelector('#modal-bulk-cancel')?.addEventListener('click', () => bulkModal.hidden = true);

  document.querySelector('#btn-insert-sample-csv')?.addEventListener('click', () => {
    bulkTextarea.value = [
      'First Name, Last Name, Identifier, Group',
      'Claire, Beauchamp, 20491, Engineering',
      'Marcus, Vance, 30582, Sales',
      'Elena, Rostova, 40193, Marketing',
      'Kenji, Sato, 50284, Product',
      'Zoe, Washington, 60375, Engineering'
    ].join('\n');
    updateBulkPreview();
  });

  bulkFileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      bulkTextarea.value = event.target.result;
      updateBulkPreview();
    };
    reader.readAsText(file);
  });

  bulkTextarea?.addEventListener('input', updateBulkPreview);

  function parseCSV(text) {
    text = (text || '').replace(/^\uFEFF/, '').trim();
    if (!text) return [];

    // Detect delimiter from first non-empty line
    const firstLine = text.split(/\r?\n/).find(l => l.trim().length > 0) || '';
    let delimiter = ',';
    const commaCount = (firstLine.match(/,/g) || []).length;
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const tabCount = (firstLine.match(/\t/g) || []).length;
    if (semicolonCount > commaCount && semicolonCount > tabCount) delimiter = ';';
    else if (tabCount > commaCount && tabCount > semicolonCount) delimiter = '\t';

    // Parse CSV rows taking quoted fields and escaped quotes into account
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const nextCh = text[i + 1];

      if (inQuotes) {
        if (ch === '"') {
          if (nextCh === '"') {
            currentField += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          currentField += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delimiter) {
          currentRow.push(currentField.trim());
          currentField = '';
        } else if (ch === '\r') {
          if (nextCh === '\n') i++;
          currentRow.push(currentField.trim());
          currentField = '';
          if (currentRow.some(val => val !== '')) rows.push(currentRow);
          currentRow = [];
        } else if (ch === '\n') {
          currentRow.push(currentField.trim());
          currentField = '';
          if (currentRow.some(val => val !== '')) rows.push(currentRow);
          currentRow = [];
        } else {
          currentField += ch;
        }
      }
    }

    if (currentField || currentRow.length > 0) {
      currentRow.push(currentField.trim());
      if (currentRow.some(val => val !== '')) rows.push(currentRow);
    }

    if (rows.length === 0) return [];

    // Analyze first row for headers
    let fnIdx = -1, lnIdx = -1, idIdx = -1, grpIdx = -1, nameIdx = -1;
    const headerRow = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));

    headerRow.forEach((h, idx) => {
      if (['firstname', 'first', 'givenname', 'fname'].includes(h)) fnIdx = idx;
      else if (['lastname', 'last', 'surname', 'familyname', 'lname'].includes(h)) lnIdx = idx;
      else if (['name', 'fullname', 'attendee', 'person'].includes(h)) nameIdx = idx;
      else if (['identifier', 'id', 'identifiernumber', 'badgenumber', 'badge', 'barcode', 'number', 'empid', 'employeeid'].includes(h)) idIdx = idx;
      else if (['group', 'groupname', 'department', 'dept', 'team', 'cohort', 'class', 'section'].includes(h)) grpIdx = idx;
    });

    const hasHeader = (fnIdx >= 0 || idIdx >= 0 || nameIdx >= 0);
    const dataRows = hasHeader ? rows.slice(1) : rows;

    // Fallback column positions if no recognized header
    if (fnIdx < 0 && nameIdx < 0) fnIdx = 0;
    if (lnIdx < 0 && nameIdx < 0) lnIdx = 1;
    if (idIdx < 0) idIdx = 2;
    if (grpIdx < 0) grpIdx = 3;

    const parsed = [];
    for (const row of dataRows) {
      let fn = '';
      let ln = '';
      let id = '';
      let grp = 'General';

      if (nameIdx >= 0 && fnIdx < 0 && lnIdx < 0) {
        const fullName = (row[nameIdx] || '').trim();
        const spaceIdx = fullName.indexOf(' ');
        if (spaceIdx > 0) {
          fn = fullName.slice(0, spaceIdx).trim();
          ln = fullName.slice(spaceIdx + 1).trim();
        } else {
          fn = fullName;
          ln = '—';
        }
      } else {
        fn = (fnIdx >= 0 && row[fnIdx] !== undefined) ? row[fnIdx].trim() : '';
        ln = (lnIdx >= 0 && row[lnIdx] !== undefined) ? row[lnIdx].trim() : '';
      }

      if (idIdx >= 0 && row[idIdx] !== undefined) {
        id = row[idIdx].trim();
      }
      if (grpIdx >= 0 && row[grpIdx] !== undefined && row[grpIdx].trim()) {
        grp = row[grpIdx].trim();
      }

      if (fn && ln && id) {
        parsed.push({
          firstName: fn,
          lastName: ln,
          identifierNumber: id,
          groupName: grp
        });
      }
    }

    return parsed;
  }

  function updateBulkPreview() {
    const list = parseCSV(bulkTextarea.value);
    if (list.length === 0) {
      bulkPreviewSummary.textContent = 'No valid rows detected yet. Format: "First Name, Last Name, Identifier, Group".';
      bulkPreviewSummary.style.color = '#8496a5';
    } else {
      bulkPreviewSummary.textContent = `✓ Detected ${list.length} valid attendee row${list.length === 1 ? '' : 's'} ready for import.`;
      bulkPreviewSummary.style.color = '#126e62';
    }
  }

  document.querySelector('#btn-execute-import')?.addEventListener('click', async () => {
    const list = parseCSV(bulkTextarea.value);
    if (list.length === 0) {
      showToast('Please provide at least one valid attendee row (e.g. First Name, Last Name, Identifier, Group).', 'error');
      return;
    }

    const importBtn = document.querySelector('#btn-execute-import');
    const cancelBtn = document.querySelector('#modal-bulk-cancel');
    const originalText = importBtn.textContent;
    importBtn.disabled = true;
    cancelBtn.disabled = true;

    try {
      // Chunk into batches of 250 rows for smooth network transmission and live progress
      const CHUNK_SIZE = 250;
      let totalImported = 0;

      for (let i = 0; i < list.length; i += CHUNK_SIZE) {
        const batch = list.slice(i, i + CHUNK_SIZE);
        const processedSoFar = Math.min(i + batch.length, list.length);
        importBtn.textContent = `Importing ${processedSoFar} of ${list.length}...`;

        const res = await api('/api/persons/bulk', {
          method: 'POST',
          body: JSON.stringify({ persons: batch })
        });
        totalImported += (res.count || batch.length);
      }

      bulkModal.hidden = true;
      bulkTextarea.value = '';
      showToast(`Successfully imported ${totalImported} attendees into the roster!`, 'success', 5000);
      loadRoster();
      loadReports();
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error', 6000);
    } finally {
      importBtn.disabled = false;
      cancelBtn.disabled = false;
      importBtn.textContent = originalText;
    }
  });

  // -------------------------------------------------------------
  // SUPERVISORS VIEW (Admin Only)
  // -------------------------------------------------------------
  async function loadSupervisors() {
    try {
      const data = await api('/api/supervisors');
      const tbody = document.querySelector('#supervisors-table-body');
      tbody.innerHTML = '';
      const list = data.supervisors || [];

      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#6d8496;padding:24px;">No supervisors created yet. Click "+ Add Supervisor" above.</td></tr>';
        return;
      }

      list.forEach(s => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(s.display_name)}</strong></td>
          <td><code>${escapeHtml(s.username)}</code></td>
          <td><span class="user-role-tag">${escapeHtml(s.role)}</span></td>
          <td class="tabular">${formatDate(s.created_at)}</td>
          <td>
            <button type="button" class="btn-sm btn-outline danger" data-id="${s.id}">Delete</button>
          </td>
        `;

        tr.querySelector('button').addEventListener('click', async () => {
          if (!confirm(`Delete supervisor account "${s.display_name}" (@${s.username})?`)) return;
          try {
            await api('/api/supervisors/delete', {
              method: 'POST',
              body: JSON.stringify({ id: s.id })
            });
            showToast(`Deleted supervisor ${s.display_name}`, 'info');
            loadSupervisors();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });

        tbody.append(tr);
      });
    } catch (err) {
      console.warn('Failed to load supervisors:', err);
    }
  }

  // Modal: Add Supervisor
  const addSupervisorModal = document.querySelector('#modal-add-supervisor');
  document.querySelector('#btn-open-add-supervisor')?.addEventListener('click', () => {
    addSupervisorModal.hidden = false;
    document.querySelector('#sup-display-name').focus();
  });
  document.querySelector('#modal-add-sup-close')?.addEventListener('click', () => addSupervisorModal.hidden = true);
  document.querySelector('#modal-add-sup-cancel')?.addEventListener('click', () => addSupervisorModal.hidden = true);

  document.querySelector('#form-add-supervisor')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const displayName = document.querySelector('#sup-display-name').value.trim();
    const username = document.querySelector('#sup-username').value.trim();
    const password = document.querySelector('#sup-password').value.trim();

    try {
      await api('/api/supervisors', {
        method: 'POST',
        body: JSON.stringify({ displayName, username, password })
      });
      addSupervisorModal.hidden = true;
      document.querySelector('#form-add-supervisor').reset();
      showToast(`Created supervisor account for ${displayName}!`, 'success');
      loadSupervisors();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // -------------------------------------------------------------
  // SETTINGS VIEW (Admin Only)
  // -------------------------------------------------------------
  async function loadSettings() {
    try {
      const sessionsData = await api('/api/sessions');
      const tbody = document.querySelector('#settings-sessions-table');
      tbody.innerHTML = '';
      (sessionsData.sessions || []).forEach(s => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(s.name)}</strong></td>
          <td class="tabular">${formatDate(s.created_at)}</td>
          <td><span class="badge-status ${s.is_active ? 'present' : ''}">${s.is_active ? 'Active' : 'Archived'}</span></td>
          <td>
            ${s.is_active ? '<em>Current</em>' : `<button type="button" class="btn-sm btn-outline" data-id="${s.id}">Activate</button>`}
          </td>
        `;
        const btn = tr.querySelector('button');
        if (btn) {
          btn.addEventListener('click', async () => {
            await api('/api/sessions/active', {
              method: 'POST',
              body: JSON.stringify({ id: s.id })
            });
            showToast(`Activated event "${s.name}"`, 'success');
            await loadSessions();
            loadSettings();
          });
        }
        tbody.append(tr);
      });

      const settingsData = await api('/api/admin/settings');
      document.querySelector('#key-status').textContent = settingsData.key.configured
        ? `Configured · Fingerprint ${settingsData.key.fingerprint} · Updated ${formatDate(settingsData.key.updatedAt)}`
        : 'No AES badge key configured';
      document.querySelector('#days').value = settingsData.retentionDays || 30;
    } catch (err) {
      console.warn('Failed to load settings:', err);
    }
  }

  document.querySelector('#key-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = document.querySelector('#key');
    if (!confirm('Replace the active AES key? Existing encrypted QR codes issued under the old key will fail.')) return;
    try {
      await api('/api/admin/key', {
        method: 'PUT',
        body: JSON.stringify({ keyHex: key.value, confirmation: 'REPLACE' })
      });
      key.value = '';
      showToast('Active AES key replaced.', 'success');
      loadSettings();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelector('#retention-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const days = Number(document.querySelector('#days').value);
      await api('/api/admin/retention', {
        method: 'PUT',
        body: JSON.stringify({ retentionDays: days })
      });
      showToast('Retention limit updated.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // -------------------------------------------------------------
  // PWA INTEGRATION & INSTALL PROMPT
  // -------------------------------------------------------------
  function initPWA() {
    // Register Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('PWA service worker registration notice:', err);
      });
    }

    // Check if already running in standalone PWA display mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator && window.navigator.standalone === true);

    if (isStandalone && btnInstallPwa) {
      btnInstallPwa.hidden = true;
    }

    // Capture Chrome/Android/Desktop install prompt event
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (btnInstallPwa && !isStandalone) {
        btnInstallPwa.hidden = false;
      }
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      if (btnInstallPwa) btnInstallPwa.hidden = true;
      showToast('QRPass installed successfully on your device!', 'success');
    });

    // Detect iOS devices for guided install flow
    const isIOS = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
    const modalPwaIos = document.querySelector('#modal-pwa-ios');

    btnInstallPwa?.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        await deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          deferredInstallPrompt = null;
          btnInstallPwa.hidden = true;
        }
      } else if (isIOS && modalPwaIos) {
        modalPwaIos.hidden = false;
      } else {
        showToast('To install, open your browser menu and choose "Install App" or "Add to Home Screen".', 'info', 5000);
      }
    });

    document.querySelector('#modal-ios-close')?.addEventListener('click', () => {
      if (modalPwaIos) modalPwaIos.hidden = true;
    });
    document.querySelector('#modal-ios-done')?.addEventListener('click', () => {
      if (modalPwaIos) modalPwaIos.hidden = true;
    });

    // Online / Offline status
    function updateOnlineStatus() {
      if (navigator.onLine) {
        if (offlineBanner) offlineBanner.hidden = true;
        if (syncStatusText) syncStatusText.textContent = 'Multi-gate live sync active';
      } else {
        if (offlineBanner) offlineBanner.hidden = false;
        if (syncStatusText) syncStatusText.textContent = 'Offline (cached)';
      }
    }

    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();
  }

  // -------------------------------------------------------------
  // MULTI-SUPERVISOR REAL-TIME AUTO-SYNC
  // -------------------------------------------------------------
  function startSyncLoop() {
    if (syncTimer) clearInterval(syncTimer);
    // Auto-sync scans every 3.5 seconds across gates
    syncTimer = setInterval(() => {
      if (!navigator.onLine) return;
      const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
      if (activeTab === 'scanner' || activeTab === 'reports') {
        loadReports(true);
      }
    }, 3500);
  }

  // -------------------------------------------------------------
  // UTILITIES
  // -------------------------------------------------------------
  function debounce(fn, ms) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), ms);
    };
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initialization sequence
  initTabs();
  initAuth();
  loadSessions();
  updateCameras();
  initPWA();
  startSyncLoop();
})();
