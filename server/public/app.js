'use strict';

const REFRESH_MS = 1000;   // dashboard minta data baru tiap 1 detik (sama dengan data live ESP32)
const DATASET_TARGET = 1000;
// harus sama dengan threshold di firmware/src/main.cpp
const TH = { tempOn: 30, tempOff: 28.5, rhOn: 66, rhOff: 64 };
const COLORS = {
  ink: '#2B2A28', muted: '#8A8478', grid: '#ECE8E0',
  temp: '#E8711A', hum: '#2E6DB4', light: '#C9950C', act: '#7B4FA0', red: '#C0392B',
};

// range = { from: Date, to: Date } saat rentang bebas dipilih; null = N jam terakhir (live)
const state = { device: null, mode: null, modeLocked: false, hours: 6, range: null, charts: {}, timer: null };

const rangeQuery = () => (state.range
  ? `from=${state.range.from.toISOString()}&to=${state.range.to.toISOString()}`
  : `hours=${state.hours}`);
const rangeHours = () => (state.range ? (state.range.to - state.range.from) / 3600000 : state.hours);
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ utils
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

const fmt = (v, d = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

function fmtTime(ms, withDate) {
  const o = withDate
    ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', ...(state.mode === 'test' ? { second: '2-digit' } : {}) };
  return new Date(ms).toLocaleString('id-ID', o);
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec} detik`;
  if (sec < 3600) return `${Math.floor(sec / 60)} menit`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h} jam ${m} menit`;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 4000);
}

function setPill(el, on, cls) {
  el.textContent = on ? 'ON' : 'OFF';
  el.className = `pill${on ? ` on ${cls}` : ''}`;
}

const localDate = (d) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};
// nilai untuk <input type="datetime-local">: YYYY-MM-DDTHH:MM jam lokal
const localDateTime = (d) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 16);
};

// ------------------------------------------------------------ charts
function baseOptions(yTitle, extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 12, color: COLORS.ink } },
      tooltip: {
        callbacks: {
          title: (items) => (items.length ? fmtTime(items[0].parsed.x, true) : ''),
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        grid: { color: COLORS.grid },
        ticks: { color: COLORS.muted, maxTicksLimit: 8, callback: (v) => fmtTime(v, rangeHours() > 24) },
      },
      y: {
        title: { display: !!yTitle, text: yTitle, color: COLORS.muted },
        grid: { color: COLORS.grid },
        ticks: { color: COLORS.muted },
        ...extra.y,
      },
    },
  };
}

const line = (label, color, more = {}) => ({
  label, data: [], borderColor: color, backgroundColor: color, borderWidth: 2,
  pointRadius: 0, tension: 0.25, spanGaps: false, ...more,
});
const threshold = (label, color) => line(label, color, { borderWidth: 1, borderDash: [6, 4], tension: 0 });

function initCharts() {
  const C = Chart;
  state.charts.temp = new C($('cTemp'), {
    type: 'line',
    data: { datasets: [
      line('Suhu (°C)', COLORS.temp),
      line('Prediksi t+5 menit', COLORS.ink, { borderDash: [3, 3], pointRadius: 2 }),
      threshold(`Kipas ON ${TH.tempOn} °C`, COLORS.red),
      threshold(`Kipas OFF ${TH.tempOff} °C`, COLORS.muted),
    ] },
    options: baseOptions('°C'),
  });
  state.charts.hum = new C($('cHum'), {
    type: 'line',
    data: { datasets: [
      line('Kelembapan (%RH)', COLORS.hum),
      threshold(`ON ${TH.rhOn}%`, COLORS.red),
      threshold(`OFF ${TH.rhOff}%`, COLORS.muted),
    ] },
    options: baseOptions('%RH'),
  });
  state.charts.light = new C($('cLight'), {
    type: 'line',
    data: { datasets: [line('Cahaya (%)', COLORS.light, { fill: true, backgroundColor: 'rgba(201,149,12,.15)' })] },
    options: baseOptions('%', { y: { min: 0, max: 100 } }),
  });
  state.charts.act = new C($('cAct'), {
    type: 'line',
    data: { datasets: [
      line('% waktu bergerak', COLORS.act, { stepped: true, fill: true, backgroundColor: 'rgba(123,79,160,.15)', tension: 0 }),
      { label: 'Feeding', data: [], showLine: false, pointStyle: 'triangle', pointRadius: 8,
        borderColor: COLORS.ink, backgroundColor: COLORS.ink },
    ] },
    options: baseOptions('%', { y: { min: 0, max: 100 } }),
  });

  const actuLabels = { 0.4: 'LED putih', 2.4: 'LED merah', 4.4: 'Kipas' };
  const actuOpts = baseOptions('');
  actuOpts.scales.y = {
    min: -0.3, max: 5.4, grid: { color: COLORS.grid },
    afterBuildTicks: (axis) => { axis.ticks = [{ value: 0.4 }, { value: 2.4 }, { value: 4.4 }]; },
    ticks: { color: COLORS.muted, callback: (v) => actuLabels[v] || '' },
  };
  actuOpts.plugins.tooltip.callbacks.label = (ctx) => `${ctx.dataset.label}: ${ctx.raw.state ? 'ON' : 'OFF'}`;
  state.charts.actu = new C($('cActu'), {
    type: 'line',
    data: { datasets: [
      line('Kipas', COLORS.hum, { stepped: true, tension: 0 }),
      line('LED merah', COLORS.red, { stepped: true, tension: 0 }),
      line('LED putih', COLORS.muted, { stepped: true, tension: 0 }),
    ] },
    options: actuOpts,
  });
}

