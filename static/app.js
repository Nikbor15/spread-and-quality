/* ── STATE ───────────────────────────────────────────────────────────────── */
const state = {
 data: null,
 tab: 'catalogo',
 sort: { col: null, dir: 'asc' },
 pendingFiles: [],
 tpBonds: [],
 feeBased: false,
 portfolio: new Map(),
 cdiRate: 10.65, // % a.a. — used to convert CDI% delta from pp-CDI -> pp absolute
 multiFilters: {
 rating: new Set(),
 setor: new Set(),
 tipo: new Set(),
 juros: new Set(),
 publico: new Set(),
 indexador: new Set(),
 },
};

/* ── UPLOAD ──────────────────────────────────────────────────────────────── */
function openUpload() { document.getElementById('uploadModal').classList.add('open'); }
function closeUpload() { document.getElementById('uploadModal').classList.remove('open'); }
function closeUploadOnOverlay(e) { if (e.target === e.currentTarget) closeUpload(); }

function handleDrop(e) {
 e.preventDefault();
 e.currentTarget.classList.remove('drag-over');
 handleFiles(e.dataTransfer.files);
}

function handleFiles(files) {
 state.pendingFiles = Array.from(files).filter(f =>
 /\.(xlsx|xls|csv)$/i.test(f.name)
 );
 document.getElementById('btnProcess').disabled = state.pendingFiles.length === 0;
 if (state.pendingFiles.length)
 log(`${state.pendingFiles.length} arquivo(s): ${state.pendingFiles.map(f=>f.name).join(', ')}`, 'inf');
}

async function uploadFiles() {
 if (!state.pendingFiles.length) return;
 const btn = document.getElementById('btnProcess');
 btn.disabled = true;
 btn.innerHTML = '<span class="loading-spinner"></span>Processando...';
 const fd = new FormData();
 state.pendingFiles.forEach((f, i) => fd.append(`file_${i}`, f));
 try {
 const res = await fetch('/api/upload', { method:'POST', body:fd });
 const json = await res.json();
 json.processed.forEach(p => { log(` ${p.file} -> ${typeLabel(p.type)}`, 'ok'); markSlot(p.type); });
 json.errors.forEach(e => log(`X ${e.file}: ${e.error}`, 'err'));
 if (json.processed.length) await loadData();
 } catch(err) {
 log(`Erro: ${err.message}`, 'err');
 } finally {
 btn.innerHTML = 'Processar';
 btn.disabled = false;
 state.pendingFiles = [];
 }
}

function typeLabel(t) {
 return { anbima_cri_cra:'ANBIMA CRI/CRA', anbima_debentures:'ANBIMA Debêntures',
 produtos:'Produtos XP', produtos_tp:'Produtos XP — TP',
 empresas:'Score Emissores', mercado:'RF Mercado',
 b3_negocios:'B3 — Negócios Mercado Secundário' }[t] || t;
}
function markSlot(type) {
 const el = document.getElementById(`slot-${type}`);
 if (el) { el.classList.add('loaded'); el.querySelector('.slot-icon').textContent = ''; }
}
function log(msg, cls='inf') {
 const box = document.getElementById('uploadLog');
 box.style.display = 'block';
 const l = document.createElement('div');
 l.className = `log-${cls}`; l.textContent = msg;
 box.appendChild(l); box.scrollTop = box.scrollHeight;
}

/* ── DATA LOAD ───────────────────────────────────────────────────────────── */
async function loadData() {
 const res = await fetch('/api/data');
 state.data = await res.json();
 updateHeader(); updateStats(); renderCurrentTab();
 // Carrega diagnóstico em paralelo (não bloqueia render)
 refreshDiagnostics();
 // Atualiza CDI dinâmico do BCB (não bloqueia render — usa fallback se falhar)
 refreshCdiRate();
}

/* ── DIAGNÓSTICO ────────────────────────────────────────────────────────── */
async function refreshDiagnostics() {
 try {
 const res = await fetch('/api/diagnostics');
 state.diagnostics = await res.json();
 _updateDiagChip();
 } catch(_){}
}
function _updateDiagChip() {
 const d = state.diagnostics; if (!d) return;
 const c = d.counts || {};
 const failXp = (c.sem_match||0) + (c.sem_score||0) + (c.indice_desconhecido||0);
 const failB3 = (c.b3_sem_match||0);
 const fail = failXp + failB3;
 const chip = document.getElementById('diagChip'); if (!chip) return;
 if (!fail) { chip.style.display = 'none'; return; }
 chip.style.display = '';
 // Texto do chip: prioriza categoria com mais ocorrências, mas mostra ambas
 const parts = [];
 if (failXp) parts.push(`${failXp} XP`);
 if (failB3) parts.push(`${failB3} B3`);
 chip.innerHTML = `! ${parts.join(' · ')} sem casamento`;
 chip.title = `Tickers sem ANBIMA: ${c.sem_match||0} · Emissores sem score: ${c.sem_score||0} · Indexador desconhecido: ${c.indice_desconhecido||0} · B3 sem cobertura XP: ${c.b3_sem_match||0}${(c.b3_sem_match_low_vol||0)?` (+${c.b3_sem_match_low_vol} ocultos por baixo volume)`:''}`;
}
function openDiagModal() {
 const d = state.diagnostics;
 const body = document.getElementById('diagContent');
 if (!d) { body.innerHTML = '<p style="color:var(--txt-muted)">Carregando…</p>'; }
 else {
 const c = d.counts || {};
 const tickers = d.unmatched_tickers || [];
 const emissores = d.unmatched_emissores || [];
 const itypes = d.unknown_itype || [];
 const b3u = d.unmatched_b3 || {items:[], hidden_low_vol:0, total_b3:0, n_total_relevant:0};
 const fmtList = (items, fmt) => items.length
 ? `<ul class="diag-list">${items.slice(0,200).map(fmt).join('')}</ul>`
 + (items.length>200 ? `<p style="font-size:9.5px;color:var(--txt-dim);margin-top:4px">+${items.length-200} ocultos no payload</p>`: '')
: '<div class="diag-empty">Nenhum problema detectado</div>';

 // Seção B3: agrupa unmatched por instrumento e mostra top por volume
 const b3Items = b3u.items || [];
 const b3HasData = (c.b3_total||0) > 0;
 let b3Section = '';
 if (b3HasData) {
 // Agrupa por instrumento p/ a barra de cobertura
 const byInstr = {};
 b3Items.forEach(i => {
 const k = i.instr || '?';
 if (!byInstr[k]) byInstr[k] = { n:0, vol:0, vol_extra:0 };
 byInstr[k].n += 1;
 byInstr[k].vol += i.vol_total||0;
 byInstr[k].vol_extra += i.vol_extra||0;
 });
 const instrChips = Object.entries(byInstr)
.sort((a,b) => b[1].vol - a[1].vol)
.map(([k,v]) => `<span class="diag-count" style="color:var(--blue-lt)"><strong>${v.n}</strong>${_esc(k)} <span style="color:var(--txt-dim);font-weight:400">(${fmtVol(v.vol)})</span></span>`)
.join('');

 const hiddenNote = (b3u.hidden_low_vol||0)
 ? `<p style="font-size:9.5px;color:var(--txt-dim);margin-top:4px">+${b3u.hidden_low_vol} papéis sem match com volume &lt; R$ 100k (filtrados — irrelevância institucional)</p>`
: '';

 b3Section = `
 <div class="diag-section">
 <h4>Cobertura B3 vs universo XP — total: ${c.b3_total||0} papéis</h4>
 <p style="font-size:10px;color:var(--txt-muted);margin:0 0 6px">
 <span style="color:var(--green-lt)"> ${c.b3_matched||0} com cobertura XP</span> ·
 <span style="color:var(--gold-lt)">! ${c.b3_sem_match||0} líquidos no B3 sem cobertura XP (vol ≥ R$ 100k)</span>
</p>
 ${instrChips ? `<div class="diag-counts" style="margin-bottom:8px">${instrChips}</div>`: ''}
 </div>
 <div class="diag-section">
 <h4>Códigos B3 negociando &gt; R$ 100k SEM cobertura XP (${(b3u.n_total_relevant ?? b3Items.length).toLocaleString('pt-BR')})</h4>
 <p style="font-size:9.5px;color:var(--txt-dim);margin:0 0 6px">
 Papéis líquidos no mercado oficial que a XP não distribui — gap de cobertura / oportunidade de pesquisa.
</p>
 ${b3Items.length ? `
 <ul class="diag-list">${b3Items.slice(0,200).map(i => `<li>
 <span class="diag-tk">${_esc(i.cod_if||'?')}</span>
 <span class="diag-info" style="flex:1">
 <span class="instr-badge ${_b3InstrBadgeCls(i.instr)}" style="margin-right:6px">${_esc((i.instr||'?').toUpperCase())}</span>
 <span title="${_esc(i.emissor||'')}" style="color:var(--txt-sec)">${_esc((i.emissor||'?').substring(0,40))}</span>
</span>
 <span style="color:var(--blue-lt);font-family:var(--mono);font-size:10px">${fmtVol(i.vol_total)}</span>
 <span style="color:var(--gold-lt);font-family:var(--mono);font-size:9.5px">${i.n_trades||0}t</span>
 <span class="b3-ratio-pill ${_b3RatioCls(i.ratio_extra)}">${i.ratio_extra!=null?Math.round(i.ratio_extra*100)+'%':'—'}</span>
</li>`).join('')}</ul>
 ${(b3u.n_total_relevant||0) > b3Items.length ? `<p style="font-size:9.5px;color:var(--txt-dim);margin-top:4px">+${(b3u.n_total_relevant - b3Items.length).toLocaleString('pt-BR')} ocultos no payload (mostrando top ${b3Items.length} por volume)</p>`: ''}
 ${hiddenNote}
 `: '<div class="diag-empty">Toda a B3 com volume relevante tem cobertura XP</div>'}
 </div>`;
 }

 body.innerHTML = `
 <div class="diag-counts">
 <span class="diag-count"><strong>${c.produtos||0}</strong>produtos XP</span>
 <span class="diag-count"><strong>${c.anbima||0}</strong>refs ANBIMA</span>
 <span class="diag-count" style="color:var(--green-lt)"><strong>${c.matched||0}</strong>com match</span>
 ${(c.sem_match||0)?`<span class="diag-count" style="color:var(--red-lt)"><strong>${c.sem_match}</strong>sem ANBIMA</span>`:''}
 ${(c.sem_score||0)?`<span class="diag-count" style="color:var(--gold-lt)"><strong>${c.sem_score}</strong>sem score</span>`:''}
 ${(c.indice_desconhecido||0)?`<span class="diag-count" style="color:var(--gold-lt)"><strong>${c.indice_desconhecido}</strong>idx desconhecido</span>`:''}
 </div>
 <div class="diag-section">
 <h4>Tickers XP sem referência ANBIMA (${tickers.length})</h4>
 ${fmtList(tickers, t=>`<li><span class="diag-tk">${_esc(t.ticker||'?')}</span><span class="diag-info">${_esc(t.ativo||'')}</span></li>`)}
 </div>
 <div class="diag-section">
 <h4>Emissores ANBIMA sem score (${emissores.length})</h4>
 ${fmtList(emissores, e=>`<li><span class="diag-info">${_esc(e)}</span></li>`)}
 </div>
 <div class="diag-section">
 <h4>Indexadores não reconhecidos (${itypes.length})</h4>
 ${fmtList(itypes, t=>`<li><span class="diag-tk">${_esc(t.ticker||'?')}</span><span class="diag-info">${_esc(t.indice||'?')}</span></li>`)}
 </div>
 ${b3Section}`;
 }
 document.getElementById('diagModal').classList.add('open');
}

/** Helpers reutilizados pelo modal de diagnóstico para renderizar B3. */
function _b3InstrBadgeCls(instr) {
 const i = (instr||'').toUpperCase();
 return ({CRI:'instr-cri', CRA:'instr-cra', DEB:'instr-deb', CDCA:'instr-cdca',
 LF:'instr-lf', CDB:'instr-cdb', LCI:'instr-lci', LCA:'instr-lca'})[i] || 'instr-other';
}
function _b3RatioCls(r) {
 if (r == null) return 'b3-ratio-na';
 if (r >= 0.5) return 'b3-ratio-hi';
 if (r >= 0.2) return 'b3-ratio-md';
 return 'b3-ratio-lo';
}
function closeDiagModal() {
 document.getElementById('diagModal').classList.remove('open');
}

/* ── RESUMO EXECUTIVO ───────────────────────────────────────────────────── */
function openResumoModal() {
 const body = document.getElementById('resumoBody');
 const d = state.data;
 if (!d || !(d.loaded||[]).length) {
 body.innerHTML = `<p class="modal-desc" style="color:var(--gold-lt)">Faça upload dos arquivos antes de gerar o resumo.</p>`;
 document.getElementById('resumoModal').classList.add('open');
 return;
 }
 const modeLabel = state.feeBased ? 'Fee-based': 'Comissão';

 // 1. Top 5 oportunidades (Mercado vs Catálogo XP)
 const opor = [...(d.oportunidades || [])]
.filter(r => (state.feeBased ? r.delta_vs_catalog_fb: r.delta_vs_catalog) > 0)
.sort((a,b)=> {
 const da = state.feeBased ? a.delta_vs_catalog_fb: a.delta_vs_catalog;
 const db = state.feeBased ? b.delta_vs_catalog_fb: b.delta_vs_catalog;
 return (db||0) - (da||0);
 })
.slice(0, 5);

 // 2. Top 5 ativos do catálogo XP por Δ ANBIMA (melhor "compra primária")
 const allCat = ['ipca','cdi_pct','cdi_plus','pre','outros'].flatMap(k => d.spread_score?.[k] || []);
 const topCat = allCat.filter(r => r.delta_anbima != null && r.aloc_max > 0)
.sort((a,b)=> (b.delta_anbima||0) - (a.delta_anbima||0))
.slice(0, 5);

 // 2b. Top 5 por FAIR-VALUE (Taxa Mín XP vs Taxa Venda ANBIMA — OFFER
 // interbancário), separado por indexador. Comparação OFFER vs OFFER:
 // XP é o vendedor (cliente compra dela), ANBIMA Venda é o OFFER do dealer
 // interbancário. Δ positivo = XP oferece taxa MAIOR que o melhor preço
 // institucional -> cliente captura prêmio acima do book interbancário.
 //
 // SOMENTE INDICADOS: aloc_max > 0 (papel recomendado pela mesa).
 // Empate desempata por menor duração (entrega mais rápida).
 const topFairByIdx = {};
 ['IPCA','CDI%','CDI+','PRE'].forEach(idx => {
 const bucket = idx === 'IPCA' ? 'ipca':
 idx === 'CDI%' ? 'cdi_pct':
 idx === 'CDI+' ? 'cdi_plus': 'pre';
 const list = (d.spread_score?.[bucket] || [])
.filter(r => r.aloc_max > 0
 && r.spread_xp != null
 && r.anbima_venda != null)
.map(r => ({
...r,
 _delta_vs_venda_anb: r.spread_xp - r.anbima_venda,
 }))
.sort((a,b) => {
 if (b._delta_vs_venda_anb !== a._delta_vs_venda_anb)
 return b._delta_vs_venda_anb - a._delta_vs_venda_anb;
 return (a.dur||9e9) - (b.dur||9e9);
 })
.slice(0, 5);
 topFairByIdx[idx] = list;
 });

 // 3. Trocas viáveis (apenas se houver posições parseadas)
 const swaps = (state_posicao.positions || []).map(pos => {
 const alts = _lookupAlternatives(pos);
 const cat = alts[0];
 if (!cat) return null;
 const r = _rowEffectiveRate(cat).spread_xp;
 const pb = _swapPayback(pos, r);
 if (pb == null || pb > 5) return null;
 return { pos, cat, rate: r, payback: pb };
 }).filter(Boolean).sort((a,b)=> a.payback - b.payback).slice(0, 5);

 // 4. Alertas: emissores em RJ na carteira; conglomerados concentrados
 const portRows = [...state.portfolio.values()].map(e => e.row);
 const rjInPort = portRows.filter(r => r.rj);
 const congCount = {};
 portRows.forEach(r => { const c = _conglomerate(r); if (c) congCount[c.grp] = (congCount[c.grp]||0)+1; });
 const congHigh = Object.entries(congCount).filter(([,n]) => n > 1);

 // 5. Diagnóstico resumido
 const diagC = state.diagnostics?.counts || {};
 const totalIssues = (diagC.sem_match||0) + (diagC.sem_score||0) + (diagC.indice_desconhecido||0);

 const fmtRate = v => v != null ? v.toFixed(2)+'%': '—';
 const fmtPP = v => v != null ? (v>0?'+':'')+v.toFixed(2)+'pp': '—';

 // Aba inicial do card "Top fair-value" — primeiro indexador com pelo menos 1 papel
 const defaultFairIdx = ['IPCA','CDI%','CDI+','PRE'].find(k => topFairByIdx[k].length > 0) || 'IPCA';
 // Cache no state para o switch de abas reusar (sem recomputar)
 state._resumoFair = topFairByIdx;

 body.innerHTML = `
 <div class="resumo-header">
 <p class="resumo-subtitle">Visão consolidada · modo <strong>${modeLabel}</strong></p>
 </div>

 <div class="resumo-grid">
 <!-- Top 5 Oportunidades — Mercado >Catálogo. Colunas iguais ao Top 5 Catálogo. -->
 <div class="resumo-card">
 <h4 class="resumo-card-title" style="color:var(--green-lt)">Top 5 oportunidades — Mercado &gt; Catálogo</h4>
 ${opor.length ? `
 <table class="resumo-tbl">
 <thead><tr><th>Emissor</th><th>Ticker</th><th>Vcto</th><th>IDX</th><th class="right">Taxa</th><th class="right">Δ ANB</th></tr></thead>
 <tbody>${opor.map(r=>{
 return `<tr>
 <td title="${_esc(r.emissor||'')}"><a href="#" onclick="closeResumoModal();openXpDetailModal('${_esc(r.ticker)}');return false" style="color:var(--blue-lt);text-decoration:none">${_esc((r.emissor||'?').substring(0,22))}</a></td>
 <td class="cell-ticker">${_esc(r.ticker||'—')}</td>
 <td class="cell-venc">${_esc(r.vencimento||'—')}</td>
 <td style="font-size:9.5px;color:var(--txt-muted)">${_esc(r.indice_type||'—')}</td>
 <td class="mono right">${fmtRate(r.offer_rate)}</td>
 <td class="mono right" style="color:var(--green-lt)">${fmtPP(r.delta_anbima_mkt)}</td>
 </tr>`;
 }).join('')}</tbody>
 </table>`: '<p class="resumo-empty">Sem oportunidades ativas.</p>'}
 </div>

 <!-- Top 5 do catálogo (Δ ANBIMA, Indicados). Colunas iguais ao Top 5 Oportunidades. -->
 <div class="resumo-card">
 <h4 class="resumo-card-title" style="color:var(--gold-lt)">Top 5 do catálogo (Δ ANBIMA, Indicados)</h4>
 ${topCat.length ? `
 <table class="resumo-tbl">
 <thead><tr><th>Emissor</th><th>Ticker</th><th>Vcto</th><th>IDX</th><th class="right">Taxa</th><th class="right">Δ ANB</th></tr></thead>
 <tbody>${topCat.map(r=>{
 const eff = _rowEffectiveRate(r);
 return `<tr>
 <td title="${_esc(r.emissor||'')}"><a href="#" onclick="closeResumoModal();openXpDetailModal('${_esc(r.ticker)}');return false" style="color:var(--blue-lt);text-decoration:none">${_esc((r.emissor||r.ativo||'?').substring(0,22))}</a></td>
 <td class="cell-ticker">${_esc(r.ticker||'—')}</td>
 <td class="cell-venc">${_esc(r.vencimento||'—')}</td>
 <td style="font-size:9.5px;color:var(--txt-muted)">${_esc(r.indice_type||'—')}</td>
 <td class="mono right">${fmtRate(eff.spread_xp)}</td>
 <td class="mono right" style="color:var(--green-lt)">${fmtPP(eff.delta_anbima)}</td>
 </tr>`;
 }).join('')}</tbody>
 </table>`: '<p class="resumo-empty">Sem catálogo carregado.</p>'}
 </div>

 <!-- Top 5 por fair-value (Δ Taxa Mín XP vs Taxa Venda ANBIMA) -->
 <div class="resumo-card resumo-card-wide">
 <h4 class="resumo-card-title" style="color:#a78bfa">Top 5 fair-value — Taxa Mín XP vs Taxa Venda ANBIMA</h4>
 <p class="resumo-card-hint">Δ entre a Taxa Mínima oferecida pela XP e a Taxa Venda ANBIMA (lado do OFFER do book ANBIMA). Δ positivo = XP oferece taxa MAIOR que dealers vendem, cliente captura prêmio acima do book ANBIMA. <strong>Apenas Indicados</strong>.</p>
 <div class="resumo-idx-tabs">
 ${['IPCA','CDI%','CDI+','PRE'].map(idx => `
 <button class="resumo-idx-tab ${idx===defaultFairIdx?'active':''}" data-idx="${idx}"
 onclick="_switchResumoFairTab('${idx}')"
 ${topFairByIdx[idx].length===0 ? 'disabled style="opacity:.4"': ''}>
 ${idx} <span class="resumo-idx-count">${topFairByIdx[idx].length}</span>
</button>
 `).join('')}
 </div>
 <div id="resumoFairContent">
 ${_renderResumoFairList(topFairByIdx[defaultFairIdx] || [], defaultFairIdx)}
 </div>
 </div>

 <!-- Trocas viáveis (apenas com posição) -->
 <div class="resumo-card">
 <h4 class="resumo-card-title" style="color:#34d399">Trocas viáveis (payback ≤ 5a)</h4>
 ${swaps.length ? `
 <table class="resumo-tbl">
 <thead><tr><th>De</th><th>Para</th><th>Δ taxa</th><th>Payback</th></tr></thead>
 <tbody>${swaps.map(s=>{
 const baseline = s.pos.taxa_compra?.value ?? s.pos.taxa_mercado?.value;
 const dRate = baseline != null ? s.rate - baseline: null;
 return `<tr>
 <td title="${_esc(s.pos.nome||'')}">${_esc((s.pos.nome||'?').substring(0,18))}</td>
 <td title="${_esc(s.cat.emissor||'')}">${_esc((s.cat.emissor||s.cat.ticker||'?').substring(0,18))}</td>
 <td class="mono" style="color:var(--green-lt)">${fmtPP(dRate)}</td>
 <td class="mono">${s.payback.toFixed(1)}a</td>
 </tr>`;
 }).join('')}</tbody>
 </table>`: '<p class="resumo-empty">Cole a posição na aba Posição para ver trocas sugeridas.</p>'}
 </div>

 <!-- Alertas -->
 <div class="resumo-card">
 <h4 class="resumo-card-title" style="color:var(--red-lt)">! Alertas</h4>
 <ul class="resumo-alerts">
 ${rjInPort.length ? `<li><strong>${rjInPort.length}</strong> emissor${rjInPort.length>1?'es':''} em RJ na carteira: ${rjInPort.map(r=>_esc(r.emissor||r.ticker||'?')).slice(0,3).join(', ')}${rjInPort.length>3?'…':''}</li>`: ''}
 ${congHigh.length ? `<li>Concentração em conglomerado: ${congHigh.map(([g,n])=>`<strong>${n}× ${g}</strong>`).join(', ')}</li>`: ''}
 ${totalIssues > 0 ? `<li><strong>${totalIssues}</strong> matches com problemas — <a href="#" onclick="closeResumoModal();openDiagModal();return false">ver diagnóstico</a></li>`: ''}
 ${(d.validation||[]).length ? `<li><strong>${d.validation.length}</strong> linhas com warnings de validação (verifique a aba)</li>`: ''}
 ${!rjInPort.length && !congHigh.length && !totalIssues && !(d.validation||[]).length ? '<li class="resumo-ok">Nenhum alerta</li>': ''}
 </ul>
 </div>
 </div>
 `;
 document.getElementById('resumoModal').classList.add('open');
}
function closeResumoModal() {
 document.getElementById('resumoModal').classList.remove('open');
}

/** Renderiza tabela do Top 5 fair-value (vs Taxa Venda ANBIMA) por indexador. */
function _renderResumoFairList(rows, idx) {
 if (!rows || !rows.length) {
 return '<p class="resumo-empty">Sem Indicados com Taxa Venda ANBIMA nesse indexador. Verifique se ANBIMA CRI/CRA + Debêntures + Empresas foram carregados (necessário para definir "Indicados").</p>';
 }
 const isCdiPct = idx === 'CDI%';
 // CDI% trabalha em pp-CDI; demais em pp absolutos
 const unitTxt = isCdiPct ? 'pp CDI': 'pp';
 const fmtRate = v => v != null ? v.toFixed(2) + (isCdiPct?'% CDI':'%'): '—';
 const fmtDelta = v => v != null ? (v>0?'+':'') + v.toFixed(2) + unitTxt: '—';
 return `
 <table class="resumo-tbl">
 <thead><tr>
 <th>Emissor</th><th>Ticker</th><th>Vcto</th>
 <th class="right">Taxa XP</th>
 <th class="right">Taxa Venda ANBIMA</th>
 <th class="right" title="Δ = Taxa Mín XP − Taxa Venda ANBIMA. Positivo = XP oferece taxa maior que o lado de venda do book ANBIMA.">Δ vs Venda</th>
 </tr></thead>
 <tbody>${rows.map(r => {
 const eff = _rowEffectiveRate(r);
 return `<tr>
 <td title="${_esc(r.emissor||'')}"><a href="#" onclick="closeResumoModal();openXpDetailModal('${_esc(r.ticker)}');return false" style="color:var(--blue-lt);text-decoration:none">${_esc((r.emissor||r.ativo||'?').substring(0,24))}</a></td>
 <td class="cell-ticker">${_esc(r.ticker||'—')}</td>
 <td class="cell-venc">${_esc(r.vencimento||'—')}</td>
 <td class="mono right">${fmtRate(eff.spread_xp)}</td>
 <td class="mono right" style="color:#34d399">${fmtRate(r.anbima_venda)}</td>
 <td class="mono right" style="color:#a78bfa;font-weight:600">${fmtDelta(r._delta_vs_venda_anb)}</td>
 </tr>`;
 }).join('')}</tbody>
 </table>`;
}

/** Alterna aba de indexador no card Top fair-value. */
function _switchResumoFairTab(idx) {
 document.querySelectorAll('.resumo-idx-tab').forEach(el => {
 el.classList.toggle('active', el.dataset.idx === idx);
 });
 const list = (state._resumoFair || {})[idx] || [];
 const cont = document.getElementById('resumoFairContent');
 if (cont) cont.innerHTML = _renderResumoFairList(list, idx);
}

/* ── CDI BCB ────────────────────────────────────────────────────────────── */
async function refreshCdiRate() {
 try {
 const res = await fetch('/api/cdi-rate');
 if (!res.ok) return;
 const j = await res.json();
 if (j && typeof j.rate === 'number' && j.rate > 0) {
 state.cdiRate = j.rate;
 state.cdiRateDate = j.date || '';
 // Re-render se a aba atual depende do CDI (carteira / posição)
 if (state.tab === 'carteira') renderCarteiraTab();
 // Atualiza chip se UI já renderizou
 _renderCdiChip();
 }
 } catch(_){}
}
function _renderCdiChip() {
 const meta = document.getElementById('headerMeta'); if (!meta) return;
 let chip = document.getElementById('cdiChip');
 if (!chip) {
 chip = document.createElement('span');
 chip.id = 'cdiChip';
 chip.className = 'meta-chip meta-ok';
 meta.appendChild(chip);
 }
 chip.textContent = `CDI ${state.cdiRate.toFixed(2)}% a.a.${state.cdiRateDate?` (${state.cdiRateDate})`:''}`;
 chip.title = state.cdiRateDate
 ? `Taxa CDI anualizada (BCB SGS 4389) — referência ${state.cdiRateDate}`
: 'Taxa CDI anualizada — fallback local (BCB indisponível)';
}

/* ── HEADER ──────────────────────────────────────────────────────────────── */
function updateHeader() {
 const meta = document.getElementById('headerMeta');
 const loaded = state.data?.loaded || [];
 if (!loaded.length) return;
 meta.innerHTML = '';
 const refDate = state.data?.spread_score?.meta?.ref_date || '';
 const dm = refDate.match(/(\d{2}\/\d{2}\/\d{4})/) ||
 (state.data?.spread_score?.meta?.ipca_info||'').match(/(\d{2}\/\d{2}\/\d{4})/);
 if (dm) {
 const chip = document.createElement('span');
 chip.className = 'meta-chip meta-date';
 chip.textContent = `ANBIMA ${dm[1]}`;
 meta.appendChild(chip);
 }
 const m = state.data?.spread_score?.meta;
 if (m?.n_matched) {
 const chip = document.createElement('span');
 chip.className = 'meta-chip meta-ok';
 chip.textContent = `${m.n_matched} ativos c/ referência ANBIMA`;
 meta.appendChild(chip);
 }
 const mercLen = state.data?.mercado?.length;
 if (mercLen) {
 const chip = document.createElement('span');
 chip.className = 'meta-chip meta-ok';
 chip.textContent = `${mercLen} ordens RF Mercado`;
 meta.appendChild(chip);
 }
}

/* ── STATS ───────────────────────────────────────────────────────────────── */
function updateStats() {
 const d = state.data; if (!d) return;
 const ipca = d.spread_score?.ipca||[], cdiPct = d.spread_score?.cdi_pct||[];
 const cdiPlus = d.spread_score?.cdi_plus||[], pre = d.spread_score?.pre||[];
 const cdi = [...cdiPct,...cdiPlus], all = [...ipca,...cdi,...pre];
 set('statIpca', ipca.length||'—'); set('statCdi', cdi.length||'—');
 const deltas = all.map(r=>r.delta_anbima).filter(v=>v!=null&&!isNaN(v));
 if (deltas.length) {
 set('statBestDelta', fmtDelta(Math.max(...deltas)));
 set('statAvgDelta', fmtDelta(deltas.reduce((a,b)=>a+b,0)/deltas.length));
 }
 const scores = all.map(r=>r.score_total).filter(v=>v!=null&&!isNaN(v));
 if (scores.length) set('statTopScore', Math.max(...scores).toFixed(2));
 const isento = all.filter(r=>r.isento==='S').length;
 set('statIsento', isento?`${isento} / ${all.length}`:'—');
 const dm = (d.spread_score?.meta?.ref_date||'').match(/(\d{2}\/\d{2}\/\d{4})/) ||
 (d.spread_score?.meta?.ipca_info||'').match(/(\d{2}\/\d{2}\/\d{4})/);
 if (dm) set('statDate', dm[1]);
 document.getElementById('statsBar').style.display = 'flex';
}
function set(id, val) { const el=document.getElementById(id); if(el) el.textContent=val; }

/* ── FEE-BASED TOGGLE ────────────────────────────────────────────────────── */
function setFeeBased(val) {
 state.feeBased = val;
 document.getElementById('btnCommission').classList.toggle('active', !val);
 document.getElementById('btnFeeBased').classList.toggle('active', val);
 applyFilters();
}

/** Taxa/spread efetivos de uma LINHA de resultado (display + cálculos em abas).
 * - Comissão: usa taxa_min / spread_xp / delta_anbima (XP retém spread).
 * - Fee-based: usa taxa_max / spread_xp_fb / delta_anbima_fb.
 * Para cálculo de entrada na carteira (com quantidade, rendimentos em R$)
 * use _portEntryEffectiveRate. */
function _rowEffectiveRate(r) {
 if (state.feeBased) return {
 taxa_xp: r.taxa_xp_fb || r.taxa_max || r.taxa_xp,
 spread_xp: r.spread_xp_fb ?? r.taxa_max_num ?? r.spread_xp,
 delta_anbima: r.delta_anbima_fb ?? r.delta_anbima,
 };
 return {
 taxa_xp: r.taxa_xp || r.taxa_min,
 spread_xp: r.spread_xp ?? r.taxa_min_num,
 delta_anbima: r.delta_anbima,
 };
}
// Alias legado — remover após migrar todos os callers.
const _effectiveRate = _rowEffectiveRate;

/* ── TABS ────────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(btn => {
 btn.addEventListener('click', () => {
 document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
 btn.classList.add('active');
 state.tab = btn.dataset.tab;
 state.sort = { col:null, dir:'asc' };
 resetFilters(false);
 renderCurrentTab();
 });
});

/* ── MULTI-SELECT FILTERS ────────────────────────────────────────────────── */
function toggleMs(wrapId) {
 const wrap = document.getElementById(wrapId);
 const isOpen = wrap.classList.contains('ms-open');
 document.querySelectorAll('.ms-wrap.ms-open').forEach(w=>w.classList.remove('ms-open'));
 if (!isOpen) wrap.classList.add('ms-open');
}
document.addEventListener('click', e => {
 if (!e.target.closest('.ms-wrap'))
 document.querySelectorAll('.ms-wrap.ms-open').forEach(w=>w.classList.remove('ms-open'));
});

function populateMs(wrapId, filterKey, values) {
 const wrap = document.getElementById(wrapId); if (!wrap) return;
 const drop = wrap.querySelector('.ms-drop');
 const cur = state.multiFilters[filterKey];
 drop.innerHTML = values.map(v =>
 `<label class="ms-item${cur.has(v)?' checked':''}">
 <input type="checkbox" value="${_esc(v)}" ${cur.has(v)?'checked':''} onchange="toggleMsItem('${filterKey}','${_esc(v)}',this.checked)">
 <span>${v}</span>
 </label>`
 ).join('');
 updateMsBadge(wrapId, filterKey);
}

function toggleMsItem(filterKey, value, checked) {
 if (checked) state.multiFilters[filterKey].add(value);
 else state.multiFilters[filterKey].delete(value);
 const wrapMap = {rating:'ms-rating',setor:'ms-setor',tipo:'ms-tipo',juros:'ms-juros',publico:'ms-publico',indexador:'ms-indexador'};
 updateMsBadge(wrapMap[filterKey], filterKey);
 applyFilters();
}
function updateMsBadge(wrapId, filterKey) {
 const wrap = document.getElementById(wrapId); if (!wrap) return;
 const cnt = wrap.querySelector('.ms-cnt');
 const size = state.multiFilters[filterKey].size;
 cnt.textContent = size ? ` (${size})`: '';
 wrap.classList.toggle('ms-active', size > 0);
}
/** Escape para uso em atributos HTML E em strings JS dentro de onclick=…
 * Cobre: & < > " ' (todos via entidades). Antes só cobria ' " — se um
 * emissor tiver "&" ou "<" no nome, o HTML quebrava silenciosamente. */
function _esc(s) {
 return String(s)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}

/* ── FILTER VISIBILITY ───────────────────────────────────────────────────── */
const CREDIT_TABS = ['catalogo']; // aba unificada — substitui ss-ipca/cdi-pct/cdi-plus/ss-pre

function _setFilterVisibility(tab) {
 const isCredit = CREDIT_TABS.includes(tab);
 const isTp = tab === 'tp';
 const isMercado = tab === 'mercado';
 const isOpport = tab === 'oportunidades';
 const isB3 = tab === 'b3';
 const isPosicao = tab === 'posicao';
 const hasRows = isCredit || isMercado || isOpport;
 _showEl('ms-rating', hasRows);
 _showEl('ms-setor', hasRows);
 _showEl('ms-tipo', isCredit || isTp || isMercado || isOpport || isB3);
 // Oportunidades herda os mesmos filtros da RF Mercado
 _showEl('ms-publico', isCredit || isTp || isMercado || isOpport);
 _showEl('ms-juros', isCredit || isTp || isMercado || isOpport);
 _showEl('ms-indexador', isCredit || isMercado || isOpport || isTp);
 _showEl('filterDurWrap', hasRows);
 _showEl('filterVencWrap', hasRows);
 _showEl('toggleIsento', hasRows);
 _showEl('toggleNaoIsento', hasRows);
 _showEl('toggleIndicado', isCredit || isOpport || isMercado);
 _showEl('toggleComOrdem', isMercado || isOpport);
 _showEl('filterLiquidezWrap', isMercado || isOpport);
 // Filtros específicos B3
 _showEl('toggleSoExtra', isB3);
 _showEl('filterB3VolWrap', isB3);
}
function _showEl(id, show) { const el=document.getElementById(id); if(el) el.style.display=show?'':'none'; }

