(() => {
  'use strict';
  const R = window.DASH_RAW;
  if (!R) return;
  const REGION_CANON = {
    'Андижон вилояти':'Andijon viloyati','Бухоро вилояти':'Buxoro viloyati','Жиззах вилояти':'Jizzax viloyati',
    'Қашқадарё вилояти':'Qashqadaryo viloyati','Қорақалпоғистон Р.':"Qoraqalpog'iston Respublikasi",
    'Қорақалпоғистон Республикаси':"Qoraqalpog'iston Respublikasi",'Навоий вилояти':'Navoiy viloyati',
    'Наманган вилояти':'Namangan viloyati','Самарқанд вилояти':'Samarqand viloyati','Сирдарё вилояти':'Sirdaryo viloyati',
    'Сурхондарё вилояти':'Surxondaryo viloyati','Тошкент вилояти':'Toshkent viloyati','Тошкент шаҳри':'Toshkent shahri',
    'Фарғона вилояти':"Farg'ona viloyati",'Хоразм вилояти':'Xorazm viloyati'
  };
  const region = v => REGION_CANON[v] || v;
  const type = v => v === 'Бино' ? 'Bino' : v === 'Ер' ? 'Yer' : v;
  if (Array.isArray(R.c)) R.c = R.c.map(x => { const y=[...x]; y[1]=region(y[1]); y[7]=type(y[7]); return y; });
  if (Array.isArray(R.p)) R.p = R.p.map(x => { const y=[...x]; y[1]=region(y[1]); y[7]=type(y[7]); return y; });
  if (Array.isArray(R.d)) R.d = R.d.map(x => { const y=[...x]; y[1]=region(y[1]); return y; });
})();
