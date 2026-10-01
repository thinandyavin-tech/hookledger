let token = '';
let jobs = [];
let busy = false;
const $ = id => document.getElementById(id);
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
async function api(path, method = 'GET') {
  const response = await fetch(path, { method, headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
function cell(text, className) {
  const element = document.createElement('td');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
async function showHistory(id) {
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(id)}/history`);
    $('selected').textContent = id;
    $('history').replaceChildren(...data.history.map(entry => {
      const li = document.createElement('li');
      li.textContent = `${entry.action.replaceAll('_', ' ')} · ${time(entry.at)}`;
      const detail = document.createElement('small');
      detail.textContent = entry.detail;
      li.append(detail);
      return li;
    }));
    $('detail').hidden = false;
  } catch (error) { $('notice').textContent = error.message; }
}
function render() {
  const filtered = jobs.filter(job => $('filter').value === 'all' || job.status === $('filter').value);
  $('rows').replaceChildren(...filtered.map(job => {
    const tr = document.createElement('tr');
    const name = cell('');
    const button = document.createElement('button');
    button.className = 'event-link';
    button.textContent = job.type;
    button.addEventListener('click', () => showHistory(job.id));
    const id = document.createElement('small');
    id.textContent = job.id;
    name.append(button, id);
    const state = cell('');
    const badge = document.createElement('span');
    badge.className = `badge ${job.status}`;
    badge.textContent = job.status === 'dead' ? 'Dead letter' : job.status;
    state.append(badge);
    const action = cell('');
    if (job.status === 'dead') {
      const retry = document.createElement('button');
      retry.className = 'retry';
      retry.textContent = 'Retry ↗';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try { await api(`/api/jobs/${encodeURIComponent(job.id)}/retry`, 'POST'); await refresh(); await showHistory(job.id); }
        catch (error) { $('notice').textContent = error.message; retry.disabled = false; }
      });
      action.append(retry);
    }
    tr.append(name, state, cell(`${job.attempts} / ${job.max_attempts}`), cell(time(job.created_at)), action);
    return tr;
  }));
  $('empty').hidden = filtered.length > 0;
  if (jobs.length && !filtered.length) {
    $('empty').querySelector('h3').textContent = 'No events match this filter.';
    $('empty').querySelector('p').textContent = 'Choose another status to see your events.';
  }
  $('count').textContent = String(filtered.length);
}
async function refresh() {
  if (!token || busy) return;
  busy = true;
  try {
    const data = await api('/api/jobs');
    jobs = data.jobs;
    $('total').textContent = Object.values(data.stats).reduce((a, b) => a + b, 0);
    $('succeeded').textContent = data.stats.succeeded;
    $('pending').textContent = data.stats.queued + data.stats.processing;
    $('dead').textContent = data.stats.dead;
    $('sync').textContent = `Synced ${time(Date.now())} · refreshes every 2s`;
    $('notice').textContent = '';
    $('unlock').hidden = true;
    $('refresh').disabled = false;
    render();
  } catch (error) {
    $('notice').textContent = error.message;
    $('sync').textContent = 'Connection interrupted';
    $('unlock').hidden = false;
  } finally { busy = false; }
}
$('unlock').addEventListener('submit', event => { event.preventDefault(); token = $('token').value.trim(); $('token').value = ''; refresh(); });
$('filter').addEventListener('change', render);
$('refresh').addEventListener('click', refresh);
$('close-detail').addEventListener('click', () => { $('detail').hidden = true; });
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