/* ── RENDER CURRENT TAB ─────────────────────────────────────────────────── */
function renderCurrentTab() {
 const { tab, data } = state;
 const filterBar = document.getElementById('filterBar');
 const tpArea = document.getElementById('tpArea');
 const posicaoArea= document.getElementById('posicaoArea');
 const emptyState = document.getElementById('emptyState');
 const container = document.getElementById('tableContainer');

 const posicaoContainer = document.getElementById('posicaoContainer');
 const carteiraContainer = document.getElementById('carteiraContainer');

 // Hide all content areas first
 tpArea.style.display = 'none';
 posicaoArea.style.display = 'none';
 container.style.display = 'none';
 if (posicaoContainer) posicaoContainer.style.display = 'none';
 if (carteiraContainer) carteiraContainer.style.display = 'none';
 // Remove stale banners — incluindo o yieldCurveBanner que só faz sentido
 // em Catálogo / RF Mercado / Oportunidades. Outras abas (TP, Empresas,
 // B3, Posição, Carteira) precisam que ele seja removido.
 ['mercadoBanner','oportunidadesBanner','yieldCurveBanner','b3Banner'].forEach(id => {
 const el=document.getElementById(id); if(el) el.remove();
 });

 filterBar.style.display = '';

 // ── CARTEIRA ──
 if (tab === 'carteira') {
 filterBar.style.display = 'none';
 emptyState.style.display = 'none';
 if (carteiraContainer) { carteiraContainer.style.display = 'flex'; }
 _setFilterVisibility('carteira');
 renderCarteiraTab();
 return;
 }

 // ── POSIÇÃO ──
 if (tab === 'posicao') {
 filterBar.style.display = 'none';
 posicaoArea.style.display = 'flex';
 emptyState.style.display = 'none';
 if (posicaoContainer) posicaoContainer.style.display = 'block';
 _setFilterVisibility('posicao');
 renderPosicaoAnalysis();
 return;
 }

 // ── TP ──
 if (tab === 'tp') {
 tpArea.style.display = 'flex';
 _setFilterVisibility('tp');
 const tpRows = data?.tp_data || [];
 if (tpRows.length || state.tpBonds.length) {
 emptyState.style.display = 'none';
 container.style.display = 'block';
 const rows = tpRows.length ? tpRows: state.tpBonds;
 if (tpRows.length) { populateFilters(rows); applyFilters(); }
 else renderTitulosTable(rows);
 } else {
 emptyState.style.display = 'none';
 }
 document.getElementById('filterResult').textContent = '';
 return;
 }

 _setFilterVisibility(tab);

 if (!data?.loaded?.length) {
 emptyState.style.display = 'flex';
 return;
 }

 let rows = null;
 if (tab === 'catalogo') rows = getCatalogoRows();
 if (tab === 'mercado') rows = data?.mercado || [];
 if (tab === 'oportunidades') rows = data?.oportunidades || [];
 if (tab === 'b3') rows = data?.b3_negocios || [];
 if (tab === 'empresas') rows = data?.empresas || [];

 if (!rows?.length) {
 emptyState.style.display = 'flex';
 document.getElementById('filterResult').textContent = '';
 return;
 }

 emptyState.style.display = 'none';
 container.style.display = 'block';
 populateFilters(rows);
 applyFilters();
}

function getRows(src, key) { return state.data?.[src]?.[key] || []; }

/** Concatena todos os buckets do spread_score (ipca + cdi_pct + cdi_plus + pre + outros).
 * Usado pela aba unificada "Catálogo XP". Mantém o indice_type de cada row para
 * que o frontend possa colorir/formatar conforme o indexador. */
function getCatalogoRows() {
 const s = state.data?.spread_score; if (!s) return [];
 return [...(s.ipca||[]),...(s.cdi_pct||[]),...(s.cdi_plus||[]),
...(s.pre||[]),...(s.outros||[])];
}

/* ── POPULATE FILTERS ────────────────────────────────────────────────────── */
function populateFilters(rows) {
 const uniq = fn => [...new Set(rows.map(fn).filter(Boolean))].sort();
 populateMs('ms-rating', 'rating', uniq(r=>r.rating));
 populateMs('ms-setor', 'setor', uniq(r=>r.setor));
 populateMs('ms-tipo', 'tipo', uniq(r=>r.instrumento||r.tipo));
 populateMs('ms-publico', 'publico', uniq(r=>r.publico));
 populateMs('ms-juros', 'juros', uniq(r=>r.juros));
 populateMs('ms-indexador','indexador', uniq(r=>r.indexador));
}

/* ── APPLY FILTERS ───────────────────────────────────────────────────────── */
function applyFilters() {
 const { tab, data } = state;
 let rows = [];
 if (tab === 'catalogo') rows = getCatalogoRows();
 if (tab === 'tp') rows = data?.tp_data || [];
 if (tab === 'mercado') rows = data?.mercado || [];
 if (tab === 'oportunidades') rows = data?.oportunidades || [];
 if (tab === 'b3') {
 // Aba B3 usa engine própria de filtros (volume mín, só extragrupo, tipo, busca)
 _renderB3Tab(data?.b3_negocios || []);
 return;
 }
 if (tab === 'produtos') {
 // Compatibilidade: aba Produtos foi removida. Redireciona para Catálogo XP.
 state.tab = 'catalogo';
 rows = getCatalogoRows();
 }
 if (tab === 'empresas') rows = data?.empresas || [];
 if (tab === 'produtos') rows = data?.produtos || [];
 if (tab === 'posicao') { renderPosicaoAnalysis(); return; }

 const q = document.getElementById('searchInput').value.toLowerCase();
 const isento = document.getElementById('filterIsento').checked;
 const naoIsento = document.getElementById('filterNaoIsento').checked;
 const indicado = document.getElementById('filterIndicado').checked;
 const comOrdem = document.getElementById('filterComOrdem').checked;
 const liqEl = document.getElementById('filterLiquidez');
 const liqMin = liqEl ? parseFloat(liqEl.value) || 0: 0;
 const durMinRaw = document.getElementById('filterDurMin').value;
 const durMaxRaw = document.getElementById('filterDurMax').value;
 const vencMinRaw = document.getElementById('filterVencMin').value.trim();
 const vencMaxRaw = document.getElementById('filterVencMax').value.trim();
 const durMin = durMinRaw !== '' ? parseFloat(durMinRaw): null;
 const durMax = durMaxRaw !== '' ? parseFloat(durMaxRaw): null;
 const vencMin = _parseMonthYear(vencMinRaw);
 const vencMax = _parseMonthYear(vencMaxRaw);
 const mf = state.multiFilters;

 const isOpport = tab === 'oportunidades';
 // Campos pesquisáveis pela busca textual. Antes era JSON.stringify(r), o que
 // gerava falsos positivos (ex: "0.5" batia em qualquer Δ). Agora limita aos
 // campos identificadores que o usuário tipicamente busca.
 const _SEARCH_FIELDS = ['emissor','ticker','setor','ativo','nome','indexador','rating','codigo'];

 let filtered = rows.filter(r => {
 if (q) {
 let hit = false;
 for (const f of _SEARCH_FIELDS) {
 const v = r[f];
 if (v != null && String(v).toLowerCase().includes(q)) { hit = true; break; }
 }
 if (!hit) return false;
 }
 if (mf.rating.size && !mf.rating.has(r.rating)) return false;
 if (mf.setor.size && !mf.setor.has(r.setor)) return false;
 if (mf.tipo.size && !mf.tipo.has(r.instrumento) && !mf.tipo.has(r.tipo)) return false;
 if (mf.publico.size && !mf.publico.has(r.publico)) return false;
 if (mf.juros.size && !mf.juros.has(r.juros)) return false;
 if (mf.indexador.size && !mf.indexador.has(r.indexador)) return false;
 if (isento && r.isento !== 'S') return false;
 if (naoIsento && r.isento === 'S') return false;
 if (indicado && !(r.aloc_max > 0)) return false;
 if (comOrdem && !(r.vol_bid > 0 || r.vol_offer > 0)) return false;
 // ── OPORTUNIDADES — filtros fixos ──
 // 1) Apenas ativos Indicados (têm pct_alocação > 0 no catálogo).
 // 2) Apenas onde OFFER do mercado é taxa MAIOR que a taxa do catálogo
 // (i.e. mais vantajoso comprar no secundário do que no primário XP).
 // Usa delta_vs_catalog_fb em fee-based e delta_vs_catalog em comissão.
 if (isOpport) {
 if (!(r.aloc_max > 0)) return false;
 const dCmp = state.feeBased ? r.delta_vs_catalog_fb: r.delta_vs_catalog;
 if (dCmp == null || dCmp <= 0) return false;
 }
 // Liquidez: filtra pela coluna OFFER (onde o cliente efetivamente compra).
 // Assim só aparecem ativos com volume de OFERTA suficiente para executar.
 if (liqMin > 0 && (r.vol_offer || 0) < liqMin) return false;
 // Duration filter (dur = ANBIMA business days ÷252; duration = mercado years)
 const durYears = r.dur != null ? r.dur / 252: r.duration;
 if (durMin != null && (durYears == null || durYears < durMin)) return false;
 if (durMax != null && (durYears == null || durYears > durMax)) return false;
 // Vencimento filter
 if (vencMin != null || vencMax != null) {
 const rv = _parseVenc(r.vencimento);
 if (rv == null) return false;
 if (vencMin != null && rv < vencMin) return false;
 if (vencMax != null && rv > vencMax) return false;
 }
 return true;
 });

 if (state.sort.col) filtered = sortRows(filtered, state.sort.col, state.sort.dir);

 document.getElementById('filterResult').textContent = `${filtered.length} / ${rows.length}`;
 document.getElementById('tabCount').textContent = filtered.length ? `${filtered.length} registros`: '';

 renderTable(filtered, tab);
}

function resetFilters(rerender=true) {
 document.getElementById('searchInput').value = '';
 document.getElementById('filterIsento').checked = false;
 document.getElementById('filterNaoIsento').checked = false;
 // Default Indicados = true for credit tabs and oportunidades
 document.getElementById('filterIndicado').checked = CREDIT_TABS.includes(state.tab) || state.tab === 'oportunidades' || state.tab === 'mercado';
 document.getElementById('filterComOrdem').checked = false;
 const liqEl = document.getElementById('filterLiquidez');
 // Oportunidades: por definição só fazem sentido com liquidez OFFER ≥ 300k
 if (liqEl) liqEl.value = state.tab === 'oportunidades' ? '300000': '0';
 document.getElementById('filterDurMin').value = '';
 document.getElementById('filterDurMax').value = '';
 document.getElementById('filterVencMin').value = '';
 document.getElementById('filterVencMax').value = '';
 const wrapMap = {rating:'ms-rating',setor:'ms-setor',tipo:'ms-tipo',juros:'ms-juros',publico:'ms-publico',indexador:'ms-indexador'};
 Object.keys(state.multiFilters).forEach(k => {
 state.multiFilters[k].clear();
 updateMsBadge(wrapMap[k], k);
 });
 if (rerender) applyFilters();
}

/* ── SORT ────────────────────────────────────────────────────────────────── */
function sortRows(rows, col, dir) {
 return [...rows].sort((a,b) => {
 let va=a[col], vb=b[col];
 if (va==null) return 1; if (vb==null) return -1;
 if (typeof va==='number'&&typeof vb==='number') return dir==='asc'?va-vb:vb-va;
 const sa=String(va).toLowerCase(), sb=String(vb).toLowerCase();
 return dir==='asc'?sa.localeCompare(sb):sb.localeCompare(sa);
 });
}
function handleSort(col) {
 state.sort.col === col ? (state.sort.dir = state.sort.dir==='asc'?'desc':'asc'): (state.sort.col=col, state.sort.dir='asc');
 applyFilters();
}

/* ── TABLE DISPATCH ──────────────────────────────────────────────────────── */
function renderTable(rows, tab) {
 if (tab==='catalogo') renderCatalogoTable(rows);
 else if (tab==='mercado') renderMercadoTable(rows);
 else if (tab==='oportunidades') renderOportunidadesTable(rows);
 else if (tab==='b3') renderB3Table(rows);
 else if (tab==='tp') renderTpProductsTable(rows);
 else if (tab==='empresas') renderEmpresasTable(rows);
 else if (tab==='posicao') renderPosicaoAnalysis();
}

/* ── YIELD CURVE (3 painéis: PRE / IPCA / CDI) ───────────────────────────── */
/** Banner colapsável com 3 painéis lado a lado — um por grupo de indexador.
 * - PRE: Duration × Taxa nominal, curva DI proxy (NTN-F/LTN) sobreposta
 * - IPCA: Duration × Taxa real, curva NTN-B sobreposta
 * - CDI: Duration × Prêmio sobre CDI (pp), com CDI+ e %CDI normalizados em pp absoluto
 *
 * `opts.taxaSource`:
 * - 'xp' (default) — usa _rowEffectiveRate(r).spread_xp (catálogo/mercado XP)
 * - 'offer' — usa r.offer_rate (oportunidades — taxa do secundário)
 * `opts.scopeLabel`: rótulo do escopo na header ("Catálogo XP" / "RF Mercado" / "Oportunidades")
 */
function _renderYieldCurveBanner(rows, opts) {
 opts = opts || {};
 const taxaSource = opts.taxaSource || 'xp';
 const scopeLabel = opts.scopeLabel || 'misto';
 const wrap = document.getElementById('tableWrap');
 const existing = document.getElementById('yieldCurveBanner');
 if (existing) existing.remove();
 if (!rows || !rows.length) return;

 // Estado de colapso (default aberto)
 if (state.yieldCurveCollapsed == null) state.yieldCurveCollapsed = {};
 const collapsed = state.yieldCurveCollapsed[state.tab] === true;

 // Particiona por grupo de indexador. Filtra papéis sem taxa válida
 // (baseRate <= 0) — comum em RF Mercado quando o book está inativo
 // e o papel vem com Taxa Mín = "CDI + 0,00%".
 const useOffer = (opts.taxaSource || 'xp') === 'offer';
 const groups = { PRE: [], IPCA: [], CDI: [] };
 rows.forEach(r => {
 const it = (r.indice_type || '').toUpperCase();
 const eff = _rowEffectiveRate(r);
 const baseRate = useOffer ? r.offer_rate: eff.spread_xp;
 if (baseRate == null || baseRate <= 0) return;
 if (it === 'IPCA') groups.IPCA.push(r);
 else if (it === 'PRE') groups.PRE.push(r);
 else if (it === 'CDI+' || it === 'CDI%') groups.CDI.push(r);
 });

 const totalPts = groups.PRE.length + groups.IPCA.length + groups.CDI.length;
 if (totalPts === 0) return;

 const curves = state.data?.curves || {};
 const cdiRate = state.data?.cdi_rate || state.cdiRate;

 // Fonte da curva (online vs manual)
 const cm = state.data?.curves_meta || {};
 const isOnline = cm.source === 'tesouro_online';
 const meta = cm.meta || {};
 const sourceBadge = isOnline
 ? `<span class="yc-source yc-source-online" title="Curvas oficiais do Tesouro Direto. Última atualização: ${meta.date || '?'} (${meta.days_old != null ? meta.days_old + ' dia(s) atrás': '?'}). Atualizado a cada 6h.">Tesouro online · ${meta.date || ''}</span>`
: `<span class="yc-source yc-source-manual" title="Sem dados online. Faça upload de Produtos TP + cole ANBIMA, ou clique em Atualizar para tentar puxar online.">Sem online</span>`;

 const banner = document.createElement('div');
 banner.id = 'yieldCurveBanner';
 banner.className = 'yield-curve-banner';
 banner.innerHTML = `
 <div class="yc-header">
 <span class="yc-icon" onclick="toggleYieldCurve()" style="cursor:pointer">${collapsed?'>':'v'}</span>
 <span class="yc-title" onclick="toggleYieldCurve()" style="cursor:pointer">Yield Curve — Duration × Taxa <span style="font-weight:400;font-size:10px;color:var(--txt-muted)">(${scopeLabel}${taxaSource === 'offer' ? ' · taxa OFFER B3': ''})</span></span>
 <span class="yc-sub">PRE ${groups.PRE.length} · IPCA+ ${groups.IPCA.length} · CDI ${groups.CDI.length} · ${state.feeBased?'fee-based':'comissão'}</span>
 ${sourceBadge}
 <button class="yc-refresh-btn" onclick="event.stopPropagation(); refreshCurves(this)" title="Forçar refresh do Tesouro Transparente (ignora cache de 6h)">Atualizar</button>
 <span class="yc-spacer"></span>
 <span class="yc-hint" onclick="toggleYieldCurve()" style="cursor:pointer">Clique para ${collapsed?'expandir':'recolher'}</span>
 </div>
 ${collapsed ? '': `<div class="yc-body yc-body-grid">
 ${_buildYcPanel('PRE', groups.PRE, curves.PRE || [], { yLabel:'Taxa nominal (%)', curveLabel:'Tesouro Pré (LTN/NTN-F)', taxaSource }, cdiRate)}
 ${_buildYcPanel('IPCA', groups.IPCA, curves.IPCA || [], { yLabel:'Taxa real (%)', curveLabel:'Tesouro IPCA+ (NTN-B)', taxaSource }, cdiRate)}
 ${_buildYcPanel('CDI', groups.CDI, [], { yLabel:'Prêmio sobre CDI (pp)', curveLabel:null, cdiMode:true, taxaSource }, cdiRate)}
 </div>`}
 `;
 wrap.insertBefore(banner, document.getElementById('tableContainer'));
}

/** Força refresh do Tesouro online (ignora cache de 6h). */
async function refreshCurves(btn) {
 const orig = btn ? btn.innerHTML: null;
 if (btn) { btn.innerHTML = '⏳ Atualizando…'; btn.disabled = true; }
 try {
 const res = await fetch('/api/curves-refresh', { method: 'POST' });
 if (!res.ok) {
 const j = await res.json().catch(()=>({}));
 alert('Falha ao atualizar: ' + (j.error || res.status));
 return;
 }
 // Recarrega payload com curva nova
 await loadData();
 } catch(e) {
 alert('Erro de rede: ' + e.message);
 } finally {
 if (btn) { btn.innerHTML = orig; btn.disabled = false; }
 }
}

function toggleYieldCurve() {
 if (state.yieldCurveCollapsed == null) state.yieldCurveCollapsed = {};
 state.yieldCurveCollapsed[state.tab] = !state.yieldCurveCollapsed[state.tab];
 applyFilters();
}

/* ── Tooltip rico nos pontos do Yield Curve ─────────────────────────────── */
function _ensureYcTooltip() {
 let t = document.getElementById('ycTooltip');
 if (t) return t;
 t = document.createElement('div');
 t.id = 'ycTooltip';
 t.className = 'yc-tooltip';
 document.body.appendChild(t);
 return t;
}
// Event delegation — funciona para todo `.yc-dot` da página, mesmo após re-render.
document.addEventListener('mouseover', (e) => {
 const dot = e.target.closest && e.target.closest('.yc-dot');
 if (!dot) return;
 const tip = _ensureYcTooltip();
 const cdiMode = dot.dataset.cdimode === '1';
 const isento = dot.dataset.isento === '1';
 const suffix = cdiMode ? 'pp': '%';
 const rate = parseFloat(dot.dataset.rate);
 const sign = cdiMode && rate > 0 ? '+': '';
 const ticker = dot.dataset.ticker || '—';
 const emissor = dot.dataset.emissor || '—';
 const itype = dot.dataset.itype || '—';
 const instr = dot.dataset.instr || '';
 const vcto = dot.dataset.vcto || '';
 const rating = dot.dataset.rating || '';
 const setor = dot.dataset.setor || '';
 const dur = parseFloat(dot.dataset.dur).toFixed(1);
 tip.innerHTML = `
 <div class="yc-tip-head">
 <span class="yc-tip-ticker">${ticker}</span>
 ${instr ? `<span class="yc-tip-instr">${instr}</span>`: ''}
 <span class="yc-tip-idx">${itype}</span>
 </div>
 <div class="yc-tip-emissor" title="${emissor}">${emissor}</div>
 <div class="yc-tip-grid">
 <span class="yc-tip-l">Duration:</span><span class="yc-tip-v">${dur}a</span>
 <span class="yc-tip-l">${cdiMode ? 'Prêmio:': 'Taxa:'}</span><span class="yc-tip-v">${sign}${rate.toFixed(2)}${suffix}</span>
 ${vcto ? `<span class="yc-tip-l">Vcto:</span><span class="yc-tip-v">${vcto}</span>`: ''}
 ${rating ? `<span class="yc-tip-l">Rating:</span><span class="yc-tip-v">${rating}</span>`: ''}
 ${setor ? `<span class="yc-tip-l">Setor:</span><span class="yc-tip-v">${setor}</span>`: ''}
 </div>
 ${isento ? '<div class="yc-tip-tag">Isento IR</div>': ''}
 `;
 tip.style.display = 'block';
 _moveYcTooltip(e);
});
document.addEventListener('mousemove', (e) => {
 const dot = e.target.closest && e.target.closest('.yc-dot');
 if (!dot) return;
 _moveYcTooltip(e);
});
document.addEventListener('mouseout', (e) => {
 const dot = e.target.closest && e.target.closest('.yc-dot');
 if (!dot) return;
 const tip = document.getElementById('ycTooltip');
 if (tip) tip.style.display = 'none';
});
function _moveYcTooltip(e) {
 const tip = document.getElementById('ycTooltip'); if (!tip) return;
 // Posiciona com offset; vira lado se sair da tela à direita
 const w = tip.offsetWidth || 240;
 const h = tip.offsetHeight || 100;
 const x = e.clientX + 14 + w > window.innerWidth ? e.clientX - 14 - w: e.clientX + 14;
 const y = e.clientY + 14 + h > window.innerHeight ? e.clientY - 14 - h: e.clientY + 14;
 tip.style.left = x + 'px';
 tip.style.top = y + 'px';
}

/** Constrói um painel da yield curve para um grupo. cdiMode = true converte
 * CDI+/% em prêmio em pp absolutas (papel - 0), referência na origem 0. */
function _buildYcPanel(groupKey, rows, curva, opts, cdiRate) {
 const title = { PRE:'Pré-Fixado', IPCA:'IPCA+', CDI:'CDI+ / %CDI' }[groupKey] || groupKey;
 if (!rows || rows.length === 0) {
 return `<div class="yc-panel">
 <div class="yc-panel-title">${title}</div>
 <div class="yc-empty">Sem papéis deste indexador no filtro atual.</div>
 </div>`;
 }

 // Extrai pontos com metadata para tooltip rico
 const useOffer = opts.taxaSource === 'offer';
 const pts = rows.map(r => {
 const dur = r.dur != null ? r.dur / 252: (r.duration ?? null);
 const eff = _rowEffectiveRate(r);
 const it = (r.indice_type || '').toUpperCase();

 // Fonte da taxa: 'offer' usa r.offer_rate (B3 / mercado secundário) — útil
 // na aba Oportunidades onde o ativo é avaliado pela taxa que o cliente
 // captura comprando no secundário. Default 'xp' usa a taxa do catálogo.
 const baseRate = useOffer ? r.offer_rate: eff.spread_xp;

 // ATENÇÃO: na RF Mercado muitos papéis vêm com "Taxa Mín = CDI + 0,00%"
 // (book inativo). Esses entram com baseRate=0 e poluem o gráfico:
 // - PRE/IPCA: aparecem como pontos na linha 0% (visualmente "rastro")
 // - CDI%: a fórmula (0-100)×CDI/100 dá ~-14pp e empurra a escala
 // Excluímos qualquer papel com baseRate ≤ 0.
 if (baseRate == null || baseRate <= 0) return null;

 let rate;
 if (opts.cdiMode) {
 if (it === 'CDI+') rate = baseRate;
 else if (it === 'CDI%' && cdiRate) rate = (baseRate - 100) * cdiRate / 100;
 else rate = null;
 } else {
 rate = baseRate;
 }
 return {
 dur, rate,
 lbl: r.ticker || (r.emissor||'').substring(0,10),
 ticker: r.ticker,
 emissor: r.emissor || r.ativo,
 vencimento:r.vencimento,
 rating: r.rating,
 setor: r.setor,
 itype: it,
 instr: r.instrumento,
 isento: r.isento === 'S',
 };
 }).filter(p => p != null && p.dur != null && p.rate != null);

 if (pts.length < 1) {
 return `<div class="yc-panel">
 <div class="yc-panel-title">${title}</div>
 <div class="yc-empty">Sem dados de duration para este grupo.</div>
 </div>`;
 }

 // Eixos
 const W = 480, H = 200, PAD = { l:46, r:14, t:18, b:30 };
 const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
 const xs = pts.map(p => p.dur);
 const ys = pts.map(p => p.rate).concat(curva.map(p => p[1]));
 const xMin = Math.max(0, Math.min(...xs) - 0.3);
 const xMax = Math.max(...xs) + 0.3;
 let yMin = Math.min(...ys);
 let yMax = Math.max(...ys);
 const yPad = (yMax - yMin) * 0.12 || 0.5;
 yMin -= yPad; yMax += yPad;
 if (opts.cdiMode && yMin > 0) yMin = 0; // CDI sempre inclui zero como base
 const xRange = (xMax - xMin) || 1;
 const yRange = (yMax - yMin) || 1;
 const px = x =>PAD.l + (x - xMin) / xRange * plotW;
 const py = y =>PAD.t + plotH - (y - yMin) / yRange * plotH;

 // Grid Y
 let grid = '', xl = '', yl = '';
 const yStep = yRange > 8 ? 2: yRange > 4 ? 1: yRange > 1.5 ? 0.5: 0.25;
 for (let y = Math.ceil(yMin/yStep)*yStep; y <= yMax; y += yStep) {
 const cy = py(y).toFixed(1);
 grid += `<line x1="${PAD.l}" y1="${cy}" x2="${W-PAD.r}" y2="${cy}" stroke="var(--border)" stroke-width="0.5"/>`;
 const label = opts.cdiMode ? (y > 0 ? '+': '') + y.toFixed(y<10?1:0) + 'pp'
: y.toFixed(y<10?1:0) + '%';
 yl += `<text x="${PAD.l-4}" y="${(+cy+3).toFixed(1)}" fill="var(--txt-dim)" font-size="8.5" text-anchor="end">${label}</text>`;
 }
 for (let x = Math.ceil(xMin); x <= xMax; x++) {
 const cx = px(x).toFixed(1);
 grid += `<line x1="${cx}" y1="${PAD.t}" x2="${cx}" y2="${H-PAD.b}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>`;
 xl += `<text x="${cx}" y="${(H-PAD.b+11).toFixed(1)}" fill="var(--txt-dim)" font-size="8.5" text-anchor="middle">${x}a</text>`;
 }

 // Linha zero p/ painel CDI (referência da curva livre de risco)
 let zeroLine = '';
 if (opts.cdiMode && yMin < 0 && yMax > 0) {
 const cy0 = py(0).toFixed(1);
 zeroLine = `<line x1="${PAD.l}" y1="${cy0}" x2="${W-PAD.r}" y2="${cy0}" stroke="var(--gold-dim)" stroke-width="1" stroke-dasharray="4,2" opacity="0.8"/>
 <text x="${(W-PAD.r-2).toFixed(1)}" y="${(+cy0-3).toFixed(1)}" fill="var(--gold-lt)" font-size="8.5" text-anchor="end">CDI/Selic</text>`;
 }

 // Curva soberana — linha real, interpolando pontos do TP (NTN-B/NTN-F/LTN)
 let curvePath = '';
 let curveDots = '';
 if (curva && curva.length >= 2) {
 const sorted = [...curva].sort((a,b)=>a[0]-b[0]);
 const STEPS = 60;
 const samples = [];
 const sigma = Math.max(0.4, xRange * 0.08);
 for (let i = 0; i <= STEPS; i++) {
 const x = xMin + (xRange * i / STEPS);
 let num = 0, den = 0;
 sorted.forEach(([d, t]) => {
 const w = Math.exp(-Math.pow((x - d) / sigma, 2));
 num += w * t; den += w;
 });
 if (den > 0) samples.push({ x, y: num/den });
 }
 curvePath = samples.map((s,i)=>`${i===0?'M':'L'}${px(s.x).toFixed(1)},${py(s.y).toFixed(1)}`).join('');
 curveDots = sorted.map(([d,t]) =>
 `<circle cx="${px(d).toFixed(1)}" cy="${py(t).toFixed(1)}" r="2" fill="none" stroke="var(--blue-lt)" stroke-width="1.2" opacity="0.6"><title>Curva soberana · ${d.toFixed(1)}a · ${t.toFixed(2)}%</title></circle>`
 ).join('');
 }

 // Pontos XP — `data-*` carregam info para tooltip JS rico (handlers globais)
 const dots = pts.map(p => {
 const cx = px(p.dur).toFixed(1), cy = py(p.rate).toFixed(1);
 const fill = p.isento ? '#34d399': 'var(--gold-lt)';
 return `<circle class="yc-dot" cx="${cx}" cy="${cy}" r="3.6" fill="${fill}" opacity="0.85" stroke="var(--bg2)" stroke-width="1"
 data-ticker="${_esc(p.ticker || '')}"
 data-emissor="${_esc(p.emissor || '')}"
 data-vcto="${_esc(p.vencimento || '')}"
 data-rating="${_esc(p.rating || '')}"
 data-setor="${_esc(p.setor || '')}"
 data-itype="${_esc(p.itype || '')}"
 data-instr="${_esc(p.instr || '')}"
 data-dur="${p.dur.toFixed(2)}"
 data-rate="${p.rate.toFixed(2)}"
 data-isento="${p.isento ? '1':'0'}"
 data-cdimode="${opts.cdiMode ? '1':'0'}"
 ></circle>`;
 }).join('');

 // Legenda mini
 const legend = `<g transform="translate(${PAD.l+4},${(PAD.t-6).toFixed(0)})">
 <circle cx="0" cy="0" r="3" fill="var(--gold-lt)" opacity="0.85"/><text x="6" y="3" fill="var(--txt-muted)" font-size="8.5">XP</text>
 <circle cx="32" cy="0" r="3" fill="#34d399" opacity="0.85"/><text x="38" y="3" fill="var(--txt-muted)" font-size="8.5">isento</text>
 ${curvePath ? `<line x1="74" y1="0" x2="92" y2="0" stroke="var(--blue-lt)" stroke-width="1.5" opacity="0.7"/><text x="96" y="3" fill="var(--txt-muted)" font-size="8.5">${opts.curveLabel || 'curva'}</text>`: ''}
 </g>`;

 const subtitle = opts.cdiMode
 ? `${pts.length} ativos · prêmio em pp sobre Selic (CDI ${cdiRate ? cdiRate.toFixed(2)+'%': '?'})`
: `${pts.length} ativos · ${opts.yLabel||'taxa'}`;

 return `<div class="yc-panel">
 <div class="yc-panel-title">${title} <span class="yc-panel-sub">${subtitle}</span></div>
 <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px">
 ${grid}${yl}${xl}
 <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H-PAD.b}" stroke="var(--border-lt)" stroke-width="1"/>
 <line x1="${PAD.l}" y1="${H-PAD.b}" x2="${W-PAD.r}" y2="${H-PAD.b}" stroke="var(--border-lt)" stroke-width="1"/>
 ${zeroLine}
 ${curvePath ? `<path d="${curvePath}" stroke="var(--blue-lt)" stroke-width="1.8" fill="none" opacity="0.6"/>`: ''}
 ${curveDots}
 ${dots}
 ${legend}
 </svg>
 ${!curvePath && !opts.cdiMode ? `<div class="yc-note">Sem curva-base — faça upload de Produtos TP + cole de dados ANBIMA p/ ver a sobreposição.</div>`: ''}
 </div>`;
}

/* ── CATÁLOGO XP — aba unificada (IPCA+ + CDI% + CDI+ + PRE + outros) ──── */
function renderCatalogoTable(rows) {
 // Yield curve com pontos do CATÁLOGO XP (taxa que XP cobra)
 _renderYieldCurveBanner(rows, { taxaSource:'xp', scopeLabel:'Catálogo XP' });

 const cols = [
 { key:'instrumento', label:'', group:'', sticky:true },
 { key:'emissor', label:'Emissor', group:'IDENTIFICAÇÃO', sticky:false },
 { key:'ticker', label:'Ticker', group:'', sticky:false },
 { key:'setor', label:'Setor', group:'', sticky:false },
 { key:'vencimento', label:'Vcto', group:'', sticky:false },
 { key:'dur', label:'Dur.', group:'', sticky:false },
 { key:'rating', label:'Rating', group:'', sticky:false },
 { key:'isento', label:'Isen.', group:'', sticky:false },
 { key:'taxa_xp', label:'Taxa XP', group:'PRECIFICAÇÃO', sticky:false },
 { key:'spread_xp', label:'Taxa#', group:'', sticky:false },
 { key:'anbima', label:'ANBIMA Ind.', group:'', sticky:false },
 { key:'delta_anbima', label:'Δ ANBIMA', group:'', sticky:false },
 { key:'premio_risco', label:'Prêmio', group:'', sticky:false },
 { key:'roa', label:'ROA E.A.', group:'', sticky:false },
 { key:'score_total', label:'Score', group:'CRÉDITO', sticky:false },
 { key:'score_quant', label:'S.Qnt', group:'', sticky:false },
 { key:'score_qual', label:'S.Ql', group:'', sticky:false },
 { key:'aloc_max', label:'Aloc%', group:'', sticky:false },
 { key:'b3_vol_total', label:'B3', group:'B3 SECUNDÁRIO', sticky:false },
 { key:'b3_vol_diaria_std', label:'Vol D.', group:'VOLATILIDADE B3', sticky:false },
 { key:'b3_vol_period_pct', label:'Range', group:'VOLATILIDADE B3', sticky:false },
 { key:'b3_tendencia_pct_dia', label:'Tend.', group:'VOLATILIDADE B3', sticky:false },
 { key:'_port', label:'', group:'', sticky:false, nosort:true },
 ];

 document.getElementById('tableHead').innerHTML = buildGroupRow(cols) + buildHeaderRow(cols);
 document.getElementById('tableBody').innerHTML = rows.map((r,i) => buildCatalogoRow(r,i)).join('');
 attachSortHandlers();
}

/** Renderiza o spread de crédito (prêmio sobre curva soberana) em pp.
 * Cor:
 * < 1pp -> vermelho (prêmio insuficiente vs risco)
 * 1-3pp -> amarelo (prêmio justo / IG típico)
 * 3-5pp -> verde claro (prêmio bom / IG ligeiramente prêmio)
 * > 5pp -> verde escuro (prêmio agressivo / HY ou borderline)
 * Tooltip explica como foi calculado e mostra a curva-base.
 */
function _premioRiscoHtml(v, itype, curvaRef) {
 if (v == null) return '<span style="color:var(--txt-faint)">—</span>';
 const abs = Math.abs(v);
 const cls = abs < 1 ? 'vol-hi': abs < 3 ? 'vol-mid': abs < 5 ? 'vol-low': 'vol-up';
 const sign = v > 0 ? '+': '';
 let tip;
 if (itype === 'CDI+') tip = `Prêmio embutido na nomenclatura ("CDI+X%"). Valor = ${sign}${v.toFixed(2)} pp sobre Selic/CDI.`;
 else if (itype === 'CDI%') tip = `Prêmio = (% CDI − 100) × CDI atual / 100 = ${sign}${v.toFixed(2)} pp absolutas sobre Selic.`;
 else if (itype === 'IPCA' && curvaRef != null) tip = `Prêmio = taxa real do papel − NTN-B interpolada (${curvaRef.toFixed(2)}% na duration). Resultado: ${sign}${v.toFixed(2)} pp acima da curva real.`;
 else if (itype === 'PRE' && curvaRef != null) tip = `Prêmio = taxa do papel − curva DI/NTN-F interpolada (${curvaRef.toFixed(2)}% na duration). Resultado: ${sign}${v.toFixed(2)} pp acima da curva nominal.`;
 else if (curvaRef != null) tip = `Prêmio = taxa do papel − curva ${itype} interpolada (${curvaRef.toFixed(2)}%). ${sign}${v.toFixed(2)} pp.`;
 else tip = `Prêmio sobre a taxa livre de risco: ${sign}${v.toFixed(2)} pp.`;
 return `<span class="vol-pill ${cls}" title="${_esc(tip)}">${sign}${v.toFixed(2)}</span>`;
}

