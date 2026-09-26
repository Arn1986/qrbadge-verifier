const notice = document.querySelector('#notice');
let page = 1, pages = 0;
async function api(path, options) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json' }, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function show(message, isError = false) { notice.textContent = message; notice.className = isError ? 'error-text' : 'success-text'; }
function stamp(value) { return value == null ? '—' : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(value * 1000)); }
async function settings() {
  const data = await api('/api/admin/settings');
  document.querySelector('#key-status').textContent = data.key.configured ? `Configured · Fingerprint ${data.key.fingerprint} · Updated ${stamp(data.key.updatedAt)}` : 'No key configured';
  document.querySelector('#days').value = data.retentionDays;
}
async function history() {
  const data = await api(`/api/admin/history?page=${page}`);
  pages = data.pages;
  const body = document.querySelector('#history');
  body.replaceChildren();
  for (const row of data.entries) {
    const tr = document.createElement('tr');
    for (const value of [stamp(row.scanned_at), row.result.replaceAll('_', ' '), row.identifier ?? '—', stamp(row.starts_at), stamp(row.ends_at), row.source]) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    body.append(tr);
  }
  document.querySelector('#page-status').textContent = `${data.total} scans · Page ${page} of ${pages || 1}`;
  document.querySelector('#previous').disabled = page <= 1;
  document.querySelector('#next').disabled = page >= pages;
}
document.querySelector('#key-form').addEventListener('submit', async event => {
  event.preventDefault();
  const key = document.querySelector('#key');
  if (!confirm('Replace the active key? Existing old-key QR codes will immediately fail.')) return;
  try {
    await api('/api/admin/key', { method: 'PUT', body: JSON.stringify({ keyHex: key.value, confirmation: 'REPLACE' }) });
    key.value = ''; show('Active key replaced. Update the issuer key separately.'); await settings();
  } catch (error) { show(error.message, true); }
});
document.querySelector('#retention-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const days = Number(document.querySelector('#days').value);
    await api('/api/admin/retention', { method: 'PUT', body: JSON.stringify({ retentionDays: days }) });
    show('Retention saved. Cleanup runs daily.');
  } catch (error) { show(error.message, true); }
});
document.querySelector('#previous').addEventListener('click', () => { if (page > 1) { page--; history().catch(error => show(error.message, true)); } });
document.querySelector('#next').addEventListener('click', () => { if (page < pages) { page++; history().catch(error => show(error.message, true)); } });
Promise.all([settings(), history()]).catch(error => show(error.message, true));
