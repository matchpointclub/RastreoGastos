(function(){
  const firebaseConfig = {
    apiKey: "AIzaSyDJ7mWMdkzsBgoEojTQFKbHmn5xQ71B61k",
    authDomain: "rastreo-de-gastos.firebaseapp.com",
    projectId: "rastreo-de-gastos",
    storageBucket: "rastreo-de-gastos.firebasestorage.app",
    messagingSenderId: "247710120971",
    appId: "1:247710120971:web:d429f7e8c8515029339b0e"
  };
  firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();
  const movimientosRef = db.collection('movimientos');
  const settingsRef = db.collection('settings').doc('thresholds');

  const OFICIAL_URL = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial';
  const BLUE_URL = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/blue';
  const LIVE_OFICIAL_URL = 'https://dolarapi.com/v1/dolares/oficial';
  const LIVE_BLUE_URL = 'https://dolarapi.com/v1/dolares/blue';
  const RIESGO_PAIS_URL = 'https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo';
  const POLL_MS = 15 * 60 * 1000;
  const STORAGE_KEY = 'dolar-tracker:thresholds';
  const INTRADAY_PREFIX = 'dolar-tracker:intraday:';

  let oficialData = [];
  let blueData = [];
  let liveOficial = null;
  let liveBlue = null;
  let currentRange = 'hoy';
  let chart = null;
  let thresholds = { ofMin:'', ofMax:'', blMin:'', blMax:'', gapPct:'' };
  let notifGranted = false;

  const fmt = (n) => n == null ? '—' : n.toLocaleString('es-AR', { style:'currency', currency:'ARS', minimumFractionDigits:0, maximumFractionDigits:0 });

  function todayKey(){
    const d = new Date();
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }

  function recordIntradaySnapshot(ofVenta, blVenta){
    const key = INTRADAY_PREFIX + todayKey();
    let day = {};
    try{
      const raw = localStorage.getItem(key);
      if(raw) day = JSON.parse(raw);
    }catch(e){ day = {}; }
    const hour = String(new Date().getHours()).padStart(2,'0');
    day[hour] = { oficial: ofVenta, blue: blVenta, minute: new Date().getMinutes() };
    try{ localStorage.setItem(key, JSON.stringify(day)); }catch(e){ /* storage llena, ignorar */ }
  }

  function getIntradaySeries(){
    const key = INTRADAY_PREFIX + todayKey();
    let day = {};
    try{
      const raw = localStorage.getItem(key);
      if(raw) day = JSON.parse(raw);
    }catch(e){ day = {}; }
    const labels = [];
    const oficial = [];
    const blue = [];
    for(let h = 0; h <= 23; h++){
      const hh = String(h).padStart(2,'0');
      labels.push(hh+':00');
      oficial.push(day[hh] ? day[hh].oficial : null);
      blue.push(day[hh] ? day[hh].blue : null);
    }
    return { labels, oficial, blue };
  }

  function blueAvgRate(){
    if(!liveBlue) return null;
    return (liveBlue.compra + liveBlue.venta) / 2;
  }

  function updateCalcRateLabel(){
    const rate = blueAvgRate();
    const label = document.getElementById('calcRate');
    if(!rate){ label.textContent = 'Cargando cotización…'; return; }
    label.textContent = 'Promedio blue usado: '+fmt(rate)+' por USD (compra '+fmt(liveBlue.compra)+' / venta '+fmt(liveBlue.venta)+')';
  }

  function initCalculator(){
    const arsInput = document.getElementById('calcArs');
    const usdInput = document.getElementById('calcUsd');
    const swapBtn = document.getElementById('calcSwap');

    arsInput.addEventListener('input', ()=>{
      const rate = blueAvgRate();
      if(!rate || arsInput.value === ''){ usdInput.value = ''; return; }
      usdInput.value = (parseFloat(arsInput.value) / rate).toFixed(2);
    });

    usdInput.addEventListener('input', ()=>{
      const rate = blueAvgRate();
      if(!rate || usdInput.value === ''){ arsInput.value = ''; return; }
      arsInput.value = (parseFloat(usdInput.value) * rate).toFixed(2);
    });

    swapBtn.addEventListener('click', ()=>{
      const tmp = arsInput.value;
      arsInput.value = usdInput.value;
      usdInput.value = tmp;
      const rate = blueAvgRate();
      if(rate && arsInput.value !== ''){
        usdInput.value = (parseFloat(arsInput.value) / rate).toFixed(2);
      }
    });
  }

  function refreshCalculator(){
    updateCalcRateLabel();
    const arsInput = document.getElementById('calcArs');
    const usdInput = document.getElementById('calcUsd');
    const rate = blueAvgRate();
    if(!rate) return;
    if(arsInput.value !== '' && document.activeElement !== usdInput){
      usdInput.value = (parseFloat(arsInput.value) / rate).toFixed(2);
    }else if(usdInput.value !== '' && document.activeElement !== arsInput){
      arsInput.value = (parseFloat(usdInput.value) * rate).toFixed(2);
    }
  }

  function applyThresholdsToInputs(){
    document.getElementById('ofMin').value = thresholds.ofMin || '';
    document.getElementById('ofMax').value = thresholds.ofMax || '';
    document.getElementById('blMin').value = thresholds.blMin || '';
    document.getElementById('blMax').value = thresholds.blMax || '';
    document.getElementById('gapPct').value = thresholds.gapPct || '';
  }

  function initThresholdsSync(){
    settingsRef.onSnapshot((doc)=>{
      if(doc.exists){
        thresholds = Object.assign(thresholds, doc.data());
        applyThresholdsToInputs();
      }
    }, (err)=> console.error('Error sincronizando umbrales', err));
  }

  function saveThresholds(){
    thresholds = {
      ofMin: document.getElementById('ofMin').value,
      ofMax: document.getElementById('ofMax').value,
      blMin: document.getElementById('blMin').value,
      blMax: document.getElementById('blMax').value,
      gapPct: document.getElementById('gapPct').value,
    };
    settingsRef.set(thresholds)
      .then(()=>{
        const btn = document.getElementById('saveThresholds');
        const original = btn.textContent;
        btn.textContent = 'Guardado';
        setTimeout(()=>{ btn.textContent = original; }, 1500);
      })
      .catch((e)=> console.error('No se pudieron guardar los umbrales', e));
  }

  function logAlert(msg){
    const list = document.getElementById('logList');
    if(list.querySelector('.log-empty')) list.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'log-item';
    const time = new Date().toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
    row.innerHTML = '<span>'+msg+'</span><span class="log-time">'+time+'</span>';
    list.prepend(row);
  }

  function notify(title, body){
    if(notifGranted && 'Notification' in window){
      try{ new Notification(title, { body }); }catch(e){ /* fallback al log */ }
    }
    logAlert(body);
  }

  function checkThresholds(ofVenta, blVenta){
    if(thresholds.ofMin && ofVenta < parseFloat(thresholds.ofMin)){
      notify('Dólar oficial bajo', 'El oficial bajó a '+fmt(ofVenta));
    }
    if(thresholds.ofMax && ofVenta > parseFloat(thresholds.ofMax)){
      notify('Dólar oficial alto', 'El oficial subió a '+fmt(ofVenta));
    }
    if(thresholds.blMin && blVenta < parseFloat(thresholds.blMin)){
      notify('Dólar blue bajo', 'El blue bajó a '+fmt(blVenta));
    }
    if(thresholds.blMax && blVenta > parseFloat(thresholds.blMax)){
      notify('Dólar blue alto', 'El blue subió a '+fmt(blVenta));
    }
    if(thresholds.gapPct && ofVenta && blVenta){
      const gap = ((ofVenta - blVenta) / blVenta) * 100;
      const limit = parseFloat(thresholds.gapPct);
      if(Math.abs(gap) >= limit){
        const direccion = gap > 0 ? 'más alto que' : 'más bajo que';
        notify('Brecha oficial/blue', 'El oficial quedó '+Math.abs(gap).toFixed(1)+'% '+direccion+' el blue');
      }
    }
  }

  function renderBoards(){
    const boards = document.getElementById('boards');
    const yesterdayClose = (arr) => arr.length > 1 ? arr[arr.length-2] : (arr.length ? arr[arr.length-1] : null);

    const ofPrev = yesterdayClose(oficialData);
    const blPrev = yesterdayClose(blueData);

    function boardHtml(cls, label, live, prevEntry){
      if(!live) return '<div class="board '+cls+'"><div class="board-label">'+label+'</div><div class="loading">Sin datos</div></div>';
      const change = prevEntry ? live.venta - prevEntry.venta : 0;
      const changeCls = change >= 0 ? 'up' : 'down';
      const changeSign = change >= 0 ? '+' : '';
      const hora = live.fechaActualizacion ? new Date(live.fechaActualizacion).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' }) : '';
      return '<div class="board '+cls+'">'
        + '<div class="board-label">'+label+'</div>'
        + '<div class="price-row">'
        +   '<span class="price">'+fmt(live.venta)+'</span>'
        +   (prevEntry ? '<span class="change '+changeCls+'">'+changeSign+fmt(change)+'</span>' : '')
        + '</div>'
        + '<div class="sub-line"><span>Compra '+fmt(live.compra)+'</span><span>'+hora+'</span></div>'
        + '</div>';
    }

    boards.innerHTML = boardHtml('oficial','Oficial', liveOficial, ofPrev) + boardHtml('blue','Blue', liveBlue, blPrev);
  }

  function buildSeries(range){
    const map = {};
    oficialData.forEach(d => { map[d.fecha] = map[d.fecha] || {}; map[d.fecha].oficial = d.venta; });
    blueData.forEach(d => { map[d.fecha] = map[d.fecha] || {}; map[d.fecha].blue = d.venta; });
    const dates = Object.keys(map).sort();
    const recent = dates.slice(-range);
    return {
      labels: recent.map(d => d.slice(5)),
      oficial: recent.map(d => map[d].oficial ?? null),
      blue: recent.map(d => map[d].blue ?? null),
    };
  }

  function renderChart(){
    const isIntraday = currentRange === 'hoy';
    const series = isIntraday ? getIntradaySeries() : buildSeries(currentRange);
    const ctx = document.getElementById('chart');
    if(chart) chart.destroy();
    chart = new Chart(ctx, {
      type:'line',
      data:{
        labels: series.labels,
        datasets:[
          {
            label:'Oficial',
            data: series.oficial,
            borderColor:'#d9a441',
            backgroundColor:'rgba(217,164,65,0.08)',
            borderWidth:2,
            pointRadius: isIntraday ? 5 : 2,
            pointHoverRadius: isIntraday ? 7 : 4,
            pointBackgroundColor:'#d9a441',
            tension: isIntraday ? 0 : 0.25,
            fill:true,
          },
          {
            label:'Blue',
            data: series.blue,
            borderColor:'#3fb897',
            backgroundColor:'rgba(63,184,151,0.08)',
            borderWidth:2,
            pointRadius: isIntraday ? 5 : 2,
            pointHoverRadius: isIntraday ? 7 : 4,
            pointBackgroundColor:'#3fb897',
            tension: isIntraday ? 0 : 0.25,
            fill:true,
          },
        ],
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{
          x:{ ticks:{ color:'#9a9689', maxRotation:0 }, grid:{ display:false } },
          y:{ ticks:{ color:'#9a9689' }, grid:{ color:'#2a2f3a' } },
        },
      },
    });
  }

  async function fetchRiesgoPais(){
    try{
      const res = await fetch(RIESGO_PAIS_URL);
      if(!res.ok) throw new Error('Respuesta no válida de riesgo país');
      const data = await res.json();
      document.getElementById('riesgoPais').innerHTML =
        'Riesgo país: <span class="rp-value">'+Math.round(data.valor)+' pb</span> · '+data.fecha;
    }catch(e){
      document.getElementById('riesgoPais').textContent = '';
      console.error(e);
    }
  }

  async function fetchHistorical(){
    const [ofRes, blRes] = await Promise.all([fetch(OFICIAL_URL), fetch(BLUE_URL)]);
    if(!ofRes.ok || !blRes.ok) throw new Error('Respuesta no válida de la API histórica');
    oficialData = await ofRes.json();
    blueData = await blRes.json();
    oficialData.sort((a,b)=>a.fecha.localeCompare(b.fecha));
    blueData.sort((a,b)=>a.fecha.localeCompare(b.fecha));
  }

  async function fetchLive(){
    const [ofRes, blRes] = await Promise.all([fetch(LIVE_OFICIAL_URL), fetch(LIVE_BLUE_URL)]);
    if(!ofRes.ok || !blRes.ok) throw new Error('Respuesta no válida de la API en vivo');
    liveOficial = await ofRes.json();
    liveBlue = await blRes.json();
    recordIntradaySnapshot(liveOficial.venta, liveBlue.venta);
  }

  async function fetchAll(){
    try{
      await Promise.all([fetchHistorical(), fetchLive(), fetchRiesgoPais()]);
      renderBoards();
      renderChart();
      refreshCalculator();
      renderGastos();
      if(liveOficial && liveBlue) checkThresholds(liveOficial.venta, liveBlue.venta);
    }catch(e){
      document.getElementById('boards').innerHTML = '<div class="err">No se pudo obtener la cotización ahora. Reintentá en un momento.</div>';
      console.error(e);
    }
  }

  document.getElementById('rangeToggle').addEventListener('click', (ev)=>{
    const btn = ev.target.closest('button[data-range]');
    if(!btn) return;
    document.querySelectorAll('#rangeToggle button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range === 'hoy' ? 'hoy' : parseInt(btn.dataset.range, 10);
    renderChart();
  });

  document.getElementById('saveThresholds').addEventListener('click', saveThresholds);

  document.getElementById('enableNotif').addEventListener('click', async ()=>{
    const statusEl = document.getElementById('notifStatus');
    if(!('Notification' in window)){
      statusEl.textContent = 'Notificaciones: no disponibles en este navegador';
      return;
    }
    try{
      const perm = await Notification.requestPermission();
      notifGranted = perm === 'granted';
      statusEl.textContent = notifGranted
        ? 'Notificaciones: activas'
        : 'Notificaciones: bloqueadas (vas a ver los avisos en el historial igual)';
    }catch(e){
      statusEl.textContent = 'Notificaciones: no se pudo pedir permiso';
    }
  });

  const GASTOS_KEY = 'dolar-tracker:movimientos';
  let movimientos = [];
  let gastoTipoSeleccionado = 'ingreso';
  let gastoMonedaSeleccionada = 'ARS';

  const fmtUsd = (n) => 'US$ ' + n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

  function initNav(){
    const menuBtn = document.getElementById('menuBtn');
    const navMenu = document.getElementById('navMenu');
    const pageTitle = document.getElementById('pageTitle');
    const pageEyebrow = document.getElementById('pageEyebrow');

    menuBtn.addEventListener('click', ()=>{
      const isHidden = navMenu.hasAttribute('hidden');
      if(isHidden){ navMenu.removeAttribute('hidden'); menuBtn.setAttribute('aria-expanded','true'); }
      else{ navMenu.setAttribute('hidden',''); menuBtn.setAttribute('aria-expanded','false'); }
    });

    navMenu.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('.nav-item');
      if(!btn) return;
      const view = btn.dataset.view;
      document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('view-cotizaciones').toggleAttribute('hidden', view !== 'cotizaciones');
      document.getElementById('view-gastos').toggleAttribute('hidden', view !== 'gastos');
      pageTitle.textContent = view === 'cotizaciones' ? 'Pizarra del dólar' : 'Mis gastos';
      pageEyebrow.textContent = view === 'cotizaciones' ? 'Cotizaciones · Argentina' : 'Tu ahorro';
      navMenu.setAttribute('hidden','');
      menuBtn.setAttribute('aria-expanded','false');
    });

    document.addEventListener('click', (ev)=>{
      if(navMenu.hasAttribute('hidden')) return;
      if(navMenu.contains(ev.target) || menuBtn.contains(ev.target)) return;
      navMenu.setAttribute('hidden','');
      menuBtn.setAttribute('aria-expanded','false');
    });
  }

  function initMovimientosSync(){
    movimientosRef.orderBy('fecha','desc').onSnapshot((snapshot)=>{
      movimientos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      renderGastos();
    }, (err)=> console.error('Error sincronizando movimientos', err));
  }

  function renderGastos(){
    const porMoneda = (moneda, tipo) => movimientos
      .filter(m => m.moneda === moneda && m.tipo === tipo)
      .reduce((s,m)=>s+m.monto,0);

    const ingresosArs = porMoneda('ARS','ingreso');
    const egresosArs = porMoneda('ARS','egreso');
    const totalArs = ingresosArs - egresosArs;

    const ingresosUsd = porMoneda('USD','ingreso');
    const egresosUsd = porMoneda('USD','egreso');
    const totalUsd = ingresosUsd - egresosUsd;

    document.getElementById('totalArs').textContent = fmt(totalArs);
    document.getElementById('ingresosArs').textContent = fmt(ingresosArs);
    document.getElementById('egresosArs').textContent = fmt(egresosArs);

    document.getElementById('totalUsd').textContent = fmtUsd(totalUsd);
    document.getElementById('ingresosUsd').textContent = fmtUsd(ingresosUsd);
    document.getElementById('egresosUsd').textContent = fmtUsd(egresosUsd);

    const rate = blueAvgRate();
    const combinadoEl = document.getElementById('gastosCombinado');
    combinadoEl.textContent = rate
      ? 'Combinado (pesos + dólares al blue promedio): ' + fmt(totalArs + totalUsd * rate)
      : '';

    const list = document.getElementById('gastoList');
    if(movimientos.length === 0){
      list.innerHTML = '<p class="log-empty">Todavía no cargaste movimientos.</p>';
      return;
    }
    const ordenados = movimientos;
    list.innerHTML = ordenados.map(m => {
      const sign = m.tipo === 'ingreso' ? '+' : '−';
      const montoFmt = m.moneda === 'USD' ? fmtUsd(m.monto) : fmt(m.monto);
      return '<div class="gasto-item '+m.tipo+'" data-id="'+m.id+'">'
        + '<div class="gasto-item-info">'
        +   '<span class="gasto-item-desc">'+m.desc+' <span class="gasto-item-moneda">'+m.moneda+'</span></span>'
        +   '<span class="gasto-item-date">'+m.fecha+'</span>'
        + '</div>'
        + '<div class="gasto-item-actions">'
        +   '<span class="gasto-item-amount">'+sign+' '+montoFmt+'</span>'
        +   '<button class="gasto-delete" data-id="'+m.id+'" aria-label="Eliminar movimiento">✕</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  function initGastos(){
    const form = document.getElementById('gastoForm');
    const typeToggle = document.getElementById('gastoTypeToggle');
    const monedaToggle = document.getElementById('gastoMonedaToggle');
    const fechaInput = document.getElementById('gastoFecha');
    fechaInput.value = new Date().toISOString().slice(0,10);

    typeToggle.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('.type-btn');
      if(!btn) return;
      gastoTipoSeleccionado = btn.dataset.type;
      typeToggle.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
    });

    monedaToggle.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('.type-btn');
      if(!btn) return;
      gastoMonedaSeleccionada = btn.dataset.moneda;
      monedaToggle.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('gastoMonto').placeholder = gastoMonedaSeleccionada === 'USD' ? 'Monto en USD' : 'Monto en ARS';
    });

    form.addEventListener('submit', (ev)=>{
      ev.preventDefault();
      const desc = document.getElementById('gastoDesc').value.trim();
      const monto = parseFloat(document.getElementById('gastoMonto').value);
      const fecha = fechaInput.value || new Date().toISOString().slice(0,10);
      if(!desc || !monto || monto <= 0) return;

      movimientosRef.add({ tipo: gastoTipoSeleccionado, moneda: gastoMonedaSeleccionada, desc, monto, fecha })
        .catch((e)=> console.error('No se pudo guardar el movimiento', e));
      form.reset();
      fechaInput.value = new Date().toISOString().slice(0,10);
    });

    document.getElementById('gastoList').addEventListener('click', (ev)=>{
      const btn = ev.target.closest('.gasto-delete');
      if(!btn) return;
      movimientosRef.doc(btn.dataset.id).delete()
        .catch((e)=> console.error('No se pudo eliminar el movimiento', e));
    });

    renderGastos();
  }

  function initBackup(){
    document.getElementById('exportBtn').addEventListener('click', ()=>{
      const payload = {
        exportado: new Date().toISOString(),
        movimientos,
        thresholds,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dolar-tracker-backup-' + todayKey() + '.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    const importInput = document.getElementById('importFile');
    document.getElementById('importBtn').addEventListener('click', ()=> importInput.click());

    importInput.addEventListener('change', async (ev)=>{
      const file = ev.target.files[0];
      if(!file) return;
      try{
        const text = await file.text();
        const data = JSON.parse(text);
        if(!Array.isArray(data.movimientos)) throw new Error('Archivo con formato inesperado');
        const batch = db.batch();
        data.movimientos.forEach(m => {
          const { id, ...resto } = m;
          const docRef = movimientosRef.doc();
          batch.set(docRef, resto);
        });
        await batch.commit();
        if(data.thresholds){
          await settingsRef.set(Object.assign({}, thresholds, data.thresholds));
        }
        alert('Se importaron '+data.movimientos.length+' movimiento(s).');
      }catch(e){
        alert('No se pudo leer el archivo. Verificá que sea un backup exportado desde esta misma app.');
        console.error(e);
      }
      importInput.value = '';
    });
  }

  initThresholdsSync();
  initCalculator();
  initNav();
  initMovimientosSync();
  initGastos();
  initBackup();
  fetchAll();
  setInterval(fetchAll, POLL_MS);
})();