/** Badge colorido por indexador — usado na coluna "Idx" da aba Catálogo. */
function _idxBadge(itype) {
 const t = (itype||'').toUpperCase();
 const map = {
 'IPCA': ['#34d399','rgba(16,185,129,.12)','rgba(16,185,129,.35)'],
 'CDI%': ['#60a5fa','rgba(59,130,246,.12)','rgba(59,130,246,.35)'],
 'CDI+': ['#93c5fd','rgba(96,165,250,.12)','rgba(96,165,250,.35)'],
 'PRE': ['#e0bc64','rgba(196,162,68,.12)','rgba(196,162,68,.35)'],
 'IGPM': ['#fbbf24','rgba(251,191,36,.12)','rgba(251,191,36,.35)'],
 'DOLAR': ['#fb923c','rgba(251,146,60,.12)','rgba(251,146,60,.35)'],
 };
 const c = map[t] || ['var(--txt-sec)', 'rgba(255,255,255,.04)', 'var(--border)'];
 return `<span class="badge-rating" style="background:${c[1]};color:${c[0]};border:1px solid ${c[2]};font-weight:600">${t||'—'}</span>`;
}

function buildGroupRow(cols) {
 const groups = [];
 let cur='', span=0;
 cols.forEach(c => {
 if (c.group && c.group !== cur) {
 if (cur) groups.push({label:cur,span}); cur=c.group; span=1;
 } else if (c.group === cur && c.group) { span++;
 } else { if (cur) { groups.push({label:cur,span}); cur=''; span=0; } groups.push({label:'',span:1}); }
 });
 if (cur) groups.push({label:cur,span});
 return '<tr class="group-row">' + groups.map(g=>`<th colspan="${g.span}">${g.label}</th>`).join('') + '</tr>';
}

function buildHeaderRow(cols) {
 return '<tr>' + cols.map(c => {
 if (c.nosort) return `<th></th>`;
 const sorted = state.sort.col===c.key ? `sorted-${state.sort.dir}`: '';
 const sticky = c.sticky ? 'col-sticky': '';
 return `<th class="${sticky}"><div class="th-inner ${sorted}" data-col="${c.key}">${c.label}<span class="sort-ind"></span></div></th>`;
 }).join('') + '</tr>';
}

function attachSortHandlers() {
 document.querySelectorAll('.th-inner[data-col]').forEach(el =>
 el.addEventListener('click', () => handleSort(el.dataset.col))
 );
 attachResizeHandles();
}

/* ── COLUMN RESIZE ───────────────────────────────────────────────────────── */
// Persists user-resized column widths across re-renders, keyed by tab
if (!state.colWidths) state.colWidths = {};

/** Lock all columns at their current rendered widths and switch to table-layout:fixed.
 * Called just before the user starts dragging, so other cols don't reflow. */
function _lockColumnWidths() {
 const table = document.getElementById('dataTable'); if(!table) return;
 const rows = table.querySelectorAll('thead tr');
 const lastRow = rows[rows.length-1]; if(!lastRow) return;
 if(!state.colWidths[state.tab]) state.colWidths[state.tab] = {};
 [...lastRow.querySelectorAll('th')].forEach((th, i) => {
 if (state.colWidths[state.tab][i] == null) {
 const w = th.getBoundingClientRect().width;
 state.colWidths[state.tab][i] = w;
 }
 const w = state.colWidths[state.tab][i];
 th.style.width = w + 'px';
 th.style.minWidth = w + 'px';
 });
 table.style.tableLayout = 'fixed';
 table.style.minWidth = ''; // let fixed layout take over
}

/** Restore saved column widths after a table re-render */
function _applyColumnWidths() {
 const saved = state.colWidths[state.tab];
 if (!saved || !Object.keys(saved).length) return;
 const table = document.getElementById('dataTable'); if(!table) return;
 const rows = table.querySelectorAll('thead tr');
 const lastRow = rows[rows.length-1]; if(!lastRow) return;
 [...lastRow.querySelectorAll('th')].forEach((th, i) => {
 if (saved[i] != null) {
 th.style.width = saved[i] + 'px';
 th.style.minWidth = saved[i] + 'px';
 }
 });
 table.style.tableLayout = 'fixed';
}

function attachResizeHandles() {
 _applyColumnWidths(); // restore saved widths after re-render

 const table = document.getElementById('dataTable'); if(!table) return;
 const rows = table.querySelectorAll('thead tr');
 const lastRow = rows[rows.length-1]; if(!lastRow) return;

 [...lastRow.querySelectorAll('th')].forEach((th, idx) => {
 if (th.querySelector('.resize-handle')) return;
 const handle = document.createElement('span');
 handle.className = 'resize-handle';
 th.appendChild(handle);

 let startX = 0, startW = 0;
 handle.addEventListener('mousedown', e => {
 e.stopPropagation(); e.preventDefault();
 _lockColumnWidths(); // freeze all cols before dragging
 startX = e.pageX;
 startW = th.getBoundingClientRect().width;
 handle.classList.add('dragging');
 document.addEventListener('mousemove', onMove);
 document.addEventListener('mouseup', onUp, { once: true });
 document.body.style.cursor = 'col-resize';
 document.body.style.userSelect = 'none';
 });
 function onMove(e) {
 const w = Math.max(36, startW + e.pageX - startX);
 th.style.width = w + 'px';
 th.style.minWidth = w + 'px';
 if (!state.colWidths[state.tab]) state.colWidths[state.tab] = {};
 state.colWidths[state.tab][idx] = w;
 }
 function onUp() {
 document.removeEventListener('mousemove', onMove);
 handle.classList.remove('dragging');
 document.body.style.cursor = '';
 document.body.style.userSelect = '';
 }
 });
}

/* ── DATE PARSE HELPERS ─────────────────────────────────────────────────── */
/** Parse "DD/MM/YYYY" or "MM/YYYY" ->Date (first day of month) for range compare */
function _parseVenc(s) {
 if (!s || s === '—') return null;
 const parts = String(s).split('/');
 if (parts.length === 3) {
 // DD/MM/YYYY
 const d = new Date(+parts[2], +parts[1]-1, +parts[0]);
 return isNaN(d) ? null: d;
 }
 if (parts.length === 2) {
 // MM/YYYY -> 1º dia do mês
 const d = new Date(+parts[1], +parts[0]-1, 1);
 return isNaN(d) ? null: d;
 }
 return null;
}
/** Parse filter input "MM/AAAA" ->Date (first day of that month) */
function _parseMonthYear(s) {
 if (!s) return null;
 const m = s.match(/^(\d{1,2})\/(\d{4})$/);
 if (!m) return null;
 const d = new Date(+m[2], +m[1]-1, 1);
 return isNaN(d) ? null: d;
}

function _rowKey(r) { return `${r.ticker||r.ativo||''}_${r.vencimento||''}`; }

/* ── CONGLOMERATES ───────────────────────────────────────────────────────── */
const CONGLOMERATES = {
 Simpar: {
 color: '#f59e0b',
 colorDim: 'rgba(245,158,11,.18)',
 // Match on emissor name fragments (uppercase) or ticker prefixes
 names: ['SIMPAR','JSL','MOVIDA','VAMOS','VAMO','INTERMODAL'],
 tickers: ['SIMPA','JSLE','JSIM','MOVI3','MOVI','VAMO3','VAMO'],
 },
 Cosan: {
 color: '#22d3ee',
 colorDim: 'rgba(34,211,238,.18)',
 // Cosan, Raízen (joint-venture Cosan + Shell), Comgás, Compass, Rumo, Moove
 names: ['COSAN','RAIZEN','RAÍZEN','COMGAS','COMGÁS','COMPASS','RUMO','MOOVE'],
 tickers: ['CSAN','RAIZ','CMGS','RAILT','RUMO'],
 },
 Eletrobras: {
 color: '#a78bfa',
 colorDim: 'rgba(167,139,250,.18)',
 names: ['ELETROBRAS','ELETROBRÁS','FURNAS','CHESF','ELETRONORTE','ELETRONUCLEAR','CGT ELETROSUL'],
 tickers: ['ELET','FURN','CHES','ENBR'],
 },
 Eneva: {
 color: '#34d399',
 colorDim: 'rgba(52,211,153,.18)',
 names: ['ENEVA','PARNAIBA','PARNAÍBA','AZULAO','AZULÃO'],
 tickers: ['ENEV','PMGA','PRGS'],
 },
 Vibra: {
 color: '#fb923c',
 colorDim: 'rgba(251,146,60,.18)',
 names: ['VIBRA','BR DISTRIBUIDORA','PETROBRAS DISTRIBUIDORA'],
 tickers: ['VBBR','BRDT'],
 },
};

/** Returns conglomerate entry if this row belongs to one, else null */
function _conglomerate(r) {
 const nome = (r.emissor||r.ativo||'').toUpperCase();
 const tick = (r.ticker||'').toUpperCase();
 for (const [grp, cfg] of Object.entries(CONGLOMERATES)) {
 if (cfg.names.some(n => nome.includes(n))) return {grp,...cfg};
 if (cfg.tickers.some(t => tick.startsWith(t))) return {grp,...cfg};
 }
 return null;
}

// Badges desabilitados visualmente — solicitação do usuário (deixar só o nome).
// O flag interno r.rj e a detecção _conglomerate() continuam ativos para uso
// em ALERTAS (Resumo Executivo) e classificação de carteira.
function _congloBadge(r) { return ''; }
function _rjBadge(r)     { return ''; }

function _instrBadge(instrumento) {
 const raw = (instrumento||'').toUpperCase();
 let label = '—';
 if (raw.includes('RECEBIVEIS IMOBILIARIOS')||raw==='CRI') label='CRI';
 else if (raw.includes('AGRONEGOCIO')||raw==='CRA') label='CRA';
 else if (raw.includes('DEBENTURE')||raw==='DEB') label='DEB';
 else if (raw.includes('CDCA')) label='CDCA';
 else if (raw.includes('LETRA FINANCEIRA')||raw==='LF') label='LF';
 else if (raw.includes('CDB')||raw==='CDB') label='CDB';
 else if (raw.includes('LCI')) label='LCI';
 else if (raw.includes('LCA')) label='LCA';
 else if (raw) label=raw.split(' ')[0].substring(0,4);
 const cls = {CRI:'instr-cri',CRA:'instr-cra',DEB:'instr-deb',CDCA:'instr-cdca',
 LF:'instr-lf',CDB:'instr-cdb',LCI:'instr-lci',LCA:'instr-lca'}[label]||'instr-other';
 return `<span class="instr-badge ${cls}" title="${instrumento||''}">${label}</span>`;
}

function buildCatalogoRow(r, i) {
 const eff = _rowEffectiveRate(r);
 // Δ ANBIMA é em pp-CDI quando CDI%, em pp absoluto para os demais.
 const itype = r.indice_type;
 const deltaClass = itype === 'CDI%' ? deltaCdiClass(eff.delta_anbima): deltaIpcaClass(eff.delta_anbima);
 const key = _rowKey(r);
 const inPort = state.portfolio.has(key);
 const durYears = r.dur != null ? (r.dur/252).toFixed(1)+'a': '—';
 const setorHtml = r.setor
 ? `<span class="setor-badge setor-sm" title="${r.setor}">${r.setor}</span>`
: '<span style="color:var(--txt-faint)">—</span>';
 const conglo = _congloBadge(r);
 const roaNum = _parseRoa(r.roa);
 const roaHtml = state.feeBased
 ? `<span class="roa-cell" title="Fee-based: cliente recebe taxa máxima, XP não retém ROA" style="color:var(--txt-dim)">0,00%</span>`
: (roaNum != null
 ? `<span class="roa-cell" title="ROA que a XP retém como receita">${roaNum.toFixed(2)}%</span>`
: '<span style="color:var(--txt-faint)">—</span>');

 return `<tr class="${inPort?'row-in-port':''}">
 <td class="col-sticky">${_instrBadge(r.instrumento)}</td>
 <td title="${r.emissor||''}">${r.emissor||r.ativo||'—'}${_rjBadge(r)}${conglo}</td>
 <td>${r.ticker ? `<a href="#" class="cell-ticker xp-cod-link" onclick="openXpDetailModal('${_esc(r.ticker)}');return false" title="Ver detalhe completo (taxas ANBIMA, datas, prêmio, banda, B3)">${_esc(r.ticker)}</a>`: '<span class="cell-ticker">—</span>'}</td>
 <td>${setorHtml}</td>
 <td class="cell-venc">${r.vencimento||'—'}</td>
 <td class="cell-dur right mono">${durYears}</td>
 <td>${ratingBadge(r.rating)}</td>
 <td class="center">${isentoHtml(r.isento)}</td>
 <td class="cell-taxa">${eff.taxa_xp||'—'}</td>
 <td class="right mono">${fmt4(eff.spread_xp)}</td>
 <td class="right mono">${fmt4(r.anbima)}</td>
 <td class="cell-delta ${deltaClass}" title="${itype === 'CDI%' ? 'Δ em pontos percentuais de %CDI': 'Δ em pontos percentuais absolutos'}">${fmtDelta(eff.delta_anbima)}</td>
 <td>${_premioRiscoHtml(state.feeBased ? r.premio_risco_fb: r.premio_risco, itype, r.curva_ref_taxa)}</td>
 <td class="right">${roaHtml}</td>
 <td class="cell-score ${scoreColorClass(r.score_total)}">${r.score_total!=null?fmt2(r.score_total):'<span class="s-na">N/A</span>'}</td>
 <td class="right mono">${r.score_quant!=null?fmt2(r.score_quant):'<span style="color:var(--txt-dim)">—</span>'}</td>
 <td class="right mono">${r.score_qual!=null?fmt2(r.score_qual):'<span style="color:var(--txt-dim)">—</span>'}</td>
 <td>${alocBar(r.aloc_max)}</td>
 <td>${_b3Cell(r)}</td>
 <td class="center">${_volPill(r.b3_vol_diaria_std, '%', 'std dos retornos PU dia-a-dia (B3)')}</td>
 <td class="center">${_volPill(r.b3_vol_period_pct, '%', 'amplitude PU no período (B3)')}</td>
 <td class="center">${_tendenciaPill(r.b3_tendencia_pct_dia)}</td>
 <td class="center"><button class="port-add-btn${inPort?' in-port':''}" onclick="togglePortfolioItem('${_esc(key)}',${i})" title="${inPort?'Remover':'Adicionar à carteira'}">${inPort?'':'+'}</button></td>
 </tr>`;
}

/** Display ROA respecting feeBased toggle.
 * Regra universal: no modo fee-based o cliente compra na taxa máxima e o
 * ROA E. Aprox. é zerado em TODAS as abas (XP não retém spread).
 * No modo comissão mostra o ROA real do catálogo. */
function _roaDisplay(rawRoa, opts={}) {
 if (state.feeBased) {
 return `<span class="roa-cell" title="Fee-based: cliente compra na taxa máxima, XP não retém ROA" style="color:var(--txt-dim)">0,00%</span>`;
 }
 if (!rawRoa) return '<span style="color:var(--txt-faint)">—</span>';
 const cls = opts.raw ? '': 'roa-cell';
 const title = opts.raw ? '': 'ROA que a XP retém como receita';
 return `<span class="${cls}"${title?` title="${title}"`:''}>${rawRoa}</span>`;
}

/** Parse ROA string "0,47%" -> 0.47 */
function _parseRoa(s) {
 if (!s) return null;
 const n = parseFloat(String(s).replace('%','').replace(',','.'));
 return isNaN(n) ? null: n;
}

/* ── RF MERCADO TABLE ────────────────────────────────────────────────────── */
function renderMercadoTable(rows) {
 // Compute summary: how many assets are cheaper in mercado vs XP
 const withComp = rows.filter(r => r.delta_mkt_xp != null);
 const betterInMkt = withComp.filter(r => (state.feeBased ? r.delta_mkt_xp_fb: r.delta_mkt_xp) > 0).length;
 const betterAtXp = withComp.filter(r => (state.feeBased ? r.delta_mkt_xp_fb: r.delta_mkt_xp) <= 0).length;

 // Yield curve dos papéis do RF Mercado (taxa XP do book)
 _renderYieldCurveBanner(rows, { taxaSource:'xp', scopeLabel:'RF Mercado' });

 // Inject comparison banner above table
 _renderMercadoBanner(betterInMkt, betterAtXp, withComp.length);

 const cols = [
 { key:'instrumento', label:'', sticky:true },
 { key:'emissor', label:'Emissor' },
 { key:'setor', label:'Setor' },
 { key:'aloc_max', label:'Ind.' },
 { key:'ticker', label:'Ticker' },
 { key:'vencimento', label:'Vcto' },
 { key:'duration', label:'Dur.' },
 { key:'rating', label:'Rating' },
 { key:'isento', label:'Isen.' },
 { key:'bid_rate', label:'BID' },
 { key:'offer_rate', label:'OFFER' },
 { key:'taxa_min', label:'Taxa XP' },
 { key:'roa', label:'ROA E.A.' },
 { key:'delta_anbima', label:'Δ ANBIMA' },
 { key:'delta_offer_anbima', label:'OFFER − ANB', group:'XP vs ANBIMA IND.' },
 { key:'delta_bid_anbima', label:'BID − ANB', group:'XP vs ANBIMA IND.' },
 { key:'spread_bid_ask_xp', label:'Spread XP', group:'XP vs ANBIMA IND.' },
 { key:'delta_mkt_xp', label:'Compra (OFFER−XP)', group:'COMPARATIVO' },
 { key:'b3_vol_total', label:'B3', group:'B3 SECUNDÁRIO' },
 { key:'score_total', label:'Score' },
 { key:'b3_vol_diaria_std', label:'Vol D.', group:'VOLATILIDADE B3' },
 { key:'b3_vol_period_pct', label:'Range', group:'VOLATILIDADE B3' },
 { key:'b3_tendencia_pct_dia', label:'Tend.', group:'VOLATILIDADE B3' },
 { key:'_port', label:'', nosort:true },
 ];

 // Build header with group row
 const groups = [];
 let curGroup = '', curSpan = 0;
 cols.forEach(c => {
 const g = c.group || '';
 if (g !== curGroup) {
 if (curGroup !== '' || curSpan > 0) groups.push({label:curGroup, span:curSpan});
 curGroup = g; curSpan = 1;
 } else { curSpan++; }
 });
 groups.push({label:curGroup, span:curSpan});

 const hasGroups = groups.some(g => g.label);
 const groupRow = hasGroups
 ? '<tr class="group-row">' + groups.map(g =>
 `<th colspan="${g.span}"${g.label?` class="group-hdr"`:''}>` +
 (g.label ? `<span class="group-hdr-txt">${g.label}</span>`: '') +
 '</th>'
 ).join('') + '</tr>'
: '';

 const headerRow = '<tr>' + cols.map(c => {
 const sorted = state.sort.col===c.key?`sorted-${state.sort.dir}`:'';
 const sticky = c.sticky?'col-sticky':'';
 return `<th class="${sticky}"><div class="th-inner ${sorted}" data-col="${c.key}">${c.label}<span class="sort-ind"></span></div></th>`;
 }).join('') + '</tr>';

 document.getElementById('tableHead').innerHTML = groupRow + headerRow;

 document.getElementById('tableBody').innerHTML = rows.map((r,i) => {
 const key = _rowKey(r);
 const inPort = state.portfolio.has(key);
 const eff = _effectiveRate(r);
 const dClass = deltaIpcaClass(eff.delta_anbima);
 const hasBid = r.vol_bid > 0 || r.bid_rate > 0;
 const hasOffer = r.vol_offer > 0 || r.offer_rate > 0;

 const bidHtml = hasBid
 ? `<div class="market-side bid"><span class="bid-cell">${r.bid_rate_str||fmt2(r.bid_rate)+'%'}</span><span class="vol-chip">${fmtVol(r.vol_bid)}</span></div>`
: `<span class="no-order">—</span>`;
 const offerHtml = hasOffer
 ? `<div class="market-side offer"><span class="offer-cell">${r.offer_rate_str||fmt2(r.offer_rate)+'%'}</span><span class="vol-chip">${fmtVol(r.vol_offer)}</span></div>`
: `<span class="no-order">—</span>`;

 const durFmt = r.duration!=null ? Number(r.duration).toFixed(1)+'a': '—';

 // Mercado vs XP comparison (BID removed por ora — manteremos apenas Compra)
 const dMkt = state.feeBased ? r.delta_mkt_xp_fb: r.delta_mkt_xp;
 const mktHtml = _mktDeltaHtml(dMkt, 'Ref. COMPRA — OFFER Mercado vs Taxa XP. Verde = mercado oferece taxa maior = yield melhor para o investidor comprar no mercado secundário.');

 return `<tr class="${inPort?'row-in-port':''}">
 <td class="col-sticky">${_instrBadge(r.instrumento)}</td>
 <td class="cell-emissor" title="${r.emissor||''}">${_congloBadge(r)}${r.emissor||'—'}${_rjBadge(r)}</td>
 <td><span class="setor-badge setor-sm">${r.setor||'—'}</span></td>
 <td class="center">${indDot(r.aloc_max)}</td>
 <td>${r.ticker ? `<a href="#" class="cell-ticker xp-cod-link" onclick="openXpDetailModal('${_esc(r.ticker)}');return false" title="Ver detalhe completo do papel">${_esc(r.ticker)}</a>`: '<span class="cell-ticker">—</span>'}</td>
 <td class="cell-venc">${r.vencimento||'—'}</td>
 <td class="right mono" style="font-size:10.5px">${durFmt}</td>
 <td>${ratingBadge(r.rating)}</td>
 <td class="center">${isentoHtml(r.isento)}</td>
 <td>${bidHtml}</td>
 <td>${offerHtml}</td>
 <td class="cell-taxa" style="font-size:10.5px" title="${state.feeBased?'Fee-based: taxa máxima que o cliente recebe':'Comissão: taxa mínima líquida para o cliente'}">${state.feeBased?(r.taxa_max||'—'):(r.taxa_min||'—')}</td>
 <td class="right mono" style="color:var(--gold-lt);font-size:10.5px">${_roaDisplay(r.roa,{raw:true})}</td>
 <td class="cell-delta ${dClass}">${fmtDelta(eff.delta_anbima)}</td>
 <td>${_dOfferAnbHtml(r.delta_offer_anbima)}</td>
 <td>${_dBidAnbHtml(r.delta_bid_anbima)}</td>
 <td>${_spreadBidAskXpHtml(r.spread_bid_ask_xp)}</td>
 <td>${mktHtml}</td>
 <td>${_b3Cell(r)}</td>
 <td class="cell-score ${scoreColorClass(r.score_total)}">${r.score_total!=null?fmt2(r.score_total):'<span class="s-na">—</span>'}</td>
 <td class="center">${_volPill(r.b3_vol_diaria_std, '%', 'std dos retornos PU dia-a-dia (B3)')}</td>
 <td class="center">${_volPill(r.b3_vol_period_pct, '%', 'amplitude PU no período (B3)')}</td>
 <td class="center">${_tendenciaPill(r.b3_tendencia_pct_dia)}</td>
 <td class="center"><button class="port-add-btn${inPort?' in-port':''}" onclick="togglePortfolioItem('${_esc(key)}',${i})" title="${inPort?'Remover':'Adicionar à carteira'}">${inPort?'':'+'}</button></td>
 </tr>`;
 }).join('');

 attachSortHandlers();
}

function _mktDeltaHtml(delta, tip) {
 if (delta == null) return '<span style="color:var(--txt-faint)">—</span>';
 const pos = delta > 0;
 const cls = pos ? 'mkt-delta-pos': 'mkt-delta-neg';
 const sign = delta > 0 ? '+': '';
 return `<span class="mkt-delta ${cls}" title="${tip}">${sign}${delta.toFixed(2)}</span>`;
}

/** Δ OFFER XP − Indicativa ANBIMA. Pedido do sales.
 * Positivo (verde) = OFFER XP >Indicativa ->XP cobra taxa maior que o fair
 * -> papel "barato" para o cliente (taxa boa). Negativo = XP engordando spread. */
function _dOfferAnbHtml(v) {
 if (v == null) return '<span style="color:var(--txt-faint)">—</span>';
 const cls = v > 0 ? 'mkt-delta-pos': 'mkt-delta-neg';
 const sign = v > 0 ? '+': '';
 const tip = `OFFER XP − Indicativa ANBIMA = ${sign}${v.toFixed(2)} pp. `
 + (v > 0 ? 'XP oferece taxa MAIOR que o fair institucional -> papel barato p/ comprar.'
: 'XP oferece taxa MENOR que o fair ->XP engordando spread, cliente paga caro.');
 return `<span class="mkt-delta ${cls}" title="${tip}">${sign}${v.toFixed(2)}</span>`;
}
/** Δ BID XP − Indicativa ANBIMA.
 * Positivo = BID XP >Indicativa -> mesa compra do cliente a taxa maior que fair
 * -> cliente recebe preço pior na venda. Negativo = mesa paga acima do fair. */
function _dBidAnbHtml(v) {
 if (v == null) return '<span style="color:var(--txt-faint)">—</span>';
 // Aqui a leitura é INVERSA: positivo é ruim p/ vendedor (taxa alta = preço baixo)
 const cls = v < 0 ? 'mkt-delta-pos': 'mkt-delta-neg';
 const sign = v > 0 ? '+': '';
 const tip = `BID XP − Indicativa ANBIMA = ${sign}${v.toFixed(2)} pp. `
 + (v < 0 ? 'BID XP MENOR que Indicativa = preço MAIOR -> mesa pagando prêmio, bom p/ vender.'
: 'BID XP MAIOR que Indicativa = preço MENOR -> cliente recebe abaixo do fair na venda.');
 return `<span class="mkt-delta ${cls}" title="${tip}">${sign}${v.toFixed(2)}</span>`;
}
/** Spread bid-ask do book XP (OFFER − BID) em pp. Proxy de liquidez. */
function _spreadBidAskXpHtml(v) {
 if (v == null) return '<span style="color:var(--txt-faint)">—</span>';
 const cls = v < 0.15 ? 'vol-low': v < 0.5 ? 'vol-mid': 'vol-hi';
 const tip = `Spread Bid-Ask XP = ${v.toFixed(2)} pp. `
 + (v < 0.15 ? 'Spread estreito = book líquido, formação de preço sólida.'
: v < 0.5 ? 'Spread moderado = liquidez razoável.'
: 'Spread largo = book ilíquido, risco de saída ruim para o cliente.');
 return `<span class="vol-pill ${cls}" title="${_esc(tip)}">${v.toFixed(2)}</span>`;
}

function _renderMercadoBanner(betterMkt, betterXp, total) {
 const existing = document.getElementById('mercadoBanner');
 if (existing) existing.remove();
 if (!total) return;

 const wrap = document.getElementById('tableWrap');
 const banner = document.createElement('div');
 banner.id = 'mercadoBanner';
 banner.className = 'mercado-banner';
 banner.innerHTML = `
 <div class="mkt-banner-inner">
 <span class="mkt-banner-icon"></span>
 <span class="mkt-banner-title">Comparativo Mercado Secundário vs XP</span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat mkt-banner-good" title="Ativos onde a taxa OFFER no mercado é maior que a taxa XP — comprar no mercado é mais vantajoso para o investidor">
 <strong>${betterMkt}</strong> com taxa melhor no mercado
</span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat mkt-banner-bad" title="Ativos onde a XP oferece taxa maior que o mercado secundário">
 <strong>${betterXp}</strong> com taxa melhor na XP
</span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-hint" title="Coluna 'OFFER vs XP': taxa OFFER mercado − taxa comissão XP. Positivo (verde) = mercado é mais barato para o investidor.">
 ℹ Δ positivo = mercado mais vantajoso
</span>
 </div>`;
 wrap.insertBefore(banner, document.getElementById('tableContainer'));
}

/* ── OPORTUNIDADES TABLE ─────────────────────────────────────────────────── */
function renderOportunidadesTable(rows) {
 // Yield curve com taxa OFFER B3 (taxa que o cliente captura comprando no secundário)
 _renderYieldCurveBanner(rows, { taxaSource:'offer', scopeLabel:'Oportunidades' });

 // Summary banner
 _renderOportBanner(rows);

 const cols = [
 { key:'instrumento', label:'', sticky:true },
 { key:'emissor', label:'Emissor' },
 { key:'ticker', label:'Ticker' },
 { key:'vencimento', label:'Vcto' },
 { key:'duration', label:'Dur.' },
 { key:'setor', label:'Segmento' },
 { key:'rating', label:'Rating' },
 { key:'isento', label:'Isen.' },
 { key:'offer_rate', label:'OFFER Mkt', group:'MERCADO SECUNDÁRIO' },
 { key:'vol_offer', label:'Vol.', group:'MERCADO SECUNDÁRIO' },
 { key:'cat_taxa_xp', label:'XP Com.', group:'XP CATÁLOGO' },
 { key:'cat_taxa_fb', label:'XP Fee-b.', group:'XP CATÁLOGO' },
 { key:'delta_vs_catalog', label:'Δ Com.', group:'COMPARATIVO' },
 { key:'delta_vs_catalog_fb',label:'Δ Fee-b.', group:'COMPARATIVO' },
 { key:'anbima', label:'ANBIMA' },
 { key:'delta_anbima_mkt', label:'Δ ANBIMA' },
 { key:'premio_risco', label:'Prêmio' },
 { key:'cat_roa', label:'ROA XP' },
 { key:'b3_vol_total', label:'B3', group:'B3 SECUNDÁRIO' },
 { key:'score_total', label:'Score' },
 { key:'b3_vol_diaria_std', label:'Vol D.', group:'VOLATILIDADE B3' },
 { key:'b3_vol_period_pct', label:'Range', group:'VOLATILIDADE B3' },
 { key:'b3_tendencia_pct_dia', label:'Tend.', group:'VOLATILIDADE B3' },
 { key:'_port', label:'', nosort:true },
 ];

 // Build group+header rows
 const groups=[], seen={};
 cols.forEach(c => { const g=c.group||''; seen[g]=(seen[g]||0)+1; });
 // deduplicate groups in order
 let curG='',curSpan=0;
 const groupsArr=[];
 cols.forEach(c=>{ const g=c.group||''; if(g!==curG){if(curSpan)groupsArr.push({label:curG,span:curSpan}); curG=g;curSpan=1;}else curSpan++;});
 groupsArr.push({label:curG,span:curSpan});
 const hasGroups=groupsArr.some(g=>g.label);
 const groupRow=hasGroups?'<tr class="group-row">'+groupsArr.map(g=>
 `<th colspan="${g.span}"${g.label?` class="group-hdr"`:''}>${g.label?`<span class="group-hdr-txt">${g.label}</span>`:''}</th>`
 ).join('')+'</tr>':'';

 const headerRow='<tr>'+cols.map(c=>{
 if(c.nosort) return '<th></th>';
 const sorted=state.sort.col===c.key?`sorted-${state.sort.dir}`:'';
 const sticky=c.sticky?'col-sticky':'';
 return `<th class="${sticky}"><div class="th-inner ${sorted}" data-col="${c.key}">${c.label}<span class="sort-ind"></span></div></th>`;
 }).join('')+'</tr>';

 document.getElementById('tableHead').innerHTML = groupRow + headerRow;

 document.getElementById('tableBody').innerHTML = rows.map((r,i) => {
 const key = _rowKey(r);
 const inPort = state.portfolio.has(key);
 const dClass = r.indice_type==='CDI%' ? deltaCdiClass(r.delta_anbima_mkt): deltaIpcaClass(r.delta_anbima_mkt);
 const conglo = _congloBadge(r);

 const offerHtml = r.offer_rate!=null
 ? `<div class="market-side offer"><span class="offer-cell">${r.offer_rate_str||r.offer_rate.toFixed(2)+'%'}</span></div>`
: '<span class="no-order">—</span>';

 // Comparison columns
 const dCom = state.feeBased ? r.delta_vs_catalog_fb: r.delta_vs_catalog;
 const dFb = r.delta_vs_catalog_fb;
 const comHtml = _mktDeltaHtml(dCom, 'OFFER Mercado − Taxa XP catálogo. Positivo = mercado mais vantajoso para compra');
 const fbHtml = _mktDeltaHtml(dFb, 'OFFER Mercado − Taxa XP fee-based. Positivo = mercado mais vantajoso mesmo vs fee-based');

 const durFmt = r.duration!=null ? Number(r.duration).toFixed(1)+'a': '—';

 return `<tr class="${inPort?'row-in-port':''}">
 <td class="col-sticky">${_instrBadge(r.instrumento)}</td>
 <td title="${r.emissor||''}">${conglo}${r.emissor||'—'}${_rjBadge(r)}</td>
 <td>${r.ticker ? `<a href="#" class="cell-ticker xp-cod-link" onclick="openXpDetailModal('${_esc(r.ticker)}');return false" title="Ver detalhe completo do papel">${_esc(r.ticker)}</a>`: '<span class="cell-ticker">—</span>'}</td>
 <td class="cell-venc">${r.vencimento||'—'}</td>
 <td class="right mono" style="font-size:10.5px">${durFmt}</td>
 <td><span class="setor-badge setor-sm">${r.setor||'—'}</span></td>
 <td>${ratingBadge(r.rating)}</td>
 <td class="center">${isentoHtml(r.isento)}</td>
 <td>${offerHtml}</td>
 <td class="right mono" style="font-size:10px;color:var(--txt-muted)">${fmtVol(r.vol_offer)}</td>
 <td class="cell-taxa" style="font-size:10.5px">${r.cat_taxa_xp||'—'}</td>
 <td class="cell-taxa" style="font-size:10.5px;color:var(--txt-muted)">${r.cat_taxa_fb||'—'}</td>
 <td>${comHtml}</td>
 <td>${fbHtml}</td>
 <td class="right mono" style="font-size:10.5px">${r.anbima!=null?r.anbima.toFixed(4):'—'}</td>
 <td class="cell-delta ${dClass}">${fmtDelta(r.delta_anbima_mkt)}</td>
 <td>${_premioRiscoHtml(state.feeBased ? r.premio_risco_fb: r.premio_risco, r.indice_type, r.curva_ref_taxa)}</td>
 <td class="right mono" style="color:var(--gold-lt);font-size:10.5px">${_roaDisplay(r.cat_roa,{raw:true})}</td>
 <td>${_b3Cell(r)}</td>
 <td class="cell-score ${scoreColorClass(r.score_total)}">${r.score_total!=null?fmt2(r.score_total):'<span class="s-na">—</span>'}</td>
 <td class="center">${_volPill(r.b3_vol_diaria_std, '%', 'std dos retornos PU dia-a-dia (B3)')}</td>
 <td class="center">${_volPill(r.b3_vol_period_pct, '%', 'amplitude PU no período (B3)')}</td>
 <td class="center">${_tendenciaPill(r.b3_tendencia_pct_dia)}</td>
 <td><button class="port-add-btn${inPort?' in-port':''}" onclick="togglePortfolioItem('${_esc(key)}',${i})" title="${inPort?'Remover':'Adicionar à carteira'}">${inPort?'':'+'}</button></td>
 </tr>`;
 }).join('');

 attachSortHandlers();
}

function _renderOportBanner(rows) {
 const existing = document.getElementById('oportunidadesBanner');
 if (existing) existing.remove();
 if (!rows.length) return;

 // Como a aba aplica hard-filter (delta > 0), todas as rows são oportunidades
 // por construção. Os stats agora são fee-based-aware: o "melhor" é calculado
 // sobre o mesmo lado da taxa que a tabela está mostrando.
 const pickDelta = r => state.feeBased ? r.delta_vs_catalog_fb: r.delta_vs_catalog;
 const valid = rows.filter(r => pickDelta(r) != null);
 const sorted = [...valid].sort((a,b)=> (pickDelta(b)||0) - (pickDelta(a)||0));
 const best = sorted[0];
 const bestDelta = best ? pickDelta(best): null;
 const sumDelta = valid.reduce((s,r)=> s + (pickDelta(r)||0), 0);
 const avgDelta = valid.length ? sumDelta / valid.length: 0;
 const modeLabel = state.feeBased ? 'Fee-based': 'Comissão';

 const wrap = document.getElementById('tableWrap');
 const banner = document.createElement('div');
 banner.id = 'oportunidadesBanner';
 banner.className = 'mercado-banner';
 banner.innerHTML = `
 <div class="mkt-banner-inner">
 <span class="mkt-banner-icon"></span>
 <span class="mkt-banner-title">Oportunidades — Mercado Secundário >Catálogo XP <span style="font-weight:400;font-size:9px;opacity:.65">(${modeLabel})</span></span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat mkt-banner-good" title="Ativos onde a OFFER do secundário oferece taxa MAIOR que o catálogo XP no modo ${modeLabel}">
 <strong>${rows.length}</strong> oportunidade${rows.length===1?'':'s'}
</span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat" style="color:var(--gold-lt)" title="Δ médio (OFFER − Catálogo XP) ponderado por ativo">
 Δ médio <strong>+${avgDelta.toFixed(2)}pp</strong>
</span>
 ${bestDelta!=null && best ? `
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-hint" style="color:var(--green-lt)">
 Melhor: <strong>${best.emissor||best.ticker||'?'}</strong> (+${bestDelta.toFixed(2)} pp)
</span>`: ''}
 </div>`;
 wrap.insertBefore(banner, document.getElementById('tableContainer'));
}