function thresholdData(rows, value) {
  if (!rows.length) return [];
  return [{ x: rows[0].x, y: value }, { x: rows[rows.length - 1].x, y: value }];
}

function updateCharts(rows, preds) {
  const pts = rows.map((r) => ({ ...r, x: new Date(r.recorded_at).getTime() }));
  const xy = (key) => pts.map((p) => ({ x: p.x, y: p[key] }));

  const t = state.charts.temp.data.datasets;
  t[0].data = xy('temperature');
  t[1].data = preds.map((p) => ({ x: new Date(p.target_time).getTime(), y: p.predicted_temp }));
  t[2].data = thresholdData(pts, TH.tempOn);
  t[3].data = thresholdData(pts, TH.tempOff);

  const h = state.charts.hum.data.datasets;
  h[0].data = xy('humidity');
  h[1].data = thresholdData(pts, TH.rhOn);
  h[2].data = thresholdData(pts, TH.rhOff);

  state.charts.light.data.datasets[0].data = xy('light_pct');

  const a = state.charts.act.data.datasets;
  a[0].data = xy('active_pct');
  a[1].data = pts.filter((p) => p.feed_event > 0).map((p) => ({ x: p.x, y: p.active_pct }));

  const u = state.charts.actu.data.datasets;
  u[0].data = pts.map((p) => ({ x: p.x, y: 4 + p.fan_state * 0.8, state: p.fan_state }));
  u[1].data = pts.map((p) => ({ x: p.x, y: 2 + p.red_led * 0.8, state: p.red_led }));
  u[2].data = pts.map((p) => ({ x: p.x, y: 0 + p.white_led * 0.8, state: p.white_led }));

  // rentang bebas: sumbu x mengikuti rentang yang dipilih, termasuk bagian yang tidak ada datanya
  const xMin = state.range ? state.range.from.getTime() : undefined;
  const xMax = state.range ? state.range.to.getTime() : undefined;
  Object.values(state.charts).forEach((c) => {
    c.options.scales.x.min = xMin;
    c.options.scales.x.max = xMax;
    c.update('none');
  });
}

