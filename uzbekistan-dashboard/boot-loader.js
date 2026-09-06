(async()=>{
  const ungzip=async url=>{const r=await fetch(url,{cache:"force-cache"});if(!r.ok)throw new Error(`${url}: ${r.status}`);if(!("DecompressionStream" in window))throw new Error("Brauzer gzip DecompressionStream texnologiyasini qo‘llamaydi");return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text()};
  try{
    const [css,js]=await Promise.all([ungzip("./styles.css.gz"),ungzip("./app.js.gz")]);
    const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);
    (0,eval)(js);
    // Defer scriptning ichidagi async fetch tugaguncha DOMContentLoaded o'tib ketishi mumkin.
    // App ushbu eventni kutadi, shuning uchun kerak bo'lsa uni bir marta qayta yuboramiz.
    if(document.readyState!=="loading"&&document.body.dataset.dashboardReady!=="true"){
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }
  }catch(e){
    console.error(e);document.body.dataset.dashboardReady="error";
    const m=document.querySelector("#map");if(m)m.innerHTML=`<div class="map-loading"><div><b>Dashboard yuklanmadi</b><small>${String(e.message||e)}</small></div></div>`;
  }
})();