/* ── B3 NEGÓCIOS TABLE ───────────────────────────────────────────────────── */
/** Renderiza a aba B3 com banner consolidado + tabela do tape do dia.
 * Reutiliza a barra de filtros (busca, tipo) e adiciona controles próprios
 * (volume mínimo B3, só com extragrupo). */
function _renderB3Tab(rows) {
 // Banner consolidado: data range, n_papéis, vol total, vol extra, ratio geral
 _renderB3Banner(state.data?.b3_meta);

 // Aplica filtros: search + tipo + vol_b3_min + só_extra
 const q = document.getElementById('searchInput').value.toLowerCase();
 const mf = state.multiFilters;
 const volMinEl = document.getElementById('filterB3Vol');
 const volMin = volMinEl ? parseFloat(volMinEl.value) || 0: 0;
 const soExtra = document.getElementById('filterSoExtra')?.checked || false;
 const _SEARCH = ['cod_if','isin','emissor','instr'];

 let filtered = rows.filter(r => {
 if (q) {
 let hit = false;
 for (const f of _SEARCH) {
 const v = r[f]; if (v != null && String(v).toLowerCase().includes(q)) { hit = true; break; }
 }
 if (!hit) return false;
 }
 if (mf.tipo.size && !mf.tipo.has(r.instr)) return false;
 if (volMin > 0 && (r.vol_total || 0) < volMin) return false;
 if (soExtra && !(r.vol_extra > 0)) return false;
 return true;
 });

 if (state.sort.col) filtered = sortRows(filtered, state.sort.col, state.sort.dir);

 document.getElementById('filterResult').textContent = `${filtered.length} / ${rows.length}`;
 document.getElementById('tabCount').textContent = filtered.length ? `${filtered.length} papéis`: '';

 renderB3Table(filtered);
 // Popula filtro de tipo com instr únicos (CRI/CRA/CDCA/CPR/CFF…)
 const tipos = [...new Set(rows.map(r=>r.instr).filter(Boolean))].sort();
 populateMs('ms-tipo','tipo',tipos);
}

function _renderB3Banner(meta) {
 const wrap = document.getElementById('tableWrap');
 const ex = document.getElementById('b3Banner');
 if (ex) ex.remove();
 if (!meta || !meta.n_rows) return;

 const ratioGeral = meta.vol_total ? (meta.vol_extra / meta.vol_total): 0;
 const dateLabel = meta.date_first === meta.date_last
 ? `${meta.date_first}`: `${meta.date_first} -> ${meta.date_last} (${(meta.datas||[]).length} dias)`;

 const banner = document.createElement('div');
 banner.id = 'b3Banner';
 banner.className = 'mercado-banner';
 banner.innerHTML = `
 <div class="mkt-banner-inner">
 <span class="mkt-banner-icon"></span>
 <span class="mkt-banner-title">B3 — Negócios Mercado Secundário <span style="opacity:.65;font-weight:400;font-size:9.5px">${dateLabel}</span></span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat" style="color:var(--gold-lt)" title="Total de papéis distintos negociados no período">
 <strong>${meta.n_papeis}</strong> papéis
</span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat" style="color:var(--blue-lt)" title="Volume financeiro total negociado">
 <strong>${fmtVol(meta.vol_total)}</strong> total
</span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat" style="color:var(--green-lt)" title="Volume EXTRAGRUPO — trades entre players de conglomerados diferentes (preço institucional 'limpo')">
 <strong>${fmtVol(meta.vol_extra)}</strong> extragrupo
</span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat" title="Ratio geral = volume extragrupo / volume total. Alto = mercado institucional ativo. Baixo = circulação concentrada em distribuidores.">
 ratio <strong>${(ratioGeral*100).toFixed(0)}%</strong>
</span>
 <span class="mkt-banner-sep">·</span>
 <span class="mkt-banner-stat" style="color:var(--txt-muted)" title="Total de fechamentos (trades) no período">
 <strong>${meta.n_trades.toLocaleString('pt-BR')}</strong> trades
</span>
 </div>`;
 wrap.insertBefore(banner, document.getElementById('tableContainer'));
}

function renderB3Table(rows) {
 const cols = [
 { key:'instr', label:'Tipo', sticky:true },
 { key:'cod_if', label:'Código IF' },
 { key:'isin', label:'ISIN' },
 { key:'emissor', label:'Emissor' },
 { key:'data', label:'Data' },
 { key:'vol_total', label:'Vol. Total', group:'VOLUME (R$)' },
 { key:'vol_extra', label:'Vol. Extra', group:'VOLUME (R$)' },
 { key:'vol_intra', label:'Vol. Intra', group:'VOLUME (R$)' },
 { key:'ratio_extra', label:'Ratio Ex.', group:'QUALIDADE' },
 { key:'n_trades', label:'# Trades', group:'QUALIDADE' },
 { key:'pu_medio', label:'PU Médio', group:'PREÇO' },
 { key:'pu_min', label:'PU Mín', group:'PREÇO' },
 { key:'pu_max', label:'PU Máx', group:'PREÇO' },
 { key:'pu_ult', label:'PU Últ', group:'PREÇO' },
 { key:'oscilacao', label:'Oscil.%', group:'PREÇO' },
 { key:'b3_vol_diaria_std', label:'Vol Diária', group:'VOLATILIDADE' },
 { key:'b3_vol_period_pct', label:'Range', group:'VOLATILIDADE' },
 { key:'b3_tendencia_pct_dia', label:'Tend.', group:'VOLATILIDADE' },
 { key:'b3_persistencia', label:'Pers.', group:'VOLATILIDADE' },
 ];

 // Group + header rows (mesma lógica das outras abas)
 const groupsArr = [];
 let curG='', curSpan=0;
 cols.forEach(c => {
 const g = c.group||'';
 if (g !== curG) { if (curSpan) groupsArr.push({label:curG, span:curSpan}); curG=g; curSpan=1; }
 else curSpan++;
 });
 groupsArr.push({label:curG, span:curSpan});
 const hasGroups = groupsArr.some(g => g.label);
 const groupRow = hasGroups
 ? '<tr class="group-row">'+groupsArr.map(g=>`<th colspan="${g.span}"${g.label?' class="group-hdr"':''}>${g.label?`<span class="group-hdr-txt">${g.label}</span>`:''}</th>`).join('')+'</tr>'
: '';
 const headerRow = '<tr>'+cols.map(c=>{
 const sorted = state.sort.col===c.key?`sorted-${state.sort.dir}`:'';
 const sticky = c.sticky?'col-sticky':'';
 return `<th class="${sticky}"><div class="th-inner ${sorted}" data-col="${c.key}">${c.label}<span class="sort-ind"></span></div></th>`;
 }).join('')+'</tr>';

 document.getElementById('tableHead').innerHTML = groupRow + headerRow;

 document.getElementById('tableBody').innerHTML = rows.map(r => {
 const ratioPct = r.ratio_extra != null ? (r.ratio_extra * 100).toFixed(0)+'%': '—';
 const ratioCls = r.ratio_extra == null ? 'b3-ratio-na'
: r.ratio_extra >= 0.5 ? 'b3-ratio-hi'
: r.ratio_extra >= 0.2 ? 'b3-ratio-md'
: 'b3-ratio-lo';
 const oscClass = r.oscilacao == null ? '': (r.oscilacao > 0 ? 'd-g1': r.oscilacao < 0 ? 'd-r1': '');
 return `<tr>
 <td class="col-sticky">${_b3InstrBadge(r.instr)}</td>
 <td><a href="#" class="cell-ticker b3-cod-link" onclick="openB3DetailModal('${_esc(r.cod_if||'')}');return false" title="Ver detalhe + série temporal">${_esc(r.cod_if||'—')}</a></td>
 <td style="font-size:9.5px;color:var(--txt-muted)">${_esc(r.isin||'—')}</td>
 <td title="${_esc(r.emissor||'')}" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(r.emissor||'—')}</td>
 <td class="cell-venc">${_esc(r.data||'—')}</td>
 <td class="right mono" style="font-weight:600">${fmtVol(r.vol_total)}</td>
 <td class="right mono" style="color:var(--green-lt)">${fmtVol(r.vol_extra)}</td>
 <td class="right mono" style="color:var(--gold-lt);opacity:.85">${fmtVol(r.vol_intra)}</td>
 <td class="center"><span class="b3-ratio-pill ${ratioCls}" title="${_b3RatioTip(r.ratio_extra)}">${ratioPct}</span></td>
 <td class="right mono">${r.n_trades||0}</td>
 <td class="right mono">${r.pu_medio!=null?fmt2(r.pu_medio):'—'}</td>
 <td class="right mono" style="font-size:10px;color:var(--txt-muted)">${r.pu_min!=null?fmt2(r.pu_min):'—'}</td>
 <td class="right mono" style="font-size:10px;color:var(--txt-muted)">${r.pu_max!=null?fmt2(r.pu_max):'—'}</td>
 <td class="right mono">${r.pu_ult!=null?fmt2(r.pu_ult):'—'}</td>
 <td class="right mono ${oscClass}">${r.oscilacao!=null?(r.oscilacao>0?'+':'')+r.oscilacao.toFixed(2)+'%':'—'}</td>
 <td class="center">${_volPill(r.b3_vol_diaria_std, '%', 'std dos retornos PU dia-a-dia')}</td>
 <td class="center">${_volPill(r.b3_vol_period_pct, '%', '(PU_max−PU_min)/PU_médio do período')}</td>
 <td class="center">${_tendenciaPill(r.b3_tendencia_pct_dia)}</td>
 <td class="center">${_persistenciaPill(r.b3_persistencia, r.b3_dias_negociados, r.b3_n_obs)}</td>
 </tr>`;
 }).join('');

 attachSortHandlers();
}

/* ── B3 Volatility helpers (pills + tooltips) ───────────────────────────── */
/** Pill colorido para vol % (intra/diária/range). cls = baixo/médio/alto. */
function _volPill(v, suffix='%', tipExtra='') {
 if (v == null) return '<span class="vol-pill vol-na" title="Sem dados">—</span>';
 const cls = v < 1 ? 'vol-low': v < 3 ? 'vol-mid': 'vol-hi';
 const label = `${v.toFixed(2)}${suffix}`;
 const tip = `${label} — ${tipExtra}. ${v < 1 ? 'baixa': v < 3 ? 'moderada': 'alta'} dispersão.`;
 return `<span class="vol-pill ${cls}" title="${_esc(tip)}">${label}</span>`;
}
/** Tendência: +/-/= + valor pp/dia */
function _tendenciaPill(v) {
 if (v == null) return '<span class="vol-pill vol-na">—</span>';
 const abs = Math.abs(v);
 const cls = abs < 0.05 ? 'vol-flat': v > 0 ? 'vol-up': 'vol-down';
 const arr = abs < 0.05 ? '=': v > 0 ? '+': '-';
 const label = `${arr} ${(v>0?'+':'')}${v.toFixed(3)}`;
 const tip = `Slope da regressão linear PU vs dia em pp/dia. ${arr} ${abs<0.05?'estável':v>0?'apreciando':'desvalorizando'}`;
 return `<span class="vol-pill ${cls}" title="${_esc(tip)}">${label}</span>`;
}
/** Persistência (% de dias negociados sobre o período) */
function _persistenciaPill(p, n_dias, n_obs) {
 if (p == null) return '<span class="vol-pill vol-na">—</span>';
 const pct = (p*100).toFixed(0);
 const cls = p >= 0.8 ? 'vol-low': p >= 0.5 ? 'vol-mid': 'vol-hi';
 const tip = `${n_dias||0} dia(s) com trade num período de ${n_obs?Math.round(n_obs/p):'?'} dias úteis. ${p>=0.8?'Liquidez consistente':p>=0.5?'Liquidez intermitente':'Pouco negociado'}`;
 return `<span class="vol-pill ${cls}" title="${_esc(tip)}">${pct}%</span>`;
}

/* ── Modal de detalhe B3 (sparkline + tabela de dias) ───────────────────── */
async function openB3DetailModal(codIf) {
 if (!codIf) return;
 const modal = _ensureB3DetailModal();
 const body = document.getElementById('b3DetailBody');
 body.innerHTML = '<p style="color:var(--txt-muted);padding:20px">Carregando…</p>';
 modal.classList.add('open');
 try {
 const res = await fetch('/api/b3-papel/' + encodeURIComponent(codIf));
 if (!res.ok) {
 body.innerHTML = `<p style="color:var(--red-lt);padding:20px">Não foi possível carregar (${res.status}).</p>`;
 return;
 }
 const d = await res.json();
 body.innerHTML = _renderB3DetailContent(d);
 } catch(e) {
 body.innerHTML = `<p style="color:var(--red-lt);padding:20px">Erro: ${_esc(e.message)}</p>`;
 }
}
function closeB3DetailModal() {
 const m = document.getElementById('b3DetailModal');
 if (m) m.classList.remove('open');
}
function _ensureB3DetailModal() {
 let modal = document.getElementById('b3DetailModal');
 if (modal) return modal;
 modal = document.createElement('div');
 modal.id = 'b3DetailModal';
 modal.className = 'modal-overlay';
 modal.onclick = (e) => { if (e.target === modal) closeB3DetailModal(); };
 modal.innerHTML = `
 <div class="modal" style="max-width:960px">
 <div class="modal-header">
 <span class="modal-title">Detalhe do papel B3</span>
 <button class="modal-close" onclick="closeB3DetailModal()">X</button>
 </div>
 <div class="modal-body" id="b3DetailBody"></div>
 <div class="modal-footer">
 <button class="btn-secondary" onclick="closeB3DetailModal()">Fechar</button>
 </div>
 </div>`;
 document.body.appendChild(modal);
 return modal;
}

function _renderB3DetailContent(d) {
 const series = (d.series || []).slice().sort((a,b) => {
 // Ordenação correta por data (dd/mm/aaaa -> yyyymmdd numérico)
 const dt = s => { const p = (s||'').split('/'); return p.length===3 ? +(p[2]+p[1].padStart(2,'0')+p[0].padStart(2,'0')): 0; };
 return dt(a.data) - dt(b.data);
 });
 const sparkSvg = _renderB3Sparkline(series, d.coupon_dates_iso || []);

 const fmtPct = (v, dec=2) => v == null ? '—': `${v.toFixed(dec)}%`;
 const fmtRate = v => v == null ? '—': (v>0?'+':'')+v.toFixed(3);
 const fmtVolM = v => fmtVol(v);
 const ratioPct = d.ratio_extra != null ? (d.ratio_extra*100).toFixed(0)+'%': '—';
 const ratioCls = _b3RatioCls(d.ratio_extra);

 const trendCls = d.tendencia_pct_dia == null ? 'vol-na'
: Math.abs(d.tendencia_pct_dia) < 0.05 ? 'vol-flat'
: d.tendencia_pct_dia > 0 ? 'vol-up': 'vol-down';
 const trendArr = d.tendencia_pct_dia == null ? '—'
: Math.abs(d.tendencia_pct_dia) < 0.05 ? '='
: d.tendencia_pct_dia > 0 ? '+': '-';

 return `
 <div class="b3-detail-header">
 <div class="b3-detail-id">
 <span class="instr-badge ${_b3InstrBadgeCls(d.instr)}">${_esc((d.instr||'').toUpperCase())}</span>
 <span class="b3-detail-code">${_esc(d.cod_if||'?')}</span>
 <span class="b3-detail-isin">${_esc(d.isin||'')}</span>
 </div>
 <div class="b3-detail-emissor">${_esc(d.emissor||'')}</div>
 </div>

 <div class="b3-detail-kpis">
 <div class="b3-kpi"><span class="b3-kpi-lbl">Volume total</span><span class="b3-kpi-val" style="color:var(--blue-lt)">${fmtVolM(d.vol_total)}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Trades</span><span class="b3-kpi-val">${d.n_trades||0}</span></div>
 <div class="b3-kpi" title="Dias com trade no período carregado"><span class="b3-kpi-lbl">Dias negociados</span><span class="b3-kpi-val">${d.dias_negociados||0} / ${d.period_n_dates||'?'}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Ratio extragrupo</span><span class="b3-kpi-val"><span class="b3-ratio-pill ${ratioCls}">${ratioPct}</span></span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">PU médio</span><span class="b3-kpi-val">${d.pu_medio!=null?fmt2(d.pu_medio):'—'}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Range PU</span><span class="b3-kpi-val">${d.pu_min!=null?fmt2(d.pu_min):'?'} -> ${d.pu_max!=null?fmt2(d.pu_max):'?'}</span></div>
 </div>

 <h4 class="b3-detail-section-title">Volatilidade <span style="font-weight:400;font-size:9.5px;color:var(--txt-dim)">— período carregado: ${d.period_n_dates||'?'} dias úteis</span></h4>
 <div class="b3-detail-vols">
 <div class="b3-vol-card" title="Média de (PU_max − PU_min) / PU_médio entre os dias. Mede a dispersão de preço dentro do dia.">
 <div class="b3-vol-lbl">Vol intradiária</div>
 <div class="b3-vol-val">${_volPill(d.vol_intra_pct, '%')}</div>
 <div class="b3-vol-hint">média do range diário</div>
 </div>
 <div class="b3-vol-card" title="Desvio-padrão dos retornos PU dia-a-dia (não anualizado). É a volatilidade clássica do período.">
 <div class="b3-vol-lbl">Vol diária (std)</div>
 <div class="b3-vol-val">${_volPill(d.vol_diaria_std, '%')}</div>
 <div class="b3-vol-hint">std dos retornos</div>
 </div>
 ${d.vol_diaria_std_ex_cupom != null ? `
 <div class="b3-vol-card" title="Vol diária descartando dias próximos a datas previstas de pagamento de cupom (janela ±2 dias). Métrica 'limpa' que isola a volatilidade de mercado da queda contábil pós-cupom.">
 <div class="b3-vol-lbl">Vol diária ex-cupom</div>
 <div class="b3-vol-val">${_volPill(d.vol_diaria_std_ex_cupom, '%')}</div>
 <div class="b3-vol-hint">${d.n_excluded_cupom || 0} dia(s) descartado(s)</div>
 </div>`: ''}
 <div class="b3-vol-card" title="(PU_max global − PU_min global) / PU_médio global. Amplitude total no período.">
 <div class="b3-vol-lbl">Range no período</div>
 <div class="b3-vol-val">${_volPill(d.vol_period_pct, '%')}</div>
 <div class="b3-vol-hint">amplitude total</div>
 </div>
 <div class="b3-vol-card" title="Slope da regressão linear PU vs dia em pp/dia. Sinal direcional da tendência.">
 <div class="b3-vol-lbl">Tendência</div>
 <div class="b3-vol-val"><span class="vol-pill ${trendCls}">${trendArr} ${d.tendencia_pct_dia!=null?fmtRate(d.tendencia_pct_dia):'—'}</span></div>
 <div class="b3-vol-hint">pp/dia (slope linear)</div>
 </div>
 <div class="b3-vol-card" title="Dias com trade dividido por dias úteis do período. Alta = liquidez consistente.">
 <div class="b3-vol-lbl">Persistência</div>
 <div class="b3-vol-val">${_persistenciaPill(d.persistencia, d.dias_negociados, d.period_n_dates)}</div>
 <div class="b3-vol-hint">freq. de negociação</div>
 </div>
 </div>

 <h4 class="b3-detail-section-title">Série temporal <span style="font-weight:400;font-size:9.5px;color:var(--txt-dim)">— ${series.length} dia(s) com trade</span></h4>
 <div class="b3-spark-wrap">${sparkSvg}</div>

 <h4 class="b3-detail-section-title">Detalhe por dia</h4>
 <div class="b3-detail-table-wrap">
 <table class="b3-detail-table">
 <thead><tr>
 <th>Data</th><th class="right">PU médio</th><th class="right">PU min</th><th class="right">PU max</th>
 <th class="right">Range %</th><th class="right">Volume</th><th class="right">Trades</th><th class="right">Oscil.</th>
 </tr></thead>
 <tbody>
 ${series.map((s,i) => {
 const range = (s.pu_min != null && s.pu_max != null && s.pu_medio > 0)
 ? ((s.pu_max - s.pu_min) / s.pu_medio * 100).toFixed(2)+'%': '—';
 const ret = i > 0 && series[i-1].pu_medio && s.pu_medio
 ? ` <span style="font-size:8.5px;opacity:.65">(${((s.pu_medio/series[i-1].pu_medio-1)*100).toFixed(2)}%)</span>`
: '';
 return `<tr>
 <td class="cell-venc">${_esc(s.data||'?')}</td>
 <td class="right mono">${s.pu_medio!=null?fmt2(s.pu_medio):'—'}${ret}</td>
 <td class="right mono" style="font-size:10px;color:var(--txt-muted)">${s.pu_min!=null?fmt2(s.pu_min):'—'}</td>
 <td class="right mono" style="font-size:10px;color:var(--txt-muted)">${s.pu_max!=null?fmt2(s.pu_max):'—'}</td>
 <td class="right mono" style="font-size:10px">${range}</td>
 <td class="right mono">${fmtVolM(s.vol_total)}</td>
 <td class="right mono" style="font-size:10px">${s.n_trades||0}</td>
 <td class="right mono" style="font-size:10px">${s.oscilacao!=null?(s.oscilacao>0?'+':'')+s.oscilacao.toFixed(2)+'%':'—'}</td>
 </tr>`;
 }).join('')}
 </tbody>
 </table>
 </div>`;
}

/** Sparkline SVG: linha PU médio + barras de volume embaixo.
 * `couponDatesIso` (opcional): lista de 'YYYY-MM-DD' marcadas com linha
 * vertical tracejada (eventos esperados de pagamento de cupom). */
