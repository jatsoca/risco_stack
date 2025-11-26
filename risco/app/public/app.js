const wsStatusEl = document.getElementById('ws-status');
const panelOnlineEl = document.getElementById('panel-online');
const modbusInfoEl = document.getElementById('modbus-info');
const partitionTable = document.querySelector('#partitions tbody');
const zoneTable = document.querySelector('#zones tbody');
const zoneFilter = document.getElementById('zone-filter');
const zonesCount = document.getElementById('zones-count');
const partitionInput = document.getElementById('partition-id');
const armButtons = document.querySelectorAll('.arm-btn');
const toastContainer = document.getElementById('toast-container');

let snapshot = { partitions: [], zones: [] };
let ws;
let panelOnline = false;

function setBadge(el, text, cls) {
  el.textContent = text;
  el.className = `badge ${cls}`;
}

async function loadSnapshot() {
  try {
    const res = await fetch('/snapshot');
    if (!res.ok) throw new Error('snapshot fetch failed');
    snapshot = await res.json();
    panelOnline = !!snapshot.panelOnline;
    renderPanelStatus();
    renderPartitions();
    renderZones();
  } catch (e) {
    console.error(e);
  }
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}${window.WS_PATH || '/ws'}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => setBadge(wsStatusEl, 'WS conectado', 'badge ok');
  ws.onclose = () => setBadge(wsStatusEl, 'WS desconectado', 'badge bad');
  ws.onerror = () => setBadge(wsStatusEl, 'WS error', 'badge bad');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') {
      panelOnline = !!msg.panelOnline;
      snapshot.partitions = msg.partitions;
      snapshot.zones = msg.zones;
      renderPanelStatus();
      renderPartitions();
      renderZones();
    } else if (msg.type === 'partition') {
      upsert(snapshot.partitions, msg.data, 'id');
      renderPartitions();
    } else if (msg.type === 'zone') {
      upsert(snapshot.zones, msg.data, 'id');
      renderZones();
    } else if (msg.type === 'panel') {
      panelOnline = !!msg.online;
      renderPanelStatus();
    } else if (msg.type === 'ack') {
      const ok = !!msg.ok;
      const msgText = msg.message || (ok ? 'Acción ejecutada' : 'Acción rechazada');
      const title = msg.action === 'bypass' ? 'Bypass' : 'Armado';
      showToast(`${title}: ${msgText}`, ok ? 'ok' : 'bad');
    }
  };
}

function upsert(arr, item, key) {
  const idx = arr.findIndex((x) => x[key] === item[key]);
  if (idx >= 0) arr[idx] = item; else arr.push(item);
}

function renderPartitions() {
  partitionTable.innerHTML = '';
  snapshot.partitions
    .sort((a, b) => a.id - b.id)
    .forEach((p) => {
      const tr = document.createElement('tr');
      const badgeCls = p.status === 'disarmed' ? 'pill closed' :
        p.status === 'armed_home' ? 'pill warn' :
        p.status === 'armed_away' ? 'pill open' : 'pill';
      const readyBadge = p.ready === undefined ? '' :
        `<span class="pill ${p.ready ? 'closed' : 'warn'}" style="margin-left:6px">${p.ready ? 'Ready' : 'NotReady'}</span>`;
      tr.innerHTML = `<td>${p.id}</td><td><span class="${badgeCls}">${p.status}</span>${readyBadge}</td>`;
      partitionTable.appendChild(tr);
    });
}

function renderZones() {
  const text = zoneFilter.value.toLowerCase().trim();
  const filtered = snapshot.zones.filter((z) => {
    if (!text) return true;
    return `${z.id}`.includes(text) || (z.label || '').toLowerCase().includes(text);
  }).sort((a, b) => a.id - b.id);
  zoneTable.innerHTML = '';
  filtered.forEach((z) => {
    const openCls = z.open ? 'pill open' : 'pill closed';
    const bypassCls = z.bypass ? 'pill bypass' : 'pill closed';
    const tr = document.createElement('tr');
    const btn = document.createElement('button');
    btn.textContent = z.bypass ? 'Quitar bypass' : 'Aplicar bypass';
    btn.className = 'arm-btn';
    btn.disabled = !ws || ws.readyState !== WebSocket.OPEN || !panelOnline;
    btn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'bypass', zoneId: z.id }));
    });
    tr.innerHTML = `<td>${z.id}</td><td>${z.label || ''}</td>
      <td><span class="${openCls}">${z.open ? 'Abierta' : 'Cerrada'}</span></td>
      <td><span class="${bypassCls}">${z.bypass ? 'Bypass' : 'Normal'}</span></td>
      <td class="btn-cell"></td>`;
    tr.querySelector('.btn-cell').appendChild(btn);
    zoneTable.appendChild(tr);
  });
  zonesCount.textContent = `${filtered.length} zonas mostradas / ${snapshot.zones.length} total`;
}

function renderPanelStatus() {
  if (panelOnline) setBadge(panelOnlineEl, 'Panel online', 'badge accent');
  else setBadge(panelOnlineEl, 'Panel offline', 'badge bad');
}

armButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const partitionId = Number(partitionInput.value);
    const mode = btn.dataset.mode;
    ws.send(JSON.stringify({ type: 'arm', partitionId, mode }));
  });
});

zoneFilter.addEventListener('input', renderZones);

window.addEventListener('DOMContentLoaded', async () => {
  setBadge(wsStatusEl, 'WS conectando...', 'badge warn');
  setBadge(panelOnlineEl, 'Panel offline', 'badge bad');
  setBadge(modbusInfoEl, 'Modbus TCP activo', 'badge accent2');
  await loadSnapshot();
  connectWS();
});

function showToast(text, variant = 'ok') {
  if (!toastContainer) return;
  const el = document.createElement('div');
  el.className = `toast ${variant}`;
  el.textContent = text;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, 2500);
}
