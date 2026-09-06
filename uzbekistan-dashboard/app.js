(() => {
  'use strict';

  const R = window.DASH_RAW;
  if (!R) throw new Error('Dashboard ma’lumotlari topilmadi');
  const D = {
    meta:{centers2026:R.m[0],proposals2027:R.m[1],districts208:R.m[2],selected2027Districts:R.m[3],selected2026Districts:R.m[4],population:R.m[5]},
    centers2026:R.c.map(x=>({id:x[0],region:x[1],district:x[2],centerName:x[3],objectName:x[4],lat:x[5],lng:x[6],objectType:x[7],inSon:x[8],year:2026})),
    proposals2027:R.p.map(x=>({id:x[0],region:x[1],district:x[2],mfy:x[3],objectName:x[4],lat:x[5],lng:x[6],objectType:x[7],floor:x[8],balanceType:x[9],balance:x[10],landArea:x[11],area:x[12],selectedOfficial:x[13],year:2027})),
    districts208:R.d.map(x=>({id:x[0],region:x[1],district:x[2],population:x[3],registry:x[4],disabilities:x[5],orphans:x[6],elderly:x[7],status:x[8],totalShare:x[9]}))
  };

  const COLORS = { green:'#22c55e', red:'#ef4444', blue:'#3b82f6', purple:'#a855f7' };
  const UZ_BOUNDS = [[55.7,37.0],[73.4,45.8]];
  const ADM1_URL = 'https://raw.githubusercontent.com/Rakhmatovdev/uz-map/main/public/data/uzbekistan-adm1.geojson';
  const ADM2_URL = 'https://raw.githubusercontent.com/Rakhmatovdev/uz-map/main/public/data/uzbekistan-adm2.geojson';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const fmt = n => new Intl.NumberFormat('uz-UZ').format(Number(n)||0);
  const fmt1 = n => new Intl.NumberFormat('uz-UZ',{maximumFractionDigits:1}).format(Number(n)||0);
  const norm = (s='') => String(s).toLowerCase().normalize('NFKD')
    .replace(/[ʻʼ’`´]/g,"'").replace(/ў/g,"o'").replace(/ғ/g,"g'").replace(/қ/g,'q').replace(/ҳ/g,'h')
    .replace(/ч/g,'ch').replace(/ш/g,'sh').replace(/ж/g,'j').replace(/я/g,'ya').replace(/ю/g,'yu').replace(/ё/g,'yo')
    .replace(/ц/g,'s').replace(/[а-я]/g,c=>({а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'x',ъ:'',ь:'',ы:'i',э:'e'}[c]||c))
    .replace(/\b(viloyati|viloyat|tumani|tuman|shahri|shahar|respublikasi|r)\b/g,' ')
    .replace(/[^a-z0-9'\s.-]/g,' ').replace(/\s+/g,' ').trim();

  const objects = [
    ...D.centers2026.map(x => ({...x, uid:`c26-${x.id}`, displayName:x.centerName, kind:'center'})),
    ...D.proposals2027.map(x => ({...x, uid:`p27-${x.id}`, displayName:x.objectName, kind:'proposal'})),
  ];

  const state = { year:'all', region:'', type:'', selectedOnly:false, q:'', selectedUid:null, pitch:false };
  let map = null;
  let mapLoaded = false;
  let boundariesLoaded = false;
  let toastTimer = null;

  function markerClass(o){
    if (o.year === 2026 && o.inSon) return 'purple';
    if (o.year === 2026) return 'green';
    if (o.selectedOfficial) return 'blue';
    return 'red';
  }

  function filteredObjects(){
    const q = norm(state.q);
    return objects.filter(o => {
      if (state.year !== 'all' && String(o.year) !== state.year) return false;
      if (state.region && o.region !== state.region) return false;
      if (state.type && o.objectType !== state.type) return false;
      if (state.selectedOnly && !(o.year===2027 && o.selectedOfficial)) return false;
      if (q) {
        const hay = norm([o.region,o.district,o.mfy,o.displayName,o.objectName,o.centerName,o.balance].filter(Boolean).join(' '));
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function pointCollection(rows){
    return {type:'FeatureCollection',features:rows.filter(o=>Number.isFinite(+o.lat)&&Number.isFinite(+o.lng)).map(o=>({
      type:'Feature',geometry:{type:'Point',coordinates:[+o.lng,+o.lat]},properties:{uid:o.uid,year:o.year,district:o.district,region:o.region,marker:markerClass(o),selected:o.selectedOfficial?1:0,label:o.district}
    }))};
  }

  function populateRegions(){
    const regions = [...new Set([...D.districts208.map(x=>x.region), ...objects.map(x=>x.region)].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'uz'));
    $('#regionSelect').innerHTML = '<option value="">Barcha hududlar</option>' + regions.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('');
  }

  function setKpis(){
    $('#kpi2026').textContent = fmt(D.meta.centers2026);
    $('#kpi2027').textContent = fmt(D.meta.proposals2027);
    $('#kpiSelected').textContent = fmt(D.meta.selected2027Districts);
    $('#kpiDistricts').textContent = fmt(D.meta.districts208);
    $('#kpiPopulation').textContent = `${fmt1(D.meta.population/1e6)} mln`;
  }

  function renderList(){
    const rows = filteredObjects();
    $('#listSummary').textContent = `${fmt(rows.length)} ta obyekt`;
    $('#listRegionSummary').textContent = `${new Set(rows.map(x=>x.region)).size} hudud`;
    const el = $('#objectList');
    if (!rows.length) {
      el.innerHTML = '<div style="padding:28px 15px;text-align:center;color:#7893a4;font-size:11px">Filtr bo‘yicha obyekt topilmadi.</div>';
    } else {
      el.innerHTML = rows.map(o => {
        const mc = markerClass(o);
        const selected = o.uid===state.selectedUid ? ' active' : '';
        const main = o.year===2026 ? o.centerName : o.objectName;
        return `<button class="object-card${selected}" data-uid="${o.uid}" role="listitem" type="button">
          <div class="object-top"><i class="marker-mini ${mc}"></i><span class="object-year">${o.year}</span>${o.year===2027&&o.selectedOfficial?'<span class="object-tag">TANLANGAN</span>':''}</div>
          <strong>${esc(main)}</strong>
          <p><span>${esc(o.region)} · ${esc(o.district)}</span></p>
        </button>`;
      }).join('');
      $$('.object-card').forEach(btn => btn.addEventListener('click', () => selectObject(btn.dataset.uid, true)));
    }
    updateMapSource(rows);
  }

  function updateMapSource(rows=filteredObjects()){
    if (!mapLoaded || !map?.getSource('objects')) return;
    map.getSource('objects').setData(pointCollection(rows));
  }

  function selectObject(uid, fly=true){
    const o = objects.find(x=>x.uid===uid);
    if (!o) return;
    state.selectedUid = uid;
    renderList();
    renderDetail(o);
    $('#detailDrawer').classList.add('open');
    $('#browserPanel').classList.remove('mobile-open');
    if (fly && mapLoaded) map.flyTo({center:[+o.lng,+o.lat],zoom:Math.max(map.getZoom(),10),pitch:state.pitch?48:0,bearing:state.pitch?-8:0,duration:850});
  }

  function renderDetail(o){
    const mc = markerClass(o);
    const selected = o.year===2027 && o.selectedOfficial;
    const details = o.year===2026 ? [
      ['Yil','2026'],['Obyekt turi',o.objectType||'—'],['Hudud',o.region],['Tuman / shahar',o.district],['Kenglik',o.lat],['Uzunlik',o.lng]
    ] : [
      ['Yil','2027'],['Obyekt turi',o.objectType||'—'],['MFY',o.mfy||'—'],['Qavat',o.floor||'—'],['Yer maydoni',o.landArea?`${fmt1(o.landArea)} ga`:'—'],['Bino maydoni',o.area?`${fmt1(o.area)} m²`:'—'],['Balans turi',o.balanceType||'—'],['Balans',o.balance||'—']
    ];
    const title = o.year===2026 ? o.centerName : o.objectName;
    const objectDescription = o.year===2026 ? o.objectName : `${o.mfy?o.mfy+' · ':''}${o.objectType||'Obyekt'}${selected?' · 208-jadval bo‘yicha tanlangan hudud':''}`;
    $('#detailContent').innerHTML = `<div class="detail-wrap">
      <div class="detail-head"><div><div class="detail-badges"><span class="badge marker-${mc}">${o.year} · ${mc==='green'?'MARKAZ':mc==='purple'?'INSON':mc==='blue'?'TANLANGAN':'TAKLIF'}</span>${selected?'<span class="badge">Rasmiy status: 2027-YIL TAKLIF</span>':''}</div><h2>${esc(title)}</h2></div><button class="panel-close" id="detailClose" type="button">×</button></div>
      <div class="detail-location">${esc(o.region)} · ${esc(o.district)}</div>
      <div class="detail-grid">${details.map(([k,v])=>`<div class="detail-item"><small>${esc(k)}</small><strong>${esc(v??'—')}</strong></div>`).join('')}</div>
      <div class="detail-object"><small>OBYEKT / JOYLASHUV</small><p>${esc(objectDescription)}</p></div>
      <div class="detail-actions"><button class="primary-action" id="focusObject" type="button">Xaritada ko‘rsatish</button><a class="secondary-action" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${encodeURIComponent(o.lat+','+o.lng)}">Google Maps</a></div>
      <div class="photo-section"><div class="section-title">Rasmlar</div><div class="photo-empty"><div><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>Ushbu manba fayllarida foto havolalari mavjud emas.<br>Galereya uchun joy tayyor — real rasmlar keyin ulanadi.</div></div></div>
    </div>`;
    $('#detailClose').onclick = closeDetail;
    $('#focusObject').onclick = () => selectObject(o.uid,true);
  }

  function closeDetail(){ $('#detailDrawer').classList.remove('open'); state.selectedUid=null; renderList(); }

  function fitRows(rows=filteredObjects()){
    if (!mapLoaded) return;
    if (!rows.length) return fitUzbekistan();
    if (rows.length===1) return map.flyTo({center:[+rows[0].lng,+rows[0].lat],zoom:10,duration:700});
    const b = new maplibregl.LngLatBounds();
    rows.forEach(o=>b.extend([+o.lng,+o.lat]));
    map.fitBounds(b,{padding:{top:165,left:innerWidth<820?30:380,right:60,bottom:70},maxZoom:9,duration:750});
  }
  function fitUzbekistan(){ if(mapLoaded) map.fitBounds(UZ_BOUNDS,{padding:{top:155,left:innerWidth<820?20:360,right:50,bottom:50},duration:700}); }

  function showToast(msg){
    const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),3500);
  }

  async function addBoundaries(){
    try{
      const [adm1,adm2] = await Promise.all([fetch(ADM1_URL).then(r=>{if(!r.ok)throw 0;return r.json()}),fetch(ADM2_URL).then(r=>{if(!r.ok)throw 0;return r.json()})]);
      if (!map.getSource('adm1')) map.addSource('adm1',{type:'geojson',data:adm1});
      if (!map.getSource('adm2')) map.addSource('adm2',{type:'geojson',data:adm2});
      const firstSymbol = map.getStyle().layers?.find(l=>l.type==='symbol')?.id;
      map.addLayer({id:'adm1-fill',type:'fill',source:'adm1',paint:{'fill-color':'#0ea5e9','fill-opacity':0.025}},firstSymbol);
      map.addLayer({id:'adm1-line',type:'line',source:'adm1',paint:{'line-color':'rgba(122,207,235,.52)','line-width':['interpolate',['linear'],['zoom'],4,1,8,1.8]}},firstSymbol);
      map.addLayer({id:'adm2-line',type:'line',source:'adm2',minzoom:5.2,paint:{'line-color':'rgba(157,196,216,.26)','line-width':['interpolate',['linear'],['zoom'],5,0.35,10,1]}},firstSymbol);
      boundariesLoaded=true;
    }catch(e){
      showToast('Tuman chegaralari yuklanmadi. Obyektlar xaritasi ishlashda davom etadi.');
    }
  }

  function initMap(){
    if (!window.maplibregl) {
      $('#map').innerHTML='<div class="map-fallback"><div><strong>Xarita kutubxonasi yuklanmadi</strong><p>Internet ulanishini tekshiring. Obyektlar ro‘yxati va tahlil paneli ishlashda davom etadi.</p></div></div>';
      document.body.dataset.dashboardReady='true';
      return;
    }
    try{
      map = new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:[64.4,41.15],zoom:5.1,minZoom:4,maxZoom:16,attributionControl:true,hash:false});
      map.on('load', async () => {
        mapLoaded=true;
        map.addSource('objects',{type:'geojson',data:pointCollection(filteredObjects())});
        map.addLayer({id:'object-halo',type:'circle',source:'objects',paint:{'circle-radius':['interpolate',['linear'],['zoom'],4,9,8,13,12,17],'circle-color':['match',['get','marker'],'green',COLORS.green,'red',COLORS.red,'blue',COLORS.blue,'purple',COLORS.purple,COLORS.red],'circle-opacity':0.16,'circle-blur':0.4}});
        map.addLayer({id:'object-points',type:'circle',source:'objects',paint:{'circle-radius':['interpolate',['linear'],['zoom'],4,4.5,8,6.5,12,9],'circle-color':['match',['get','marker'],'green',COLORS.green,'red',COLORS.red,'blue',COLORS.blue,'purple',COLORS.purple,COLORS.red],'circle-stroke-color':'#f7fbff','circle-stroke-width':['interpolate',['linear'],['zoom'],4,1,10,2],'circle-opacity':0.96}});
        map.addLayer({id:'object-labels',type:'symbol',source:'objects',minzoom:8.5,layout:{'text-field':['get','district'],'text-size':11,'text-offset':[0,1.1],'text-anchor':'top','text-allow-overlap':false},paint:{'text-color':'#e7f5fb','text-halo-color':'rgba(4,14,23,.9)','text-halo-width':1.2}});
        map.on('click','object-points',e=>{const uid=e.features?.[0]?.properties?.uid;if(uid)selectObject(uid,false)});
        map.on('mouseenter','object-points',()=>map.getCanvas().style.cursor='pointer');
        map.on('mouseleave','object-points',()=>map.getCanvas().style.cursor='');
        await addBoundaries();
        document.body.dataset.dashboardReady='true';
      });
      map.on('error', e => { if(!mapLoaded) console.warn('Map error',e?.error||e); });
    }catch(e){
      console.error(e);
      $('#map').innerHTML='<div class="map-fallback"><div><strong>Xarita ishga tushmadi</strong><p>Obyektlar ro‘yxati va 208 hudud tahlili ishlaydi. Xarita servisiga ulanishni qayta tekshirish mumkin.</p></div></div>';
      document.body.dataset.dashboardReady='true';
    }
  }

  function renderAnalysis(){
    const rows = D.districts208;
    const groups = new Map();
    rows.forEach(r=>{
      const g=groups.get(r.region)||{region:r.region,pop:0,c26:0,c27:0,total:0};g.pop+=+r.population||0;g.total++;if(r.status==='2026-YIL TAKLIF')g.c26++;if(r.status==='2027-YIL TAKLIF')g.c27++;groups.set(r.region,g);
    });
    const regionRows=[...groups.values()].sort((a,b)=>b.pop-a.pop);
    const ranked=[...rows].sort((a,b)=>(+b.totalShare||0)-(+a.totalShare||0)).slice(0,15);
    const maxShare=Math.max(...ranked.map(x=>+x.totalShare||0),.01);
    $('#analysisContent').innerHTML=`
      <div class="analysis-kpis"><div class="mini-stat"><small>2026-YIL TAKLIF</small><strong style="color:#75e39b">${fmt(D.meta.selected2026Districts)}</strong></div><div class="mini-stat"><small>2027-YIL TAKLIF</small><strong style="color:#86b9ff">${fmt(D.meta.selected2027Districts)}</strong></div><div class="mini-stat"><small>TAKLIF BERILMAGAN</small><strong>${fmt(rows.filter(x=>x.status==='TAKLIF BERILMAGAN').length)}</strong></div></div>
      <section class="analysis-block"><h3>Hududlar kesimi</h3><div class="region-table"><div class="region-row header"><span>Hudud</span><span>Aholi</span><span>2026</span><span>2027</span></div>${regionRows.map(g=>`<div class="region-row"><b>${esc(g.region)}</b><span>${fmt(g.pop)}</span><span class="status-count" style="color:#75e39b">${g.c26}</span><span class="status-count" style="color:#86b9ff">${g.c27}</span></div>`).join('')}</div></section>
      <section class="analysis-block"><h3>Kontingent ulushi bo‘yicha yuqori hududlar</h3>${ranked.map((r,i)=>`<div class="rank-row"><div class="rank-no">${i+1}</div><div class="rank-label"><b>${esc(r.district)}</b><small>${esc(r.region)}</small></div><div class="bar"><i style="width:${Math.max(3,(+r.totalShare||0)/maxShare*100)}%"></i></div><div class="rank-value">${fmt1((+r.totalShare||0)*100)}%</div></div>`).join('')}</section>
      <div class="analysis-note"><b>Izoh:</b> “2027 tanlangan hudud” soni 208 tuman/shahar jadvalidagi <b>2027-YIL TAKLIF</b> statusidan olinadi (29 hudud). Xaritadagi 102 qizil/ko‘k nuqta esa alohida 2027 obyekt/taklif qatlamidir. Bu ikki ko‘rsatkich bir xil tushuncha emas.</div>`;
  }

  function openAnalysis(){ renderAnalysis(); $('#analysisDrawer').classList.add('open'); $('#detailDrawer').classList.remove('open'); $('#browserPanel').classList.remove('mobile-open'); }

  function bind(){
    $$('.year-tab').forEach(b=>b.onclick=()=>{state.year=b.dataset.year;state.selectedOnly=false;$('#selectedOnly').checked=false;$$('.year-tab').forEach(x=>x.classList.toggle('active',x===b));renderList();fitRows()});
    $('#searchInput').addEventListener('input',e=>{state.q=e.target.value;renderList()});
    $('#regionSelect').onchange=e=>{state.region=e.target.value;renderList();fitRows()};
    $('#typeSelect').onchange=e=>{state.type=e.target.value;renderList();fitRows()};
    $('#selectedOnly').onchange=e=>{state.selectedOnly=e.target.checked;if(e.target.checked){state.year='2027';$$('.year-tab').forEach(x=>x.classList.toggle('active',x.dataset.year==='2027'))}renderList();fitRows()};
    $('#clearFilters').onclick=()=>{Object.assign(state,{year:'all',region:'',type:'',selectedOnly:false,q:''});$('#searchInput').value='';$('#regionSelect').value='';$('#typeSelect').value='';$('#selectedOnly').checked=false;$$('.year-tab').forEach(x=>x.classList.toggle('active',x.dataset.year==='all'));renderList();fitUzbekistan()};
    $$('[data-kpi-year]').forEach(b=>b.onclick=()=>{state.year=b.dataset.kpiYear;state.selectedOnly=false;$('#selectedOnly').checked=false;$$('.year-tab').forEach(x=>x.classList.toggle('active',x.dataset.year===state.year));renderList();fitRows()});
    $('[data-kpi-selected]').onclick=()=>{state.year='2027';state.selectedOnly=true;$('#selectedOnly').checked=true;$$('.year-tab').forEach(x=>x.classList.toggle('active',x.dataset.year==='2027'));renderList();fitRows()};
    $$('[data-open-analysis]').forEach(b=>b.onclick=openAnalysis);
    $('#analysisBtn').onclick=openAnalysis; $('#analysisClose').onclick=()=>$('#analysisDrawer').classList.remove('open');
    $('#fitBtn').onclick=()=>fitRows();
    $('#pitchBtn').onclick=()=>{state.pitch=!state.pitch;$('#pitchBtn').classList.toggle('active',state.pitch);if(mapLoaded)map.easeTo({pitch:state.pitch?48:0,bearing:state.pitch?-8:0,duration:650})};
    $('#zoomIn').onclick=()=>mapLoaded&&map.zoomIn({duration:250}); $('#zoomOut').onclick=()=>mapLoaded&&map.zoomOut({duration:250}); $('#northBtn').onclick=()=>mapLoaded&&map.easeTo({bearing:0,pitch:state.pitch?48:0,duration:450});
    $('#mobileBrowserBtn').onclick=()=>$('#browserPanel').classList.add('mobile-open'); $('#mobileCloseBrowser').onclick=()=>$('#browserPanel').classList.remove('mobile-open');
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDetail();$('#analysisDrawer').classList.remove('open');$('#browserPanel').classList.remove('mobile-open')}});
  }

  function init(){
    populateRegions();setKpis();renderList();renderAnalysis();bind();initMap();
    if (!window.maplibregl) document.body.dataset.dashboardReady='true';
  }
  init();
})();