function _renderB3Sparkline(series, couponDatesIso) {
 const valid = series.filter(s => s.pu_medio != null);
 if (valid.length < 2) return '<p style="color:var(--txt-dim);font-size:10.5px;padding:8px 0">Sem dados suficientes (mínimo 2 dias com trade) para sparkline.</p>';
 const W = 880, H = 200, PAD = {l:48, r:18, t:14, b:42};
 const plotW = W - PAD.l - PAD.r;
 const plotH = (H - PAD.t - PAD.b) * 0.65; // 65% para PU
 const volH = (H - PAD.t - PAD.b) * 0.30; // 30% para volume
 const volY = PAD.t + plotH + 8; // gap pequeno

 const xs = valid.map((_,i)=>i);
 const ys = valid.map(s=>s.pu_medio);
 const vs = valid.map(s=>s.vol_total||0);
 const yMin = Math.min(...ys), yMax = Math.max(...ys);
 const yRange = (yMax - yMin) || (yMax * 0.01) || 1;
 const pad = yRange * 0.1;
 const yLo = yMin - pad, yHi = yMax + pad;
 const vMax = Math.max(...vs, 1);

 const px = i =>PAD.l + (i/(valid.length-1)) * plotW;
 const py = y =>PAD.t + plotH - ((y - yLo)/(yHi - yLo)) * plotH;

 // Path PU
 const path = valid.map((s,i)=>`${i===0?'M':'L'}${px(i).toFixed(1)},${py(s.pu_medio).toFixed(1)}`).join('');
 // Pontos
 const dots = valid.map((s,i)=>{
 const cx = px(i).toFixed(1), cy = py(s.pu_medio).toFixed(1);
 return `<circle cx="${cx}" cy="${cy}" r="3" fill="var(--blue-lt)" stroke="var(--bg2)" stroke-width="1"><title>${s.data}: PU médio ${s.pu_medio.toFixed(2)} · Vol ${fmtVol(s.vol_total)} · ${s.n_trades||0} trades</title></circle>`;
 }).join('');

 // Barras volume
 const barW = Math.max(2, plotW / valid.length * 0.6);
 const bars = valid.map((s,i) => {
 const h = (s.vol_total||0) / vMax * volH;
 const x = px(i) - barW/2;
 const y = volY + (volH - h);
 return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="var(--gold-lt)" opacity="0.45"><title>${s.data}: ${fmtVol(s.vol_total)} em ${s.n_trades||0} trades</title></rect>`;
 }).join('');

 // Y labels (4 ticks)
 let yLabels = '';
 for (let t = 0; t <= 4; t++) {
 const v = yLo + (yHi - yLo) * (t/4);
 const yy = py(v);
 yLabels += `<line x1="${PAD.l}" y1="${yy.toFixed(1)}" x2="${W-PAD.r}" y2="${yy.toFixed(1)}" stroke="var(--border)" stroke-width="0.5"/>
 <text x="${PAD.l-4}" y="${(yy+3.5).toFixed(1)}" fill="var(--txt-dim)" font-size="9" text-anchor="end">${v.toFixed(2)}</text>`;
 }

 // X labels — primeiro, último, e alguns intermediários
 let xLabels = '';
 const stepX = Math.max(1, Math.floor(valid.length / 6));
 for (let i = 0; i < valid.length; i += stepX) {
 const cx = px(i);
 xLabels += `<text x="${cx.toFixed(1)}" y="${(H - PAD.b + 14).toFixed(1)}" fill="var(--txt-dim)" font-size="9" text-anchor="middle">${valid[i].data || ''}</text>`;
 }
 // Último sempre
 if ((valid.length - 1) % stepX !== 0) {
 const cx = px(valid.length-1);
 xLabels += `<text x="${cx.toFixed(1)}" y="${(H - PAD.b + 14).toFixed(1)}" fill="var(--txt-dim)" font-size="9" text-anchor="middle">${valid[valid.length-1].data || ''}</text>`;
 }

 // Marcadores verticais nas datas de cupom previstas (esperadas no período)
 // Filtra para datas dentro do range visível e desenha linha tracejada gold.
 let couponMarks = '';
 if (couponDatesIso && couponDatesIso.length) {
 // Range de datas visíveis (yyyymmdd numérico)
 const _toNum = (yyyymmdd) => parseInt(yyyymmdd.replace(/-/g, ''));
 const firstDay = _toNum(valid[0].data ? valid[0].data.split('/').reverse().join('-'): '');
 const lastDay = _toNum(valid[valid.length-1].data ? valid[valid.length-1].data.split('/').reverse().join('-'): '');
 // Mapeia índice -> data numérica para localizar X do marcador
 const dayToX = {};
 valid.forEach((s, i) => {
 if (s.data) {
 const k = _toNum(s.data.split('/').reverse().join('-'));
 dayToX[k] = px(i);
 }
 });
 couponDatesIso.forEach(iso => {
 const k = _toNum(iso);
 if (k < firstDay || k > lastDay) return;
 // Se a data exata não casa, acha o ponto mais próximo
 let bestK = null, bestDiff = Infinity;
 for (const dk in dayToX) {
 const diff = Math.abs(Number(dk) - k);
 if (diff < bestDiff) { bestK = Number(dk); bestDiff = diff; }
 }
 if (bestK == null || bestDiff > 7) return; // só marca se houver ponto dentro de 7 dias
 const cx = dayToX[bestK].toFixed(1);
 couponMarks += `<line x1="${cx}" y1="${PAD.t}" x2="${cx}" y2="${(H - PAD.b).toFixed(1)}" stroke="var(--gold-lt)" stroke-width="1" stroke-dasharray="3,3" opacity="0.55"><title>Cupom previsto: ${iso.split('-').reverse().join('/')}</title></line>`;
 });
 }

 return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px">
 ${yLabels}
 <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t+plotH}" stroke="var(--border-lt)" stroke-width="1"/>
 <line x1="${PAD.l}" y1="${PAD.t+plotH}" x2="${W-PAD.r}" y2="${PAD.t+plotH}" stroke="var(--border-lt)" stroke-width="1"/>
 ${couponMarks}
 <path d="${path}" stroke="var(--blue-lt)" stroke-width="1.8" fill="none"/>
 ${dots}
 ${bars}
 <text x="${(PAD.l-4).toFixed(1)}" y="${(volY + volH/2 + 3).toFixed(1)}" fill="var(--txt-dim)" font-size="8" text-anchor="end">vol</text>
 ${xLabels}
 ${couponMarks ? `<g transform="translate(${(W-PAD.r-110).toFixed(0)},${(PAD.t-4).toFixed(0)})">
 <line x1="0" y1="0" x2="14" y2="0" stroke="var(--gold-lt)" stroke-width="1" stroke-dasharray="3,3" opacity="0.7"/>
 <text x="18" y="3" fill="var(--txt-muted)" font-size="9">cupom previsto</text>
 </g>`: ''}
 </svg>`;
}

/** Pequeno badge de instrumento — reutiliza paleta de _instrBadge mas inclui CFF/CPR. */
function _b3InstrBadge(instr) {
 const i = (instr||'').toUpperCase();
 const map = {
 CRI:'instr-cri', CRA:'instr-cra', DEB:'instr-deb',
 CDCA:'instr-cdca', LF:'instr-lf', CDB:'instr-cdb',
 LCI:'instr-lci', LCA:'instr-lca',
 CFF:'instr-other', CPR:'instr-other',
 };
 const cls = map[i] || 'instr-other';
 return `<span class="instr-badge ${cls}" title="${_esc(instr||'')}">${_esc(i||'?')}</span>`;
}

/** Tooltip explicando o ratio extragrupo, calibrado para o valor da linha. */
function _b3RatioTip(r) {
 if (r == null) return 'Sem dados de classificação';
 if (r >= 0.5) return `${(r*100).toFixed(0)}% extragrupo — demanda institucional alta. Preço é benchmark sólido.`;
 if (r >= 0.2) return `${(r*100).toFixed(0)}% extragrupo — liquidez mista. Preço razoável mas com peso do distribuidor.`;
 if (r > 0) return `${(r*100).toFixed(0)}% extragrupo — papel circula quase só dentro do distribuidor. Preço pode estar sustentado artificialmente.`;
 return '0% extragrupo — só intragrupo. O "mercado" é o próprio distribuidor.';
}

/* ── MODAL DE DETALHE — PAPEL (CATÁLOGO / MERCADO / OPORTUNIDADES) ────── */
/** Procura row do papel por ticker em todas as fontes carregadas, ordenadas
 * por riqueza de informação:
 * 1. Catálogo XP (tem Compra/Venda ANBIMA, score, cronograma forward)
 * 2. Oportunidades (tem dados mercado + alguns campos catálogo)
 * 3. RF Mercado (tem book BID/OFFER próprio XP)
 * Mescla campos faltantes pegando da fonte com mais info. */
function _findRowByTicker(ticker) {
 const tk = (ticker || '').toUpperCase();
 if (!tk) return null;
 const _match = r => (r?.ticker || '').toUpperCase() === tk;
 const catRow = getCatalogoRows().find(_match);
 const oporRow = (state.data?.oportunidades || []).find(_match);
 const mktRow = (state.data?.mercado || []).find(_match);
 // Catálogo é o mais rico — mescla campos do mercado/oportunidades por cima
 // (BID/OFFER, vol_offer, etc não estão no catálogo).
 const base = catRow || oporRow || mktRow;
 if (!base) return null;
 return {...mktRow,...oporRow,...catRow,
 // Preserve campos importantes que mercado/oportunidades têm:
 bid_rate: mktRow?.bid_rate ?? oporRow?.bid_rate,
 bid_rate_str: mktRow?.bid_rate_str ?? oporRow?.bid_rate_str,
 offer_rate: mktRow?.offer_rate ?? oporRow?.offer_rate,
 offer_rate_str: mktRow?.offer_rate_str ?? oporRow?.offer_rate_str,
 vol_offer: mktRow?.vol_offer ?? oporRow?.vol_offer,
 vol_bid: mktRow?.vol_bid ?? oporRow?.vol_bid,
 delta_offer_anbima: mktRow?.delta_offer_anbima,
 delta_bid_anbima: mktRow?.delta_bid_anbima,
 spread_bid_ask_xp: mktRow?.spread_bid_ask_xp,
 };
}

function openXpDetailModal(ticker, initialTab) {
 const row = _findRowByTicker(ticker);
 if (!row) { alert(`Papel ${ticker} não encontrado.`); return; }
 const m = _ensureXpDetailModal();
 // Guarda o ticker atual no modal para a troca de abas
 m.dataset.currentTicker = row.ticker || ticker;
 m.dataset.activeTab = initialTab || 'detalhes';
 document.getElementById('xpDetailBody').innerHTML = _renderXpDetailContent(row, initialTab || 'detalhes');
 m.classList.add('open');
 // Se a aba inicial é série temporal, dispara o fetch
 if ((initialTab || 'detalhes') === 'serie') {
 _loadXpSerieTab(row.ticker || ticker);
 }
}

/** Alterna entre as abas "Detalhes do papel" e "Série temporal completa".
 * A aba "serie" faz fetch ao /api/b3-papel/ apenas na 1ª vez (lazy-load). */
function switchXpDetailTab(tab) {
 const modal = document.getElementById('xpDetailModal');
 if (!modal) return;
 const ticker = modal.dataset.currentTicker;
 if (!ticker) return;
 modal.dataset.activeTab = tab;

 // Atualiza visual das abas
 document.querySelectorAll('.xp-d-tab').forEach(el => {
 el.classList.toggle('active', el.dataset.tab === tab);
 });

 if (tab === 'detalhes') {
 const row = _findRowByTicker(ticker);
 document.getElementById('xpDetailTabContent').innerHTML = _renderXpDetalhesTab(row);
 } else if (tab === 'serie') {
 document.getElementById('xpDetailTabContent').innerHTML =
 '<p style="color:var(--txt-muted);padding:32px;text-align:center">Carregando série temporal…</p>';
 _loadXpSerieTab(ticker);
 }
}

async function _loadXpSerieTab(ticker) {
 try {
 const res = await fetch('/api/b3-papel/' + encodeURIComponent(ticker));
 const cont = document.getElementById('xpDetailTabContent');
 if (!cont) return;
 if (!res.ok) {
 cont.innerHTML = `<p style="color:var(--gold-lt);padding:24px;text-align:center">Sem dados B3 para <strong>${_esc(ticker)}</strong> no período carregado. Faça upload do arquivo de Negociação Consolidada da B3 para ver a série temporal.</p>`;
 return;
 }
 const d = await res.json();
 cont.innerHTML = _renderB3DetailContent(d);
 } catch (e) {
 const cont = document.getElementById('xpDetailTabContent');
 if (cont) cont.innerHTML = `<p style="color:var(--red-lt);padding:24px">Erro: ${_esc(e.message)}</p>`;
 }
}
function closeXpDetailModal() { document.getElementById('xpDetailModal')?.classList.remove('open'); }
function _ensureXpDetailModal() {
 let modal = document.getElementById('xpDetailModal');
 if (modal) return modal;
 modal = document.createElement('div');
 modal.id = 'xpDetailModal';
 modal.className = 'modal-overlay';
 modal.onclick = (e) => { if (e.target === modal) closeXpDetailModal(); };
 modal.innerHTML = `
 <div class="modal modal-xl">
 <div class="modal-header">
 <span class="modal-title">Detalhe do papel</span>
 <button class="modal-close" onclick="closeXpDetailModal()">X</button>
 </div>
 <div class="modal-body" id="xpDetailBody"></div>
 <div class="modal-footer">
 <button class="btn-secondary" onclick="closeXpDetailModal()">Fechar</button>
 </div>
 </div>`;
 document.body.appendChild(modal);
 return modal;
}

/** Estrutura completa do modal: header de abas + conteúdo da aba inicial. */
function _renderXpDetailContent(r, activeTab) {
 activeTab = activeTab || 'detalhes';
 const hasB3 = !!(r.b3_vol_total);
 const initial = activeTab === 'serie'
 ? '<p style="color:var(--txt-muted);padding:32px;text-align:center">Carregando série temporal…</p>'
: _renderXpDetalhesTab(r);
 return `
 <div class="xp-d-tabs">
 <button class="xp-d-tab ${activeTab==='detalhes'?'active':''}" data-tab="detalhes" onclick="switchXpDetailTab('detalhes')">Detalhes do papel</button>
 <button class="xp-d-tab ${activeTab==='serie'?'active':''}" data-tab="serie" onclick="switchXpDetailTab('serie')" ${!hasB3 ? 'style="opacity:.55"': ''} title="${hasB3 ? 'Ver sparkline + tabela diária do papel na B3': 'Sem dados B3 — pode estar vazio'}">Série temporal completa</button>
 </div>
 <div id="xpDetailTabContent">${initial}</div>
 `;
}

/** Conteúdo da aba "Detalhes do papel" (antiga renderização). */
function _renderXpDetalhesTab(r) {
 const eff = _rowEffectiveRate(r);
 const itype = r.indice_type || '';
 const durYears = r.dur != null ? (r.dur/252).toFixed(2) + 'a': '—';
 const conglo = _conglomerate(r);
 const band = _scoreBand(r.score_total);

 // ── Bloco "Taxas ANBIMA" — Compra / Indicativa / Venda + Spread Bid-Ask
 // Aqui está o que o sales pediu. Em RF: taxa MAIOR = preço MENOR. O BID
 // interbancário (Compra) é a taxa maior porque o comprador paga preço menor.
 const fmtT = v => v != null ? v.toFixed(4) + (itype==='CDI%' ? '% CDI': '%'): '—';
 const anbCompra = r.anbima_compra;
 const anbVenda = r.anbima_venda;
 const anbInd = r.anbima;
 const anbSpread = r.anbima_spread_ba;
 // Posição do offer XP (taxa_max) na faixa [Compra, Venda] ANBIMA — gauge
 const xpOffer = r.spread_xp_fb ?? r.taxa_max_num;
 let posPct = null;
 if (xpOffer != null && anbCompra != null && anbVenda != null && anbVenda > anbCompra) {
 // Compra é a taxa MAIOR (preço menor), Venda é a taxa MENOR (preço maior)
 // -> invertemos: 0% = perto da Compra (caro p/ cliente), 100% = perto da Venda (barato p/ cliente)
 posPct = Math.max(0, Math.min(100, (xpOffer - anbVenda) / (anbCompra - anbVenda) * 100));
 }

 // ── Prêmio de risco
 const premio = state.feeBased ? r.premio_risco_fb: r.premio_risco;
 const premioHtml = _premioRiscoHtml(premio, itype, r.curva_ref_taxa);

 // ── Cronograma de eventos (próximos cupons/amortizações)
 const sched = r.coupon_schedule || [];
 const nextEv = r.next_event;
 const schedHtml = sched.length ? `
 <h4 class="xp-d-section">Cronograma de Eventos <span style="font-weight:400;font-size:9.5px;color:var(--txt-dim)">— próximos ${Math.min(sched.length, 12)} eventos${sched.length > 12 ? ` (de ${sched.length})`: ''}</span></h4>
 ${nextEv ? `
 <div class="xp-d-next-ev">
 <span class="xp-d-next-lbl">Próximo evento:</span>
 <strong>${nextEv.date}</strong>
 <span class="xp-d-ev-tag xp-d-ev-${nextEv.tipo}">${nextEv.tipo === 'juros' ? 'Juros': nextEv.tipo === 'amort' ? 'Amortização': nextEv.tipo === 'ambos' ? 'Juros + Amortização': 'Vencimento'}</span>
 <span style="color:var(--txt-dim);font-size:10px">em ${nextEv.days_from_today} dia(s)</span>
 </div>`: ''}
 <div class="xp-d-sched-grid">
 ${sched.slice(0, 12).map(e => `
 <div class="xp-d-sched-cell xp-d-ev-${e.tipo}-bg" title="${e.tipo==='juros'?'Pagamento de juros':e.tipo==='amort'?'Amortização do principal':e.tipo==='ambos'?'Juros + amortização no mesmo dia':'Vencimento final'} · source: ${e.source}">
 <span class="xp-d-sched-date">${e.date}</span>
 <span class="xp-d-sched-tipo">${e.tipo === 'ambos' ? 'J+A': e.tipo === 'juros' ? 'J': e.tipo === 'amort' ? 'A': 'V'}</span>
 </div>
 `).join('')}
 </div>
 <p class="xp-d-sched-note">Fonte do cronograma: <strong>${sched[0].source === 'forward' ? 'Catálogo XP (Primeira Data de Juros + frequência)': sched[0].source === 'backward' ? 'Inferido do vencimento + frequência': 'Vencimento (zero-coupon)'}</strong>.${sched[0].source === 'backward' ? ' Datas podem deslocar 1-2 dias do real (depende do feriado bancário).': ''}</p>
 `: '';

 // ── B3 mini-resumo (se houver match)
 const hasB3 = !!(r.b3_vol_total);
 const b3Html = hasB3 ? `
 <h4 class="xp-d-section">B3 — Mercado Secundário <span style="font-weight:400;font-size:10px;color:var(--txt-dim);margin-left:6px">para sparkline + tabela diária, abra a aba " Série temporal completa" acima</span></h4>
 <div class="xp-d-kpis">
 <div class="b3-kpi"><span class="b3-kpi-lbl">Volume</span><span class="b3-kpi-val" style="color:var(--blue-lt)">${fmtVol(r.b3_vol_total)}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Trades</span><span class="b3-kpi-val">${r.b3_n_trades||0}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Ratio extra</span><span class="b3-kpi-val">${r.b3_ratio_extra!=null?(r.b3_ratio_extra*100).toFixed(0)+'%':'—'}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl" title="Vol diária com os retornos dos dias de pagamento de cupom incluídos">Vol diária</span><span class="b3-kpi-val">${r.b3_vol_diaria_std!=null?r.b3_vol_diaria_std.toFixed(2)+'%':'—'}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl" title="Vol diária descartando dias próximos a datas previstas de pagamento de cupom">Vol diária ex-cupom</span><span class="b3-kpi-val">${r.b3_vol_diaria_std_ex_cupom!=null?r.b3_vol_diaria_std_ex_cupom.toFixed(2)+'%':'—'}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Dias negoc.</span><span class="b3-kpi-val">${r.b3_dias_negociados||0}</span></div>
 </div>`: '';

 // ── Datas operacionais (mesclado de Produtos)
 const hasOp = r.qtd_min != null || r.carencia || r.data_emissao || r.primeira_data_juros;
 const opHtml = hasOp ? `
 <h4 class="xp-d-section">Operacional</h4>
 <div class="xp-d-grid2">
 ${r.qtd_min != null ? `<div><span class="xp-d-lbl">Qtd mín.</span><span class="xp-d-val">${r.qtd_min}</span></div>`: ''}
 ${r.carencia ? `<div><span class="xp-d-lbl">Carência</span><span class="xp-d-val">${_esc(String(r.carencia))}</span></div>`: ''}
 ${r.data_emissao ? `<div><span class="xp-d-lbl">Emissão</span><span class="xp-d-val">${_esc(String(r.data_emissao))}</span></div>`: ''}
 ${r.primeira_data_juros ? `<div><span class="xp-d-lbl">1ª data de juros</span><span class="xp-d-val">${_esc(String(r.primeira_data_juros))}</span></div>`: ''}
 ${r.juros ? `<div><span class="xp-d-lbl">Pgto juros</span><span class="xp-d-val">${_esc(String(r.juros))}</span></div>`: ''}
 ${r.amortizacao ? `<div><span class="xp-d-lbl">Amortização</span><span class="xp-d-val">${_esc(String(r.amortizacao))}</span></div>`: ''}
 ${r.publico ? `<div><span class="xp-d-lbl">Público</span><span class="xp-d-val">${_esc(String(r.publico))}</span></div>`: ''}
 </div>`: '';

 return `
 <div class="b3-detail-header">
 <div class="b3-detail-id">
 ${_instrBadge(r.instrumento)}
 ${_idxBadge(itype)}
 <span class="b3-detail-code">${_esc(r.ticker||'?')}</span>
 ${conglo ? `<span class="conglo-badge" style="border-color:${conglo.color};color:${conglo.color};background:${conglo.colorDim}">${conglo.grp}</span>`: ''}
 ${r.isento === 'S' ? '<span class="yc-tip-tag" style="margin-left:4px">Isento IR</span>': ''}
 ${r.rj ? '<span class="rj-badge" style="margin-left:4px">RJ</span>': ''}
 </div>
 <div class="b3-detail-emissor">${_esc(r.emissor||r.ativo||'?')}</div>
 </div>

 <div class="xp-d-kpis">
 <div class="b3-kpi"><span class="b3-kpi-lbl">Vencimento</span><span class="b3-kpi-val">${_esc(r.vencimento||'—')}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Duration</span><span class="b3-kpi-val">${durYears}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Setor</span><span class="b3-kpi-val" style="font-size:11px">${_esc(r.setor||'—')}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Rating</span><span class="b3-kpi-val">${ratingBadge(r.rating)}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Score</span><span class="b3-kpi-val">${r.score_total!=null?fmt2(r.score_total):'—'} ${_scoreBandBadge(band, {short:true})}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Aloc Máx</span><span class="b3-kpi-val">${r.aloc_max!=null?r.aloc_max+'%':'—'}</span></div>
 </div>

 <h4 class="xp-d-section">Taxas ANBIMA — Compra · Indicativa · Venda</h4>
 <div class="xp-d-anbima">
 <div class="xp-d-anbima-row">
 <div class="xp-d-anbima-cell">
 <div class="xp-d-anbima-lbl">Taxa Compra ANBIMA</div>
 <div class="xp-d-anbima-val xp-d-anbima-bid">${fmtT(anbCompra)}</div>
 <div class="xp-d-anbima-hint">taxa em que dealers compram (BID ANBIMA)</div>
 </div>
 <div class="xp-d-anbima-cell xp-d-anbima-cell-center">
 <div class="xp-d-anbima-lbl">Taxa Indicativa ANBIMA</div>
 <div class="xp-d-anbima-val xp-d-anbima-ind">${fmtT(anbInd)}</div>
 <div class="xp-d-anbima-hint">consenso ANBIMA (fair-value)</div>
 </div>
 <div class="xp-d-anbima-cell">
 <div class="xp-d-anbima-lbl">Taxa Venda ANBIMA</div>
 <div class="xp-d-anbima-val xp-d-anbima-offer">${fmtT(anbVenda)}</div>
 <div class="xp-d-anbima-hint">taxa em que dealers vendem (OFFER ANBIMA)</div>
 </div>
 </div>
 ${anbSpread != null ? `
 <div class="xp-d-anbima-spread" title="Spread Bid-Ask ANBIMA = Compra − Venda. Proxy de liquidez no book interbancário. <0,15pp líquido · 0,15-0,5pp moderado · >0,5pp ilíquido">
 Spread Bid-Ask ANBIMA: <strong>${anbSpread.toFixed(4)} pp</strong>
 <span class="xp-d-anbima-liq ${anbSpread<0.15?'vol-low':anbSpread<0.5?'vol-mid':'vol-hi'}">
 ${anbSpread<0.15?'líquido':anbSpread<0.5?'moderado':'ilíquido'}
</span>
 </div>`: ''}
 ${posPct != null ? `
 <div class="xp-d-gauge-wrap" title="Onde a Taxa MÁX XP (oferta ao cliente) cai no intervalo entre Taxa Compra e Taxa Venda ANBIMA. 100% = perto da Taxa Venda (barato p/ cliente). 0% = perto da Taxa Compra (caro p/ cliente).">
 <div class="xp-d-gauge-lbl">Posição da Taxa Máx XP na faixa ANBIMA <span style="color:var(--txt-muted)">(${posPct.toFixed(0)}%)</span></div>
 <div class="xp-d-gauge">
 <div class="xp-d-gauge-fill" style="width:${posPct.toFixed(0)}%"></div>
 <div class="xp-d-gauge-marker" style="left:${posPct.toFixed(0)}%"></div>
 </div>
 <div class="xp-d-gauge-axis">
 <span>Compra ANBIMA (caro p/ cliente)</span>
 <span>Indicativa</span>
 <span>Venda ANBIMA (barato p/ cliente)</span>
 </div>
 </div>`: ''}
 </div>

 <h4 class="xp-d-section">Taxas XP</h4>
 <div class="xp-d-kpis">
 <div class="b3-kpi"><span class="b3-kpi-lbl">Taxa Comissão (Mín)</span><span class="b3-kpi-val">${_esc(r.taxa_xp||'—')}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Taxa Fee-based (Máx)</span><span class="b3-kpi-val">${_esc(r.taxa_xp_fb||'—')}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">ROA E.A.</span><span class="b3-kpi-val" style="color:var(--gold-lt)">${state.feeBased?'0,00%':(r.roa||'—')}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Δ vs Indicativa</span><span class="b3-kpi-val">${fmtDelta(eff.delta_anbima)}</span></div>
 <div class="b3-kpi"><span class="b3-kpi-lbl">Prêmio de risco</span><span class="b3-kpi-val">${premioHtml}</span></div>
 </div>

 ${opHtml}
 ${schedHtml}
 ${b3Html}
 `;
}

/* ── B3 BADGE — usado nas abas Mercado / Oportunidades / Spread-Score ─────── */
/** Renderiza um pequeno badge B3 com volume + n_trades + ratio extra, ou "—".
 * Tooltip inclui métricas de volatilidade. Click abre modal de detalhe. */
function _b3Cell(r) {
 const v = r.b3_vol_total, n = r.b3_n_trades, ratio = r.b3_ratio_extra;
 if (!v) return '<span class="no-order" title="Sem trades B3 para este código IF">—</span>';
 const pct = ratio != null ? Math.round(ratio*100): null;
 const cls = ratio == null ? 'b3-ratio-na'
: ratio >= 0.5 ? 'b3-ratio-hi'
: ratio >= 0.2 ? 'b3-ratio-md'
: 'b3-ratio-lo';

 // Tooltip rico com volatilidade
 const parts = [`B3: ${fmtVol(v)} em ${n||0} trades · ${_b3RatioTip(ratio)}`];
 if (r.b3_dias_negociados > 1) parts.push(`${r.b3_dias_negociados} dias com trade`);
 if (r.b3_oscilacao != null) parts.push(`oscil. ${r.b3_oscilacao>0?'+':''}${r.b3_oscilacao.toFixed(2)}%`);
 if (r.b3_vol_diaria_std != null) parts.push(`Vol diária ${r.b3_vol_diaria_std.toFixed(2)}%`);
 if (r.b3_vol_period_pct != null) parts.push(`Range ${r.b3_vol_period_pct.toFixed(2)}%`);
 if (r.b3_tendencia_pct_dia != null) {
 const t = r.b3_tendencia_pct_dia;
 const arr = Math.abs(t) < 0.05 ? '=': t > 0 ? '+': '-';
 parts.push(`Tend. ${arr} ${(t>0?'+':'')}${t.toFixed(3)} pp/dia`);
 }
 if (r.b3_persistencia != null) parts.push(`Persist. ${(r.b3_persistencia*100).toFixed(0)}%`);
 parts.push('clique para ver série + sparkline');
 const tip = parts.join(' · ');

 const ticker = r.ticker || r.cod_if;
 // Click no badge -> abre modal de detalhe COMPLETO (taxas Compra/Venda ANBIMA,
 // cronograma, B3, etc). O modal XP tem um link "Ver série temporal completa"
 // que abre o modal B3 (sparkline) — não perdemos esse atalho.
 const onclick = ticker ? `onclick="openXpDetailModal('${_esc(ticker)}');return false"`: '';
 const fullTip = tip + ' — Clique para abrir detalhe completo do papel';
 return `<a href="#" class="b3-cell" title="${fullTip}" ${onclick}>
 <span class="b3-vol mono">${fmtVol(v)}</span>
 <span class="b3-trades mono">${n||0}t</span>
 ${pct!=null?`<span class="b3-ratio-pill ${cls}">${pct}%</span>`:''}
</a>`;
}

/* ── EMPRESAS TABLE ──────────────────────────────────────────────────────── */
function renderEmpresasTable(rows) {
 const cols = [
 {key:'empresa', label:'Empresa', sticky:true},
 {key:'setor', label:'Setor'},
 {key:'score_total', label:'Score Total'},
 {key:'score_quant', label:'S.Quant.'},
 {key:'score_qual', label:'S.Qual.'},
 {key:'aloc_max', label:'Aloc%'},
 {key:'rating_fitch', label:'Fitch'},
 {key:'rating_sp', label:'S&P'},
 {key:'rating_moodys',label:"Moody's"},
 {key:'net_filtrado', label:'NET Filtrado'},
 {key:'net_total', label:'NET Total'},
 {key:'ultima_revisao',label:'Revisão'},
 ];

 document.getElementById('tableHead').innerHTML = '<tr>' + cols.map(c => {
 const sorted=state.sort.col===c.key?`sorted-${state.sort.dir}`:'';
 const sticky=c.sticky?'col-sticky':'';
 return `<th class="${sticky}"><div class="th-inner ${sorted}" data-col="${c.key}">${c.label}<span class="sort-ind"></span></div></th>`;
 }).join('') + '</tr>';

 document.getElementById('tableBody').innerHTML = rows.map(r => `<tr>
 <td class="col-sticky" style="font-weight:500;color:var(--txt);max-width:220px;overflow:hidden;text-overflow:ellipsis">${r.empresa||'—'}</td>
 <td><span class="setor-badge">${r.setor||'—'}</span></td>
 <td class="cell-score ${scoreColorClass(r.score_total)}">${r.score_total!=null?fmt2(r.score_total):'<span class="s-na">—</span>'}</td>
 <td class="right mono">${fmt2(r.score_quant)}</td>
 <td class="right mono">${fmt2(r.score_qual)}</td>
 <td>${alocBar(r.aloc_max)}</td>
 <td>${ratingBadge(r.rating_fitch)}</td>
 <td>${ratingBadge(r.rating_sp)}</td>
 <td>${ratingBadge(r.rating_moodys)}</td>
 <td class="right mono" style="font-size:10.5px;color:var(--txt-sec)">${fmtNet(r.net_filtrado)}</td>
 <td class="right mono" style="font-size:10.5px;color:var(--txt-muted)">${fmtNet(r.net_total)}</td>
 <td style="font-size:10.5px;color:var(--txt-muted)">${r.ultima_revisao||'—'}</td>
 </tr>`).join('');

 attachSortHandlers();
}

/* ── PRODUTOS TABLE ──────────────────────────────────────────────────────── */
function renderProdutosTable(rows) {
 const cols = [
 {key:'ativo', label:'Ativo', sticky:true},
 {key:'ticker', label:'Ticker'},
 {key:'instrumento',label:'Tipo'},
 {key:'indexador', label:'Indexador'},
 {key:'vencimento', label:'Vencimento'},
 {key:'duration_xp',label:'Dur.'},
 {key:'rating', label:'Rating'},
 {key:'isento', label:'Isento'},
 {key:'taxa_min', label:'Taxa Mín.'},
 {key:'taxa_max', label:'Taxa Máx.'},
 {key:'roa', label:'ROA Aprox.'},
 {key:'publico', label:'Público'},
 {key:'qtd_min', label:'Qtd Mín.'},
 ];

 document.getElementById('tableHead').innerHTML = '<tr>' + cols.map(c => {
 const sorted=state.sort.col===c.key?`sorted-${state.sort.dir}`:'';
 const sticky=c.sticky?'col-sticky':'';
 return `<th class="${sticky}"><div class="th-inner ${sorted}" data-col="${c.key}">${c.label}<span class="sort-ind"></span></div></th>`;
 }).join('') + '</tr>';

 document.getElementById('tableBody').innerHTML = rows.map(r => `<tr>
 <td class="col-sticky"><span class="cell-ativo" title="${r.ativo||''}">${r.ativo||'—'}</span></td>
 <td><span class="cell-ticker">${r.ticker||'—'}</span></td>
 <td>${_instrBadge(r.instrumento)}</td>
 <td style="font-size:10.5px;color:var(--txt-sec)">${r.indexador||'—'}</td>
 <td class="cell-venc">${r.vencimento||'—'}</td>
 <td class="right mono">${fmt2(r.duration_xp)}</td>
 <td>${ratingBadge(r.rating)}</td>
 <td class="center">${isentoHtml(r.isento)}</td>
 <td class="cell-taxa" style="color:var(--txt-sec)">${r.taxa_min||'—'}</td>
 <td class="cell-taxa">${r.taxa_max||'—'}</td>
 <td class="right mono" style="color:var(--gold-lt)">${_roaDisplay(r.roa,{raw:true})}</td>
 <td style="font-size:10.5px;color:var(--txt-muted)">${r.publico||'—'}</td>
 <td class="right mono" style="color:var(--txt-sec)">${r.qtd_min!=null?r.qtd_min:'—'}</td>
 </tr>`).join('');

 attachSortHandlers();
}

/* ── TÍTULOS PÚBLICOS ────────────────────────────────────────────────────── */
async function parseTitulos() {
 const text=document.getElementById('tpInput').value.trim();
 const statusEl=document.getElementById('tpStatus');
 if (!text) { statusEl.textContent='Cole o texto da ANBIMA antes de parsear.'; statusEl.style.color='var(--red-lt)'; return; }
 statusEl.textContent='Parseando...'; statusEl.style.color='var(--txt-muted)';
 try {
 const res = await fetch('/api/titulos-publicos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
 const json = await res.json();
 state.tpBonds = json.bonds||[];
 const count = json.tp_data?.length||state.tpBonds.length;
 if (count) { statusEl.textContent=`${count} título(s) encontrado(s)`; statusEl.style.color='var(--green-lt)'; await loadData(); }
 else { statusEl.textContent='Nenhum título encontrado.'; statusEl.style.color='var(--gold-lt)'; }
 } catch(err) { statusEl.textContent=`Erro: ${err.message}`; statusEl.style.color='var(--red-lt)'; }
}
function clearTitulos() {
 document.getElementById('tpInput').value='';
 document.getElementById('tpStatus').textContent='';
 state.tpBonds=[];
 document.getElementById('tableContainer').style.display='none';
}

/* ── TP PRODUCTS TABLE ───────────────────────────────────────────────────── */
function renderTpProductsTable(rows) {
 const TYPE_COLORS = {
 'NTN-B':['rgba(16,185,129,.12)','#34d399','rgba(16,185,129,.35)'],
 'NTN-F':['rgba(251,146,60,.12)','#fb923c','rgba(251,146,60,.35)'],
 'LTN': ['rgba(196,162,68,.12)','#e0bc64','rgba(196,162,68,.35)'],
 'LFT': ['rgba(59,130,246,.12)','#60a5fa','rgba(59,130,246,.35)'],
 'NTN-C':['rgba(251,191,36,.12)','#fbbf24','rgba(251,191,36,.35)'],
 };
 const hasAnbima = rows.some(r=>r.anbima!=null);
 const cols = [
 {key:'tipo',label:'Tipo',sticky:true},{key:'ativo',label:'Ativo'},{key:'vencimento',label:'Vencimento'},
 {key:'duration',label:'Dur.'},{key:'rentabilidade',label:'Rentab.'},{key:'juros',label:'Cupom'},
 {key:'publico',label:'Público'},{key:'taxa_xp',label:'Taxa XP'},{key:'spread_xp',label:'XP num.'},
...(hasAnbima?[{key:'anbima',label:'ANBIMA Ind.'},{key:'delta_anbima',label:'Δ ANBIMA'},
 {key:'int_min',label:'Intv. Mín.'},{key:'int_max',label:'Intv. Máx.'},{key:'pu',label:'PU Ind.'}]:[]),
 {key:'_port',label:'',nosort:true},
 ];

 document.getElementById('tableHead').innerHTML = '<tr>'+cols.map(c=>{
 const sorted=state.sort.col===c.key?`sorted-${state.sort.dir}`:'';
 const sticky=c.sticky?'col-sticky':'';
 return `<th class="${sticky}"><div class="th-inner ${sorted}" data-col="${c.key}">${c.label}<span class="sort-ind"></span></div></th>`;
 }).join('')+'</tr>';

 const fmtRate=v=>{
 if(v==null||isNaN(+v)) return '<span style="color:var(--txt-faint)">—</span>';
 const n=+v,sign=n>0?'+':''; return `<span class="mono">${sign}${n.toFixed(4)}</span>`;
 };

 document.getElementById('tableBody').innerHTML = rows.map((r,i)=>{
 const tc=TYPE_COLORS[r.tipo]||['rgba(255,255,255,.04)','var(--txt-sec)','rgba(255,255,255,.1)'];
 const badge=`<span class="badge-rating" style="background:${tc[0]};color:${tc[1]};border:1px solid ${tc[2]}">${r.tipo||'?'}</span>`;
 const dClass=r.indice_type==='CDI%'?deltaCdiClass(r.delta_anbima):deltaIpcaClass(r.delta_anbima);
 const puFmt=r.pu!=null?'R$ '+Number(r.pu).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:6}):'—';
 const key=_rowKey(r); const inPort=state.portfolio.has(key);
 return `<tr class="${inPort?'row-in-port':''}">
 <td class="col-sticky">${badge}</td>
 <td style="font-weight:500;color:var(--txt);max-width:220px;overflow:hidden;text-overflow:ellipsis" title="${r.ativo||''}">${r.ativo||'—'}</td>
 <td class="cell-venc">${r.vencimento||'—'}</td>
 <td class="right mono">${r.duration!=null?Number(r.duration).toFixed(2):'—'}</td>
 <td style="font-size:10.5px;color:var(--txt-sec)">${r.rentabilidade||'—'}</td>
 <td>${r.juros?`<span class="setor-badge" style="font-size:9px">${r.juros}</span>`:'<span style="color:var(--txt-faint)">—</span>'}</td>
 <td>${r.publico?`<span style="font-size:10px;color:var(--txt-sec)">${r.publico}</span>`:'<span style="color:var(--txt-faint)">—</span>'}</td>
 <td class="cell-taxa">${r.taxa_xp||'—'}</td>
 <td class="right mono">${r.spread_xp!=null?Number(r.spread_xp).toFixed(4):'—'}</td>
 ${hasAnbima?`
 <td class="right mono">${fmtRate(r.anbima)}</td>
 <td class="cell-delta ${dClass}">${fmtDelta(r.delta_anbima)}</td>
 <td class="right">${fmtRate(r.int_min)}</td>
 <td class="right">${fmtRate(r.int_max)}</td>
 <td class="right mono" style="font-size:10.5px;color:var(--gold-lt)">${puFmt}</td>`:''}
 <td><button class="port-add-btn${inPort?' in-port':''}" onclick="togglePortfolioItem('${_esc(key)}',${i})" title="${inPort?'Remover':'Adicionar à carteira'}">${inPort?'':'+'}</button></td>
 </tr>`;
 }).join('');
 attachSortHandlers();
}

function renderTitulosTable(bonds) {
 const TYPE_COLORS={
 LFT:['rgba(59,130,246,.12)','#60a5fa','rgba(59,130,246,.35)'],
 LTN:['rgba(196,162,68,.12)','#e0bc64','rgba(196,162,68,.35)'],
 'NTN-B':['rgba(16,185,129,.12)','#34d399','rgba(16,185,129,.35)'],
 'NTN-C':['rgba(251,191,36,.12)','#fbbf24','rgba(251,191,36,.35)'],
 'NTN-F':['rgba(251,146,60,.12)','#fb923c','rgba(251,146,60,.35)'],
 };
 const cols=[
 {key:'tipo',label:'Tipo',sticky:true},{key:'nome',label:'Nome'},{key:'vencimento',label:'Vencimento'},
 {key:'emissao',label:'Emissão'},{key:'rentabilidade',label:'Rentabilidade'},
 {key:'taxa_indicativa',label:'Taxa Ind.'},{key:'taxa_compra',label:'Taxa Compra'},
 {key:'taxa_venda',label:'Taxa Venda'},{key:'int_min',label:'Intv. Mín.'},
 {key:'int_max',label:'Intv. Máx.'},{key:'vna',label:'VNA'},{key:'duration',label:'Duration'},{key:'pu',label:'PU Indicativo'},
 ];
 document.getElementById('tableHead').innerHTML='<tr>'+cols.map(c=>{
 const sorted=state.sort.col===c.key?`sorted-${state.sort.dir}`:'';
 const sticky=c.sticky?'col-sticky':'';
 return `<th class="${sticky}"><div class="th-inner ${sorted}" data-col="${c.key}">${c.label}<span class="sort-ind"></span></div></th>`;
 }).join('')+'</tr>';
 const fmtRate=v=>{
 if(v==null||isNaN(+v)) return '<span style="color:var(--txt-faint)">—</span>';
 const n=+v,sign=n>0?'+':''; return `<span class="mono">${sign}${n.toFixed(4)}</span>`;
 };
 document.getElementById('tableBody').innerHTML=bonds.map(b=>{
 const tc=TYPE_COLORS[b.tipo]||['rgba(255,255,255,.04)','var(--txt-sec)','rgba(255,255,255,.1)'];
 const badge=`<span class="badge-rating" style="background:${tc[0]};color:${tc[1]};border:1px solid ${tc[2]}">${b.tipo}</span>`;
 const vnaFmt=b.vna!=null?Number(b.vna).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:6}):'—';
 const puFmt=b.pu!=null?'R$ '+Number(b.pu).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:6}):'—';
 return `<tr>
 <td class="col-sticky">${badge}</td>
 <td style="font-weight:500;color:var(--txt);max-width:200px;overflow:hidden;text-overflow:ellipsis">${b.nome||'—'}</td>
 <td class="cell-venc">${b.vencimento||'—'}</td>
 <td class="cell-venc" style="color:var(--txt-muted)">${b.emissao||'—'}</td>
 <td style="font-size:10.5px;color:var(--txt-sec)">${b.rentabilidade||'—'}</td>
 <td class="right">${fmtRate(b.taxa_indicativa)}</td>
 <td class="right">${fmtRate(b.taxa_compra)}</td>
 <td class="right">${fmtRate(b.taxa_venda)}</td>
 <td class="right">${fmtRate(b.int_min)}</td>
 <td class="right">${fmtRate(b.int_max)}</td>
 <td class="right mono" style="font-size:10.5px;color:var(--txt-sec)">${vnaFmt}</td>
 <td class="right mono">${b.duration!=null?Number(b.duration).toFixed(2):'—'}</td>
 <td class="right mono" style="font-size:12px;font-weight:500;color:var(--gold-lt)">${puFmt}</td>
 </tr>`;
 }).join('');
 attachSortHandlers();
}

/* ── PORTFOLIO ───────────────────────────────────────────────────────────── */
function togglePortfolioItem(key, rowIndex) {
 const { tab, data } = state;
 let allRows=[];
 if (tab==='catalogo') allRows = getCatalogoRows();
 if (tab==='tp') allRows = data?.tp_data || [];
 if (tab==='mercado') allRows = data?.mercado || [];
 if (tab==='oportunidades') allRows = data?.oportunidades || [];

 const tbody=document.getElementById('tableBody');
 const tr=tbody.querySelectorAll('tr')[rowIndex];
 if (!tr) return;

 if (state.portfolio.has(key)) {
 state.portfolio.delete(key);
 tr.classList.remove('row-in-port');
 const btn=tr.querySelector('.port-add-btn');
 if(btn){btn.textContent='+';btn.classList.remove('in-port');btn.title='Adicionar à carteira';}
 } else {
 const row = allRows.find(r=>_rowKey(r)===key);
 if (!row) return;
 // Initial qty = 1 unit; if PU known, amount = PU; else default R$ 10k
 const pu0 = row.pu || row.cat_pu;
 const qty0 = pu0 ? Math.max(1, Math.round(10000 / pu0)): 1;
 state.portfolio.set(key, {row, t:0, qty:qty0, source:tab});
 tr.classList.add('row-in-port');
 const btn=tr.querySelector('.port-add-btn');
 if(btn){btn.textContent='';btn.classList.add('in-port');btn.title='Remover da carteira';}
 }
 _schedulePortUpdate();
}

/** Update slider t value (0-100) for a portfolio entry */
function updatePortfolioT(key, val) {
 const entry = state.portfolio.get(key); if (!entry) return;
 entry.t = parseInt(val) / 100;
 _schedulePortUpdate();
}

/** Update quantity (units) for a portfolio entry */
function updatePortfolioQty(key, val) {
 const entry = state.portfolio.get(key); if (!entry) return;
 entry.qty = Math.max(1, parseInt(String(val).replace(/\D/g,''))||1);
 _schedulePortUpdate();
}

// Keep legacy signature for backward compat (amount input -> convert to qty)
function updatePortfolioAmount(key, val) {
 const entry = state.portfolio.get(key); if (!entry) return;
 const amt = parseFloat(String(val).replace(/[^\d.,]/g,'').replace(',','.'))||0;
 const pu = _entryPU(entry);
 entry.qty = pu && pu > 0 ? Math.max(1, Math.round(amt / pu)): Math.max(1, Math.round(amt / 1000));
 _schedulePortUpdate();
}

function removeFromPortfolio(key) { state.portfolio.delete(key); _schedulePortUpdate(); applyFilters(); }
function clearPortfolio() { state.portfolio.clear(); _schedulePortUpdate(); applyFilters(); }

function togglePortfolio() {
 const panel = document.getElementById('portPanel');
 const overlay = document.getElementById('portOverlay');
 const isOpen = panel.classList.toggle('open');
 overlay.classList.toggle('visible', isOpen);
}

/* Debounced portfolio render — prevents jank with many assets */
let _portTimer = null;
function _schedulePortUpdate() {
 if (_portTimer) clearTimeout(_portTimer);
 _portTimer = setTimeout(updatePortfolioPanel, 80);
}

function updatePortfolioPanel() {
 _portTimer = null;
 const count = state.portfolio.size;
 // Update all badges (drawer + FAB + carteira tab)
 document.getElementById('portCount').textContent = count;
 const fab = document.getElementById('portCountFab');
 if (fab) { fab.textContent = count; fab.style.display = count ? '': 'none'; }
 const cartBadge = document.getElementById('carteiraBadge');
 if (cartBadge) { cartBadge.textContent = count; cartBadge.style.display = count ? '': 'none'; }

 // If carteira tab is active, re-render it instead of the drawer
 if (state.tab === 'carteira') {
 renderCarteiraTab();
 return;
 }

 if (!count) {
 // Close drawer when portfolio emptied
 document.getElementById('portPanel').classList.remove('open');
 document.getElementById('portOverlay').classList.remove('visible');
 return;
 }
 // Auto-open drawer when first item is added
 const panel = document.getElementById('portPanel');
 if (!panel.classList.contains('open')) {
 panel.classList.add('open');
 document.getElementById('portOverlay').classList.add('visible');
 }
 renderPortfolioRows();
 updatePortfolioMeta();
 renderPortfolioPie();
 renderPortAllocBar();
}

/* ── Effective rate with linear t-slider ────────────────────────────────── */

/** Taxa/spread efetivos de uma ENTRADA da carteira (posição individual).
 * Diferente de _rowEffectiveRate, permite interpolação parcial entre comissão
 * e fee-based via entry.t ∈ [0,1]:
 * 0 = comissão pura (taxa_min)
 * 1 = fee-based puro (taxa_max)
 * Valores intermediários interpolam linearmente spread e ROA.
 * Quando o toggle global state.feeBased está ligado, força t=1.
 */
function _portEntryEffectiveRate(entry) {
 const r = entry.row;
 // Quando o cliente é fee-based globalmente, força t=1 (taxa máxima, ROA zerado).
 const t = state.feeBased ? 1: (entry.t ?? 0);

 // Handle TP bonds (no taxa_min/taxa_max split)
 const isTp = entry.source === 'tp' || (r.tipo && !r.instrumento);
 if (isTp) {
 return {
 taxa_xp: r.taxa_xp,
 spread_xp: r.spread_xp != null ? r.spread_xp: null,
 delta_anbima: r.delta_anbima ?? null,
 roa: null,
 roaLabel: '—',
 t,
 };
 }

 // For oportunidades: use the catalog rates
 const isOpport = entry.source === 'oportunidades';
 if (isOpport) {
 const minNum = r.cat_taxa_num;
 const maxNum = r.cat_taxa_num_fb ?? minNum;
 const effNum = minNum != null ? minNum + t * ((maxNum ?? minNum) - minNum): null;
 const roa0 = _parseRoa(r.cat_roa);
 return {
 taxa_xp: t === 0 ? r.cat_taxa_xp: (t === 1 ? r.cat_taxa_fb: _fmtEffRate(effNum, r)),
 spread_xp: effNum,
 delta_anbima: effNum != null && r.anbima != null ? effNum - r.anbima: null,
 roa: roa0 != null ? roa0 * (1 - t): null,
 roaLabel: roa0 != null ? (roa0 * (1-t)).toFixed(2)+'%': '—',
 t,
 };
 }

 // Credit tabs: linear interpolation between taxa_min_num and taxa_max_num
 const minNum = r.spread_xp ?? r.taxa_min_num;
 const maxNum = r.spread_xp_fb ?? r.taxa_max_num ?? minNum;
 const effNum = minNum != null ? minNum + t * ((maxNum ?? minNum) - minNum): null;
 const roa0 = _parseRoa(r.roa);

 return {
 taxa_xp: t === 0 ? (r.taxa_xp || r.taxa_min)
: (t === 1 ? (r.taxa_xp_fb || r.taxa_max)
: _fmtEffRate(effNum, r)),
 spread_xp: effNum,
 delta_anbima: effNum != null && r.anbima != null ? effNum - r.anbima
: (t === 0 ? r.delta_anbima
: (r.delta_anbima_fb ?? r.delta_anbima)),
 roa: roa0 != null ? roa0 * (1 - t): null,
 roaLabel: roa0 != null ? (roa0 * (1-t)).toFixed(2)+'%': (t > 0 ? 'fee': '—'),
 t,
 };
}
// Alias legado — remover após migrar todos os callers.
const _entryEffectiveRate = _portEntryEffectiveRate;