// ------------------------------------------------------------ render
function renderLatest(data) {
  state.device = data.device_id;
  $('deviceId').textContent = data.device_id || 'belum ada device';
  const L = data.latest;

  const badge = $('onlineBadge');
  badge.textContent = data.online ? 'Online' : 'Offline';
  badge.className = `badge ${data.online ? 'badge-on' : 'badge-off'}`;
  $('lastUpdate').textContent = L ? `Update: ${fmtTime(new Date(L.recorded_at).getTime(), true)}` : '—';

  if (!L) return;
  if (!state.modeLocked && !state.mode) {
    state.mode = L.mode;
    $('modeSel').value = L.mode;
    $('eMode').value = L.mode;
  }

  $('kTemp').textContent = fmt(L.temperature);
  $('kHum').textContent = fmt(L.humidity);
  $('kLight').textContent = fmt(L.light_pct, 0);
  $('kLightHint').textContent = `LDR ${L.ldr_raw ?? '—'} · ${L.is_daytime === 0 ? 'malam' : L.is_daytime === 1 ? 'siang' : 'jam belum sinkron'}`;
  state.slotSec = data.stored?.slot_sec || 60;   // panjang 1 record dataset (bukan data live)
  // menit aktif (gerak > 5 detik) dalam 20 menit terakhir, sama dengan syarat feeding di ESP32
  const A = data.activity;
  $('kAct').textContent = A ? A.active_minutes : '—';
  $('kActUnit').textContent = A ? ` / ${A.window_min} menit aktif` : '';
  $('kActHint').textContent = !L.pir_ready ? 'PIR warm-up'
    : A ? `Feeding jika ≥ ${A.needed} · menit ini bergerak ${A.last_minute_sec} detik` : 'PIR aktif';

  const st = $('kStatus');
  st.textContent = L.inactivity_status;
  st.className = `status ${L.inactivity_status}`;
  $('kIdle').textContent = `Tidak bergerak selama ${fmtDuration(L.idle_sec)}`;

  const alert = $('alertBar');
  if (L.inactivity_status === 'WARNING' || L.inactivity_status === 'CRITICAL') {
    alert.className = `alert ${L.inactivity_status}`;
    alert.textContent = L.inactivity_status === 'CRITICAL'
      ? `CRITICAL: tidak ada gerakan selama ${fmtDuration(L.idle_sec)}. Kemungkinan hamster sakit/mati, segera cek kandang.`
      : `WARNING: tidak ada aktivitas selama ${fmtDuration(L.idle_sec)}. Cek kamera atau kandang.`;
  } else {
    alert.className = 'alert hidden';
  }

  const p = data.prediction;
  $('kPred').textContent = p ? fmt(p.predicted_temp) : '—';
  $('kPredHint').textContent = p
    ? `untuk ${fmtTime(new Date(p.target_time).getTime(), true)} · ${p.model_name}`
    : 'Belum ada model (AOL)';

  setPill($('aFan'), L.fan_state === 1, 'blue');
  const reasons = [L.fan_by_temp ? 'suhu tinggi' : null, L.fan_by_hum ? 'kelembapan tinggi' : null].filter(Boolean);
  $('aFanReason').textContent = L.fan_state ? `Penyebab: ${reasons.join(' + ')}` : 'Suhu & kelembapan normal';
  setPill($('aRed'), L.red_led === 1, 'red');
  setPill($('aWhite'), L.white_led === 1, 'white');
  $('aWhiteHint').textContent = 'ON jika ruangan gelap (LDR > 3600)';

  const F = data.feeds;   // dihitung server dari dataset (feed_event)
  $('aFeeds').textContent = F ? `${F.count}/${F.max} per ${F.period_label}` : '—';
  $('aFeeds').className = 'pill';
  $('aLastFeed').textContent = data.last_feed
    ? `Feeding terakhir: ${fmtTime(new Date(data.last_feed.recorded_at).getTime(), true)} (${data.last_feed.feed_reason || '—'})`
    : 'Belum pernah feeding';
  $('feedBtn').disabled = !data.device_id || data.pending_commands > 0;
  $('feedBtn').textContent = data.pending_commands > 0 ? 'Menunggu ESP32…' : 'Beri makan sekarang';
}

