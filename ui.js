/* ═══════════════════════════════════════════
   PipelineOS — UI Controller
   ═══════════════════════════════════════════ */

// ─── STATE ───────────────────────────────────
let simResult   = null;
let currentCycle = 1;
let playing     = false;
let playTimer   = null;
let cacheModel  = null;

// ─── INIT ────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadPreset('combined');
  buildRegGrid(makeInitialRegs());
  bindEvents();
});

function bindEvents() {
  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => loadPreset(btn.dataset.preset));
  });

  // Run button
  document.getElementById('btn-run').addEventListener('click', runSimulation);

  // Playback
  document.getElementById('btn-prev').addEventListener('click', stepPrev);
  document.getElementById('btn-next').addEventListener('click', stepNext);
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-reset').addEventListener('click', resetView);

  // Export
  document.getElementById('btn-csv').addEventListener('click', exportCSV);
  document.getElementById('btn-png').addEventListener('click', exportPNG);

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab, btn));
  });
}

// ─── THEME ───────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('pipelineOS-theme') || 'dark';
  setTheme(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
}

function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('pipelineOS-theme', t);
}

// ─── PAGE NAVIGATION ─────────────────────────
function switchPage(id) {
  document.querySelectorAll('.page').forEach(p => {
    p.style.display = 'none';
    p.classList.remove('active');
  });
  const target = document.getElementById(`page-${id}`);
  if (target) {
    target.style.display = id === 'simulator' ? 'block' : 'block';
    target.classList.add('active');
  }
  document.querySelectorAll('.nav-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === id);
  });
}

// ─── PRESET LOADER ───────────────────────────
function loadPreset(key) {
  if (PRESETS[key]) {
    document.getElementById('inst-input').value = PRESETS[key];
    document.getElementById('parse-error').style.display = 'none';
  }
}