/** Format an interpolated numeric spread back to a rate string for display */
function _fmtEffRate(num, r) {
 if (num == null) return '—';
 const itype = r.indice_type || r.xp_type || '';
 if (itype === 'CDI%') return num.toFixed(2)+'% CDI';
 if (itype === 'CDI+') return 'CDI + '+num.toFixed(2)+'%';
 if (itype === 'IPCA') return 'IPCA + '+num.toFixed(2)+'%';
 return num.toFixed(2)+'%';
}

/** Estimate effective P.U. using modified-duration approximation.
 * pu_eff ≈ pu_anbima × (1 − dur_years × delta / 100)
 * delta = effective_spread − anbima_taxa
 */
function _entryPU(entry) {
 const r = entry.row;
 const pu0 = r.pu || r.cat_pu;
 if (!pu0 || pu0 <= 0) return null;

 const eff = _entryEffectiveRate(entry);
 const delta = eff.delta_anbima;
 if (delta == null) return pu0;

 const durYrs = r.dur != null ? r.dur / 252: (r.duration ?? 0);
 if (!durYrs) return pu0;

 const puEff = pu0 * (1 - durYrs * delta / 100);
 return puEff > 0 ? puEff: pu0;
}

/** Compute total R$ value from qty × pu_eff (falls back to qty×1000 if no PU) */
function _entryAmount(entry) {
 const pu = _entryPU(entry);
 const qty = entry.qty ?? 1;
 return pu ? qty * pu: qty * 1000;
}

function renderPortfolioRows() {
 // Conglomerate concentration warnings
 const congloCount = {};
 state.portfolio.forEach(entry => {
 const c = _conglomerate(entry.row);
 if (c) congloCount[c.grp] = (congloCount[c.grp]||0)+1;
 });
 const congloWarnings = Object.entries(congloCount).filter(([,n])=>n>1);

 let html = '';
 if (congloWarnings.length) {
 const msgs = congloWarnings.map(([g,n])=>`${n}x ${g}`).join(', ');
 html += `<tr class="port-warning-row"><td colspan="14">
 <span class="port-warning">! Concentração de conglomerado: ${msgs} — verifique limites de crédito</span>
</td></tr>`;
 }

 state.portfolio.forEach((entry, key) => {
 const r = entry.row;
 const eff = _entryEffectiveRate(entry);
 const puEff = _entryPU(entry);
 const amount = _entryAmount(entry);
 const qty = entry.qty ?? 1;
 const t100 = Math.round((entry.t ?? 0) * 100);

 const durYears = r.dur != null ? r.dur/252: (r.duration ?? 0);
 const roaNum = eff.roa;
 const roaRs = roaNum != null && amount ? (roaNum/100) * amount: null;

 // CDI% bonds: delta_anbima is in pp of CDI (e.g. +2 pp CDI at 10.65% CDI = +0.213pp absolute)
 // IPCA+, CDI+, PRE: delta_anbima is already in pp absolute
 const isCdiPct = (r.indice_type || r.xp_type || '').toUpperCase() === 'CDI%';
 const cdiRate = state.data?.spread_score?.meta?.cdi_rate ?? state.cdiRate;
 const deltaAbsPp = isCdiPct && eff.delta_anbima != null
 ? eff.delta_anbima * cdiRate / 100 // convert pp-CDI -> pp absolute
: eff.delta_anbima;
 const deltaRs = deltaAbsPp != null && amount && durYears
 ? (deltaAbsPp/100) * amount * durYears: null;
 const deltaColor = deltaRs == null ? '': (deltaRs >= 0 ? 'color:var(--green-lt)': 'color:var(--red-lt)');
 // Delta display: for CDI%, show pp-CDI with clarifying label
 const deltaTip = isCdiPct && eff.delta_anbima != null
 ? `CDI%: ${fmtDelta(eff.delta_anbima)} pp CDI × ${cdiRate.toFixed(2)}% CDI = ${fmtDelta(deltaAbsPp)} pp absolutas. ΔR$ usa pp absolutas × valor × dur.`
: `Δ taxa vs ANBIMA indicativa. ΔR$ = Δ × valor × duração`;
 const deltaTxt = isCdiPct && eff.delta_anbima != null
 ? `${fmtDelta(eff.delta_anbima)}<span style="font-size:8.5px;opacity:.7"> pp CDI</span>`
: fmtDelta(eff.delta_anbima);

 const conglo = _conglomerate(r);
 const congloTag = conglo ? `<span class="conglo-dot" style="background:${conglo.color}" title="Grupo ${conglo.grp}"></span>`: '';

 // Has slider range?
 const minNum = r.spread_xp ?? r.taxa_min_num ?? r.cat_taxa_num;
 const maxNum = r.spread_xp_fb ?? r.taxa_max_num ?? r.cat_taxa_num_fb ?? minNum;
 const hasSlider = minNum != null && maxNum != null && Math.abs((maxNum||0)-(minNum||0)) > 0.001;
 const sliderLabel = t100 === 0 ? 'Com.': (t100 === 100 ? 'Fee': `${t100}%`);

 // PU display
 const puHtml = puEff != null
 ? `<span class="port-pu-val" title="PU estimado pela duração: PU_ANBIMA × (1 − dur × Δtaxa/100)">R$${fmtBrl(puEff)}</span>`
: '<span style="color:var(--txt-faint)">—</span>';

 // Validation warning icon
 const warn = r._warnings?.length
 ? `<span class="port-warn-icon" title="${r._warnings.join('; ')}">!</span>`: '';

 html += `<tr>
 <td>${_instrBadge(r.instrumento||r.tipo)}</td>
 <td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;font-size:11px" title="${r.emissor||r.ativo||''}">${congloTag}${warn}${r.emissor||r.ativo||'—'}</td>
 <td class="cell-venc">${r.vencimento||'—'}</td>
 <td class="right mono" style="font-size:10px">${durYears?(+durYears).toFixed(1)+'a':'—'}</td>
 <td style="min-width:110px">
 ${hasSlider
 ? `<div class="port-slider-wrap">
 <input class="port-slider" type="range" min="0" max="100" value="${t100}"
 oninput="updatePortfolioT('${_esc(key)}',this.value)" title="0=Comissão · 100=Fee-based" />
 <span class="port-slider-lbl">${sliderLabel}</span>
 </div>`
: `<span style="font-size:9.5px;color:var(--txt-muted)">—</span>`
 }
</td>
 <td class="cell-taxa" style="font-size:10.5px">${eff.taxa_xp||'—'}</td>
 <td class="cell-delta ${eff.delta_anbima!=null?(eff.delta_anbima>=0?'d-g1':'d-r1'):''}" style="font-size:10px" title="${deltaTip}">${deltaTxt}</td>
 <td class="right" style="font-size:10.5px;color:var(--gold-lt)">${eff.roaLabel}</td>
 <td>${puHtml}</td>
 <td><input class="port-qty-input" type="number" min="1" value="${qty}"
 oninput="updatePortfolioQty('${_esc(key)}',this.value)"
 title="Quantidade de unidades (cotas/títulos)" /></td>
 <td class="right mono" style="font-size:10.5px;color:var(--txt-sec)">R$${fmtBrl(amount)}</td>
 <td class="right mono" style="font-size:10.5px;color:var(--gold-lt)">${roaRs!=null?'R$'+fmtBrl(roaRs):'—'}</td>
 <td class="right mono" style="font-size:10.5px;${deltaColor}">${deltaRs!=null?'R$'+fmtBrl(deltaRs):'—'}</td>
 <td><button class="port-remove-btn" onclick="removeFromPortfolio('${_esc(key)}')">X</button></td>
 </tr>`;
 });
 document.getElementById('portRows').innerHTML = html;
}

/** Categorise a portfolio entry by index type */
function _entryIndexCat(entry) {
 const r = entry.row;
 if (entry.source === 'tp') {
 const tipo = (r.tipo||'').toUpperCase();
 if (tipo==='NTN-B'||tipo==='NTN-C') return 'IPCA+';
 if (tipo==='LFT') return 'Pós';
 return 'Pré';
 }
 const itype = (r.indice_type||r.xp_type||'').toUpperCase();
 if (itype==='IPCA') return 'IPCA+';
 if (itype==='CDI%'||itype==='CDI+') return 'Pós';
 if (itype==='PRE') return 'Pré';
 return 'Outros';
}

function updatePortfolioMeta() {
 let totalAmt=0, totalRoa=0, totalDelta=0, totalDurAmt=0;
 const byType = {'IPCA+':0, 'Pós':0, 'Pré':0, 'Outros':0};

 state.portfolio.forEach(entry => {
 const eff = _entryEffectiveRate(entry);
 const amount = _entryAmount(entry);
 const durYears = entry.row.dur!=null ? entry.row.dur/252: (entry.row.duration??0);
 const cat = _entryIndexCat(entry);
 totalAmt += amount;
 totalDurAmt += durYears * amount;
 byType[cat] = (byType[cat]||0) + amount;
 if (eff.roa!=null) totalRoa += (eff.roa/100)*amount;
 if (eff.delta_anbima!=null && durYears) {
 const isCdi = (entry.row.indice_type||entry.row.xp_type||'').toUpperCase()==='CDI%';
 const cdi = state.data?.spread_score?.meta?.cdi_rate ?? state.cdiRate;
 const dpp = isCdi ? eff.delta_anbima * cdi / 100: eff.delta_anbima;
 totalDelta += (dpp/100)*amount*durYears;
 }
 });

 const avgDur = totalAmt ? totalDurAmt / totalAmt: 0;

 const kpis = [
 {label:'Total alocado', val:'R$'+fmtBrl(totalAmt), color:'var(--txt)'},
 {label:'ROA XP (R$/ano)', val:totalRoa?'R$'+fmtBrl(totalRoa):'—', color:'var(--gold-lt)',
 tip:'Receita anual estimada para a XP (ROA × valor). Zero para fee-based.'},
 {label:'Δ vs ANBIMA (R$)', val:totalDelta?'R$'+fmtBrl(totalDelta):'—',
 color:totalDelta>=0?'var(--green-lt)':'var(--red-lt)',
 tip:`(Taxa XP − ANBIMA indicativa) × valor × duração. CDI%: Δ pp CDI × ${(state.data?.spread_score?.meta?.cdi_rate??state.cdiRate).toFixed(2)}% CDI = pp absolutas usadas no cálculo.`},
 {label:'Ativos', val:state.portfolio.size, color:'var(--txt-sec)'},
 {label:'Dur. Média', val:avgDur.toFixed(1)+'a', color:'var(--blue-lt)',
 tip:'Duração média ponderada pelo valor alocado'},
 ];
 document.getElementById('portMeta').innerHTML = kpis.map(k =>
 `<span class="port-kpi" ${k.tip?`title="${k.tip}"`:''}><span class="port-kpi-lbl">${k.label}</span><span class="port-kpi-val" style="color:${k.color}">${k.val}</span></span>`
 ).join('');

 // Allocation chips in summary
 const pctFmt = v => totalAmt ? (v/totalAmt*100).toFixed(0)+'%': '0%';
 const chipIpca = byType['IPCA+'] ? `<span class="port-alloc-chip alloc-ipca">IPCA+ ${pctFmt(byType['IPCA+'])}</span>`: '';
 const chipCdi = byType['Pós'] ? `<span class="port-alloc-chip alloc-cdi">Pós ${pctFmt(byType['Pós'])}</span>`: '';
 const chipPre = byType['Pré'] ? `<span class="port-alloc-chip alloc-pre">Pré ${pctFmt(byType['Pré'])}</span>`: '';
 const chipOther = byType['Outros']? `<span class="port-alloc-chip alloc-other">Outros ${pctFmt(byType['Outros'])}</span>`: '';
 const chipDur = `<span class="port-alloc-chip alloc-dur" title="Duração média ponderada">Dur. ${avgDur.toFixed(1)}a</span>`;

 document.getElementById('portSummary').innerHTML =
 `<div class="port-alloc-summary">
 <div class="port-alloc-row">${chipIpca}${chipCdi}${chipPre}${chipOther}${chipDur}</div>
 <div class="port-alloc-row">
 ${kpis.map(k=>`<div class="port-sum-item" ${k.tip?`title="${k.tip}"`:''}><span class="port-kpi-lbl">${k.label}</span><span class="port-kpi-val" style="color:${k.color};font-size:12px;font-weight:700">${k.val}</span></div>`).join('')}
 </div>
 </div>`;
}

/** Render the 4px rainbow allocation bar at the top of the drawer */
function renderPortAllocBar() {
 const el = document.getElementById('portAllocBar'); if(!el) return;
 let totalAmt=0; const byType={'IPCA+':0,'Pós':0,'Pré':0,'Outros':0};
 state.portfolio.forEach(entry=>{
 const amt=_entryAmount(entry); totalAmt+=amt;
 const cat=_entryIndexCat(entry); byType[cat]=(byType[cat]||0)+amt;
 });
 if(!totalAmt){el.innerHTML='';return;}
 const colors={'IPCA+':'#34d399','Pós':'#60a5fa','Pré':'#e0bc64','Outros':'#a78bfa'};
 el.innerHTML=Object.entries(byType).filter(([,v])=>v>0).map(([k,v])=>
 `<div class="port-alloc-seg" style="width:${(v/totalAmt*100).toFixed(1)}%;background:${colors[k]}" title="${k}: ${(v/totalAmt*100).toFixed(0)}%"></div>`
 ).join('');
}

/* ── PORTFOLIO PIE CHART ─────────────────────────────────────────────────── */
const PIE_PALETTE = [
 '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
 '#06b6d4','#f97316','#84cc16','#ec4899','#6366f1',
];

function renderPortfolioPie() {
 const el = document.getElementById('portPie'); if (!el) return;

 // Aggregate by setor
 const bySetor = {};
 let total = 0;
 state.portfolio.forEach(entry => {
 const setor = entry.row.setor || (entry.row.tipo ? `TP: ${entry.row.tipo}`: 'Sem setor');
 const amount = _entryAmount(entry);
 bySetor[setor] = (bySetor[setor]||0) + amount;
 total += amount;
 });
 if (!total) { el.innerHTML=''; return; }

 const slices = Object.entries(bySetor)
.sort((a,b)=>b[1]-a[1])
.map(([name,val],i)=>({name,val,pct:val/total,color:PIE_PALETTE[i%PIE_PALETTE.length]}));

 const SIZE=80, CX=40, CY=40, R=34;
 let angle=-Math.PI/2;

 const paths = slices.map(s=>{
 const a0=angle, a1=angle+s.pct*2*Math.PI;
 const x0=CX+R*Math.cos(a0), y0=CY+R*Math.sin(a0);
 const x1=CX+R*Math.cos(a1), y1=CY+R*Math.sin(a1);
 const large=s.pct>0.5?1:0;
 angle=a1;
 return `<path d="M${CX},${CY} L${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large},1 ${x1.toFixed(2)},${y1.toFixed(2)} Z"
 fill="${s.color}" opacity="0.85" stroke="var(--bg2)" stroke-width="1">
 <title>${s.name}: R$${fmtBrl(s.val)} (${(s.pct*100).toFixed(1)}%)</title></path>`;
 }).join('');

 const legend = slices.map(s=>
 `<div class="pie-legend-item">
 <span class="pie-dot" style="background:${s.color}"></span>
 <span class="pie-name">${s.name}</span>
 <span class="pie-pct">${(s.pct*100).toFixed(1)}%</span>
 </div>`
 ).join('');

 el.innerHTML = `
 <div class="pie-wrap">
 <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${paths}</svg>
 <div class="pie-legend">${legend}</div>
 </div>`;
}

/* ── CARTEIRA TAB (full-page portfolio view) ─────────────────────────────── */
function renderCarteiraTab() {
 const el = document.getElementById('carteiraContainer');
 if (!el) return;

 if (!state.portfolio.size) {
 el.innerHTML = `<div class="carteira-empty">
 <div style="font-size:36px;margin-bottom:12px;opacity:.3"></div>
 <p style="font-size:13px;color:var(--txt-sec);font-weight:500">Carteira vazia</p>
 <p style="font-size:11px;color:var(--txt-muted);margin-top:4px">Adicione ativos usando o botão <strong>+</strong> em qualquer aba</p>
 </div>`;
 return;
 }

 // ── Compute summary ──────────────────────────────────────────────────────
 let totalAmt=0, totalRoa=0, totalDelta=0, totalDurAmt=0;
 const byType={'IPCA+':0,'Pós':0,'Pré':0,'Outros':0};
 const bySetor={};
 const cdiRate = state.data?.spread_score?.meta?.cdi_rate ?? state.cdiRate;

 state.portfolio.forEach(entry => {
 const eff = _entryEffectiveRate(entry);
 const amt = _entryAmount(entry);
 const dur = entry.row.dur!=null ? entry.row.dur/252: (entry.row.duration??0);
 const cat = _entryIndexCat(entry);
 const setor = entry.row.setor || (entry.row.tipo ? `TP: ${entry.row.tipo}`: 'Sem setor');
 totalAmt += amt;
 totalDurAmt += dur * amt;
 byType[cat] = (byType[cat]||0) + amt;
 bySetor[setor]= (bySetor[setor]||0) + amt;
 if (eff.roa!=null) totalRoa += (eff.roa/100)*amt;
 if (eff.delta_anbima!=null && dur) {
 const isCdi = (entry.row.indice_type||entry.row.xp_type||'').toUpperCase()==='CDI%';
 const dpp = isCdi ? eff.delta_anbima * cdiRate/100: eff.delta_anbima;
 totalDelta += (dpp/100)*amt*dur;
 }
 });
 const avgDur = totalAmt ? totalDurAmt/totalAmt: 0;
 const pctOf = v => totalAmt ? (v/totalAmt*100).toFixed(0)+'%': '0%';

 // ── Allocation bar ───────────────────────────────────────────────────────
 const ACOLORS={'IPCA+':'#34d399','Pós':'#60a5fa','Pré':'#e0bc64','Outros':'#a78bfa'};
 const allocBar = Object.entries(byType).filter(([,v])=>v>0).map(([k,v])=>
 `<div style="width:${(v/totalAmt*100).toFixed(1)}%;background:${ACOLORS[k]};height:6px" title="${k} ${pctOf(v)}"></div>`
 ).join('');

 // ── Allocation chips ─────────────────────────────────────────────────────
 const chips = Object.entries(byType).filter(([,v])=>v>0).map(([k,v])=>
 `<span class="port-alloc-chip alloc-${k==='IPCA+'?'ipca':k==='Pós'?'cdi':k==='Pré'?'pre':'other'}">${k} ${pctOf(v)}</span>`
 ).join('') + `<span class="port-alloc-chip alloc-dur">Dur. ${avgDur.toFixed(1)}a</span>`;

 // ── Sector pie (SVG) ─────────────────────────────────────────────────────
 const slices = Object.entries(bySetor).sort((a,b)=>b[1]-a[1])
.map(([name,val],i)=>({name,val,pct:val/totalAmt,color:PIE_PALETTE[i%PIE_PALETTE.length]}));
 const SIZE=120, CX=60, CY=60, R=50;
 let ang=-Math.PI/2;
 const piePaths = slices.map(s=>{
 const a0=ang, a1=ang+s.pct*2*Math.PI;
 const x0=CX+R*Math.cos(a0),y0=CY+R*Math.sin(a0);
 const x1=CX+R*Math.cos(a1),y1=CY+R*Math.sin(a1);
 const lg=s.pct>0.5?1:0; ang=a1;
 return `<path d="M${CX},${CY} L${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${lg},1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${s.color}" opacity="0.85" stroke="var(--bg2)" stroke-width="1.5"><title>${s.name}: R$${fmtBrl(s.val)} (${(s.pct*100).toFixed(1)}%)</title></path>`;
 }).join('');
 const pieLegend = slices.slice(0,10).map(s=>
 `<div class="pie-legend-item"><span class="pie-dot" style="background:${s.color}"></span><span class="pie-name">${s.name}</span><span class="pie-pct">${(s.pct*100).toFixed(1)}%</span></div>`
 ).join('');

 // ── Portfolio rows (re-use logic from renderPortfolioRows) ───────────────
 const congloCount={};
 state.portfolio.forEach(e=>{const c=_conglomerate(e.row);if(c)congloCount[c.grp]=(congloCount[c.grp]||0)+1;});
 const congloWarnings=Object.entries(congloCount).filter(([,n])=>n>1);
 let rowsHtml='';
 if(congloWarnings.length){
 const msgs=congloWarnings.map(([g,n])=>`${n}× ${g}`).join(', ');
 rowsHtml+=`<tr class="port-warning-row"><td colspan="14"><span class="port-warning">! Concentração: ${msgs}</span></td></tr>`;
 }

 state.portfolio.forEach((entry,key)=>{
 const r=entry.row, eff=_entryEffectiveRate(entry);
 const puEff=_entryPU(entry), amount=_entryAmount(entry);
 const qty=entry.qty??1, t100=Math.round((entry.t??0)*100);
 const dur=r.dur!=null?r.dur/252:(r.duration??0);
 const roaRs=eff.roa!=null&&amount?(eff.roa/100)*amount:null;
 const isCdiPct=(r.indice_type||r.xp_type||'').toUpperCase()==='CDI%';
 const dpp=isCdiPct&&eff.delta_anbima!=null?eff.delta_anbima*cdiRate/100:eff.delta_anbima;
 const deltaRs=dpp!=null&&amount&&dur?(dpp/100)*amount*dur:null;
 const dCol=deltaRs==null?'':(deltaRs>=0?'color:var(--green-lt)':'color:var(--red-lt)');
 const conglo=_conglomerate(r);
 const congloTag=conglo?`<span class="conglo-dot" style="background:${conglo.color}" title="Grupo ${conglo.grp}"></span>`:'';
 const minNum=r.spread_xp??r.taxa_min_num??r.cat_taxa_num;
 const maxNum=r.spread_xp_fb??r.taxa_max_num??r.cat_taxa_num_fb??minNum;
 const hasSlider=minNum!=null&&maxNum!=null&&Math.abs((maxNum||0)-(minNum||0))>0.001;
 const sliderLbl=t100===0?'Com.':(t100===100?'Fee':`${t100}%`);
 const deltaTxt=isCdiPct&&eff.delta_anbima!=null
 ?`${fmtDelta(eff.delta_anbima)}<span style="font-size:8px;opacity:.7"> ppCDI</span>`
:fmtDelta(eff.delta_anbima);
 const deltaTip2=isCdiPct&&eff.delta_anbima!=null
 ?`${fmtDelta(eff.delta_anbima)} pp CDI × CDI ${cdiRate.toFixed(1)}% = ${fmtDelta(dpp)} pp absolutas`
:'Δ taxa vs ANBIMA';
 rowsHtml+=`<tr>
 <td>${_instrBadge(r.instrumento||r.tipo)}</td>
 <td style="max-width:160px;font-size:11px" title="${r.emissor||r.ativo||''}">${congloTag}${_rjBadge(r)}${r.emissor||r.ativo||'—'}</td>
 <td class="cell-venc">${r.vencimento||'—'}</td>
 <td class="right mono" style="font-size:10px">${dur?(+dur).toFixed(1)+'a':'—'}</td>
 <td style="min-width:110px">${hasSlider?`<div class="port-slider-wrap"><input class="port-slider" type="range" min="0" max="100" value="${t100}" oninput="updatePortfolioT('${_esc(key)}',this.value)"/><span class="port-slider-lbl">${sliderLbl}</span></div>`:'<span style="font-size:9.5px;color:var(--txt-muted)">—</span>'}</td>
 <td class="cell-taxa" style="font-size:10.5px">${eff.taxa_xp||'—'}</td>
 <td class="cell-delta ${eff.delta_anbima!=null?(eff.delta_anbima>=0?'d-g1':'d-r1'):''}" style="font-size:10px" title="${deltaTip2}">${deltaTxt}</td>
 <td class="right" style="font-size:10.5px;color:var(--gold-lt)">${eff.roaLabel}</td>
 <td>${puEff!=null?`<span class="port-pu-val">R$${fmtBrl(puEff)}</span>`:'—'}</td>
 <td><input class="port-qty-input" type="number" min="1" value="${qty}" oninput="updatePortfolioQty('${_esc(key)}',this.value)"/></td>
 <td class="right mono" style="font-size:10.5px;color:var(--txt-sec)">R$${fmtBrl(amount)}</td>
 <td class="right mono" style="font-size:10.5px;color:var(--gold-lt)">${roaRs!=null?'R$'+fmtBrl(roaRs):'—'}</td>
 <td class="right mono" style="font-size:10.5px;${dCol}">${deltaRs!=null?'R$'+fmtBrl(deltaRs):'—'}</td>
 <td><button class="port-remove-btn" onclick="removeFromPortfolio('${_esc(key)}')">X</button></td>
 </tr>`;
 });

 // ── CDI rate control ─────────────────────────────────────────────────────
 const cdiCtrl = `<label class="carteira-cdi-ctrl" title="Taxa CDI usada para converter Δ CDI% em pp absolutas no cálculo financeiro">
 CDI atual <input type="number" step="0.01" min="0" max="30" value="${cdiRate.toFixed(2)}"
 oninput="state.cdiRate=parseFloat(this.value)||10.65; renderCarteiraTab()" style="width:60px">% a.a.
 </label>`;

 el.innerHTML = `
 <div class="carteira-tab-wrap">
 <div class="carteira-header">
 <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
 <span style="font-size:15px;font-weight:700;color:var(--txt)">Carteira</span>
 <span class="port-badge">${state.portfolio.size}</span>
 ${chips}
 </div>
 <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
 ${cdiCtrl}
 <button class="btn-ghost" onclick="clearPortfolio()">Limpar</button>
 </div>
 </div>
 <div class="carteira-alloc-bar">${allocBar}</div>
 <div class="carteira-kpis">
 <div class="carteira-kpi"><span class="port-kpi-lbl">Total alocado</span><span class="port-kpi-val" style="color:var(--txt)">R$${fmtBrl(totalAmt)}</span></div>
 <div class="carteira-kpi" title="Receita anual estimada para a XP"><span class="port-kpi-lbl">ROA XP (R$/ano)</span><span class="port-kpi-val" style="color:var(--gold-lt)">${totalRoa?'R$'+fmtBrl(totalRoa):'—'}</span></div>
 <div class="carteira-kpi" title="(Taxa XP − ANBIMA) × valor × dur. CDI%: Δ pp CDI × taxa CDI"><span class="port-kpi-lbl">Δ vs ANBIMA (R$)</span><span class="port-kpi-val" style="color:${totalDelta>=0?'var(--green-lt)':'var(--red-lt)'}">${totalDelta?'R$'+fmtBrl(totalDelta):'—'}</span></div>
 <div class="carteira-kpi"><span class="port-kpi-lbl">Ativos</span><span class="port-kpi-val" style="color:var(--txt-sec)">${state.portfolio.size}</span></div>
 <div class="carteira-kpi" title="Duração média ponderada pelo valor"><span class="port-kpi-lbl">Dur. Média</span><span class="port-kpi-val" style="color:var(--blue-lt)">${avgDur.toFixed(1)}a</span></div>
 </div>
 <div class="carteira-body">
 <div class="carteira-table-wrap">
 <table class="port-table">
 <thead><tr>
 <th>Tipo</th><th>Emissor</th><th>Vcto</th><th>Dur.</th>
 <th>Spread</th><th>Taxa efetiva</th>
 <th title="Δ taxa vs ANBIMA. CDI%: em pp CDI (ver tooltip por linha)">Δ ANBIMA</th>
 <th>ROA E.A.</th><th>PU Est.</th>
 <th style="min-width:80px">Qtd.</th>
 <th style="min-width:110px">Valor (R$)</th>
 <th>ROA (R$/ano)</th><th>Δ Spread (R$)</th><th></th>
 </tr></thead>
 <tbody>${rowsHtml}</tbody>
 </table>
 </div>
 <div class="carteira-pie-wrap">
 <div style="font-size:10px;font-weight:600;color:var(--txt-muted);letter-spacing:.07em;text-transform:uppercase;margin-bottom:8px">Por Setor</div>
 <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${piePaths}</svg>
 <div class="pie-legend" style="margin-top:8px">${pieLegend}</div>
 </div>
 </div>
 </div>`;
}

/* ── COLOR HELPERS ───────────────────────────────────────────────────────── */
function deltaIpcaClass(v){
 if(v==null)return''; if(v<-2.0)return'd-r3'; if(v<-1.5)return'd-r2';
 if(v<-1.0)return'd-r1'; if(v<-0.5)return'd-o'; if(v<0)return'd-a';
 if(v<0.5)return'd-g1'; return'd-g2';
}
function deltaCdiClass(v){
 if(v==null)return''; if(v<-10)return'd-r3'; if(v<-7)return'd-r2';
 if(v<-5)return'd-r1'; if(v<-3)return'd-o'; if(v<0)return'd-a';
 if(v<1)return'd-g1'; return'd-g2';
}
function scoreColorClass(v){
 if(v==null||isNaN(v))return's-na';
 if(v>=8.5)return's-5'; if(v>=7.5)return's-4'; if(v>=6.5)return's-3';
 if(v>=5.0)return's-2'; return's-1';
}
function ratingBadge(r){
 if(!r||r==='nan'||r==='-')return'<span style="color:var(--txt-dim)">—</span>';
 const up=r.toUpperCase();
 let cls='rating-a';
 if(up.includes('AAA'))cls='rating-aaa';
 else if(up.includes('AA'))cls='rating-aa';
 else if(up.includes('BBB'))cls='rating-bbb';
 else if(up.includes('BB'))cls='rating-bb';
 else if(up.includes('B'))cls='rating-b';
 return `<span class="badge-rating ${cls}">${r}</span>`;
}
function isentoHtml(v){
 if(v==='S')return'<span class="pill-isento-s">S</span>';
 if(v==='N')return'<span class="pill-isento-n">N</span>';
 return'<span style="color:var(--txt-faint)">—</span>';
}
function indDot(v){
 if(v==null||v<=0)return`<span class="ind-dot ind-na">—</span>`;
 if(v>=4.9)return`<span class="ind-dot ind-5">5%</span>`;
 return`<span class="ind-dot ind-2">${v}%</span>`;
}
function alocBar(v){
 if(v==null)return'<span style="color:var(--txt-dim)">—</span>';
 const pct=Math.min(100,(v/5)*100);
 return`<div class="aloc-bar"><div class="aloc-track"><div class="aloc-fill" style="width:${pct}%"></div></div><span class="aloc-val">${v}%</span></div>`;
}