function renderEvents(events) {
  const body = $('eventsBody');
  body.replaceChildren();
  if (!events.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4; td.className = 'muted'; td.textContent = 'Belum ada data';
    tr.appendChild(td); body.appendChild(tr);
    return;
  }
  for (const e of events) {
    const tr = document.createElement('tr');
    [fmtTime(new Date(e.recorded_at).getTime(), true), e.actuator, e.state, e.reason || ''].forEach((v) => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
}

function renderStats(stats) {
  const byMode = Object.fromEntries((stats.modes || []).map((m) => [m.mode, m]));
  const f = byMode.final || { records: 0, missing_dht: 0 };
  const t = byMode.test || { records: 0 };
  $('dFinal').textContent = f.records.toLocaleString('id-ID');
  $('dTest').textContent = t.records.toLocaleString('id-ID');
  $('dMissing').textContent = Number(f.missing_dht || 0).toLocaleString('id-ID');
  const pct = Math.min(f.records / DATASET_TARGET, 1) * 100;
  $('dProgress').style.width = `${pct}%`;
  $('dProgressText').textContent = f.records >= DATASET_TARGET
    ? `Target ${DATASET_TARGET.toLocaleString('id-ID')} record tercapai`
    : `${f.records.toLocaleString('id-ID')} / ${DATASET_TARGET.toLocaleString('id-ID')} record (≈ ${fmtDuration((DATASET_TARGET - f.records) * (state.slotSec || 60))} lagi)`;
  $('dRange').textContent = f.first_at
    ? `Data final: ${fmtTime(new Date(f.first_at).getTime(), true)} – ${fmtTime(new Date(f.last_at).getTime(), true)}`
    : 'Belum ada data mode final';

  if (!$('eFrom').value && (f.first_at || t.first_at)) {
    $('eFrom').value = localDate(new Date(f.first_at || t.first_at));
    $('eTo').value = localDate(new Date());
  }
}

// ------------------------------------------------------------ loop
async function refresh() {
  try {
    const latest = await api('/api/latest');
    renderLatest(latest);
    if (!latest.device_id) return;

    const q = `device=${encodeURIComponent(latest.device_id)}`;
    const mode = state.mode ? `&mode=${state.mode}` : '';
    const [rows, preds, events, stats] = await Promise.all([
      api(`/api/telemetry?${q}${mode}&${rangeQuery()}`),
      api(`/api/predictions?${q}&${rangeQuery()}`),
      api(`/api/events?${q}&limit=60`),
      api(`/api/stats?${q}`),
    ]);
    updateCharts(rows.rows, preds);
    renderEvents(events);
    renderStats(stats);
  } catch (err) {
    console.error(err);
    $('onlineBadge').textContent = 'Server error';
    $('onlineBadge').className = 'badge badge-off';
  }
}

function schedule() {
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
}

// ------------------------------------------------------------ events
function bindUi() {
  $('modeSel').addEventListener('change', (e) => {
    state.mode = e.target.value; state.modeLocked = true;
    $('eMode').value = state.mode;
    refresh();
  });
  $('rangeSel').addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      // isi awal: rentang yang sedang ditampilkan, lalu tunggu tombol "Tampilkan"
      const to = state.range ? state.range.to : new Date();
      const from = state.range ? state.range.from : new Date(to.getTime() - state.hours * 3600000);
      $('rFrom').value = localDateTime(from);
      $('rTo').value = localDateTime(to);
      $('customRange').classList.remove('hidden');
      return;
    }
    state.hours = Number(e.target.value);
    state.range = null;
    $('customRange').classList.add('hidden');
    refresh();
  });

  $('customRange').addEventListener('submit', (e) => {
    e.preventDefault();
    const from = new Date($('rFrom').value);   // datetime-local = jam lokal (WIB)
    const to = new Date($('rTo').value);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return toast('Isi tanggal & jam "Dari" dan "Sampai"');
    if (to <= from) return toast('"Sampai" harus setelah "Dari"');
    if (to - from > 31 * 86400000) return toast('Rentang maksimal 31 hari');
    state.range = { from, to };
    $('rInfo').textContent = `Menampilkan ${fmtTime(from.getTime(), true)} – ${fmtTime(to.getTime(), true)}`;
    refresh();
  });

  $('rLive').addEventListener('click', () => {
    state.range = null;
    state.hours = 6;
    $('rangeSel').value = '6';
    $('rInfo').textContent = '';
    $('customRange').classList.add('hidden');
    refresh();
  });

  $('feedBtn').addEventListener('click', async () => {
    if (!state.device) return;
    $('feedBtn').disabled = true;
    try {
      await api('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: state.device, command: 'feed' }),
      });
      toast('Perintah feeding dikirim. Dieksekusi saat ESP32 mengirim data berikutnya.');
    } catch (err) {
      toast(`Gagal: ${err.message}`);
    }
    refresh();
  });

  document.querySelectorAll('.export-btns button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.device) return toast('Belum ada data untuk diexport');
      const p = new URLSearchParams({
        device: state.device,
        format: btn.dataset.format,
        mode: $('eMode').value,
        horizon_sec: $('eHorizon').value,
      });
      if ($('eFrom').value) p.set('from', $('eFrom').value);
      if ($('eTo').value) p.set('to', $('eTo').value);
      window.location.href = `/api/export?${p.toString()}`;
    });
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  bindUi();
  refresh();
  schedule();
});
