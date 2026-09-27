const video = document.querySelector('#video');
const start = document.querySelector('#start');
const again = document.querySelector('#again');
const cameras = document.querySelector('#cameras');
const cameraLabel = document.querySelector('#camera-label');
const cameraStatus = document.querySelector('#camera-status');
const empty = document.querySelector('#camera-empty');
const resultCard = document.querySelector('#result-card');
const resultBanner = document.querySelector('#result-banner');
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let stream = null, timer = null, busy = false, selectedCamera = '';
function stopCamera() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  video.style.display = 'none';
  empty.hidden = false;
}
async function listCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
  cameras.replaceChildren();
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Camera ${cameras.length + 1}`;
    cameras.append(option);
  }
  cameraLabel.hidden = devices.length < 2;
  if (selectedCamera) cameras.value = selectedCamera;
}
async function startCamera() {
  window.BadgeSounds.unlock();
  stopCamera(); busy = false; resultCard.hidden = true; again.hidden = true; start.hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatus.textContent = 'Camera unavailable in this browser or connection. Paste the QR hex below.';
    start.hidden = false; return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: selectedCamera ? { deviceId: { exact: selectedCamera } } : { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
    video.style.display = 'block'; empty.hidden = true;
    cameraStatus.textContent = 'Point the camera at the QR code.';
    await listCameras();
    tick();
  } catch {
    stopCamera(); start.hidden = false;
    cameraStatus.textContent = 'Could not start the camera. Check permission and camera selection, or paste QR hex below.';
  }
}
function tick() {
  if (!stream || busy) return;
  if (video.readyState >= 2 && video.videoWidth > 0 && typeof jsQR === 'function') {
    const scale = Math.min(1, 1000 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(pixels.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
    if (found) { busy = true; stopCamera(); verify(found.data, 'camera'); return; }
  }
  timer = setTimeout(tick, 170);
}
function dateTime(seconds) {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(seconds * 1000));
}
function render(data) {
  const names = { valid: 'Valid', not_yet_valid: 'Not valid yet', expired: 'Expired', cannot_verify: 'Cannot verify QR', malformed: 'Malformed QR', unsupported: 'Unsupported QR', connection_error: 'Connection error', rate_limited: 'Too many scans', service_error: 'Verifier unavailable' };
  const messages = { valid: 'This badge is within its encoded time window.', not_yet_valid: 'The badge start time has not arrived.', expired: 'The badge end time has passed.', cannot_verify: 'Check the AES key and QR code. The cause cannot be determined from this scan.', malformed: 'The QR is not a valid time-based-badge hex payload.', unsupported: 'This protocol or time type is not supported.', connection_error: 'The verifier could not be reached. No validity decision was made.', rate_limited: 'Please wait a minute and try again. No validity decision was made.', service_error: 'The verifier could not complete this scan. No validity decision was made.' };
  document.querySelector('#result-title').textContent = names[data.result] || 'Verification error';
  document.querySelector('#result-description').textContent = messages[data.result] || 'Please try again.';
  resultBanner.className = `result-banner ${data.result === 'valid' ? 'success' : data.result === 'not_yet_valid' || data.result === 'expired' ? 'warning' : 'failure'}`;
  const details = document.querySelector('#result-details');
  details.hidden = data.identifier === undefined;
  if (data.identifier !== undefined) {
    document.querySelector('#identifier').textContent = String(data.identifier);
    document.querySelector('#starts').textContent = dateTime(data.startsAt);
    document.querySelector('#ends').textContent = dateTime(data.endsAt);
    document.querySelector('#timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Device local time';
  }
  resultCard.hidden = false; again.hidden = false; start.hidden = true;
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function verify(hex, source) {
  stopCamera(); busy = true; cameraStatus.textContent = 'Checking QR with server…';
  try {
    const response = await fetch('/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hex: hex.trim(), source }), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
      render({ result: response.status === 429 ? 'rate_limited' : 'service_error' });
      cameraStatus.textContent = data.error || 'Verification unavailable.';
      return;
    }
    render(data);
    window.BadgeSounds.play(data.result);
    cameraStatus.textContent = 'Result shown. Select Scan again when ready.';
  } catch (error) {
    render({ result: 'connection_error' });
    cameraStatus.textContent = error.message || 'Verification unavailable.';
  }
}
start.addEventListener('click', startCamera);
again.addEventListener('click', startCamera);
cameras.addEventListener('change', () => { selectedCamera = cameras.value; startCamera(); });
document.querySelector('#sound-enabled').addEventListener('change', () => window.BadgeSounds.unlock());
document.querySelector('#paste-form').addEventListener('submit', event => { event.preventDefault(); window.BadgeSounds.unlock(); verify(document.querySelector('#hex').value, 'paste'); });
window.addEventListener('pagehide', stopCamera);