/* ── FORMAT HELPERS ──────────────────────────────────────────────────────── */
function fmt2(v){ if(v==null||isNaN(v))return'<span style="color:var(--txt-dim)">—</span>'; return Number(v).toFixed(2); }
function fmt4(v){ if(v==null||isNaN(v))return'<span style="color:var(--txt-dim)">—</span>'; return Number(v).toFixed(4); }
function fmtDelta(v){ if(v==null||isNaN(v))return'—'; return(v>0?'+':'')+Number(v).toFixed(4); }
function fmtNet(v){ if(v==null)return'—'; const n=Number(v); if(isNaN(n))return v; if(Math.abs(n)>=1e9)return(n/1e9).toFixed(1)+'B'; if(Math.abs(n)>=1e6)return(n/1e6).toFixed(1)+'M'; if(Math.abs(n)>=1e3)return(n/1e3).toFixed(0)+'K'; return n.toFixed(0); }
function fmtBrl(v){ if(v==null||isNaN(v))return'—'; return Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtVol(v){ if(!v||v<=0)return'—'; if(v>=1e6)return'R$'+(v/1e6).toFixed(1)+'M'; if(v>=1e3)return'R$'+(v/1e3).toFixed(0)+'K'; return'R$'+v.toFixed(0); }

/* ── POSIÇÃO TAB ─────────────────────────────────────────────────────────── */
const state_posicao = {
 positions: [],
 view: 'curva',
 filters: { minDesagioR: 0, maxPayback: null, onlySwap: false, onlyAgio: false },
 expandedKey: null, // key of currently expanded row
 selectedAlts: {}, // { rowKey: [tickerStr,...] } user-added alts for comparison
};

/* ── POSIÇÃO FILTERS ────────────────────────────────────────────────────── */
function applyPosicaoFilters() {
 const minD = parseFloat(document.getElementById('pfMinDesagio')?.value);
 const maxP = parseFloat(document.getElementById('pfMaxPayback')?.value);
 state_posicao.filters = {
 minDesagioR: isNaN(minD) ? 0: minD,
 maxPayback: isNaN(maxP) ? null: maxP,
 onlySwap: document.getElementById('pfOnlySwap')?.checked || false,
 onlyAgio: document.getElementById('pfOnlyAgio')?.checked || false,
 };
 renderPosicaoAnalysis();
}
function clearPosicaoFilters() {
 state_posicao.filters = { minDesagioR: 0, maxPayback: null, onlySwap: false, onlyAgio: false };
 renderPosicaoAnalysis();
}
function _applyPosicaoFilters(rows) {
 const f = state_posicao.filters;
 return rows.filter(r => {
 if (f.minDesagioR > 0 && (r.desagio == null || r.desagio < f.minDesagioR)) return false;
 if (f.maxPayback != null && (r.payback == null || r.payback > f.maxPayback)) return false;
 if (f.onlySwap && (r.payback == null || r.payback > 5)) return false;
 if (f.onlyAgio && !(r.rateMkt != null && r.rateComp != null && r.rateMkt < r.rateComp - 0.005)) return false;
 return true;
 });
}
function _renderPosicaoFilterBar(total, shown) {
 const f = state_posicao.filters;
 const filtered = shown < total;
 return `<div class="posicao-filter-bar">
 <span class="posicao-filter-label">Filtros</span>
 <label class="posicao-filter-item">
 Deságio mín. R$
 <input type="number" id="pfMinDesagio" value="${f.minDesagioR||''}" placeholder="—" min="0" step="500" class="posicao-filter-input">
 </label>
 <label class="posicao-filter-item">
 Payback máx.
 <select id="pfMaxPayback" class="posicao-filter-input">
 <option value="">Todos</option>
 <option value="1" ${f.maxPayback===1?'selected':''}>1 ano</option>
 <option value="2" ${f.maxPayback===2?'selected':''}>2 anos</option>
 <option value="3" ${f.maxPayback===3?'selected':''}>3 anos</option>
 <option value="5" ${f.maxPayback===5?'selected':''}>5 anos</option>
 </select>
 </label>
 <label class="posicao-filter-chk">
 <input type="checkbox" id="pfOnlySwap" ${f.onlySwap?'checked':''}>Apenas com troca viável
 </label>
 <label class="posicao-filter-chk">
 <input type="checkbox" id="pfOnlyAgio" ${f.onlyAgio?'checked':''}>Apenas com ágio
 </label>
 <button class="btn-sm" onclick="applyPosicaoFilters()">Aplicar</button>
 <button class="btn-sm btn-outline" onclick="clearPosicaoFilters()">Limpar</button>
 ${filtered ? `<span style="font-size:10px;color:var(--gold-lt);margin-left:6px">${shown} de ${total} ativos</span>`: ''}

 <!-- Toggle: filtro de banda de score na sugestão de troca -->
 <div class="alts-band-toggle" title="Política de banda de score na sugestão de troca. Estrito = só upgrade. Mesma banda = aceita mesma ou superior. Permissivo = aceita 1 banda abaixo (com aviso).">
 <span class="alts-band-lbl">Sugestão por banda:</span>
 <button class="alts-band-btn ${_altsBandMode()==='strict'?'active':''}" onclick="setAltsBandMode('strict')" title="Só sugere alts com banda igual ou superior. Default institucional.">Estrito</button>
 <button class="alts-band-btn ${_altsBandMode()==='equal'?'active':''}" onclick="setAltsBandMode('equal')" title="Aceita alts da mesma banda do atual ou superior.">= Mesma</button>
 <button class="alts-band-btn ${_altsBandMode()==='loose'?'active':''}" onclick="setAltsBandMode('loose')" title="Aceita 1 banda abaixo, marcado com aviso visual.">! Permissivo</button>
 </div>
 </div>`;
}

/* ── POSIÇÃO ROW EXPAND ─────────────────────────────────────────────────── */
function togglePosicaoExpand(key) {
 state_posicao.expandedKey = state_posicao.expandedKey === key ? null: key;
 renderPosicaoAnalysis();
}

/** Search catalog assets for alternative comparison, renders into inline dropdown */
function searchPosicaoAlt(inputEl, rowKey) {
 const q = (inputEl.value || '').toLowerCase().trim();
 const el = document.getElementById('pfAltDrop_' + rowKey);
 if (!el) return;
 if (!q) { el.innerHTML = ''; el.style.display='none'; return; }
 const sources = [
...(state.data?.spread_score?.ipca || []),
...(state.data?.spread_score?.cdi_plus || []),
...(state.data?.spread_score?.cdi_pct || []),
...(state.data?.spread_score?.pre || []),
 ];
 const matches = sources.filter(r =>
 (r.emissor||'').toLowerCase().includes(q) || (r.ticker||'').toLowerCase().includes(q)
 ).slice(0, 7);
 if (!matches.length) { el.innerHTML='<div style="padding:6px 10px;color:var(--txt-dim);font-size:10px">Nenhum resultado</div>'; el.style.display='block'; return; }
 el.innerHTML = matches.map(r => {
 const eff = _effectiveRate(r);
 return `<div class="pfalt-result" onclick="addPosicaoAlt('${_esc(rowKey)}','${_esc(r.ticker||'')}')">
 ${_instrBadge(r.instrumento)}
 <span style="flex:1;font-size:10px">${r.emissor||r.ticker||'?'}</span>
 <span class="cell-taxa" style="font-size:10px">${eff.taxa_xp||'?'}</span>
 <span class="cell-venc" style="font-size:9.5px">${r.vencimento||'?'}</span>
 </div>`;
 }).join('');
 el.style.display = 'block';
}
function addPosicaoAlt(rowKey, ticker) {
 if (!state_posicao.selectedAlts[rowKey]) state_posicao.selectedAlts[rowKey] = [];
 if (!state_posicao.selectedAlts[rowKey].includes(ticker)) {
 state_posicao.selectedAlts[rowKey] = [...state_posicao.selectedAlts[rowKey], ticker].slice(-3); // max 3
 }
 // Close dropdown
 const drop = document.getElementById('pfAltDrop_' + rowKey);
 if (drop) { drop.innerHTML=''; drop.style.display='none'; }
 const inp = document.getElementById('pfAltInp_' + rowKey);
 if (inp) inp.value = '';
 renderPosicaoAnalysis();
}
function removePosicaoAlt(rowKey, ticker) {
 if (state_posicao.selectedAlts[rowKey]) {
 state_posicao.selectedAlts[rowKey] = state_posicao.selectedAlts[rowKey].filter(t=>t!==ticker);
 }
 renderPosicaoAnalysis();
}

/* ── COUPON DETECTION ───────────────────────────────────────────────────── */
function _couponInfo(pos) {
 const n = (pos.nome || pos.instrumento || '').toUpperCase();
 if (/NTN-B/.test(n)) return { label:'NTN-B', note:'Paga cupom semestral de 6% a.a. real (IPCA+). Gráfico usa modelo bullet — breakeven real pode ser MENOR: cupons recebidos antes do breakeven já compensam parte do deságio.' };
 if (/NTN-F/.test(n)) return { label:'NTN-F', note:'Paga cupom semestral de 10% a.a. pré-fixado.' };
 if (/NTN-C/.test(n)) return { label:'NTN-C', note:'Paga cupom semestral de 6% a.a. real (IGPM+).' };
 return null;
}

/* ── PAYBACK CHART (per expanded row) ──────────────────────────────────── */
function _buildPaybackChart(enrichedRow, extraAlts) {
 const { pos, alts, desagio, rateComp, rateMkt } = enrichedRow;
 const Vc = pos.bruto_curva;
 const Vv = pos.bruto_venda ?? pos.bruto_curva;
 const rHold = rateComp;

 if (!Vc || !rHold) return `<p style="color:var(--txt-dim);font-size:10.5px;padding:12px 0">Sem bruto curva ou taxa contratada — dados insuficientes para gráfico.</p>`;

 // Merge auto alts + user-selected alts (dedup)
 const autoAlts = alts.slice(0, 3);
 const extraRows = (extraAlts || []).map(ticker => {
 const sources = [
...(state.data?.spread_score?.ipca || []),
...(state.data?.spread_score?.cdi_plus || []),
...(state.data?.spread_score?.cdi_pct || []),
...(state.data?.spread_score?.pre || []),
 ];
 return sources.find(r => (r.ticker||'').toUpperCase() === ticker.toUpperCase()) || null;
 }).filter(Boolean);

 // Merge, dedup by ticker
 const seen = new Set();
 const compareAlts = [...autoAlts,...extraRows].filter(r => {
 const t = r.ticker||''; if (seen.has(t)) return false; seen.add(t); return true;
 }).slice(0,4).map(a => {
 const r = _effectiveRate(a).spread_xp;
 return r != null ? { label:(a.emissor||a.ticker||'?').substring(0,14), ticker:a.ticker||'', r }: null;
 }).filter(Boolean);

 if (!compareAlts.length) return `<p style="color:var(--txt-dim);font-size:10.5px;padding:12px 0">Sem alternativas no catálogo para comparação de payback.</p>`;

 // Time horizon
 const vencDate = _parseVenc(pos.vencimento);
 const yearsLeft = vencDate ? Math.max(0.5, (vencDate - Date.now()) / (365.25*24*3600*1000)): 5;
 const horizon = Math.min(10, yearsLeft + 0.5);
 const STEPS = 80;
 const dt = horizon / STEPS;
 const times = Array.from({length:STEPS+1},(_,i)=>i*dt);

 const vHold = times.map(t =>Vc * Math.pow(1 + rHold/100, t));

 const altSeries = compareAlts.map(a => {
 const values = times.map(t =>Vv * Math.pow(1 + a.r/100, t));
 const breakeven = (a.r > rHold && Vc >Vv)
 ? Math.log(Vc/Vv) / Math.log((1+a.r/100)/(1+rHold/100))
: null;
 return {...a, values, breakeven };
 });

 const allVals = [...vHold,...altSeries.flatMap(s=>s.values)];
 const rawYMin = Math.min(...allVals), rawYMax = Math.max(...allVals);
 const yPad = (rawYMax - rawYMin) * 0.06 || 1000;
 const yMin = rawYMin - yPad, yMax = rawYMax + yPad;
 const yRange = yMax - yMin || 1;

 const W=640, H=195, PAD={l:66,r:14,t:22,b:34};
 const plotW = W-PAD.l-PAD.r, plotH = H-PAD.t-PAD.b;
 const px = t =>PAD.l + t/horizon * plotW;
 const py = v =>PAD.t + plotH - (v-yMin)/yRange*plotH;

 // Grid
 let g='', xl='', yl='';
 const yMag = Math.pow(10, Math.floor(Math.log10(yRange))-1);
 const yStep = Math.max(yMag, Math.ceil(yRange/5/yMag)*yMag);
 for (let y=Math.ceil(yMin/yStep)*yStep; y<=yMax; y+=yStep) {
 const cy=py(y).toFixed(1);
 g += `<line x1="${PAD.l}" y1="${cy}" x2="${W-PAD.r}" y2="${cy}" stroke="var(--border)" stroke-width="0.5"/>`;
 yl += `<text x="${PAD.l-4}" y="${(+cy+3).toFixed(1)}" fill="var(--txt-dim)" font-size="8" text-anchor="end">R$${fmtNet(y)}</text>`;
 }
 for (let yr=0; yr<=Math.ceil(horizon); yr++) {
 if (yr > horizon) continue;
 const cx=px(yr).toFixed(1);
 g += `<line x1="${cx}" y1="${PAD.t}" x2="${cx}" y2="${H-PAD.b}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>`;
 xl += `<text x="${cx}" y="${(H-PAD.b+12).toFixed(1)}" fill="var(--txt-dim)" font-size="8.5" text-anchor="middle">${yr===0?'Hoje':yr+'a'}</text>`;
 }
 if (yearsLeft <= horizon) {
 const mx=px(yearsLeft).toFixed(1);
 g += `<line x1="${mx}" y1="${PAD.t}" x2="${mx}" y2="${H-PAD.b}" stroke="var(--gold-dim)" stroke-width="1" stroke-dasharray="4,2"/>`;
 xl += `<text x="${mx}" y="${(H-PAD.b+12).toFixed(1)}" fill="var(--gold-lt)" font-size="8" text-anchor="middle">Vcto</text>`;
 }

 // Hold path (dashed)
 const holdPath = times.map((t,i)=>`${i===0?'M':'L'}${px(t).toFixed(1)},${py(vHold[i]).toFixed(1)}`).join('');

 const COLORS = ['#34d399','#60a5fa','#fbbf24','#c084fc'];
 let paths='', markers='', legend='';
 altSeries.forEach((s,idx) => {
 const col = COLORS[idx];
 const path = times.map((t,i)=>`${i===0?'M':'L'}${px(t).toFixed(1)},${py(s.values[i]).toFixed(1)}`).join('');
 paths += `<path d="${path}" stroke="${col}" stroke-width="1.8" fill="none"/>`;
 if (s.breakeven != null && s.breakeven >= 0 && s.breakeven <= horizon) {
 const bx=px(s.breakeven).toFixed(1);
 const bv=Vv*Math.pow(1+s.r/100,s.breakeven);
 const by=py(bv).toFixed(1);
 markers += `<circle cx="${bx}" cy="${by}" r="5" fill="${col}" stroke="var(--bg2)" stroke-width="1.5"/>`;
 markers += `<line x1="${bx}" y1="${PAD.t}" x2="${bx}" y2="${H-PAD.b}" stroke="${col}" stroke-width="0.75" stroke-dasharray="3,3" opacity="0.5"/>`;
 markers += `<text x="${bx}" y="${(+by-8).toFixed(1)}" fill="${col}" font-size="8.5" text-anchor="middle" font-weight="600">${s.breakeven.toFixed(1)}a</text>`;
 }
 legend += `<g transform="translate(${idx*155},0)">
 <line x1="0" y1="9" x2="16" y2="9" stroke="${col}" stroke-width="2"/>
 <text x="20" y="13" fill="var(--txt-muted)" font-size="8.5">${s.label} (${s.r.toFixed(2)}%)</text>
 </g>`;
 });
 const holdLeg = `<g transform="translate(${altSeries.length*155},0)">
 <line x1="0" y1="9" x2="16" y2="9" stroke="var(--txt-sec)" stroke-width="1.5" stroke-dasharray="5,2"/>
 <text x="20" y="13" fill="var(--txt-muted)" font-size="8.5">Manter ${rHold.toFixed(2)}%</text>
 </g>`;

 return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px">
 <g transform="translate(${PAD.l},0)">${legend}${holdLeg}</g>
 ${g}${yl}${xl}
 <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H-PAD.b}" stroke="var(--border-lt)" stroke-width="1"/>
 <line x1="${PAD.l}" y1="${H-PAD.b}" x2="${W-PAD.r}" y2="${H-PAD.b}" stroke="var(--border-lt)" stroke-width="1"/>
 <path d="${holdPath}" stroke="var(--txt-sec)" stroke-width="1.5" stroke-dasharray="6,3" fill="none"/>
 ${paths}${markers}
 </svg>`;
}

/** Build the full expanded sub-row content */
function _buildExpandedContent(enrichedRow, colSpan) {
 const rowKey = enrichedRow.pos.codigo || enrichedRow.pos.ticker || enrichedRow.pos.nome || '';
 const coupon = _couponInfo(enrichedRow.pos);
 const extraAlts = state_posicao.selectedAlts[rowKey] || [];
 const chartSvg = _buildPaybackChart(enrichedRow, extraAlts);

 const refScore = enrichedRow.alts._refScore;
 const refBand = enrichedRow.alts._refBand || 'S0';
 const refBandBadge = `<span style="font-size:9.5px;color:var(--txt-muted)">Atual:</span> ${_scoreBandBadge(refBand, {short:true, tip:`Score atual ${refScore!=null?refScore.toFixed(2):'?'} · ${refBand}`})}`;

 const altsHtml = enrichedRow.alts.slice(0,5).map((a,i) => {
 const eff = _effectiveRate(a);
 const pb = _swapPayback(enrichedRow.pos, eff.spread_xp);
 const bc = a._bandCheck || _bandCheck(refScore, a.score_total);
 const trend = bc.deltaBand > 0 ? `<span style="color:var(--green-lt);font-size:9.5px" title="${bc.deltaBand} banda${bc.deltaBand>1?'s':''} acima do atual">+</span>`
: bc.deltaBand === 0 ? `<span style="color:var(--txt-muted);font-size:9.5px" title="Mesma banda">=</span>`
: `<span style="color:var(--red-lt);font-size:9.5px" title="${Math.abs(bc.deltaBand)} banda(s) abaixo — atenção!">-</span>`;
 const scoreNum = a.score_total != null ? a.score_total.toFixed(2): '?';
 return `<div class="pfalt-item${bc.deltaBand < 0 ? ' pfalt-downgrade': ''}">
 ${_instrBadge(a.instrumento)}
 <span class="pfalt-name" title="${a.emissor||''}">${(a.emissor||a.ticker||'?').substring(0,16)}</span>
 ${_scoreBandBadge(bc.altBand, {short:true, tip:`Score ${scoreNum} · ${bc.altBand}`})}
 ${trend}
 <span class="cell-taxa">${eff.taxa_xp||'?'}</span>
 <span class="cell-venc" style="font-size:9.5px">${a.vencimento||'?'}</span>
 ${pb!=null?`<span class="posicao-payback-badge ${pb<=2?'pb-ok':pb<=5?'pb-warn':'pb-bad'}">${pb.toFixed(1)}a</span>`:''}
 ${!extraAlts.includes(a.ticker||'') ? `<button class="pfalt-add" onclick="addPosicaoAlt('${_esc(rowKey)}','${_esc(a.ticker||'')}')">+ gráfico</button>`: `<button class="pfalt-add pfalt-remove" onclick="removePosicaoAlt('${_esc(rowKey)}','${_esc(a.ticker||'')}')">X</button>`}
 </div>`;
 }).join('');

 const altsHeader = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;font-size:10.5px">
 <span style="display:flex;align-items:center;gap:6px">${refBandBadge}</span>
 <span style="color:var(--txt-dim);font-size:9px">Modo: ${ {strict:' Estrito',equal:'= Mesma',loose:'! Permissivo'}[_altsBandMode()] }</span>
 </div>`;

 const couponNote = coupon ? `<div class="pfalt-coupon-note">! <strong>${coupon.label}</strong> — ${coupon.note}</div>`: '';

 return `<tr class="posicao-sub-row">
 <td colspan="${colSpan}">
 <div class="posicao-expanded">
 <div class="posicao-expanded-left">
 <div class="posicao-expanded-title">Projeção Payback — Manter vs Trocar <span style="font-size:9px;color:var(--txt-dim)">( = breakeven)</span></div>
 ${chartSvg}
 ${couponNote}
 </div>
 <div class="posicao-expanded-right">
 <div class="posicao-expanded-title">Alternativas do catálogo</div>
 ${altsHeader}
 ${altsHtml || '<p style="color:var(--txt-dim);font-size:10.5px">Nenhuma alternativa atende ao critério de banda. Tente afrouxar o modo (= Mesma ou ! Permissivo).</p>'}
 <div style="position:relative;margin-top:8px">
 <input id="pfAltInp_${_esc(rowKey)}" class="posicao-alt-search-inp" placeholder="Buscar ativo para comparar…"
 oninput="searchPosicaoAlt(this,'${_esc(rowKey)}')" autocomplete="off">
 <div id="pfAltDrop_${_esc(rowKey)}" class="pfalt-dropdown" style="display:none"></div>
 </div>
 </div>
 </div>
</td>
 </tr>`;
}

function setPosicaoView(v) {
 state_posicao.view = v;
 document.getElementById('btnCurva').classList.toggle('active', v==='curva');
 document.getElementById('btnMercado').classList.toggle('active', v==='mercado');
 renderPosicaoAnalysis();
}

/** Parse R$ string like "52.617,00", "R$ 52.617,00" or "- R$ 1.751,09" -> signed number */
function _parseReais(s) {
 if (!s) return null;
 const str = String(s).trim();
 const neg = str.startsWith('-');
 const n = parseFloat(str.replace(/[R$\s\-]/g,'').replace(/\./g,'').replace(',','.'));
 if (isNaN(n)) return null;
 return neg ? -n: n;
}

/** Parse a rate string like "IPC-A +5,35%", "+16,24%", "CDI+2,50%", "107,50% CDI"
 * -> { type: 'IPCA+'|'CDI+'|'CDI%'|'PRE', value: number }
 */
function _parseRateStr(s) {
 if (!s) return null;
 s = s.trim().replace(/ipc-a/gi, 'IPCA').replace(/ipc_a/gi, 'IPCA');
 // IPCA + x%
 let m = s.match(/ipca\s*[+]\s*([\d,.]+)/i);
 if (m) return { type:'IPCA+', value: parseFloat(m[1].replace(',','.')) };
 // CDI + x%
 m = s.match(/cdi\s*[+]\s*([\d,.]+)/i);
 if (m) return { type:'CDI+', value: parseFloat(m[1].replace(',','.')) };
 // x,xx% CDI or x% CDI
 m = s.match(/([\d,.]+)\s*%\s*cdi/i);
 if (m) return { type:'CDI%', value: parseFloat(m[1].replace(',','.')) };
 // Selic / LFT -> treat as CDI%
 if (/selic/i.test(s)) {
 m = s.match(/([\d,.]+)/);
 return { type:'CDI%', value: m ? parseFloat(m[1].replace(',','.')): 100 };
 }
 // Pre: leading +/- or plain x,xx% (e.g., "+11,00%", "+16,24%", "11,00%")
 m = s.match(/^[+]?\s*([\d,.]+)\s*%/);
 if (m) return { type:'PRE', value: parseFloat(m[1].replace(',','.')) };
 return null;
}

/**
 * Parse the XP portfolio copy-paste.
 *
 * XP produces lines in this exact order per asset (14 lines):
 * 1 Name (e.g. "NTN-B - AGO/2050" or "DEB ENEVA - JUL/2037")
 * 2 Code (CODBACEN for TPs or CETIP code for credit, e.g. "760199" / "ENEV28")
 * 3 Vencimento DD/MM/YYYY
 * 4 Aplicação R$ xx.xxx,xx
 * 5 Taxa Compra (e.g. "IPC-A +5,35%" or "+11,00%")
 * 6 Taxa Venda (current market rate, e.g. "IPC-A +7,02%" — ≈ ANBIMA indicative)
 * 7 R$ Bruto Curva
 * 8 R$ Bruto Venda (MTM)
 * 9 Rendimento R$ xx.xxx,xx
 * 10 Rendimento Saída R$ xx.xxx,xx (can be "- R$ 1.751,09")
 * 11 Retorno % (e.g. "42,45%")
 * 12 Retorno Saída % (e.g. "-10,30%")
 * 13 "Simular Troca"
 * 14 "Resgatar"
 *
 * The header block ("29 Ativos", column labels) is automatically skipped.
 */
function _parsePosicaoText(text) {
 const HEADER_PAT = /^(vencimento|aplicação|taxa compra|r\$\s*bruto|rendimento|retorno\s*\(%\)|^\d+\s+ativos?)/i;
 const SKIP_PAT = /^(simular\s+troca|resgatar)$/i;

 const rawLines = text.split('\n');
 // Strip header: skip until we hit something that looks like an asset name
 // An asset name starts with NTN-B/LFT/DEB/CRI/CRA/LTN/NTN-F (public bonds) or
 // a company name in caps.
 const ASSET_NAME_PAT = /^(NTN-[BCFD]|LFT|LTN|DEB\b|CRI\b|CRA\b|CDCA\b|LF\b|CDB\b|LCI\b|LCA\b)/i;

 // Find index of first data line
 let start = 0;
 for (let i = 0; i < rawLines.length; i++) {
 const l = rawLines[i].trim();
 if (ASSET_NAME_PAT.test(l) || (/[A-ZÁÊÇÃ ]{4,}/.test(l) && !HEADER_PAT.test(l) && l.length > 3)) {
 start = i;
 break;
 }
 }

 const lines = rawLines.slice(start).map(l => l.trim());
 const positions = [];
 let i = 0;

 const nextNonEmpty = () => {
 while (i < lines.length && !lines[i]) i++;
 return i < lines.length ? lines[i]: null;
 };

 while (i < lines.length) {
 const l = nextNonEmpty();
 if (l === null) break;
 if (HEADER_PAT.test(l) || SKIP_PAT.test(l)) { i++; continue; }

 const pos = { nome: l, _raw: '' };
 const blockStart = i;
 i++;

 // Code / ID (line 2)
 const codeLine = nextNonEmpty();
 if (codeLine === null) break;
 pos.codigo = codeLine; i++;

 // Vencimento (line 3 — must look like a date)
 let vencLine = nextNonEmpty();
 if (vencLine && /\d{2}\/\d{2}\/\d{4}/.test(vencLine)) {
 pos.vencimento = vencLine.match(/\d{2}\/\d{2}\/\d{4}/)[0]; i++;
 }

 // Aplicação (line 4 — starts with R$)
 let aplLine = nextNonEmpty();
 if (aplLine && /R\$|^\d/.test(aplLine)) {
 pos.aplicado = _parseReais(aplLine); i++;
 }

 // Taxa Compra (line 5)
 let taxaC = nextNonEmpty();
 if (taxaC) { pos.taxa_compra = _parseRateStr(taxaC); i++; }

 // Taxa Venda (line 6 — the market rate / ANBIMA indicative)
 let taxaV = nextNonEmpty();
 if (taxaV && !SKIP_PAT.test(taxaV) && !/^\d{2}\/\d{2}\/\d{4}$/.test(taxaV)) {
 pos.taxa_mercado = _parseRateStr(taxaV); i++;
 }

 // R$ Bruto Curva (line 7)
 let bCurva = nextNonEmpty();
 if (bCurva && /R\$|^\d/.test(bCurva) && !SKIP_PAT.test(bCurva)) {
 pos.bruto_curva = _parseReais(bCurva); i++;
 }

 // R$ Bruto Venda (line 8)
 let bVenda = nextNonEmpty();
 if (bVenda && /R\$|^\d/.test(bVenda) && !SKIP_PAT.test(bVenda)) {
 pos.bruto_venda = _parseReais(bVenda); i++;
 }

 // Rendimento (line 9)
 let rend = nextNonEmpty();
 if (rend && /R\$|^-?\s*R\$|^\d/.test(rend) && !SKIP_PAT.test(rend)) {
 pos.rendimento = _parseReais(rend); i++;
 }

 // Rendimento Saída (line 10 — can be "- R$ 1.751,09")
 let rendS = nextNonEmpty();
 if (rendS && !SKIP_PAT.test(rendS) && /\d/.test(rendS)) {
 pos.rendimento_saida = _parseReais(rendS); i++;
 }

 // Retorno % (line 11)
 let ret = nextNonEmpty();
 if (ret && !SKIP_PAT.test(ret) && /%/.test(ret)) {
 pos.retorno_pct = parseFloat(ret.replace('%','').replace(',','.')) || null; i++;
 }

 // Retorno Saída % (line 12)
 let retS = nextNonEmpty();
 if (retS && !SKIP_PAT.test(retS) && /%/.test(retS)) {
 pos.retorno_saida_pct = parseFloat(retS.replace('%','').replace(',','.')) || null; i++;
 }

 // Skip "Simular Troca" / "Resgatar"
 while (i < lines.length && SKIP_PAT.test(lines[i].trim())) i++;

 // Build raw snippet for tooltip
 pos._raw = rawLines.slice(blockStart, i).join('\n');

 // Determine ticker: for public bonds (NTN-B etc), use name prefix; for credit, use codigo
 pos.ticker = _extractXpTicker(pos.nome, pos.codigo);
 // Determine instrument type from name prefix
 pos.instrumento = _instrFromName(pos.nome);

 if (pos.nome && (pos.taxa_compra || pos.taxa_mercado || pos.bruto_curva)) {
 positions.push(pos);
 }
 }
 return positions;
}

/** Extract the best ticker for lookup from name/code fields */
function _extractXpTicker(nome, codigo) {
 if (!nome) return codigo || '';
 const n = nome.trim().toUpperCase();
 // Public bonds: use the CODBACEN from codigo as-is (e.g., "760199")
 // but match them by tipo+vencimento. Return the TP prefix as ticker key.
 if (/^NTN-B/.test(n)) return 'NTN-B';
 if (/^NTN-F/.test(n)) return 'NTN-F';
 if (/^NTN-C/.test(n)) return 'NTN-C';
 if (/^LFT/.test(n)) return 'LFT';
 if (/^LTN/.test(n)) return 'LTN';
 // Credit instruments: codigo IS the CETIP ticker
 if (codigo && /^[A-Z0-9]+$/.test(codigo.trim()) && codigo.trim().length >= 4) return codigo.trim();
 // Fallback: uppercase alphanumeric run from nome
 const m = n.match(/\b([A-Z]{2,5}\d{1,3}[A-Z]?\d*)\b/);
 return m ? m[1]: (codigo || nome.trim().split(/\s+/)[0]);
}

/** Determine instrument label from asset name */
function _instrFromName(nome) {
 const n = (nome||'').toUpperCase();
 if (/^NTN-B/.test(n)||/^NTN-C/.test(n)) return 'NTN-B';
 if (/^LFT/.test(n)) return 'LFT';
 if (/^LTN/.test(n)) return 'LTN';
 if (/^NTN-F/.test(n)) return 'NTN-F';
 if (/^CRI\b/.test(n)) return 'CRI';
 if (/^CRA\b/.test(n)) return 'CRA';
 if (/^DEB\b/.test(n)) return 'DEB';
 if (/^CDCA/.test(n)) return 'CDCA';
 return '';
}

/* ── BANDAS DE SCORE DE CRÉDITO ──────────────────────────────────────────── */
/** Calcula a banda de score de um papel.
 * S5 ≥ 8.5 (premium / AAA)
 * S4 7.5–8.49 (high grade / AA)
 * S3 6.5–7.49 (IG / A)
 * S2 5.0–6.49 (borderline / BBB)
 * S1 < 5.0 (high yield / BB-)
 * S0 sem score
 */
function _scoreBand(score) {
 if (score == null || isNaN(score)) return 'S0';
 if (score >= 8.5) return 'S5';
 if (score >= 7.5) return 'S4';
 if (score >= 6.5) return 'S3';
 if (score >= 5.0) return 'S2';
 return 'S1';
}
/** Score numérico mínimo da banda — usado para "comparar" bandas. */
function _scoreBandRank(band) {
 return { S0:0, S1:1, S2:2, S3:3, S4:4, S5:5 }[band] || 0;
}
/** Badge HTML da banda de score. */
function _scoreBandBadge(band, opts={}) {
 const meta = {
 S5: { color:'#10b981', bg:'rgba(16,185,129,.15)', label:'S5 Premium' },
 S4: { color:'#34d399', bg:'rgba(52,211,153,.12)', label:'S4 High Grade' },
 S3: { color:'#fbbf24', bg:'rgba(251,191,36,.12)', label:'S3 IG' },
 S2: { color:'#fb923c', bg:'rgba(251,146,60,.12)', label:'S2 Borderline' },
 S1: { color:'#ef4444', bg:'rgba(239,68,68,.12)', label:'S1 High Yield' },
 S0: { color:'var(--txt-dim)', bg:'transparent', label:'S0 sem score' },
 }[band] || { color:'var(--txt-dim)', bg:'transparent', label:band };
 const tip = opts.tip || meta.label;
 const txt = opts.short ? band: meta.label;
 return `<span class="score-band" style="background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}" title="${_esc(tip)}">${txt}</span>`;
}

/** Modo de filtro de banda na sugestão de troca.
 * 'strict' — só upgrade de banda (default, recomendado)
 * 'equal' — mesma banda ou superior
 * 'loose' — aceita downgrade de 1 banda, marca com aviso
 */
function _altsBandMode() {
 return state_posicao.altsBandMode || 'strict';
}
function setAltsBandMode(mode) {
 state_posicao.altsBandMode = mode;
 renderPosicaoAnalysis();
}

/** Verifica se uma alternativa atende ao critério de banda em relação ao papel atual.
 * Retorna {ok, deltaBand, altBand, refBand} */
function _bandCheck(refScore, altScore) {
 const refBand = _scoreBand(refScore);
 const altBand = _scoreBand(altScore);
 const deltaBand = _scoreBandRank(altBand) - _scoreBandRank(refBand);
 const mode = _altsBandMode();
 let ok;
 if (mode === 'strict') ok = deltaBand >= 1 || (refBand !== 'S0' && altBand === refBand && _scoreBandRank(refBand) >= 4);
 else if (mode === 'equal') ok = deltaBand >= 0 && altBand !== 'S0';
 else ok = deltaBand >= -1 && altBand !== 'S0';
 return { ok, deltaBand, altBand, refBand };
}

/** Look up catalog alternatives for a position — same index type, better rate.
 * Returns array sorted best rate first. */
function _lookupAlternatives(pos) {
 const d = state.data; if (!d) return [];
 const ticker = (pos.ticker||'').toUpperCase();
 const itype = pos.taxa_compra?.type || pos.taxa_mercado?.type || '';
 // Baseline institucional (Fabozzi / horizon analysis): o piso é a TAXA CONTRATADA,
 // pois é o que o investidor de fato captura se mantiver o papel até o vencimento.
 // Fallback: se não houver taxa contratada, usa taxa de mercado.
 const rateComp = pos.taxa_compra?.value;
 const rateMkt = pos.taxa_mercado?.value;
 const baseline = (rateComp != null) ? rateComp: rateMkt;

 // Map XP-parsed rate type to ANBIMA indice_type
 const typeMap = { 'IPCA+':'IPCA', 'CDI+':'CDI+', 'CDI%':'CDI%', 'PRE':'PRE' };
 const anbType = typeMap[itype] || '';

 // Search all spread_score buckets + oportunidades. Dedup por ticker —
 // oportunidades inclui o mesmo ticker que já aparece em spread_score, então
 // sem dedup o slice(0,5) traz duplicatas e empurra alternativas reais para fora.
 const _seenTk = new Set();
 const _push = (arr) => arr.filter(r => {
 const t = (r?.ticker || '').toUpperCase();
 if (!t || _seenTk.has(t)) return false;
 _seenTk.add(t);
 return true;
 });
 const sources = [
..._push(d.spread_score?.ipca || []),
..._push(d.spread_score?.cdi_pct || []),
..._push(d.spread_score?.cdi_plus || []),
..._push(d.spread_score?.pre || []),
..._push(d.oportunidades || []),
 ];

 // Score do papel ATUAL (posição) — buscamos no universo via ticker.
 // Necessário para aplicar o filtro de banda na sugestão de troca.
 const refRow = sources.find(r => (r.ticker || '').toUpperCase() === ticker);
 const refScore = refRow?.score_total;

 // Filter same index type and rate strictly better than the contracted (hold) rate
 let candidates = sources.filter(r => {
 const rt = (r.indice_type || r.xp_type || '').toUpperCase();
 if (anbType && rt !== anbType) return false;
 const eff = _effectiveRate(r);
 const v = eff.spread_xp;
 // Must be better than the hold baseline (contracted rate) — só faz sentido
 // trocar por algo que SUPERE o que já está contratado.
 if (baseline != null && v != null && v <= baseline) return false;
 // Exclude the same asset
 if ((r.ticker||'').toUpperCase() === ticker) return false;
 if (v == null) return false;
 // Banda de score — bloqueia downgrades conforme o modo selecionado pelo usuário.
 // Anexa metadata de banda na própria row para o renderer mostrar.
 const bc = _bandCheck(refScore, r.score_total);
 if (!bc.ok) return false;
 r._bandCheck = bc; // não-destrutivo (atributo extra)
 return true;
 });

 // Sort: 1º por banda (maior banda primeiro), 2º por Δ taxa
 candidates.sort((a,b) => {
 const sa = _scoreBandRank((a._bandCheck || _bandCheck(refScore, a.score_total)).altBand);
 const sb = _scoreBandRank((b._bandCheck || _bandCheck(refScore, b.score_total)).altBand);
 if (sa !== sb) return sb - sa;
 const va = _effectiveRate(a).spread_xp ?? 0;
 const vb = _effectiveRate(b).spread_xp ?? 0;
 return vb - va;
 });

 // Top 8 (filtro de banda reduz, então pegamos mais opções)
 const top = candidates.slice(0, 8);
 top._refScore = refScore;
 top._refBand = _scoreBand(refScore);
 return top;
}

/** Compute swap payback for switching from pos -> alt (catalog row).
 * Metodologia institucional (horizon analysis / Fabozzi):
 * Hold = manter o papel à TAXA CONTRATADA (rateComp) — é o que o investidor
 * de fato captura se não vender.
 * Swap = realizar deságio e reinvestir em altRate sobre bruto_venda.
 * paybackYears ≈ deságio / (Δrate * bruto_venda), com Δrate = altRate − rateComp.
 * (Aproximação linear; para o breakeven logarítmico exato ver _buildPaybackChart.)
 */
function _swapPayback(pos, altRate) {
 const desagio = (pos.bruto_curva != null && pos.bruto_venda != null)
 ? Math.max(0, pos.bruto_curva - pos.bruto_venda): 0;
 const rateComp = pos.taxa_compra?.value;
 const rateMkt = pos.taxa_mercado?.value;
 const baseline = (rateComp != null) ? rateComp: rateMkt;
 if (altRate == null || baseline == null) return null;
 const deltaRate = altRate - baseline;
 if (deltaRate <= 0) return null;
 const base = pos.bruto_venda || pos.aplicado || 0;
 if (!base) return null;
 const annualGain = (deltaRate / 100) * base;
 if (!annualGain) return null;
 return desagio / annualGain; // years
}

/** Return the single best matching row (for legacy callers) */
function _lookupBestRate(pos) {
 const alts = _lookupAlternatives(pos);
 return alts.length ? alts[0]: null;
}

/** Look up BID in the RF Mercado tab for an asset the client already holds.
 * Matches by ticker. Returns the full mercado row (with bid_rate, vol_bid) or null. */
function _lookupMercadoBid(pos) {
 const mercado = state.data?.mercado || [];
 const ticker = (pos.ticker || '').toUpperCase().trim();
 if (!ticker) return null;
 // Also try matching by codigo (CETIP code) for credit assets
 const codigo = (pos.codigo || '').toUpperCase().trim();
 return mercado.find(r => {
 const rt = (r.ticker || '').toUpperCase().trim();
 return rt && (rt === ticker || (codigo && rt === codigo));
 }) || null;
}

function parsePosicao() {
 const text = document.getElementById('posicaoInput').value.trim();
 const statusEl = document.getElementById('posicaoStatus');
 if (!text) { statusEl.textContent='Cole a posição antes de analisar.'; statusEl.style.color='var(--red-lt)'; return; }
 statusEl.textContent='Parseando...'; statusEl.style.color='var(--txt-muted)';
 try {
 state_posicao.positions = _parsePosicaoText(text);
 const n = state_posicao.positions.length;
 if (n) {
 statusEl.textContent = `${n} posição(ões) detectada(s)`;
 statusEl.style.color = 'var(--green-lt)';
 } else {
 statusEl.textContent = 'Nenhuma posição encontrada — verifique o formato.';
 statusEl.style.color = 'var(--gold-lt)';
 }
 renderPosicaoAnalysis();
 } catch(err) {
 statusEl.textContent = `Erro: ${err.message}`; statusEl.style.color='var(--red-lt)';
 }
}

