(async()=>{
  const ungzip=async url=>{
    const r=await fetch(url,{cache:"force-cache"});
    if(!r.ok)throw new Error(`${url}: ${r.status}`);
    if(!("DecompressionStream" in window))throw new Error("Brauzer gzip DecompressionStream texnologiyasini qo‘llamaydi");
    return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text()
  };

  const activateEmbed=(message="Google Maps JavaScript API cheklangan")=>{
    if(document.body.dataset.mapReady==="true")return;
    document.body.dataset.mapReady="fallback";
    document.body.dataset.dashboardReady="true";
    const map=document.querySelector("#map");
    if(map){
      map.innerHTML=`<iframe id="googleEmbed" title="Google Maps — O‘zbekiston" src="https://www.google.com/maps?q=Uzbekistan&z=6&output=embed" loading="eager" referrerpolicy="no-referrer-when-downgrade" allowfullscreen style="border:0;width:100%;height:100%;display:block"></iframe>`;
    }
    const status=document.querySelector("#mapsStatus");
    if(status){status.classList.add("warn");status.innerHTML="<i></i> Google Maps · Embed";}
    const toast=document.querySelector("#toast");
    if(toast){toast.textContent=message;toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),3200)}
  };
  window.__googleEmbedFallback=activateEmbed;

  const nativeAppend=document.head.appendChild.bind(document.head);
  document.head.appendChild=node=>{
    try{
      if(node?.tagName==="SCRIPT"&&String(node.src||"").includes("maps.googleapis.com/maps/api/js")){
        const u=new URL(node.src);
        u.searchParams.delete("libraries");
        node.src=u.toString();
      }
    }catch(_){}
    return nativeAppend(node)
  };

  try{
    const [css,js]=await Promise.all([ungzip("./styles.css.gz"),ungzip("./app.js.gz")]);
    const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);
    (0,eval)(js);

    const appAuth=window.gm_authFailure;
    window.gm_authFailure=()=>{
      try{if(typeof appAuth==="function")appAuth()}catch(_){}
      setTimeout(()=>activateEmbed("Google Maps API cheklovi sabab Embed rejimi yoqildi"),0)
    };

    if(document.readyState!=="loading"&&document.body.dataset.dashboardReady!=="true"){
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }

    setTimeout(()=>{
      if(document.body.dataset.mapReady==="error"||(!document.body.dataset.mapReady&&document.body.dataset.dashboardReady==="true")){
        activateEmbed("Google Maps JavaScript ishlamadi — Google Embed rejimi yoqildi")
      }
    },9000);

    document.addEventListener("click",e=>{
      if(document.body.dataset.mapReady!=="fallback")return;
      const card=e.target.closest?.(".object-card");
      if(!card||!window.DASH_RAW)return;
      const raw=card.dataset.uid||card.dataset.id||"";
      let row=null;
      if(/^c(?:26-)?\d+$/i.test(raw)){
        const id=Number(raw.replace(/\D/g,""));row=window.DASH_RAW.c?.find(x=>Number(x[0])===id)
      }else if(/^p(?:27-)?\d+$/i.test(raw)){
        const id=Number(raw.replace(/\D/g,""));row=window.DASH_RAW.p?.find(x=>Number(x[0])===id||Number(x[0])-2027000===id)
      }
      if(row){
        const lat=Number(row[5]),lng=Number(row[6]),fr=document.querySelector("#googleEmbed");
        if(fr&&Number.isFinite(lat)&&Number.isFinite(lng))fr.src=`https://www.google.com/maps?q=${lat},${lng}&z=12&output=embed`
      }
    });
  }catch(e){
    console.error(e);document.body.dataset.dashboardReady="error";
    activateEmbed("Dashboard modullari yuklanmadi — Google Maps fallback yoqildi")
  }
})();