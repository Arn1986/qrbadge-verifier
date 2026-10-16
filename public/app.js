(() => {
  // App state
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
  const startBtn = document.querySelector('#start');
  const againBtn = document.querySelector('#again');
  const cameraLabel = document.querySelector('#camera-label');
  const camerasSelect = document.querySelector('#cameras');
  const cameraStatus = document.querySelector('#camera-status');
  const sessionSelect = document.querySelector('#session-select');
  const toastContainer = document.querySelector('#toast-container');

  // Confirmation Modal elements
  const modalConfirm = document.querySelector('#modal-confirm');
  const modalAvatar = document.querySelector('#modal-avatar');
  const modalPersonName = document.querySelector('#modal-person-name');
  const modalPersonId = document.querySelector('#modal-person-id');
  const modalPersonGroup = document.querySelector('#modal-person-group');
  const modalStatusBadge = document.querySelector('#modal-status-badge');
  const modalTimeInfo = document.querySelector('#modal-time-info');
  const modalConfirmBtn = document.querySelector('#modal-confirm-btn');
  const modalCancelBtn = document.querySelector('#modal-cancel-btn');
  const modalCloseBtn = document.querySelector('#modal-close-btn');

  // Utility: API caller
  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // Toast notification
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

  // Format Unix timestamp
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

  // Navigation tab switcher
  function initTabs() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        const tabName = tab.dataset.tab;
        document.querySelectorAll('main > section').forEach(sec => sec.hidden = true);
        const activeSec = document.querySelector(`#view-${tabName}`);
        if (activeSec) activeSec.hidden = false;

        if (tabName === 'reports') loadReports();
        if (tabName === 'roster') loadRoster();
        if (tabName === 'settings') loadSettings();
      });
    });
  }

  // Session Management
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

  sessionSelect.addEventListener('change', async () => {
    currentSessionId = Number(sessionSelect.value);
    showToast(`Switched session to "${sessionSelect.selectedOptions[0]?.text}"`, 'info');
    recentCheckins = [];
    renderRecentCheckins();
    loadReports();
  });

  // Modal: Create Session
  const sessionModal = document.querySelector('#modal-session');
  document.querySelector('#btn-open-session-modal')?.addEventListener('click', () => {
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
      const res = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      nameInput.value = '';
      sessionModal.hidden = true;
      showToast(`Session "${name}" created and set as active`, 'success');
      await loadSessions();
      loadReports();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // -------------------------------------------------------------
  // SCANNER & ATTENDANCE CONFIRMATION POPUP
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
    cameraEmpty.style.display = 'grid';
    startBtn.hidden = false;
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
      cameraEmpty.style.display = 'none';
      startBtn.hidden = true;
      againBtn.hidden = false;
      cameraStatus.textContent = 'Ready. Position QR code within frame.';
      isScanning = true;
      await updateCameras();
      requestAnimationFrame(scanFrame);
    } catch (err) {
      stopCamera();
      cameraStatus.textContent = 'Camera error or permission denied. You can still paste or type identifiers below.';
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
      cameraStatus.textContent = 'Verifying identifier...';
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
        cameraStatus.textContent = `Identifier "${result.rawIdentifier}" not found in roster.`;
        showToast(`Identifier "${result.rawIdentifier}" is not registered in the roster.`, 'error');
        setTimeout(() => { scanBusy = false; }, 1500);
        return;
      }

      // Found attendee -> Open Confirmation Modal
      openConfirmModal(result, source);
    } catch (err) {
      cameraStatus.textContent = 'Error processing scan.';
      showToast(err.message, 'error');
      setTimeout(() => { scanBusy = false; }, 1500);
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

    // Initials avatar
    const initials = `${p.firstName?.[0] || ''}${p.lastName?.[0] || ''}`.toUpperCase() || 'ID';
    modalAvatar.textContent = initials;

    if (scanResult.alreadyPresent) {
      window.BadgeSounds?.play('already_present');
      modalStatusBadge.className = 'attendee-status-badge already';
      modalStatusBadge.textContent = 'Already Marked Present';
      modalTimeInfo.textContent = `Check-in recorded at ${formatTime(scanResult.markedAt)}`;
      modalConfirmBtn.textContent = 'Keep Present';
      modalConfirmBtn.className = 'btn-secondary btn-full';
    } else {
      window.BadgeSounds?.play('valid');
      modalStatusBadge.className = 'attendee-status-badge new';
      modalStatusBadge.textContent = 'Ready for Check-in';
      modalTimeInfo.textContent = `Session: ${sessionSelect.selectedOptions[0]?.text || 'Active Session'}`;
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

        // Add to recent check-ins
        recentCheckins.unshift({
          firstName,
          lastName,
          identifierNumber,
          groupName,
          scannedAt: markRes.scannedAt
        });
        renderRecentCheckins();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    closeConfirmModal();
  }

  modalConfirmBtn.addEventListener('click', confirmMarkPresent);
  modalCancelBtn.addEventListener('click', closeConfirmModal);
  modalCloseBtn.addEventListener('click', closeConfirmModal);

  // Keyboard accessibility
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

  // Recent checkins rendering
  function renderRecentCheckins() {
    const tbody = document.querySelector('#recent-table-body');
    const countEl = document.querySelector('#recent-count');
    countEl.textContent = `${recentCheckins.length} check-in${recentCheckins.length === 1 ? '' : 's'}`;

    if (recentCheckins.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#6d8496;padding:24px;">No check-ins logged yet in this session. Start scanning above!</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    recentCheckins.slice(0, 10).forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(item.firstName)} ${escapeHtml(item.lastName)}</strong></td>
        <td><span class="tabular">${escapeHtml(item.identifierNumber)}</span></td>
        <td>${escapeHtml(item.groupName || 'General')}</td>
        <td class="tabular">${formatTime(item.scannedAt)}</td>
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

  startBtn.addEventListener('click', startCamera);
  againBtn.addEventListener('click', startCamera);
  camerasSelect.addEventListener('change', () => {
    selectedCamera = camerasSelect.value;
    startCamera();
  });
  document.querySelector('#sound-enabled')?.addEventListener('change', () => window.BadgeSounds?.unlock());
  window.addEventListener('pagehide', stopCamera);

  // -------------------------------------------------------------
  // REPORTS VIEW
  // -------------------------------------------------------------
  async function loadReports() {
    try {
      const data = await api(`/api/reports?sessionId=${currentSessionId}`);
      currentReports = data;
      renderReports();
    } catch (err) {
      console.warn('Failed to load reports:', err);
    }
  }

  function renderReports() {
    if (!currentReports) return;
    const { session, total, present, missing, percent, groups, generatedAt } = currentReports;

    document.querySelector('#report-session-title').textContent = `${session?.name || 'Session'} — Attendance Report`;
    document.querySelector('#report-last-updated').textContent = `Generated at ${formatTime(generatedAt)}`;

    document.querySelector('#kpi-total').textContent = total;
    document.querySelector('#kpi-present').textContent = present;
    document.querySelector('#kpi-missing').textContent = missing;
    document.querySelector('#kpi-percent').textContent = `${percent}%`;

    // Render group cards
    const groupCardsContainer = document.querySelector('#group-cards-container');
    groupCardsContainer.innerHTML = '';

    const groupFilterSelect = document.querySelector('#report-group-filter');
    const currentSelectedGroup = groupFilterSelect.value;
    groupFilterSelect.innerHTML = '<option value="">All Groups</option>';

    groups.forEach(g => {
      // Group select option
      const opt = document.createElement('option');
      opt.value = g.groupName;
      opt.textContent = `${g.groupName} (${g.present}/${g.total})`;
      if (opt.value === currentSelectedGroup) opt.selected = true;
      groupFilterSelect.append(opt);

      // Group Card
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

    // Collect all members across all or selected groups
    let list = [];
    currentReports.groups.forEach(g => {
      if (!activeReportGroup || g.groupName === activeReportGroup) {
        list.push(...g.members);
      }
    });

    // Apply status filter
    if (activeReportFilter === 'present') {
      list = list.filter(m => m.isPresent);
    } else if (activeReportFilter === 'missing') {
      list = list.filter(m => !m.isPresent);
    }

    // Apply search filter
    if (activeReportSearch) {
      const q = activeReportSearch.toLowerCase();
      list = list.filter(m =>
        `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) ||
        String(m.identifierNumber).toLowerCase().includes(q)
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#6d8496;padding:24px;">No attendees match the selected filter.</td></tr>';
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
        <td>
          <button type="button" class="btn-sm ${m.isPresent ? 'btn-outline' : ''}" data-id="${m.id}">
            ${m.isPresent ? 'Mark Absent' : 'Mark Present'}
          </button>
        </td>
      `;

      tr.querySelector('button').addEventListener('click', async () => {
        try {
          await api('/api/attendance/toggle', {
            method: 'POST',
            body: JSON.stringify({
              sessionId: currentSessionId,
              personId: m.id
            })
          });
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

  // Export CSV
  document.querySelector('#btn-export-csv')?.addEventListener('click', () => {
    if (!currentReports) return;
    let csv = 'First Name,Last Name,Identifier,Group,Status,Check-in Time\r\n';
    currentReports.groups.forEach(g => {
      g.members.forEach(m => {
        const timeStr = m.isPresent && m.scannedAt ? new Date(m.scannedAt * 1000).toISOString() : '';
        csv += `"${m.firstName}","${m.lastName}","${m.identifierNumber}","${m.groupName}","${m.isPresent ? 'Present' : 'Missing'}","${timeStr}"\r\n`;
      });
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_report_${currentReports.session?.name || 'session'}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported report to CSV', 'success');
  });

  // -------------------------------------------------------------
  // ROSTER & BULK IMPORT VIEW
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

    // Also populate add-person datalist
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

  // Insert sample CSV helper
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

  // File upload handler
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
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const parsed = [];
    lines.forEach((line, idx) => {
      // Split by comma or tab
      const parts = line.split(/[,\t]/).map(p => p.trim().replace(/^["']|["']$/g, ''));
      if (parts.length >= 3) {
        // Skip header if detected
        if (idx === 0 && (parts[0].toLowerCase().includes('first') || parts[2].toLowerCase().includes('id'))) {
          return;
        }
        parsed.push({
          firstName: parts[0],
          lastName: parts[1],
          identifierNumber: parts[2],
          groupName: parts[3] || 'General'
        });
      }
    });
    return parsed;
  }

  function updateBulkPreview() {
    const list = parseCSV(bulkTextarea.value);
    if (list.length === 0) {
      bulkPreviewSummary.textContent = 'No valid rows detected yet. Enter lines with "First, Last, Identifier, Group".';
      bulkPreviewSummary.style.color = '#8496a5';
    } else {
      bulkPreviewSummary.textContent = `✓ Detected ${list.length} valid attendee row${list.length === 1 ? '' : 's'} ready for import.`;
      bulkPreviewSummary.style.color = '#126e62';
    }
  }

  document.querySelector('#btn-execute-import')?.addEventListener('click', async () => {
    const list = parseCSV(bulkTextarea.value);
    if (list.length === 0) {
      showToast('Please provide at least one valid row before importing.', 'error');
      return;
    }
    try {
      const res = await api('/api/persons/bulk', {
        method: 'POST',
        body: JSON.stringify({ persons: list })
      });
      bulkModal.hidden = true;
      bulkTextarea.value = '';
      showToast(`Successfully imported ${res.count} attendees!`, 'success');
      loadRoster();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // -------------------------------------------------------------
  // SETTINGS VIEW
  // -------------------------------------------------------------
  async function loadSettings() {
    try {
      // Load sessions table
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
            showToast(`Activated session "${s.name}"`, 'success');
            await loadSessions();
            loadSettings();
          });
        }
        tbody.append(tr);
      });

      // Load AES key settings
      const settingsData = await api('/api/admin/settings');
      document.querySelector('#key-status').textContent = settingsData.key.configured
        ? `Configured · Fingerprint ${settingsData.key.fingerprint} · Updated ${formatDate(settingsData.key.updatedAt)}`
        : 'No AES badge key configured';
      document.querySelector('#days').value = settingsData.retentionDays || 30;
    } catch (err) {
      console.warn('Failed to load settings:', err);
    }
  }

  // Key form submit
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

  // Retention form submit
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

  // Helper: debounce
  function debounce(fn, ms) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), ms);
    };
  }

  // Helper: Escape HTML
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initialization
  initTabs();
  loadSessions();
  updateCameras();
})();