function clearPosicao() {
 document.getElementById('posicaoInput').value = '';
 document.getElementById('posicaoStatus').textContent = '';
 state_posicao.positions = [];
 renderPosicaoAnalysis();
}

function renderPosicaoAnalysis() {
 // Use dedicated container to avoid clobbering #dataTable
 const pcont = document.getElementById('posicaoContainer');
 const empty = document.getElementById('emptyState');
 const positions = state_posicao.positions;

 if (!pcont) return;
 if (!positions.length) {
 pcont.style.display = 'none';
 empty.style.display = 'none';
 return;
 }

 empty.style.display = 'none';
 pcont.style.display = 'block';

 // Parse patrimônio
 const patriRaw = document.getElementById('posicaoPatrimonio').value.replace(/[^\d.,]/g,'').replace('.','').replace(',','.');
 const patrimonio = parseFloat(patriRaw) || null;
 const isMercado = state_posicao.view === 'mercado';

 // Build enriched rows
 let rows = positions.map(pos => {
 const alts = _lookupAlternatives(pos);
 const catalog = alts[0] || null;
 const bruto = isMercado ? (pos.bruto_venda ?? pos.bruto_curva): pos.bruto_curva;
 const desagio = (pos.bruto_curva != null && pos.bruto_venda != null)
 ? pos.bruto_curva - pos.bruto_venda: null;
 const desagioPct = patrimonio && desagio != null ? desagio / patrimonio * 100: null;
 const rateComp = pos.taxa_compra?.value;
 const rateMkt = pos.taxa_mercado?.value;
 const rateBest = catalog ? (_effectiveRate(catalog).spread_xp ?? null): null;
 const gapBest = (rateBest != null && rateMkt != null) ? rateBest - rateMkt: null;
 const payback = catalog ? _swapPayback(pos, rateBest): null;
 // BID from RF Mercado tab — reference for selling this asset in secondary market
 const bidRow = _lookupMercadoBid(pos);
 const bidMkt = bidRow?.bid_rate ?? null; // rate at which someone will buy
 const volBid = bidRow?.vol_bid ?? null; // volume available at BID
 // Taxas ANBIMA (Compra/Venda) para validar se o BID Mercado é fair-value.
 // Em RF: taxa MAIOR = preço MENOR.
 // BID Mercado < Taxa Venda ANBIMA -> cliente vende com taxa abaixo do OFFER -> ótimo
 // BID Mercado entre Venda e Compra -> dentro do book -> fair
 // BID Mercado >Taxa Compra ANBIMA -> taxa pior que BID institucional -> ruim
 const anbCompraSale = bidRow?.anbima_compra ?? null;
 const anbVendaSale = bidRow?.anbima_venda ?? null;
 const anbIndSale = bidRow?.anbima ?? null;
 return { pos, alts, catalog, bruto, desagio, desagioPct, rateComp, rateMkt, rateBest, gapBest, payback, bidMkt, volBid, anbCompraSale, anbVendaSale, anbIndSale };
 });
 const allRows = rows;
 rows = _applyPosicaoFilters(rows);

 // Summary bar
 const totalBruto = rows.reduce((s,r)=>s+(r.bruto||0),0);
 const totalDesagio = rows.reduce((s,r)=>s+(r.desagio!=null&&r.desagio>0?r.desagio:0),0);
 const totalAgio = rows.reduce((s,r)=>s+(r.desagio!=null&&r.desagio<0?Math.abs(r.desagio):0),0);
 const totalAplic = positions.reduce((s,p)=>s+(p.aplicado||0),0);
 const desagioPatPct= patrimonio && totalDesagio ? totalDesagio/patrimonio*100: null;
 // Assets where current market rate < contracted rate (bond appreciated)
 const nAgio = rows.filter(r => r.rateMkt != null && r.rateComp != null && r.rateMkt < r.rateComp - 0.005).length;

 const viewBadge = isMercado
 ? `<span class="view-badge view-badge-mercado">A Mercado (MTM)</span>`
: `<span class="view-badge view-badge-curva">Na Curva (Accrual)</span>`;

 const nSwaps = rows.filter(r => r.payback != null && r.payback <= 5).length;

 let html = `
 <div class="posicao-analysis">
 ${_renderPosicaoFilterBar(allRows.length, rows.length)}
 <div class="posicao-summary-bar">
 <div class="posicao-kpi"><span class="posicao-kpi-lbl">Posições</span>
 <span class="posicao-kpi-val" style="color:var(--txt)">${positions.length}</span></div>
 ${totalAplic ? `<div class="posicao-kpi"><span class="posicao-kpi-lbl">Total Aplicado</span>
 <span class="posicao-kpi-val" style="color:var(--txt)">R$${fmtBrl(totalAplic)}</span></div>`: ''}
 <div class="posicao-kpi"><span class="posicao-kpi-lbl">Bruto ${isMercado?'MTM':'Curva'}</span>
 <span class="posicao-kpi-val" style="color:var(--txt-sec)">R$${fmtBrl(totalBruto)}</span></div>
 ${totalDesagio > 0 ? `
 <div class="posicao-kpi" title="Curva − MTM: perda realizada se liquidar hoje">
 <span class="posicao-kpi-lbl">Deságio Total</span>
 <span class="posicao-kpi-val" style="color:var(--red-lt)">−R$${fmtBrl(totalDesagio)}</span>
 </div>`: ''}
 ${totalAgio > 0 ? `
 <div class="posicao-kpi" title="MTM acima da curva: ativos que apreciaram (taxa de mercado caiu vs contratada)">
 <span class="posicao-kpi-lbl">Ágio Total</span>
 <span class="posicao-kpi-val" style="color:var(--green-lt)">+R$${fmtBrl(totalAgio)}</span>
 </div>`: ''}
 ${totalDesagio === 0 && totalAgio === 0 ? `
 <div class="posicao-kpi">
 <span class="posicao-kpi-lbl">MTM</span>
 <span class="posicao-kpi-val" style="color:var(--txt-dim)">Neutro</span>
 </div>`: ''}
 ${desagioPatPct != null ? `
 <div class="posicao-kpi" title="Impacto do deságio sobre o patrimônio total informado">
 <span class="posicao-kpi-lbl">Deságio / Patrimônio</span>
 <span class="posicao-kpi-val" style="color:${desagioPatPct>2?'var(--red-lt)':desagioPatPct>0.5?'#fbbf24':'var(--green-lt)'}">
 ${desagioPatPct.toFixed(2)}%</span>
 </div>`: ''}
 ${nAgio > 0 ? `
 <div class="posicao-kpi" title="Ativos onde a taxa atual de mercado está abaixo da taxa contratada — bond apreciou. Em visualização Na Curva, o bruto não reflete esse ganho latente.">
 <span class="posicao-kpi-lbl">Com ágio</span>
 <span class="posicao-kpi-val" style="color:var(--green-lt)">${nAgio} ativo${nAgio>1?'s':''}</span>
 </div>`: ''}
 ${nSwaps > 0 ? `
 <div class="posicao-kpi" title="Trocas com payback ≤ 5 anos vs deságio atual">
 <span class="posicao-kpi-lbl">Trocas viáveis</span>
 <span class="posicao-kpi-val" style="color:var(--gold-lt)">${nSwaps} ativo${nSwaps>1?'s':''}</span>
 </div>`: ''}
 <div style="margin-left:auto">${viewBadge}</div>
 </div>

 ${_renderPosicaoCharts(rows)}

 <div class="posicao-table-wrap">
 <table class="posicao-table">
 <thead>
 <tr class="group-row">
 <th colspan="5"></th>
 <th colspan="${patrimonio?3:2}" style="border-bottom:1px solid var(--gold-dim);color:var(--gold-lt);font-size:8.5px;letter-spacing:.08em">DESÁGIO / MTM</th>
 <th colspan="2" style="border-bottom:1px solid rgba(96,165,250,.4);color:#60a5fa;font-size:8.5px;letter-spacing:.08em" title="BID disponível no mercado secundário XP (taxa de saída do cliente) — classificado em zonas vs taxas ANBIMA (Compra/Indicativa/Venda) para validar se é fair-value">SAÍDA — BID MERCADO XP</th>
 <th colspan="3" style="border-bottom:1px solid rgba(16,185,129,.4);color:#34d399;font-size:8.5px;letter-spacing:.08em">TROCA SUGERIDA</th>
 <th colspan="2"></th>
 <th></th>
 </tr>
 <tr>
 <th>Nome</th>
 <th>Código</th>
 <th>Vcto</th>
 <th>Tipo</th>
 <th title="Taxa paga na compra do ativo">Taxa Compra</th>
 <th title="Taxa de mercado atual (≈ ANBIMA indicativa)">Taxa Mercado</th>
 <th title="Curva − MTM: perda se liquidar hoje">Deságio (R$)</th>
 ${patrimonio ? '<th title="Deságio ÷ Patrimônio total">% Patrim.</th>': ''}
 <th title="BID Mercado XP = taxa em que o cliente vende hoje. Abaixo: zona vs taxas ANBIMA: acima do book / lado de venda / lado de compra / abaixo do book" style="color:#60a5fa">BID + zona</th>
 <th title="Volume disponível no BID (R$)" style="color:#60a5fa">Vol.</th>
 <th title="Melhor ativo no catálogo XP com taxa > mercado atual">Melhor Alt.</th>
 <th title="Taxa catálogo − Taxa mercado">Δ pp</th>
 <th title="Anos para o ganho de taxa compensar o deságio: Deságio ÷ (Δ% × Bruto Venda)">Payback</th>
 <th title="Rendimento acumulado na curva">Rendimento</th>
 <th>Aplicado</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 ${rows.map(row => {
 const key = row.pos.codigo || row.pos.ticker || row.pos.nome || '';
 const isExp = state_posicao.expandedKey === key;
 const colSpan = patrimonio ? 17: 16;
 return _renderPosicaoRow(row, !!patrimonio) + (isExp ? _buildExpandedContent(row, colSpan): '');
 }).join('')}
 </tbody>
 </table>
 </div>
 </div>`;

 pcont.innerHTML = html;
}

function _posicaoTypeTag(pos) {
 const itype = pos.taxa_compra?.type || pos.taxa_mercado?.type || '';
 if (itype==='IPCA+') return `<span class="posicao-tag posicao-tag-ipca">IPCA+</span>`;
 if (itype==='CDI+'||itype==='CDI%') return `<span class="posicao-tag posicao-tag-cdi">${itype}</span>`;
 if (itype==='PRE') return `<span class="posicao-tag posicao-tag-pre">Pré</span>`;
 const instr = pos.instrumento || '';
 if (/NTN-B/.test(instr)) return `<span class="posicao-tag posicao-tag-ipca">NTN-B</span>`;
 if (/LFT/.test(instr)) return `<span class="posicao-tag posicao-tag-cdi">LFT</span>`;
 if (/LTN|NTN-F/.test(instr)) return `<span class="posicao-tag posicao-tag-pre">${instr}</span>`;
 return `<span class="posicao-tag posicao-tag-other">${itype||instr||'?'}</span>`;
}

function _renderPosicaoRow(row, showPatri) {
 const {pos, alts, catalog, bruto, desagio, desagioPct, rateComp, rateMkt, rateBest, gapBest, payback, bidMkt, volBid} = row;
 const nomeShort = pos.nome ? (pos.nome.length > 22 ? pos.nome.substring(0,22)+'…': pos.nome): '—';

 // Generic rate formatter (used for taxa_compra)
 const rateFmt = r => {
 if (r == null) return '<span style="color:var(--txt-dim)">—</span>';
 const t = r.type||'';
 if (t==='IPCA+') return `<span class="cell-taxa">IPCA+${r.value?.toFixed(2)||''}%</span>`;
 if (t==='CDI+') return `<span class="cell-taxa">CDI+${r.value?.toFixed(2)||''}%</span>`;
 if (t==='CDI%') return `<span class="cell-taxa">${r.value?.toFixed(2)||''}%CDI</span>`;
 return `<span class="cell-taxa">+${r.value?.toFixed(2)||''}%</span>`;
 };

 // Taxa Mercado formatter — shows Δ vs contracted rate.
 // delta < 0 -> taxa caiu -> bond apreciou (ágio) -> verde -
 // delta > 0 -> taxa subiu -> bond desvalorizou (deságio) -> vermelho +
 const rateMktFmt = r => {
 if (r == null) return '<span style="color:var(--txt-dim)">—</span>';
 const t = r.type||'', val = r.value;
 let base = '';
 if (t==='IPCA+') base = `IPCA+${val?.toFixed(2)||''}%`;
 else if (t==='CDI+') base = `CDI+${val?.toFixed(2)||''}%`;
 else if (t==='CDI%') base = `${val?.toFixed(2)||''}%CDI`;
 else base = `+${val?.toFixed(2)||''}%`;

 if (val != null && rateComp != null) {
 const delta = val - rateComp; // negative = fell = ágio; positive = rose = deságio
 if (delta < -0.005) {
 return `<div style="display:flex;flex-direction:column;gap:1px;align-items:flex-end">
 <span class="cell-taxa" style="color:var(--green-lt)">${base}</span>
 <span style="font-size:8.5px;color:var(--green-lt)"
 title="Taxa caiu ${Math.abs(delta).toFixed(2)}pp vs contratada — bond apreciou. Na Curva o bruto não reflete isso.">- ${delta.toFixed(2)}pp vs compra</span>
 </div>`;
 }
 if (delta > 0.005) {
 return `<div style="display:flex;flex-direction:column;gap:1px;align-items:flex-end">
 <span class="cell-taxa">${base}</span>
 <span style="font-size:8.5px;color:var(--red-lt)"
 title="Taxa subiu ${delta.toFixed(2)}pp vs contratada — bond desvalorizou (deságio).">+ +${delta.toFixed(2)}pp vs compra</span>
 </div>`;
 }
 }
 return `<span class="cell-taxa">${base}</span>`;
 };

 // Deságio / ágio
 // desagio > 0 -> bruto_curva > bruto_venda -> loss (MTM below curve)
 // desagio < 0 -> bruto_venda > bruto_curva -> gain (MTM above curve = ágio)
 const desagioPctBruto = (desagio != null && pos.bruto_curva) ? desagio / pos.bruto_curva * 100: null;
 const isAgio = desagio != null && desagio < 0;
 const desagioClass = isAgio ? 'desagio-ok'
: desagioPctBruto == null ? ''
: desagioPctBruto < 1 ? 'desagio-ok'
: desagioPctBruto < 5 ? 'desagio-warn'
: 'desagio-bad';

 // Best alternative
 const altHtml = catalog
 ? `<div style="display:flex;flex-direction:column;gap:2px">
 <span class="cell-taxa" style="color:var(--green-lt)">${rateBest?.toFixed(2)||'?'}%</span>
 <span style="font-size:9px;color:var(--txt-dim)">${catalog.emissor?.substring(0,12)||catalog.ticker||''}</span>
 </div>`
: '<span style="color:var(--txt-dim)">—</span>';

 const gapHtml = gapBest != null
 ? `<span class="${gapBest>0?'mkt-delta mkt-delta-pos':'mkt-delta mkt-delta-neg'}">${gapBest>0?'+':''}${gapBest.toFixed(2)}</span>`
: '—';

 // Payback: color by urgency
 const payHtml = payback != null
 ? `<div style="display:flex;flex-direction:column;gap:1px;align-items:center">
 <span class="cell-taxa ${payback<=2?'desagio-ok':payback<=5?'desagio-warn':'desagio-bad'}"
 title="Deságio ÷ (Δtaxa × BrutoVenda): ${payback.toFixed(1)} anos para compensar">${payback.toFixed(1)}a</span>
 ${payback<=5?`<span style="font-size:8.5px;color:var(--gold-lt)"> viável</span>`:''}
 </div>`
: '<span style="color:var(--txt-dim)">—</span>';

 return `<tr title="${_esc(pos._raw||'')}">
 <td style="max-width:160px">
 <div style="font-weight:500;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(pos.nome||'')}">${nomeShort}</div>
</td>
 <td><span class="cell-ticker" style="font-size:9.5px">${pos.codigo||'—'}</span></td>
 <td class="cell-venc">${pos.vencimento||'—'}</td>
 <td>${_posicaoTypeTag(pos)}</td>
 <td>${rateFmt(pos.taxa_compra)}</td>
 <td class="right">${rateMktFmt(pos.taxa_mercado)}</td>
 <td class="right mono ${desagioClass}" style="font-size:10.5px">
 ${desagio != null
 ? isAgio
 ? `<span style="color:var(--green-lt)" title="Bond apreciou — MTM acima da curva (ágio)">+R$${fmtBrl(Math.abs(desagio))}</span>
 <div style="font-size:8px;color:var(--green-lt)"> ágio</div>`
: `−R$${fmtBrl(desagio)}
 ${desagioPctBruto!=null?`<div style="font-size:8.5px;color:var(--txt-dim)">${desagioPctBruto.toFixed(1)}% bruto</div>`:''}`
: '—'}
</td>
 ${showPatri ? `<td class="right mono ${desagioClass}" style="font-size:10.5px">${desagioPct!=null?(isAgio?'+':'')+desagioPct.toFixed(2)+'%':'—'}</td>`: ''}
 ${_renderBidMktCell(bidMkt, rateMkt, row.anbCompraSale, row.anbVendaSale, row.anbIndSale)}
 <td class="right mono" style="font-size:9.5px;color:var(--txt-dim)">${volBid!=null?fmtVol(volBid):'—'}</td>
 <td>${altHtml}</td>
 <td class="center">${gapHtml}</td>
 <td class="center">${payHtml}</td>
 <td class="right mono" style="font-size:10.5px;color:var(--txt-sec)">${pos.rendimento!=null?'R$'+fmtBrl(pos.rendimento):'—'}</td>
 <td class="right mono" style="font-size:10px;color:var(--txt-muted)">${pos.aplicado?'R$'+fmtBrl(pos.aplicado):'—'}</td>
 <td class="center"><button class="posicao-expand-btn" onclick="togglePosicaoExpand('${_esc(pos.codigo||pos.ticker||pos.nome||'')}')"></button></td>
 </tr>`;
}

/** Render da célula "BID Mkt" da tabela de Posição — taxa em que o cliente
 * consegue VENDER o ativo hoje no mercado secundário (XP).
 *
 * Validação fair-value: classifica o BID Mercado XP em 4 zonas vs taxas ANBIMA:
 *
 * Convenção RF: taxa MAIOR = preço MENOR. Para o cliente que está vendendo:
 * BID baixo = taxa baixa = preço alto = GANHO
 * BID alto = taxa alta = preço baixo = PERDA
 *
 * Zonas (em relação às taxas ANBIMA Compra/Indicativa/Venda):
 * BID <= Venda ANBIMA ->Acima do book (vende com taxa abaixo do OFFER ANBIMA = excelente)
 * Venda < BID <= Indic. ->Lado de venda (entre Venda e Indicativa, ainda vantajoso)
 * Indic. < BID <= Compra->Lado de compra (entre Indicativa e Compra, fair)
 * BID >Compra ANBIMA ->Abaixo do book (taxa pior que dealers compram = saída ruim)
 */
function _renderBidMktCell(bidMkt, rateMkt, anbCompra, anbVenda, anbInd) {
 if (bidMkt == null) {
 return `<td class="right mono" style="font-size:10px;color:var(--txt-faint)">—</td>`;
 }
 // Classificação fair-value se temos as 3 taxas ANBIMA
 let zoneLabel = '';
 let zoneClass = '';
 let zoneTip = '';
 if (anbCompra != null && anbVenda != null) {
 if (bidMkt <= anbVenda) {
 zoneLabel = 'acima do book'; zoneClass = 'pos-bid-zone-best';
 zoneTip = `BID Mercado XP (${bidMkt.toFixed(2)}%) está com taxa ≤ Venda ANBIMA (${anbVenda.toFixed(2)}%). Cliente vende com taxa abaixo do OFFER ANBIMA -> preço acima do book ANBIMA. Saída ÓTIMA.`;
 } else if (anbInd != null && bidMkt <= anbInd) {
 zoneLabel = 'lado de venda'; zoneClass = 'pos-bid-zone-good';
 zoneTip = `BID Mercado XP (${bidMkt.toFixed(2)}%) está entre Venda ANBIMA (${anbVenda.toFixed(2)}%) e Indicativa (${anbInd.toFixed(2)}%). Preço acima do fair-value de consenso -> saída VANTAJOSA.`;
 } else if (bidMkt <= anbCompra) {
 zoneLabel = 'lado de compra'; zoneClass = 'pos-bid-zone-fair';
 const anbIndStr = anbInd != null ? `, Indicativa ${anbInd.toFixed(2)}%`: '';
 zoneTip = `BID Mercado XP (${bidMkt.toFixed(2)}%) está entre Indicativa${anbIndStr} e Compra ANBIMA (${anbCompra.toFixed(2)}%). Dentro do book ANBIMA -> saída FAIR.`;
 } else {
 zoneLabel = 'abaixo do book'; zoneClass = 'pos-bid-zone-bad';
 zoneTip = `BID Mercado XP (${bidMkt.toFixed(2)}%) está com taxa >Compra ANBIMA (${anbCompra.toFixed(2)}%). Cliente recebe abaixo do que dealers institucionais comprariam -> saída RUIM, considere segurar.`;
 }
 } else if (rateMkt != null) {
 // Fallback: sem ANBIMA Compra/Venda, usa só rateMkt (taxa de mercado do papel)
 if (bidMkt < rateMkt - 0.005) { zoneLabel='abaixo do mkt'; zoneClass='pos-bid-zone-best'; }
 else if (bidMkt > rateMkt + 0.005) { zoneLabel='acima do mkt'; zoneClass='pos-bid-zone-bad'; }
 else { zoneLabel='≈ mkt'; zoneClass='pos-bid-zone-fair'; }
 const delta = bidMkt - rateMkt;
 zoneTip = `BID Mercado ${bidMkt.toFixed(2)}% vs Taxa Mercado ${rateMkt.toFixed(2)}% (Δ ${delta>0?'+':''}${delta.toFixed(2)}pp). Sem taxas Compra/Venda ANBIMA para classificação mais precisa.`;
 } else {
 zoneTip = `BID ${bidMkt.toFixed(2)}% no mercado secundário XP. Sem taxas ANBIMA do papel para validar fair-value.`;
 }
 return `<td class="right mono" style="font-size:10.5px" title="${_esc(zoneTip)}">
 <div style="display:flex;flex-direction:column;align-items:flex-end;gap:1px">
 <span class="pos-bid-rate">${bidMkt.toFixed(2)}%</span>
 ${zoneLabel ? `<span class="pos-bid-zone ${zoneClass}">${zoneLabel}</span>`: ''}
 </div>
</td>`;
}

/** Render 4 scatter charts (one per index type) in a 2-column grid */
function _renderPosicaoCharts(rows) {
 const TYPES = [
 { key:'IPCA+', label:'IPCA+', color:'#34d399' },
 { key:'CDI+', label:'CDI+', color:'#60a5fa' },
 { key:'CDI%', label:'CDI%', color:'#93c5fd' },
 { key:'PRE', label:'Pré-Fixado', color:'#e0bc64' },
 ];
 const charts = TYPES.map(t => {
 const filtered = rows.filter(r =>
 (r.pos.taxa_compra?.type || r.pos.taxa_mercado?.type || '') === t.key
 );
 if (!filtered.length) return '';
 return `<div class="posicao-chart-wrap">
 <div class="posicao-chart-title">
 <span style="color:${t.color};font-weight:700">${t.label}</span>
 <span style="opacity:.55;font-size:9px;margin-left:6px">Taxa × Vencimento · ${filtered.length} ativo${filtered.length>1?'s':''}</span>
 </div>
 ${_renderPosicaoChartSingle(filtered, t.color)}
 </div>`;
 }).filter(Boolean);
 if (!charts.length) return '';
 return `<div class="posicao-charts-grid">${charts.join('')}</div>`;
}

/** SVG scatter chart for a single index-type group.
 * accentColor: the base color for all points (solid = compra, outline = mercado,
 * triangle = catálogo, diamond = BID). */
function _renderPosicaoChartSingle(rows, accentColor) {
 const W=560, H=180, PAD={l:48,r:16,t:22,b:34};
 const plotW = W - PAD.l - PAD.r;
 const plotH = H - PAD.t - PAD.b;

 const now = Date.now();
 const pts = [];
 rows.forEach(row => {
 const venc = _parseVenc(row.pos.vencimento);
 if (!venc) return;
 const xt = venc.getTime();
 const lbl = row.pos.ticker || row.pos.nome?.substring(0,10) || '?';
 if (row.rateComp != null) pts.push({x:xt, y:row.rateComp, kind:'compra', label:lbl});
 if (row.rateMkt != null) pts.push({x:xt, y:row.rateMkt, kind:'mercado', label:lbl});
 if (row.rateBest != null) pts.push({x:xt, y:row.rateBest, kind:'catalogo', label:(row.catalog?.emissor||row.catalog?.ticker||'cat').substring(0,8)});
 if (row.bidMkt != null) pts.push({x:xt, y:row.bidMkt, kind:'bid', label:lbl+' BID'});
 });
 if (!pts.length) return '';

 const xMin = Math.min(...pts.map(p=>p.x), now);
 const xMax = Math.max(...pts.map(p=>p.x));
 const yMin = Math.max(0, Math.min(...pts.map(p=>p.y)) - 0.8);
 const yMax = Math.max(...pts.map(p=>p.y)) + 0.8;
 const xRange = xMax - xMin || 1;
 const yRange = yMax - yMin || 1;

 const px = t =>PAD.l + (t - xMin) / xRange * plotW;
 const py = v =>PAD.t + plotH - (v - yMin) / yRange * plotH;

 // Y grid
 const yStep = yRange > 10 ? 2: yRange > 4 ? 1: yRange > 1.5 ? 0.5: 0.25;
 let gridLines = '', yLabels = '';
 for (let y = Math.ceil(yMin/yStep)*yStep; y <= yMax; y += yStep) {
 const cy = py(y);
 gridLines += `<line x1="${PAD.l}" y1="${cy.toFixed(1)}" x2="${W-PAD.r}" y2="${cy.toFixed(1)}" stroke="var(--border)" stroke-width="0.5"/>`;
 yLabels += `<text x="${PAD.l-4}" y="${(cy+3.5).toFixed(1)}" fill="var(--txt-dim)" font-size="8.5" text-anchor="end">${y.toFixed(y<10?1:0)}%</text>`;
 }

 // X grid + labels (years)
 let xLabels = '';
 const minYear = new Date(xMin).getFullYear();
 const maxYear = new Date(xMax).getFullYear() + 1;
 for (let yr = minYear; yr <= maxYear; yr++) {
 const t = new Date(yr, 0, 1).getTime();
 if (t < xMin || t > xMax) continue;
 const cx = px(t);
 gridLines += `<line x1="${cx.toFixed(1)}" y1="${PAD.t}" x2="${cx.toFixed(1)}" y2="${H-PAD.b}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>`;
 xLabels += `<text x="${cx.toFixed(1)}" y="${(H-PAD.b+13).toFixed(1)}" fill="var(--txt-dim)" font-size="8.5" text-anchor="middle">${yr}</text>`;
 }
 // Today line
 const todayCx = px(now);
 gridLines += `<line x1="${todayCx.toFixed(1)}" y1="${PAD.t}" x2="${todayCx.toFixed(1)}" y2="${H-PAD.b}" stroke="var(--txt-dim)" stroke-width="1" stroke-dasharray="4,3"/>`;
 xLabels += `<text x="${todayCx.toFixed(1)}" y="${(H-PAD.b+13).toFixed(1)}" fill="var(--txt-muted)" font-size="8" text-anchor="middle">Hoje</text>`;

 // Connecting lines compra->mercado per ticker
 const grouped = {};
 rows.forEach(row => {
 const venc = _parseVenc(row.pos.vencimento); if(!venc) return;
 const cxv = px(venc.getTime());
 if (!grouped[cxv]) grouped[cxv] = {};
 if (row.rateComp != null) grouped[cxv].compra = py(row.rateComp);
 if (row.rateMkt != null) grouped[cxv].mercado = py(row.rateMkt);
 });
 let connLines = '';
 Object.entries(grouped).forEach(([cxv, g]) => {
 if (g.compra != null && g.mercado != null) {
 const dir = g.mercado < g.compra ? 'var(--red-lt)': 'var(--green-lt)'; // rate rose(red) or fell(green)
 connLines += `<line x1="${cxv}" y1="${g.compra.toFixed(1)}" x2="${cxv}" y2="${g.mercado.toFixed(1)}" stroke="${dir}" stroke-width="1.5" stroke-dasharray="3,2" opacity="0.5"/>`;
 }
 });

 // Points
 const col = accentColor;
 let circles = '';
 pts.forEach(pt => {
 const cx = px(pt.x).toFixed(1), cy = py(pt.y).toFixed(1);
 if (pt.kind === 'compra') {
 circles += `<circle cx="${cx}" cy="${cy}" r="5" fill="${col}" opacity="0.9" stroke="var(--bg2)" stroke-width="1.5"><title>${pt.label}: Taxa Compra ${pt.y.toFixed(2)}%</title></circle>`;
 } else if (pt.kind === 'mercado') {
 circles += `<circle cx="${cx}" cy="${cy}" r="4.5" fill="none" stroke="${col}" stroke-width="2" opacity="0.85"><title>${pt.label}: Taxa Mercado ${pt.y.toFixed(2)}%</title></circle>`;
 } else if (pt.kind === 'bid') {
 circles += `<polygon points="${cx},${(+cy-5).toFixed(1)} ${(+cx+5).toFixed(1)},${cy} ${cx},${(+cy+5).toFixed(1)} ${(+cx-5).toFixed(1)},${cy}" fill="${col}" opacity="0.6" stroke="var(--bg2)" stroke-width="1"><title>${pt.label}: ${pt.y.toFixed(2)}% — BID secundário (ref. venda)</title></polygon>`;
 } else {
 circles += `<polygon points="${cx},${(+cy-5).toFixed(1)} ${(+cx+5).toFixed(1)},${(+cy+4).toFixed(1)} ${(+cx-5).toFixed(1)},${(+cy+4).toFixed(1)}" fill="${col}" opacity="0.45"><title>Catálogo: ${pt.y.toFixed(2)}%</title></polygon>`;
 }
 });

 // Legend (compact, inside top-right of chart)
 const legendItems = [
 { shape:'circle-fill', lbl:'Compra' },
 { shape:'circle-outline', lbl:'Mercado' },
 { shape:'triangle', lbl:'Catálogo' },
 { shape:'diamond', lbl:'BID (venda)' },
 ];
 const lStartX = W - PAD.r - legendItems.length * 80 + 10;
 const legend = legendItems.map((l, i) => {
 const lx = lStartX + i * 78;
 const ly = 11;
 if (l.shape==='circle-fill') return `<circle cx="${lx}" cy="${ly}" r="3.5" fill="${col}" opacity="0.85"/><text x="${lx+6}" y="${ly+3.5}" fill="var(--txt-muted)" font-size="8">${l.lbl}</text>`;
 if (l.shape==='circle-outline') return `<circle cx="${lx}" cy="${ly}" r="3.5" fill="none" stroke="${col}" stroke-width="1.5" opacity="0.85"/><text x="${lx+6}" y="${ly+3.5}" fill="var(--txt-muted)" font-size="8">${l.lbl}</text>`;
 if (l.shape==='diamond') return `<polygon points="${lx},${ly-4} ${lx+4},${ly} ${lx},${ly+4} ${lx-4},${ly}" fill="${col}" opacity="0.6"/><text x="${lx+6}" y="${ly+3.5}" fill="var(--txt-muted)" font-size="8">${l.lbl}</text>`;
 return `<polygon points="${lx},${ly-4} ${lx+4},${ly+4} ${lx-4},${ly+4}" fill="${col}" opacity="0.45"/><text x="${lx+7}" y="${ly+3.5}" fill="var(--txt-muted)" font-size="8">${l.lbl}</text>`;
 }).join('');

 return `<svg class="posicao-chart-svg" viewBox="0 0 ${W} ${H}" style="height:${H}px">
 ${gridLines}${yLabels}${xLabels}
 <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H-PAD.b}" stroke="var(--border-lt)" stroke-width="1"/>
 <line x1="${PAD.l}" y1="${H-PAD.b}" x2="${W-PAD.r}" y2="${H-PAD.b}" stroke="var(--border-lt)" stroke-width="1"/>
 ${connLines}${circles}
 <g>${legend}</g>
 </svg>`;
}

/* ── SCROLL HORIZONTAL — botões + shift+wheel + gradiente de overflow ──── */
(function _setupHScroll() {
 const SCROLL_STEP = 320;

 function _initHScroll() {
 const cont = document.getElementById('tableContainer');
 const wrap = document.getElementById('tableWrap');
 const btnL = document.getElementById('hScrollLeft');
 const btnR = document.getElementById('hScrollRight');
 if (!cont || !wrap || !btnL || !btnR) return;

 const update = () => {
 const overflow = cont.scrollWidth > cont.clientWidth + 1;
 wrap.classList.toggle('has-h-overflow', overflow);
 btnL.classList.toggle('h-scroll-visible', overflow);
 btnR.classList.toggle('h-scroll-visible', overflow);
 if (overflow) {
 wrap.classList.toggle('scroll-not-start', cont.scrollLeft > 4);
 wrap.classList.toggle('scroll-not-end', cont.scrollLeft + cont.clientWidth < cont.scrollWidth - 4);
 btnL.disabled = cont.scrollLeft <= 0;
 btnR.disabled = cont.scrollLeft + cont.clientWidth >= cont.scrollWidth;
 }
 };

 btnL.onclick = (e) => { e.stopPropagation(); cont.scrollBy({left: -SCROLL_STEP, behavior:'smooth'}); };
 btnR.onclick = (e) => { e.stopPropagation(); cont.scrollBy({left: SCROLL_STEP, behavior:'smooth'}); };

 // Shift+wheel = scroll horizontal (padrão de muitas planilhas).
 cont.addEventListener('wheel', (e) => {
 if (e.shiftKey && Math.abs(e.deltaY) >Math.abs(e.deltaX)) {
 e.preventDefault();
 cont.scrollLeft += e.deltaY;
 update();
 }
 }, { passive: false });

 cont.addEventListener('scroll', update);
 // ResizeObserver para reajustar quando o conteúdo muda (re-render da tabela)
 if (window.ResizeObserver) {
 const ro = new ResizeObserver(update);
 ro.observe(cont);
 // Observa também o table interno
 const dt = document.getElementById('dataTable');
 if (dt) ro.observe(dt);
 }
 window.addEventListener('resize', update);

 // Atalhos de teclado: <- -> quando a tabela está hovered
 cont.addEventListener('mouseenter', () => { cont.dataset.kbActive = '1'; });
 cont.addEventListener('mouseleave', () => { delete cont.dataset.kbActive; });
 document.addEventListener('keydown', (e) => {
 if (cont.dataset.kbActive !== '1') return;
 // Ignora se o usuário está digitando em um input
 if (document.activeElement &&
 ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
 if (e.key === 'ArrowLeft') { cont.scrollBy({left: -SCROLL_STEP, behavior:'smooth'}); e.preventDefault(); }
 if (e.key === 'ArrowRight') { cont.scrollBy({left: SCROLL_STEP, behavior:'smooth'}); e.preventDefault(); }
 });

 update();
 }

 // Inicializa após DOM pronto
 if (document.readyState === 'loading') {
 document.addEventListener('DOMContentLoaded', _initHScroll);
 } else {
 _initHScroll();
 }
})();

/* ── TOOLTIP ─────────────────────────────────────────────────────────────── */
const _tip=document.getElementById('tooltip');
document.addEventListener('mouseover',e=>{const el=e.target.closest('[data-tip]');if(!el){_tip.classList.remove('visible');return;}_tip.textContent=el.dataset.tip;_tip.classList.add('visible');});
document.addEventListener('mousemove',e=>{_tip.style.left=(e.clientX+14)+'px';_tip.style.top=(e.clientY-6)+'px';});
document.addEventListener('mouseout',e=>{if(!e.target.closest('[data-tip]'))_tip.classList.remove('visible');});

/* ── INIT ────────────────────────────────────────────────────────────────── */
(async()=>{
 const res=await fetch('/api/data');
 const d=await res.json();
 if(d.loaded&&d.loaded.length){
 state.data=d;
 d.loaded.forEach(t=>markSlot(t));
 updateHeader(); updateStats(); renderCurrentTab();
 }
})();