// ─── SIMULATION ──────────────────────────────
function runSimulation() {
  const rawText = document.getElementById('inst-input').value;
  const insts   = parseProgram(rawText);
  const errEl   = document.getElementById('parse-error');

  if (!insts.length) {
    errEl.textContent = '⚠ No valid instructions found. Check your input.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';

  const forwarding   = document.getElementById('opt-forwarding').checked;
  const branchPred   = document.getElementById('opt-branch-pred').checked;
  const structural   = document.getElementById('opt-structural').checked;
  const cacheEnable  = document.getElementById('opt-cache').checked;

  const numLines     = parseInt(document.getElementById('cache-size').value, 10);
  const assoc        = parseInt(document.getElementById('cache-assoc').value, 10);
  const penalty      = parseInt(document.getElementById('cache-penalty').value, 10) || 4;
  const missMode     = document.getElementById('cache-miss-mode').value;

  cacheModel = new CacheModel(numLines, assoc, penalty, missMode);

  simResult = runPipeline(insts, {
    forwarding, branchPred, structural, cacheEnable, cachePenalty: penalty
  }, cacheModel);

  // Animate run button
  const btn = document.getElementById('btn-run');
  btn.style.transform = 'scale(0.97)';
  setTimeout(() => { btn.style.transform = ''; }, 200);

  renderStats(simResult, insts.length);
  renderTable(simResult);
  renderHazards(simResult);
  renderCachePanel(simResult);

  // Show controls and tabs
  document.getElementById('playbar').style.display = 'flex';
  document.getElementById('legend-bar').style.display = 'flex';
  document.getElementById('detail-section').style.display = 'flex';

  currentCycle = 1;
  buildRegGrid(makeInitialRegs());
  updateCycleDisplay();
}

// ─── RENDER TABLE ────────────────────────────
function renderTable(result, activeCycle) {
  const { insts, startCycle, stallsBefore, totalCycles, ctrlHazards, fwdPaths,
          forwarding, cacheHazards } = result;

  const highlight = document.getElementById('opt-highlight').checked;
  const stepMode  = activeCycle !== undefined;
  const N         = insts.length;

  // Build flush cycle map: flushCycle → true
  const flushCycles = {};
  ctrlHazards.forEach(h => {
    for (let p = 1; p <= h.penalty; p++) {
      flushCycles[startCycle[h.inst] + 1 + p] = true;
    }
  });

  let html = `<table class="ptable${stepMode ? ' step-mode' : ''}">`;

  // Header row
  html += '<tr><th></th>';
  for (let c = 1; c <= totalCycles; c++) {
    const isAct = stepMode && c === activeCycle;
    const isDim = stepMode && !isAct;
    const flushMark = flushCycles[c] ? ' style="color:var(--orange)"' : '';
    html += `<th class="${isAct ? 'col-active' : ''} ${isDim ? 'col-dim' : ''}"${flushMark}>C${c}</th>`;
  }
  html += '</tr>';

  // Instruction rows
  for (let i = 0; i < N; i++) {
    const s   = startCycle[i];
    const st  = stallsBefore[i];
    const inst = insts[i];

    const shortOps = inst.text.replace(/^[A-Z]+\s*/i, '').trim().substring(0, 24);
    const labelHtml = `<td class="row-label">` +
      `<span class="idx">I${i}·</span>` +
      `<span class="mnem">${esc(inst.mnem)}</span> ` +
      `<span class="ops">${esc(shortOps)}</span></td>`;

    html += '<tr>' + labelHtml;

    for (let c = 1; c <= totalCycles; c++) {
      const si = c - s;
      const isAct = stepMode && c === activeCycle;
      const isDim = stepMode && !isAct;
      const ccls = isAct ? 'col-active-cell' : (isDim ? 'col-dim' : '');

      let stageCls = 's-EMPTY';
      let lbl = '';
      let extra = '';

      const inStall = st > 0 && c >= (s - st) && c < s;

      if (inStall) {
        stageCls = 's-STALL';
        lbl = 'STALL';
        if (highlight) extra = 'box-shadow:inset 0 0 0 2px rgba(248,113,113,.4);';
      } else if (si >= 0 && si < STAGES.length) {
        const stage = STAGES[si];
        const isFwd  = forwarding && fwdPaths.some(f => f.to === i && stage === 'EX');
        const isMiss = cacheHazards.some(ch => ch.inst === i && stage === 'MEM');

        if (isMiss) {
          stageCls = 's-CACHE'; lbl = '$MISS';
        } else if (isFwd) {
          stageCls = 's-FWD'; lbl = 'FWD';
          if (highlight) extra = 'box-shadow:inset 0 0 0 2px rgba(45,212,191,.4);';
        } else {
          stageCls = `s-${stage}`; lbl = stage;
        }
      }

      html += `<td class="${stageCls}${ccls ? ' ' + ccls : ''}" style="${extra}" title="I${i}: ${esc(inst.text.trim())} | C${c} | ${lbl || '—'}">${lbl}</td>`;
    }

    html += '</tr>';

    // Flush rows
    const bh = ctrlHazards.find(h => h.inst === i);
    if (bh) {
      for (let p = 1; p <= bh.penalty; p++) {
        const fc = s + 1 + p;
        html += '<tr>';
        html += `<td class="row-label flush-label">↳ FLUSH #${p}</td>`;
        for (let c = 1; c <= totalCycles; c++) {
          const isAct = stepMode && c === activeCycle;
          const isDim = stepMode && !isAct;
          const ccls = isAct ? 'col-active-cell' : (isDim ? 'col-dim' : '');
          html += c === fc
            ? `<td class="s-FLUSH${ccls ? ' ' + ccls : ''}">FLUSH</td>`
            : `<td class="s-EMPTY${ccls ? ' ' + ccls : ''}"></td>`;
        }
        html += '</tr>';
      }
    }
  }

  html += '</table>';
  document.getElementById('pipeline-canvas').innerHTML = html;
}

// ─── RENDER STATS ────────────────────────────
function renderStats(r, n) {
  const allStalls = r.stallCount + r.ctrlStalls;
  setEl('stat-cycles',    r.totalCycles);
  setEl('stat-insts',     n);
  setEl('stat-cpi',       (r.totalCycles / n).toFixed(2));
  setEl('stat-eff',       ((n / r.totalCycles) * 100).toFixed(1) + '%');
  setEl('stat-stalls',    allStalls);
  setEl('stat-data-hz',   r.dataHazards.length);
  setEl('stat-ctrl-hz',   r.ctrlHazards.length);
  setEl('stat-struct-hz', r.structHazards.length);
  setEl('stat-cache-miss',r.cacheHazards.length);
  setEl('stat-fwd',       r.fwdPaths.length);
}

// ─── RENDER HAZARDS ──────────────────────────
function renderHazards(r) {
  const { insts, dataHazards, ctrlHazards, structHazards,
          cacheHazards, fwdPaths, forwarding, structural, cacheEnabled } = r;

  // Data hazards
  const dl = document.getElementById('data-hazard-list');
  dl.innerHTML = '';
  if (!dataHazards.length) {
    dl.innerHTML = '<li><span class="hz-icon">✅</span><div><span class="hz-main" style="color:var(--green)">No data hazards detected</span></div></li>';
  } else {
    dataHazards.forEach(h => {
      const prod = insts[h.producer]?.text.trim() || '';
      const cons = insts[h.consumer]?.text.trim() || '';
      const icon = h.forwarded ? '↪' : '⚡';
      const col  = h.forwarded ? 'var(--teal)' : 'var(--red)';
      dl.innerHTML += `<li><span class="hz-icon" style="color:${col}">${icon}</span><div>
        <span class="hz-main">${esc(h.type)}</span> on <code style="font-family:'Space Mono',monospace;color:var(--accent)">${esc(h.reg)}</code>
        <span class="hz-detail">I${h.producer}: ${esc(prod.substring(0,26))} → I${h.consumer}: ${esc(cons.substring(0,26))}</span>
        <span class="hz-detail">${h.stalls > 0 ? h.stalls + ' stall(s)' : 'No stall'} ${h.forwarded ? '· forwarding applied' : ''}</span>
      </div></li>`;
    });
  }

  // Control hazards
  const cl = document.getElementById('ctrl-hazard-list');
  cl.innerHTML = '';
  if (!ctrlHazards.length) {
    cl.innerHTML = '<li><span class="hz-icon">✅</span><div><span class="hz-main" style="color:var(--green)">No control hazards detected</span></div></li>';
  } else {
    ctrlHazards.forEach(h => {
      const instText = insts[h.inst]?.text.trim() || '';
      cl.innerHTML += `<li><span class="hz-icon" style="color:var(--yellow)">⟳</span><div>
        <span class="hz-main">Branch Hazard</span>
        <span class="hz-detail">I${h.inst}: ${esc(instText.substring(0,30))}</span>
        <span class="hz-detail">${h.penalty} cycle(s) flushed · ${h.predicted ? 'predict not-taken (1c)' : 'no prediction (2c)'}</span>
      </div></li>`;
    });
  }

  // Forwarding paths
  const fs = document.getElementById('fwd-section');
  const fl = document.getElementById('fwd-paths-list');
  if (fwdPaths.length > 0 && forwarding) {
    fs.style.display = 'block';
    fl.innerHTML = '';
    fwdPaths.forEach(f => {
      fl.innerHTML += `<div class="fwd-path">
        I${f.from} [${esc(f.fromStage)}] <span class="farrow">──${esc(f.reg)}──▶</span> I${f.to} [${esc(f.toStage)}]
      </div>`;
    });
  } else {
    fs.style.display = 'none';
  }

  // Structural hazards
  const ss = document.getElementById('struct-section');
  const sl = document.getElementById('struct-hazard-list');
  if (structHazards.length > 0 && structural) {
    ss.style.display = 'block';
    sl.innerHTML = '';
    structHazards.forEach(h => {
      sl.innerHTML += `<li><span class="hz-icon" style="color:var(--purple)">🔒</span><div>
        <span class="hz-main" style="color:var(--purple)">${esc(h.type)}</span>
        <span class="hz-detail">I${h.inst1} conflicts with I${h.inst2} at C${h.cycle} · ${h.stalls} stall(s)</span>
      </div></li>`;
    });
  } else {
    ss.style.display = 'none';
  }

  // Cache hazards
  const chs = document.getElementById('cache-hz-section');
  const chl = document.getElementById('cache-hazard-list');
  if (cacheHazards.length > 0 && cacheEnabled) {
    chs.style.display = 'block';
    chl.innerHTML = '';
    cacheHazards.forEach(h => {
      const addrHex = (h.address * 4).toString(16).padStart(4, '0');
      chl.innerHTML += `<li><span class="hz-icon" style="color:var(--orange)">💾</span><div>
        <span class="hz-main" style="color:var(--orange)">${esc(h.type)}</span>
        <span class="hz-detail">I${h.inst} · addr 0x${addrHex} · +${h.penalty} stall cycle(s)</span>
      </div></li>`;
    });
  } else {
    chs.style.display = 'none';
  }
}

// ─── RENDER CACHE PANEL ──────────────────────
function renderCachePanel() {
  if (!cacheModel) return;
  const { hits, misses, numSets, assoc, sets, accessLog } = cacheModel;
  const tot = hits + misses;

  setEl('cs-accesses', tot);
  setEl('cs-hits',     hits);
  setEl('cs-misses',   misses);
  setEl('cs-rate',     cacheModel.hitRate);
  setEl('cs-stalls',   simResult ? simResult.cacheHazards.reduce((a, h) => a + h.penalty, 0) : 0);

  const con = document.getElementById('cache-lines');
  con.innerHTML = '';

  for (let s = 0; s < numSets; s++) {
    for (let w = 0; w < assoc; w++) {
      const entry = sets[s][w];
      const la = accessLog.filter(a => a.set === s && a.tag === entry.tag).pop();
      const d = document.createElement('div');
      d.className = `cache-line${la?.hit ? ' hit' : (la && !la.hit ? ' miss' : '')}`;
      d.innerHTML = `<div class="cl-set">Set${s}${assoc > 1 ? ` W${w}` : ''}</div>
        <div class="cl-tag">${entry.valid ? 'Tag:0x' + entry.tag.toString(16).padStart(3, '0') : '&lt;empty&gt;'}</div>
        <div class="cl-state">${entry.valid ? (la?.hit ? '✅ Hit' : (la ? '❌ Miss' : 'Valid')) : '—'}</div>`;
      con.appendChild(d);
    }
  }
}

// ─── REGISTER VIEW ───────────────────────────
function buildRegGrid(regs) {
  const g = document.getElementById('reg-grid');
  g.innerHTML = '';
  for (let i = 0; i <= 31; i++) {
    const nm = `R${i}`, val = regs[nm] ?? 0;
    const d = document.createElement('div');
    d.className = 'reg-cell';
    d.id = `rc-${nm}`;
    d.innerHTML = `<div class="reg-name">${nm}</div>
      <div class="reg-val" id="rv-${nm}">${fmtHex(val)}</div>`;
    g.appendChild(d);
  }
}

function updateRegAtCycle(cycle) {
  if (!simResult) return;
  const { insts, startCycle, stallsBefore, fwdPaths, cacheHazards } = simResult;
  const regs = makeInitialRegs();
  const justWritten = {};
  const logLines = [];

  // Apply all WBs that complete by this cycle
  for (let i = 0; i < insts.length; i++) {
    const s = startCycle[i];
    const inst = insts[i];
    const wbCycle = s + 4;
    if (wbCycle <= cycle && inst.dest) {
      regs[inst.dest] = computeResult(inst, regs);
      justWritten[inst.dest] = wbCycle;
    }
  }

  // Generate log for current cycle
  for (let i = 0; i < insts.length; i++) {
    const s  = startCycle[i];
    const st = stallsBefore[i];
    const inst = insts[i];
    const si = cycle - s;
    const inStall = st > 0 && cycle >= (s - st) && cycle < s;

    if (inStall) {
      logLines.push({ cls: 'log-stall', t: `C${cycle}: I${i} [${esc(inst.mnem)}] ⛔ STALL` });
    } else if (si >= 0 && si < STAGES.length) {
      const stage = STAGES[si];
      if (stage === 'WB' && inst.dest) {
        logLines.push({ cls: 'log-wb', t: `C${cycle}: I${i} [${esc(inst.mnem)}] ✅ WB → ${inst.dest} = ${fmtHex(regs[inst.dest] ?? 0)}` });
      } else if (stage === 'MEM' && (inst.isLoad || inst.isStore)) {
        const miss = simResult.cacheHazards.find(ch => ch.inst === i);
        if (miss) {
          logLines.push({ cls: 'log-cache', t: `C${cycle}: I${i} [${esc(inst.mnem)}] 💾 $MISS (+${miss.penalty}c)` });
        } else {
          logLines.push({ cls: 'log-default', t: `C${cycle}: I${i} [${esc(inst.mnem)}] ${stage}` });
        }
      } else if (stage === 'EX') {
        const fwd = fwdPaths.find(fp => fp.to === i);
        if (fwd) {
          logLines.push({ cls: 'log-fwd', t: `C${cycle}: I${i} [${esc(inst.mnem)}] ↪ EX (fwd ${fwd.reg} from I${fwd.from})` });
        } else {
          logLines.push({ cls: 'log-default', t: `C${cycle}: I${i} [${esc(inst.mnem)}] ${stage}` });
        }
      } else {
        logLines.push({ cls: 'log-default', t: `C${cycle}: I${i} [${esc(inst.mnem)}] ${stage}` });
      }
    }
  }

  // Update register cells
  for (let i = 0; i <= 31; i++) {
    const nm  = `R${i}`;
    const val = regs[nm] ?? 0;
    const cell  = document.getElementById(`rc-${nm}`);
    const valEl = document.getElementById(`rv-${nm}`);
    if (!cell || !valEl) continue;
    valEl.textContent = fmtHex(val);
    cell.className = 'reg-cell' +
      (justWritten[nm] === cycle ? ' just-written' : justWritten[nm] !== undefined ? ' dirty' : '');
  }

  setEl('reg-cycle-lbl', `${cycle} / ${simResult.totalCycles}`);

  const logEl = document.getElementById('cycle-log');
  logEl.innerHTML = logLines.length
    ? logLines.map(l => `<div class="${l.cls}">${l.t}</div>`).join('')
    : '<span style="color:var(--muted)">No active stages this cycle.</span>';
  logEl.scrollTop = 0;
}

// ─── STEP CONTROLS ───────────────────────────
function stepNext() {
  if (!simResult) return;
  if (currentCycle < simResult.totalCycles) { currentCycle++; updateCycleDisplay(); }
}

function stepPrev() {
  if (!simResult) return;
  if (currentCycle > 1) { currentCycle--; updateCycleDisplay(); }
}

function resetView() {
  stopPlay();
  currentCycle = 1;
  updateCycleDisplay();
}

function stopPlay() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  playing = false;
  document.getElementById('btn-play').textContent = '⏵';
}

