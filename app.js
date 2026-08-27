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
  const productosRef = db.collection('productos');
  const alertasRef = db.collection('alertas');
  const settingsRef = db.collection('settings').doc('thresholds');

  const OFICIAL_URL = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial';
  const BLUE_URL = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/blue';
  const LIVE_OFICIAL_URL = 'https://dolarapi.com/v1/dolares/oficial';
  const LIVE_BLUE_URL = 'https://dolarapi.com/v1/dolares/blue';
  const RIESGO_PAIS_URL = 'https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo';
  const POLL_MS = 15 * 60 * 1000;
  const LOG_KEY = 'dolar-tracker:cotiz-log';
  const LOG_MAX_AGE_MS = 26 * 60 * 60 * 1000; // guardamos un poco más de 24hs de margen

  let oficialData = [];
  let blueData = [];
  let liveOficial = null;
  let liveBlue = null;
  let currentRange = 'ultimas24h';
  let chart = null;
  let thresholds = { ofMin:'', ofMax:'', blMin:'', blMax:'', gapPct:'', stockDiasAlerta:'' };

  const fmt = (n) => n == null ? '—' : n.toLocaleString('es-AR', { style:'currency', currency:'ARS', minimumFractionDigits:0, maximumFractionDigits:0 });
  const fmtUsd = (n) => 'US$ ' + n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

  function todayKey(){
    const d = new Date();
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }

  function isUltimoMes(fechaStr){
    if(!fechaStr) return false;
    const fecha = new Date(fechaStr + 'T00:00:00');
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    return fecha >= cutoff;
  }

  function readLog(){
    try{
      const raw = localStorage.getItem(LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    }catch(e){ return []; }
  }

  function recordSnapshot(ofVenta, blVenta){
    let log = readLog();
    const now = Date.now();
    log.push({ ts: now, oficial: ofVenta, blue: blVenta });
    const cutoff = now - LOG_MAX_AGE_MS;
    log = log.filter(entry => entry.ts >= cutoff);
    try{ localStorage.setItem(LOG_KEY, JSON.stringify(log)); }catch(e){ /* storage llena, ignorar */ }
  }

  function getUltimas24hSeries(){
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const recent = readLog()
      .filter(entry => entry.ts >= cutoff)
      .sort((a,b) => a.ts - b.ts);
    return {
      labels: recent.map(entry => new Date(entry.ts).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' })),
      oficial: recent.map(entry => entry.oficial),
      blue: recent.map(entry => entry.blue),
    };
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
    const stockDiasEl = document.getElementById('stockDiasAlerta');
    if(stockDiasEl) stockDiasEl.value = thresholds.stockDiasAlerta || '';
  }

  function initThresholdsSync(){
    settingsRef.onSnapshot((doc)=>{
      if(doc.exists){
        thresholds = Object.assign(thresholds, doc.data());
        applyThresholdsToInputs();
        renderStock();
        checkStockEstancado();
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
      stockDiasAlerta: document.getElementById('stockDiasAlerta') ? document.getElementById('stockDiasAlerta').value : (thresholds.stockDiasAlerta || ''),
    };
    settingsRef.set(thresholds)
      .then(()=>{
        ['saveThresholds','saveStockDias'].forEach(btnId=>{
          const btn = document.getElementById(btnId);
          if(!btn) return;
          const original = btn.textContent;
          btn.textContent = 'Guardado';
          setTimeout(()=>{ btn.textContent = original; }, 1500);
        });
      })
      .catch((e)=> console.error('No se pudieron guardar los umbrales', e));
  }

  let allAlertas = [];
  let swRegistration = null;

  async function initServiceWorker(){
    if(!('serviceWorker' in navigator)) return;
    try{
      swRegistration = await navigator.serviceWorker.register('sw.js');
    }catch(e){
      console.error('No se pudo registrar el service worker', e);
    }
  }

  function logAlert(msg, dedupeKey){
    const payload = {
      mensaje: msg,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if(dedupeKey){
      payload.dedupeKey = dedupeKey;
      // set() con el dedupeKey como ID: si dos pestañas chequean casi al mismo
      // tiempo, ambas escriben al mismo documento en vez de crear uno cada una.
      alertasRef.doc(dedupeKey).set(payload).catch((e)=> console.error('No se pudo guardar la alerta', e));
    }else{
      alertasRef.add(payload).catch((e)=> console.error('No se pudo guardar la alerta', e));
    }
  }

  function renderAlertas(){
    const lists = document.querySelectorAll('.alert-log-list');
    const html = allAlertas.length === 0
      ? '<p class="log-empty">Todavía no se disparó ninguna alerta.</p>'
      : allAlertas.map(a => {
          const time = (a.createdAt && typeof a.createdAt.toDate === 'function')
            ? a.createdAt.toDate().toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
            : 'Guardando…';
          return '<div class="log-item" data-id="'+a.id+'">'
            + '<span>'+a.mensaje+'</span>'
            + '<span class="log-time">'+time+'</span>'
            + '<button type="button" class="gasto-delete" data-id="'+a.id+'" aria-label="Eliminar alerta">✕</button>'
            + '</div>';
        }).join('');
    lists.forEach(list => { list.innerHTML = html; });
  }

  function initAlertasSync(){
    alertasRef.onSnapshot((snapshot)=>{
      const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      allAlertas = items.sort((a,b) => sortKeyMillis(b) - sortKeyMillis(a));
      renderAlertas();
    }, (err)=> console.error('Error sincronizando alertas', err));
  }

  function initAlertasDelete(){
    document.querySelectorAll('.alert-log-list').forEach(list => {
      list.addEventListener('click', (ev)=>{
        const btn = ev.target.closest('.gasto-delete');
        if(!btn) return;
        alertasRef.doc(btn.dataset.id).delete()
          .catch((e)=> console.error('No se pudo eliminar la alerta', e));
      });
    });
  }

  async function vaciarAlertas(){
    if(allAlertas.length === 0) return;
    const confirmado = window.confirm('¿Vaciar todo el historial de alertas? Esta acción no se puede deshacer.');
    if(!confirmado) return;
    try{
      const batch = db.batch();
      allAlertas.forEach(a => batch.delete(alertasRef.doc(a.id)));
      await batch.commit();
    }catch(e){
      console.error('No se pudo vaciar el historial de alertas', e);
    }
  }

  function initAlertasClear(){
    ['clearAlertas','clearAlertasNeg'].forEach(id => {
      const btn = document.getElementById(id);
      if(btn) btn.addEventListener('click', vaciarAlertas);
    });
  }

  function notify(title, body, dedupeKey){
    if('Notification' in window && Notification.permission === 'granted'){
      if(swRegistration && swRegistration.showNotification){
        // Método compatible con Android: requiere un service worker registrado.
        swRegistration.showNotification(title, { body }).catch(()=>{
          try{ new Notification(title, { body }); }catch(e){ /* solo queda el historial */ }
        });
      }else{
        // Sin service worker (o navegadores que no lo requieren): método clásico.
        try{ new Notification(title, { body }); }catch(e){ /* solo queda el historial */ }
      }
    }
    logAlert(body, dedupeKey);
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

  function diasEnStockDe(producto){
    if(!producto || !producto.fechaCompra) return null;
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const fCompra = new Date(producto.fechaCompra + 'T00:00:00');
    return Math.floor((hoy - fCompra) / (24*60*60*1000));
  }

  // Avisa como máximo una vez por día por artículo. El "ya avisé hoy" se guarda
  // en Firebase (no en localStorage) usando el dedupeKey como ID del documento,
  // para que no se duplique entre pestañas o dispositivos distintos.
  function checkStockEstancado(){
    const limite = parseInt(thresholds.stockDiasAlerta, 10);
    if(!limite || limite <= 0) return;
    const hoyKey = todayKey();
    allProductos
      .filter(p => p.estado !== 'vendido')
      .forEach(p => {
        const dias = diasEnStockDe(p);
        if(dias == null || dias < limite) return;
        const dedupeKey = 'stock_' + p.id + '_' + hoyKey;
        const yaAvisado = allAlertas.some(a => a.dedupeKey === dedupeKey);
        if(!yaAvisado){
          notify('Stock estancado', '"'+p.nombre+'" lleva '+dias+' día'+(dias===1?'':'s')+' en stock sin vender.', dedupeKey);
        }
      });
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
    const isIntraday = currentRange === 'ultimas24h';
    const series = isIntraday ? getUltimas24hSeries() : buildSeries(currentRange);

    const noteEl = document.getElementById('chartNote');
    if(isIntraday){
      const n = series.labels.length;
      if(n === 0){
        noteEl.textContent = 'Todavía no hay puntos registrados. Se va a ir completando a medida que uses la app (o cada 15 minutos si la dejás abierta).';
      }else if(n < 6){
        noteEl.textContent = 'Llevás ' + n + ' punto' + (n === 1 ? '' : 's') + ' registrado' + (n === 1 ? '' : 's') + ' en esta ventana de 24hs. Se va completando con el uso, no es un dato histórico ya cargado.';
      }else{
        noteEl.textContent = '';
      }
    }else{
      noteEl.textContent = '';
    }
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
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{ display:false },
          tooltip:{
            mode:'index', intersect:false,
            callbacks:{
              label:(ctx)=>{
                const v = ctx.parsed.y;
                return ctx.dataset.label + ': ' + (v == null ? '—' : fmt(v));
              },
            },
          },
        },
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
    recordSnapshot(liveOficial.venta, liveBlue.venta);
  }

  async function fetchAll(){
    try{
      await Promise.all([fetchHistorical(), fetchLive(), fetchRiesgoPais()]);
      renderBoards();
      renderChart();
      refreshCalculator();
      ahorrosController.render();
      gastosController.render();
      negocioController.render();
      renderNegocioChart();
      renderPatrimonio();
      if(liveOficial && liveBlue) checkThresholds(liveOficial.venta, liveBlue.venta);
      checkStockEstancado();
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
    currentRange = btn.dataset.range === 'ultimas24h' ? 'ultimas24h' : parseInt(btn.dataset.range, 10);
    renderChart();
  });

  document.getElementById('saveThresholds').addEventListener('click', saveThresholds);
  document.getElementById('saveStockDias').addEventListener('click', saveThresholds);

  function updateNotifStatusText(){
    const statusEl = document.getElementById('notifStatus');
    const btn = document.getElementById('enableNotif');
    if(!statusEl) return;
    if(!('Notification' in window)){
      statusEl.textContent = 'Notificaciones: no disponibles en este navegador';
      if(btn) btn.setAttribute('hidden','');
    }else if(Notification.permission === 'granted'){
      statusEl.textContent = 'Notificaciones: activas. Para desactivarlas, hacelo desde la configuración de notificaciones del sitio en tu navegador (no se puede desde acá).';
      if(btn) btn.setAttribute('hidden','');
    }else if(Notification.permission === 'denied'){
      statusEl.textContent = 'Notificaciones: bloqueadas por el navegador. Para activarlas, habilitalas a mano en la configuración del sitio (tocar el botón no alcanza).';
      if(btn) btn.setAttribute('hidden','');
    }else{
      statusEl.textContent = 'Notificaciones: sin activar';
      if(btn) btn.removeAttribute('hidden');
    }
  }

  document.getElementById('enableNotif').addEventListener('click', async ()=>{
    if(!('Notification' in window)){
      updateNotifStatusText();
      return;
    }
    try{
      await Notification.requestPermission();
    }catch(e){ /* el estado real se refleja igual abajo */ }
    updateNotifStatusText();
  });

  // ---------- Movimientos: Ahorros y Gastos (dos billeteras independientes) ----------

  let allMovimientos = [];

  // Los movimientos viejos no tienen campo "seccion": se tratan como "ahorro"
  // para no perder nada de lo que ya venías cargando.
  function getSeccion(m){
    if(m.seccion === 'gasto') return 'gasto';
    if(m.seccion === 'negocio') return 'negocio';
    return 'ahorro';
  }

  // Momento exacto de carga, para desempatar movimientos del mismo día.
  // - Sin campo createdAt (movimientos viejos): se tratan como lo más antiguo.
  // - createdAt en null (escritura recién enviada, todavía no confirmada por el
  //   servidor): se trata como "ahora", para que aparezca arriba al instante.
  function sortKeyMillis(m){
    if(m.createdAt === undefined) return 0;
    if(m.createdAt === null) return Date.now();
    if(typeof m.createdAt.toMillis === 'function') return m.createdAt.toMillis();
    return 0;
  }

  function ordenarMovimientos(movs){
    return movs.slice().sort((a,b) => {
      const fa = a.fecha || '';
      const fb = b.fecha || '';
      if(fa !== fb) return fb.localeCompare(fa); // fecha más reciente primero
      return sortKeyMillis(b) - sortKeyMillis(a); // dentro del mismo día, lo cargado último primero
    });
  }

  const SECCION_IDS = {
    ahorro: {
      totalArs:'totalArs', ingresosArs:'ingresosArs', egresosArs:'egresosArs',
      totalUsd:'totalUsd', ingresosUsd:'ingresosUsd', egresosUsd:'egresosUsd',
      combinado:'gastosCombinado', list:'gastoList',
      form:'gastoForm', monedaToggle:'gastoMonedaToggle', typeToggle:'gastoTypeToggle',
      desc:'gastoDesc', monto:'gastoMonto', fecha:'gastoFecha',
      exportBtn:'exportBtn', importBtn:'importBtn', importFile:'importFile',
      arsEquiv:'arsEquivUsd', usdEquiv:'usdEquivArs',
    },
    gasto: {
      totalArs:'totalArsMes', ingresosArs:'ingresosArsMes', egresosArs:'egresosArsMes',
      totalUsd:'totalUsdMes', ingresosUsd:'ingresosUsdMes', egresosUsd:'egresosUsdMes',
      combinado:'gastosCombinadoMes', list:'gastoListMes',
      form:'gastoFormMes', monedaToggle:'gastoMonedaToggleMes', typeToggle:'gastoTypeToggleMes',
      desc:'gastoDescMes', monto:'gastoMontoMes', fecha:'gastoFechaMes',
      exportBtn:'exportBtnMes', importBtn:'importBtnMes', importFile:'importFileMes',
    },
    negocio: {
      totalArs:'totalArsNeg', ingresosArs:'ingresosArsNeg', egresosArs:'egresosArsNeg',
      totalUsd:'totalUsdNeg', ingresosUsd:'ingresosUsdNeg', egresosUsd:'egresosUsdNeg',
      combinado:'gastosCombinadoNeg', list:'gastoListNeg',
      form:'gastoFormNeg', monedaToggle:'gastoMonedaToggleNeg', typeToggle:'gastoTypeToggleNeg',
      desc:'gastoDescNeg', monto:'gastoMontoNeg', fecha:'gastoFechaNeg',
      exportBtn:'exportBtnNeg', importBtn:'importBtnNeg', importFile:'importFileNeg',
      arsEquiv:'arsEquivUsdNeg', usdEquiv:'usdEquivArsNeg',
    },
  };

  function crearControladorSeccion(seccionKey, ids){
    let tipoSeleccionado = 'ingreso';
    let monedaSeleccionada = 'ARS';

    function movimientosDeSeccion(){
      return allMovimientos.filter(m => getSeccion(m) === seccionKey);
    }

    function render(){
      const movs = movimientosDeSeccion();
      const porMoneda = (moneda, tipo) => movs
        .filter(m => m.moneda === moneda && m.tipo === tipo)
        .reduce((s,m)=>s+m.monto,0);
      const porMonedaUltimoMes = (moneda, tipo) => movs
        .filter(m => m.moneda === moneda && m.tipo === tipo && isUltimoMes(m.fecha))
        .reduce((s,m)=>s+m.monto,0);

      // Balance total: con todo el historial de esta sección
      const totalArs = porMoneda('ARS','ingreso') - porMoneda('ARS','egreso');
      const totalUsd = porMoneda('USD','ingreso') - porMoneda('USD','egreso');

      // Ingresos/Egresos mostrados: solo últimos 30 días
      const ingresosArs = porMonedaUltimoMes('ARS','ingreso');
      const egresosArs = porMonedaUltimoMes('ARS','egreso');
      const ingresosUsd = porMonedaUltimoMes('USD','ingreso');
      const egresosUsd = porMonedaUltimoMes('USD','egreso');

      document.getElementById(ids.totalArs).textContent = fmt(totalArs);
      document.getElementById(ids.ingresosArs).textContent = fmt(ingresosArs);
      document.getElementById(ids.egresosArs).textContent = fmt(egresosArs);

      document.getElementById(ids.totalUsd).textContent = fmtUsd(totalUsd);
      document.getElementById(ids.ingresosUsd).textContent = fmtUsd(ingresosUsd);
      document.getElementById(ids.egresosUsd).textContent = fmtUsd(egresosUsd);

      const rate = blueAvgRate();

      // Equivalencia cruzada: cuánto valen los pesos en dólares y viceversa,
      // al tipo de cambio blue promedio de hoy.
      if(ids.arsEquiv){
        const arsEquivEl = document.getElementById(ids.arsEquiv);
        if(arsEquivEl) arsEquivEl.textContent = rate ? '≈ ' + fmtUsd(totalArs / rate) : '';
      }
      if(ids.usdEquiv){
        const usdEquivEl = document.getElementById(ids.usdEquiv);
        if(usdEquivEl) usdEquivEl.textContent = rate ? '≈ ' + fmt(totalUsd * rate) : '';
      }

      const combinadoEl = document.getElementById(ids.combinado);
      combinadoEl.textContent = rate
        ? 'Total ahorrado (pesos + dólares al blue promedio): ' + fmt(totalArs + totalUsd * rate)
        : '';

      const list = document.getElementById(ids.list);
      if(movs.length === 0){
        list.innerHTML = '<p class="log-empty">Todavía no cargaste movimientos.</p>';
        return;
      }
      list.innerHTML = movs.map(m => {
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

    function initForm(){
      const form = document.getElementById(ids.form);
      const typeToggle = document.getElementById(ids.typeToggle);
      const monedaToggle = document.getElementById(ids.monedaToggle);
      const fechaInput = document.getElementById(ids.fecha);
      fechaInput.value = new Date().toISOString().slice(0,10);

      typeToggle.addEventListener('click', (ev)=>{
        const btn = ev.target.closest('.type-btn');
        if(!btn) return;
        tipoSeleccionado = btn.dataset.type;
        typeToggle.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
      });

      monedaToggle.addEventListener('click', (ev)=>{
        const btn = ev.target.closest('.type-btn');
        if(!btn) return;
        monedaSeleccionada = btn.dataset.moneda;
        monedaToggle.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(ids.monto).placeholder = monedaSeleccionada === 'USD' ? 'Monto en USD' : 'Monto en ARS';
      });

      form.addEventListener('submit', (ev)=>{
        ev.preventDefault();
        const desc = document.getElementById(ids.desc).value.trim();
        const monto = parseFloat(document.getElementById(ids.monto).value);
        const fecha = fechaInput.value || new Date().toISOString().slice(0,10);
        if(!desc || !monto || monto <= 0) return;

        movimientosRef.add({
          tipo: tipoSeleccionado, moneda: monedaSeleccionada, desc, monto, fecha, seccion: seccionKey,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        }).catch((e)=> console.error('No se pudo guardar el movimiento', e));
        form.reset();
        fechaInput.value = new Date().toISOString().slice(0,10);
      });

      document.getElementById(ids.list).addEventListener('click', (ev)=>{
        const btn = ev.target.closest('.gasto-delete');
        if(!btn) return;
        const confirmado = window.confirm('¿Estás seguro que desea eliminar este movimiento?');
        if(!confirmado) return;
        movimientosRef.doc(btn.dataset.id).delete()
          .catch((e)=> console.error('No se pudo eliminar el movimiento', e));
      });
    }

    function initBackup(){
      document.getElementById(ids.exportBtn).addEventListener('click', ()=>{
        const payload = {
          exportado: new Date().toISOString(),
          seccion: seccionKey,
          movimientos: movimientosDeSeccion(),
          thresholds,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'dolar-tracker-'+seccionKey+'-backup-' + todayKey() + '.json';
        a.click();
        URL.revokeObjectURL(url);
      });

      const importInput = document.getElementById(ids.importFile);
      document.getElementById(ids.importBtn).addEventListener('click', ()=> importInput.click());

      importInput.addEventListener('change', async (ev)=>{
        const file = ev.target.files[0];
        if(!file) return;
        try{
          const text = await file.text();
          const data = JSON.parse(text);
          if(!Array.isArray(data.movimientos)) throw new Error('Archivo con formato inesperado');
          const batch = db.batch();
          data.movimientos.forEach(m => {
            const { id, seccion, createdAt, ...resto } = m;
            const docRef = movimientosRef.doc();
            batch.set(docRef, Object.assign({}, resto, {
              seccion: seccionKey,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            }));
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

    return { render, initForm, initBackup };
  }

  const ahorrosController = crearControladorSeccion('ahorro', SECCION_IDS.ahorro);
  const gastosController = crearControladorSeccion('gasto', SECCION_IDS.gasto);
  const negocioController = crearControladorSeccion('negocio', SECCION_IDS.negocio);

  // ---------- Reventa: stock de artículos (paletas, bolsos, zapatillas, accesorios) ----------

  let allProductos = [];
  let productoMonedaSeleccionada = 'ARS';
  let ventaProductoId = null;

  function ordenarProductos(items){
    return items.slice().sort((a,b) => {
      const fa = a.fechaCompra || '';
      const fb = b.fechaCompra || '';
      if(fa !== fb) return fb.localeCompare(fa);
      return sortKeyMillis(b) - sortKeyMillis(a);
    });
  }

  function renderStock(){
    const enStock = allProductos.filter(p => p.estado !== 'vendido');
    const vendidos = allProductos.filter(p => p.estado === 'vendido');

    const sumBy = (arr, moneda, field) => arr
      .filter(p => p.moneda === moneda)
      .reduce((s,p) => s + (p[field] || 0), 0);

    const stockArs = sumBy(enStock, 'ARS', 'costo');
    const stockUsd = sumBy(enStock, 'USD', 'costo');

    const gananciaArs = vendidos
      .filter(p => p.moneda === 'ARS')
      .reduce((s,p) => s + ((p.precioVenta || 0) - (p.costo || 0)), 0);
    const gananciaUsd = vendidos
      .filter(p => p.moneda === 'USD')
      .reduce((s,p) => s + ((p.precioVenta || 0) - (p.costo || 0)), 0);

    const stockInvertidoEl = document.getElementById('stockInvertido');
    if(stockInvertidoEl){
      stockInvertidoEl.textContent = 'Invertido en stock actual: ' + fmt(stockArs) + ' + ' + fmtUsd(stockUsd);
    }
    const gananciaEl = document.getElementById('gananciaRealizada');
    if(gananciaEl){
      gananciaEl.textContent = 'Ganancia realizada (vendido): ' + fmt(gananciaArs) + ' + ' + fmtUsd(gananciaUsd);
    }

    const stockListEl = document.getElementById('stockList');
    if(stockListEl){
      if(enStock.length === 0){
        stockListEl.innerHTML = '<p class="log-empty">Todavía no cargaste artículos en stock.</p>';
      }else{
        const limiteDias = parseInt(thresholds.stockDiasAlerta, 10);
        stockListEl.innerHTML = enStock.map(p => {
          const montoFmt = p.moneda === 'USD' ? fmtUsd(p.costo) : fmt(p.costo);
          const dias = diasEnStockDe(p);
          let diasTexto = '';
          if(dias != null){
            const diasLabel = dias+' día'+(dias===1?'':'s')+' en stock';
            const estancado = limiteDias && dias >= limiteDias;
            diasTexto = ' · ' + (estancado ? '<span class="egr">'+diasLabel+'</span>' : diasLabel);
          }
          return '<div class="gasto-item egreso" data-id="'+p.id+'">'
            + '<div class="gasto-item-info">'
            +   '<span class="gasto-item-desc">'+p.nombre+' <span class="gasto-item-moneda">'+p.moneda+'</span></span>'
            +   '<span class="gasto-item-date">Comprado '+(p.fechaCompra||'')+' · Costo '+montoFmt+diasTexto+'</span>'
            + '</div>'
            + '<div class="gasto-item-actions">'
            +   '<button type="button" class="ghost vender-btn" data-id="'+p.id+'">Vender</button>'
            +   '<button type="button" class="gasto-delete" data-id="'+p.id+'" aria-label="Eliminar artículo">✕</button>'
            + '</div>'
            + '</div>';
        }).join('');
      }
    }

    const vendidosListEl = document.getElementById('vendidosList');
    if(vendidosListEl){
      if(vendidos.length === 0){
        vendidosListEl.innerHTML = '<p class="log-empty">Todavía no vendiste nada.</p>';
      }else{
        vendidosListEl.innerHTML = vendidos.map(p => {
          const costoFmt = p.moneda === 'USD' ? fmtUsd(p.costo) : fmt(p.costo);
          const ventaFmt = p.moneda === 'USD' ? fmtUsd(p.precioVenta || 0) : fmt(p.precioVenta || 0);
          const ganancia = (p.precioVenta || 0) - (p.costo || 0);
          const gananciaFmt = p.moneda === 'USD' ? fmtUsd(Math.abs(ganancia)) : fmt(Math.abs(ganancia));
          const sign = ganancia >= 0 ? '+' : '−';
          return '<div class="gasto-item ingreso" data-id="'+p.id+'">'
            + '<div class="gasto-item-info">'
            +   '<span class="gasto-item-desc">'+p.nombre+' <span class="gasto-item-moneda">'+p.moneda+'</span></span>'
            +   '<span class="gasto-item-date">Vendido '+(p.fechaVenta||'')+' · '+costoFmt+' → '+ventaFmt+'</span>'
            + '</div>'
            + '<div class="gasto-item-actions">'
            +   '<span class="gasto-item-amount">'+sign+' '+gananciaFmt+'</span>'
            +   '<button type="button" class="gasto-delete" data-id="'+p.id+'" aria-label="Eliminar artículo">✕</button>'
            + '</div>'
            + '</div>';
        }).join('');
      }
    }
  }

  function initProductosSync(){
    productosRef.onSnapshot((snapshot)=>{
      const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      allProductos = ordenarProductos(items);
      renderStock();
      checkStockEstancado();
      renderAhorrosChart();
      renderPatrimonio();
    }, (err)=> console.error('Error sincronizando productos', err));
  }

  async function eliminarProducto(id){
    const p = allProductos.find(x => x.id === id);
    if(!p) return;
    const incluyeVenta = p.estado === 'vendido';
    const confirmado = window.confirm(
      '¿Eliminar "'+p.nombre+'"? Esto también borra el/los movimiento(s) de caja asociados (compra'
      + (incluyeVenta ? ' y venta' : '') + ') y el historial de alertas de stock estancado de este artículo.'
    );
    if(!confirmado) return;
    try{
      const batch = db.batch();
      if(p.movCompraId) batch.delete(movimientosRef.doc(p.movCompraId));
      if(p.movVentaId) batch.delete(movimientosRef.doc(p.movVentaId));
      batch.delete(productosRef.doc(id));
      // Limpia también las alertas de "stock estancado" ya disparadas para este
      // artículo puntual, para que no queden huérfanas en el historial.
      const prefijo = 'stock_' + id + '_';
      allAlertas
        .filter(a => a.dedupeKey && a.dedupeKey.indexOf(prefijo) === 0)
        .forEach(a => batch.delete(alertasRef.doc(a.id)));
      await batch.commit();
    }catch(e){
      console.error('No se pudo eliminar el artículo', e);
    }
  }

  function initStockForm(){
    const monedaToggle = document.getElementById('productoMonedaToggle');
    const nombreInput = document.getElementById('productoNombre');
    const costoInput = document.getElementById('productoCosto');
    const fechaInput = document.getElementById('productoFecha');
    const form = document.getElementById('productoForm');
    if(!form) return;

    fechaInput.value = new Date().toISOString().slice(0,10);

    monedaToggle.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('.type-btn');
      if(!btn) return;
      productoMonedaSeleccionada = btn.dataset.moneda;
      monedaToggle.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      costoInput.placeholder = productoMonedaSeleccionada === 'USD' ? 'Costo en USD' : 'Costo en ARS';
    });

    form.addEventListener('submit', async (ev)=>{
      ev.preventDefault();
      const nombre = nombreInput.value.trim();
      const costo = parseFloat(costoInput.value);
      const fechaCompra = fechaInput.value || new Date().toISOString().slice(0,10);
      if(!nombre || !costo || costo <= 0) return;
      try{
        const movRef = await movimientosRef.add({
          tipo:'egreso', moneda: productoMonedaSeleccionada, desc:'Compra stock: '+nombre,
          monto: costo, fecha: fechaCompra, seccion:'negocio',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        await productosRef.add({
          nombre, moneda: productoMonedaSeleccionada, costo, fechaCompra, estado:'stock',
          movCompraId: movRef.id, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        form.reset();
        fechaInput.value = new Date().toISOString().slice(0,10);
        productoMonedaSeleccionada = 'ARS';
        monedaToggle.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
        monedaToggle.querySelector('[data-moneda="ARS"]').classList.add('active');
        costoInput.placeholder = 'Costo';
      }catch(e){
        console.error('No se pudo agregar el artículo', e);
      }
    });
  }

  function initVentaPanel(){
    const stockListEl = document.getElementById('stockList');
    const vendidosListEl = document.getElementById('vendidosList');
    const panel = document.getElementById('ventaPanel');
    const panelNombre = document.getElementById('ventaPanelNombre');
    const precioInput = document.getElementById('ventaPrecio');
    const fechaInput = document.getElementById('ventaFecha');
    const confirmarBtn = document.getElementById('ventaConfirmar');
    const cancelarBtn = document.getElementById('ventaCancelar');
    if(!stockListEl || !panel) return;

    function cerrarPanel(){
      ventaProductoId = null;
      panel.setAttribute('hidden','');
    }

    stockListEl.addEventListener('click', (ev)=>{
      const venderBtn = ev.target.closest('.vender-btn');
      if(venderBtn){
        const p = allProductos.find(x => x.id === venderBtn.dataset.id);
        if(!p) return;
        ventaProductoId = p.id;
        const costoFmt = p.moneda === 'USD' ? fmtUsd(p.costo) : fmt(p.costo);
        panelNombre.textContent = p.nombre + ' (' + p.moneda + ') · costo ' + costoFmt;
        precioInput.value = '';
        fechaInput.value = new Date().toISOString().slice(0,10);
        panel.removeAttribute('hidden');
        precioInput.focus();
        return;
      }
      const delBtn = ev.target.closest('.gasto-delete');
      if(delBtn) eliminarProducto(delBtn.dataset.id);
    });

    vendidosListEl.addEventListener('click', (ev)=>{
      const delBtn = ev.target.closest('.gasto-delete');
      if(delBtn) eliminarProducto(delBtn.dataset.id);
    });

    cancelarBtn.addEventListener('click', cerrarPanel);

    confirmarBtn.addEventListener('click', async ()=>{
      if(!ventaProductoId) return;
      const p = allProductos.find(x => x.id === ventaProductoId);
      if(!p) return;
      const precioVenta = parseFloat(precioInput.value);
      const fechaVenta = fechaInput.value || new Date().toISOString().slice(0,10);
      if(precioVenta === '' || isNaN(precioVenta) || precioVenta < 0){
        alert('Ingresá un precio de venta válido.');
        return;
      }
      try{
        const movRef = await movimientosRef.add({
          tipo:'ingreso', moneda: p.moneda, desc:'Venta: '+p.nombre,
          monto: precioVenta, fecha: fechaVenta, seccion:'negocio',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        await productosRef.doc(p.id).update({
          estado:'vendido', precioVenta, fechaVenta, movVentaId: movRef.id,
        });
        cerrarPanel();
      }catch(e){
        console.error('No se pudo registrar la venta', e);
      }
    });
  }

  // ---------- Patrimonio total (Ahorros + caja Paletas + stock invertido en Paletas) ----------

  function renderPatrimonio(){
    const totalEl = document.getElementById('patrimonioTotal');
    const breakdownEl = document.getElementById('patrimonioBreakdown');
    if(!totalEl) return;

    const sumaMovs = (seccion, moneda) => allMovimientos
      .filter(m => getSeccion(m) === seccion && m.moneda === moneda)
      .reduce((s,m) => s + (m.tipo === 'ingreso' ? m.monto : -m.monto), 0);

    const ahorroArs = sumaMovs('ahorro', 'ARS');
    const ahorroUsd = sumaMovs('ahorro', 'USD');
    const negocioArs = sumaMovs('negocio', 'ARS');
    const negocioUsd = sumaMovs('negocio', 'USD');

    const enStock = allProductos.filter(p => p.estado !== 'vendido');
    const stockArs = enStock.filter(p => p.moneda === 'ARS').reduce((s,p) => s + (p.costo || 0), 0);
    const stockUsd = enStock.filter(p => p.moneda === 'USD').reduce((s,p) => s + (p.costo || 0), 0);

    const totalArs = ahorroArs + negocioArs + stockArs;
    const totalUsd = ahorroUsd + negocioUsd + stockUsd;
    const rate = blueAvgRate();

    totalEl.textContent = rate
      ? fmt(totalArs + totalUsd * rate)
      : fmt(totalArs) + ' + ' + fmtUsd(totalUsd);

    breakdownEl.textContent = 'Ahorros: ' + fmt(ahorroArs) + ' + ' + fmtUsd(ahorroUsd)
      + ' · Caja Paletas: ' + fmt(negocioArs) + ' + ' + fmtUsd(negocioUsd)
      + ' · Stock Paletas: ' + fmt(stockArs) + ' + ' + fmtUsd(stockUsd);
  }

  function initMovimientosSync(){
    movimientosRef.onSnapshot((snapshot)=>{
      const movs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      allMovimientos = ordenarMovimientos(movs);
      ahorrosController.render();
      gastosController.render();
      negocioController.render();
      renderAhorrosChart();
      renderNegocioChart();
      renderPatrimonio();
    }, (err)=> console.error('Error sincronizando movimientos', err));
  }

  // ---------- Gráfico de evolución de Ahorros (60 días o historia completa) ----------

  let ahorrosChart = null;
  let negocioChart = null;
  let currentNegocioRange = 30;
  let currentAhorrosRange = 60;

  function buildAhorrosSeries(range){
    const movs = allMovimientos.filter(m => getSeccion(m) === 'ahorro');
    const today = new Date(); today.setHours(0,0,0,0);

    let startDate;
    if(range === 'all'){
      const fechas = movs.map(m => m.fecha).filter(Boolean).sort();
      startDate = fechas.length ? new Date(fechas[0] + 'T00:00:00') : today;
    }else{
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (range - 1));
    }
    if(startDate > today) startDate = new Date(today);

    const rateForDate = buildBlueRateLookup();

    // Saldo acumulado justo antes del inicio de la ventana
    let runningArs = 0, runningUsd = 0;
    movs.forEach(m => {
      const f = new Date(m.fecha + 'T00:00:00');
      if(f < startDate){
        const sign = m.tipo === 'ingreso' ? 1 : -1;
        if(m.moneda === 'ARS') runningArs += sign * m.monto;
        else runningUsd += sign * m.monto;
      }
    });

    // Movimientos agrupados por día dentro de la ventana
    const byDate = {};
    movs.forEach(m => {
      const f = new Date(m.fecha + 'T00:00:00');
      if(f >= startDate && f <= today){
        byDate[m.fecha] = byDate[m.fecha] || { ars:0, usd:0 };
        const sign = m.tipo === 'ingreso' ? 1 : -1;
        if(m.moneda === 'ARS') byDate[m.fecha].ars += sign * m.monto;
        else byDate[m.fecha].usd += sign * m.monto;
      }
    });

    // Valor de stock de Paletas por día: entra al costo en la fecha de compra,
    // sale al mismo costo en la fecha de venta (si ya se vendió).
    const stockEventos = {};
    allProductos.forEach(p => {
      if(!p.fechaCompra || !p.costo) return;
      stockEventos[p.fechaCompra] = stockEventos[p.fechaCompra] || { ars:0, usd:0 };
      if(p.moneda === 'USD') stockEventos[p.fechaCompra].usd += p.costo;
      else stockEventos[p.fechaCompra].ars += p.costo;
      if(p.estado === 'vendido' && p.fechaVenta){
        stockEventos[p.fechaVenta] = stockEventos[p.fechaVenta] || { ars:0, usd:0 };
        if(p.moneda === 'USD') stockEventos[p.fechaVenta].usd -= p.costo;
        else stockEventos[p.fechaVenta].ars -= p.costo;
      }
    });
    let runningStockArs = 0, runningStockUsd = 0;
    Object.keys(stockEventos).forEach(fecha => {
      const f = new Date(fecha + 'T00:00:00');
      if(f < startDate){
        runningStockArs += stockEventos[fecha].ars;
        runningStockUsd += stockEventos[fecha].usd;
      }
    });

    // Caja de Paletas (aportes, ventas, retiros, gastos) por día — se suma al
    // valor de stock para que la línea de Paletas represente el total real
    // (plata líquida + mercadería sin vender), no solo el stock.
    const negocioMovs = allMovimientos.filter(m => getSeccion(m) === 'negocio');
    let runningCajaArs = 0, runningCajaUsd = 0;
    negocioMovs.forEach(m => {
      const f = new Date(m.fecha + 'T00:00:00');
      if(f < startDate){
        const sign = m.tipo === 'ingreso' ? 1 : -1;
        if(m.moneda === 'ARS') runningCajaArs += sign * m.monto;
        else runningCajaUsd += sign * m.monto;
      }
    });
    const byDateCaja = {};
    negocioMovs.forEach(m => {
      const f = new Date(m.fecha + 'T00:00:00');
      if(f >= startDate && f <= today){
        byDateCaja[m.fecha] = byDateCaja[m.fecha] || { ars:0, usd:0 };
        const sign = m.tipo === 'ingreso' ? 1 : -1;
        if(m.moneda === 'ARS') byDateCaja[m.fecha].ars += sign * m.monto;
        else byDateCaja[m.fecha].usd += sign * m.monto;
      }
    });

    const days = Math.round((today - startDate) / (24*60*60*1000)) + 1;
    const labels = [];
    const arsSeries = [];
    const usdSeries = [];
    const paletasPesosSeries = [];
    for(let i = 0; i < days; i++){
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const key = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      if(byDate[key]){
        runningArs += byDate[key].ars;
        runningUsd += byDate[key].usd;
      }
      if(stockEventos[key]){
        runningStockArs += stockEventos[key].ars;
        runningStockUsd += stockEventos[key].usd;
      }
      if(byDateCaja[key]){
        runningCajaArs += byDateCaja[key].ars;
        runningCajaUsd += byDateCaja[key].usd;
      }
      const rate = rateForDate(key) ?? blueAvgRate() ?? 0;
      labels.push(range === 'all' && days > 120 ? key.slice(2) : key.slice(5));
      arsSeries.push(runningArs);
      usdSeries.push(runningUsd);
      const stockPesos = runningStockArs + runningStockUsd * rate;
      const cajaPesos = runningCajaArs + runningCajaUsd * rate;
      paletasPesosSeries.push(stockPesos + cajaPesos);
    }
    return { labels, arsSeries, usdSeries, paletasPesosSeries };
  }

  function renderAhorrosChart(){
    const canvas = document.getElementById('ahorrosChart');
    if(!canvas) return;
    const series = buildAhorrosSeries(currentAhorrosRange);
    if(ahorrosChart) ahorrosChart.destroy();
    ahorrosChart = new Chart(canvas, {
      type:'line',
      data:{
        labels: series.labels,
        datasets:[
          {
            label:'Ahorros (pesos)',
            data: series.arsSeries,
            borderColor:'#d9a441',
            backgroundColor:'rgba(217,164,65,0.08)',
            borderWidth:2,
            pointRadius:0,
            tension:0.25,
            fill:true,
            yAxisID:'y',
          },
          {
            label:'Ahorros (dólares)',
            data: series.usdSeries,
            borderColor:'#3fb897',
            backgroundColor:'rgba(63,184,151,0.08)',
            borderWidth:2,
            pointRadius:0,
            tension:0.25,
            fill:true,
            yAxisID:'y1',
          },
          {
            label:'Paletas (caja + stock)',
            data: series.paletasPesosSeries,
            borderColor:'#218ad9',
            backgroundColor:'rgba(58, 99, 166, 0.06)',
            borderWidth:2,
            borderDash:[6,4],
            pointRadius:0,
            tension:0.25,
            fill:true,
            yAxisID:'y',
          },
        ],
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{ display:false },
          tooltip:{
            mode:'index', intersect:false,
            callbacks:{
              label:(ctx)=>{
                const v = ctx.parsed.y;
                const esUsd = ctx.dataset.label.indexOf('dólares') !== -1;
                const formatear = esUsd ? fmtUsd : fmt;
                return ctx.dataset.label + ': ' + (v == null ? '—' : formatear(v));
              },
            },
          },
        },
        scales:{
          x:{ ticks:{ color:'#9a9689', maxRotation:0, autoSkip:true, maxTicksLimit:8 }, grid:{ display:false } },
          y:{ position:'left', ticks:{ color:'#d9a441' }, grid:{ color:'#2a2f3a' } },
          y1:{ position:'right', ticks:{ color:'#3fb897' }, grid:{ display:false } },
        },
      },
    });
  }

  // ---------- Gráfico de evolución del capital total de Paletas (1 mes / 6 meses / todo) ----------

  // Cotización blue histórica por fecha, para convertir saldos en USD a pesos
  // del día correspondiente (no al valor de hoy). Devuelve una función
  // rateForDate(dateKey) que usa la cotización más cercana disponible.
  function buildBlueRateLookup(){
    const blueByDate = {};
    blueData.forEach(d => { blueByDate[d.fecha] = d.venta; });
    if(liveBlue) blueByDate[todayKey()] = liveBlue.venta;
    const blueDatesSorted = Object.keys(blueByDate).sort();
    return function rateForDate(dateKey){
      if(blueByDate[dateKey] != null) return blueByDate[dateKey];
      let rate = null;
      for(let i = blueDatesSorted.length - 1; i >= 0; i--){
        if(blueDatesSorted[i] <= dateKey){ rate = blueByDate[blueDatesSorted[i]]; break; }
      }
      if(rate == null && blueDatesSorted.length) rate = blueByDate[blueDatesSorted[0]];
      return rate;
    };
  }

  function buildNegocioCapitalSeries(range){
    const movs = allMovimientos.filter(m => getSeccion(m) === 'negocio');
    const today = new Date(); today.setHours(0,0,0,0);

    let startDate;
    if(range === 'all'){
      const fechas = movs.map(m => m.fecha).filter(Boolean).sort();
      startDate = fechas.length ? new Date(fechas[0] + 'T00:00:00') : today;
    }else{
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (range - 1));
    }
    if(startDate > today) startDate = new Date(today);

    const rateForDate = buildBlueRateLookup();

    // Saldo acumulado justo antes del inicio de la ventana
    let runningArs = 0, runningUsd = 0;
    movs.forEach(m => {
      const f = new Date(m.fecha + 'T00:00:00');
      if(f < startDate){
        const sign = m.tipo === 'ingreso' ? 1 : -1;
        if(m.moneda === 'ARS') runningArs += sign * m.monto;
        else runningUsd += sign * m.monto;
      }
    });

    const byDate = {};
    movs.forEach(m => {
      const f = new Date(m.fecha + 'T00:00:00');
      if(f >= startDate && f <= today){
        byDate[m.fecha] = byDate[m.fecha] || { ars:0, usd:0 };
        const sign = m.tipo === 'ingreso' ? 1 : -1;
        if(m.moneda === 'ARS') byDate[m.fecha].ars += sign * m.monto;
        else byDate[m.fecha].usd += sign * m.monto;
      }
    });

    const days = Math.round((today - startDate) / (24*60*60*1000)) + 1;
    const labels = [];
    const data = [];
    for(let i = 0; i < days; i++){
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const key = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      if(byDate[key]){
        runningArs += byDate[key].ars;
        runningUsd += byDate[key].usd;
      }
      const rate = rateForDate(key) ?? blueAvgRate() ?? 0;
      labels.push(range === 'all' && days > 120 ? key.slice(2) : key.slice(5));
      data.push(runningArs + runningUsd * rate);
    }
    return { labels, data };
  }

  function renderNegocioChart(){
    const canvas = document.getElementById('negocioChart');
    if(!canvas) return;
    const series = buildNegocioCapitalSeries(currentNegocioRange);
    if(negocioChart) negocioChart.destroy();
    negocioChart = new Chart(canvas, {
      type:'line',
      data:{
        labels: series.labels,
        datasets:[
          {
            label:'Capital total (ARS)',
            data: series.data,
            borderColor:'#d9a441',
            backgroundColor:'rgba(217,164,65,0.08)',
            borderWidth:2,
            pointRadius:0,
            tension:0.25,
            fill:true,
          },
        ],
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{ display:false },
          tooltip:{
            mode:'index', intersect:false,
            callbacks:{
              label:(ctx)=>{
                const v = ctx.parsed.y;
                return 'Capital: ' + (v == null ? '—' : fmt(v));
              },
            },
          },
        },
        scales:{
          x:{ ticks:{ color:'#9a9689', maxRotation:0, autoSkip:true, maxTicksLimit:8 }, grid:{ display:false } },
          y:{ ticks:{ color:'#9a9689', callback:(v)=>fmt(v) }, grid:{ color:'#2a2f3a' } },
        },
      },
    });
  }

  function initNegocioRangeToggle(){
    const toggle = document.getElementById('negocioRangeToggle');
    if(!toggle) return;
    toggle.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('button[data-range]');
      if(!btn) return;
      toggle.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      currentNegocioRange = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range, 10);
      renderNegocioChart();
    });
  }

  function initAhorrosRangeToggle(){
    const toggle = document.getElementById('ahorrosRangeToggle');
    if(!toggle) return;
    toggle.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('button[data-range]');
      if(!btn) return;
      toggle.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      currentAhorrosRange = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range, 10);
      renderAhorrosChart();
    });
  }

  // ---------- Navegación ----------

  function initNav(){
    const menuBtn = document.getElementById('menuBtn');
    const navMenu = document.getElementById('navMenu');
    const pageTitle = document.getElementById('pageTitle');
    const pageEyebrow = document.getElementById('pageEyebrow');

    const viewMeta = {
      ahorros: { title:'Ahorros', eyebrow:'Tu ahorro' },
      gastosmes: { title:'Mis gastos', eyebrow:'Gastos del mes' },
      negocio: { title:'Paletas', eyebrow:'Stock y reventa' },
      cotizaciones: { title:'Pizarra del dólar', eyebrow:'Cotizaciones · Argentina' },
    };

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
      document.getElementById('view-ahorros').toggleAttribute('hidden', view !== 'ahorros');
      document.getElementById('view-gastosmes').toggleAttribute('hidden', view !== 'gastosmes');
      document.getElementById('view-negocio').toggleAttribute('hidden', view !== 'negocio');
      document.getElementById('view-cotizaciones').toggleAttribute('hidden', view !== 'cotizaciones');
      const meta = viewMeta[view] || viewMeta.ahorros;
      pageTitle.textContent = meta.title;
      pageEyebrow.textContent = meta.eyebrow;
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

  initServiceWorker();
  initThresholdsSync();
  initCalculator();
  initNav();
  updateNotifStatusText();
  initAlertasSync();
  initAlertasDelete();
  initAlertasClear();
  initMovimientosSync();
  ahorrosController.initForm();
  ahorrosController.initBackup();
  gastosController.initForm();
  gastosController.initBackup();
  negocioController.initForm();
  negocioController.initBackup();
  initProductosSync();
  initStockForm();
  initVentaPanel();
  initNegocioRangeToggle();
  initAhorrosRangeToggle();
  fetchAll();
  setInterval(fetchAll, POLL_MS);
})();