function togglePlay() {
  if (playing) { stopPlay(); return; }
  if (!simResult) return;
  playing = true;
  document.getElementById('btn-play').textContent = '⏸';
  const spd = parseInt(document.getElementById('speed-select').value, 10) || 500;
  if (currentCycle >= simResult.totalCycles) currentCycle = 1;
  playTimer = setInterval(() => {
    if (currentCycle >= simResult.totalCycles) { stopPlay(); return; }
    currentCycle++;
    updateCycleDisplay();
  }, spd);
}

function updateCycleDisplay() {
  if (!simResult) return;
  const total = simResult.totalCycles;
  document.getElementById('cycle-display').textContent = `C${currentCycle} / C${total}`;
  document.getElementById('progress-fill').style.width = ((currentCycle / total) * 100) + '%';
  document.getElementById('btn-prev').disabled = currentCycle <= 1;
  document.getElementById('btn-next').disabled = currentCycle >= total;
  renderTable(simResult, currentCycle);
  updateRegAtCycle(currentCycle);
}

// ─── TABS ────────────────────────────────────
function switchTab(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById(id);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
}

// ─── EXPORT ──────────────────────────────────
function exportPNG() {
  if (!simResult) return;
  const target = document.getElementById('pipeline-export-target');

  const doExport = () => {
    html2canvas(target, {
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg'),
      scale: 2,
      useCORS: true,
      logging: false
    }).then(canvas => {
      const a = document.createElement('a');
      a.download = `pipeline_C${currentCycle}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    }).catch(() => alert('PNG export failed. Try right-clicking the table and saving as image.'));
  };

  if (typeof html2canvas === 'undefined') {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = doExport;
    s.onerror = () => alert('Could not load html2canvas library.');
    document.head.appendChild(s);
  } else {
    doExport();
  }
}

function exportCSV() {
  if (!simResult) return;
  const { insts, startCycle, stallsBefore, totalCycles, fwdPaths, forwarding, cacheHazards } = simResult;
  const N = insts.length;

  let csv = 'Instruction,' + Array.from({ length: totalCycles }, (_, i) => `C${i+1}`).join(',') + '\n';

  for (let i = 0; i < N; i++) {
    const s  = startCycle[i];
    const st = stallsBefore[i];
    const cells = [];

    for (let c = 1; c <= totalCycles; c++) {
      const si = c - s;
      const inStall = st > 0 && c >= (s - st) && c < s;
      if (inStall) {
        cells.push('STALL');
      } else if (si >= 0 && si < 5) {
        const stage = STAGES[si];
        const isFwd  = forwarding && fwdPaths.some(f => f.to === i && stage === 'EX');
        const isMiss = cacheHazards.some(ch => ch.inst === i && stage === 'MEM');
        cells.push(isMiss ? '$MISS' : (isFwd ? 'FWD' : stage));
      } else {
        cells.push('');
      }
    }
    csv += `"I${i}: ${insts[i].text.trim()}",` + cells.join(',') + '\n';
  }

  csv += '\n--- Metrics ---\n';
  csv += `Total Cycles,${totalCycles}\n`;
  csv += `Instructions,${N}\n`;
  csv += `CPI,${(totalCycles / N).toFixed(3)}\n`;
  csv += `Efficiency,${((N / totalCycles) * 100).toFixed(1)}%\n`;
  csv += `Data Hazards,${simResult.dataHazards.length}\n`;
  csv += `Control Hazards,${simResult.ctrlHazards.length}\n`;
  csv += `Structural Hazards,${simResult.structHazards.length}\n`;
  csv += `Cache Misses,${simResult.cacheHazards.length}\n`;
  csv += `Forwarding Paths,${simResult.fwdPaths.length}\n`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'pipeline_sim.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ─── UTILS ───────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function fmtHex(val) {
  return '0x' + ((val >>> 0).toString(16).padStart(4, '0').toUpperCase());
}
