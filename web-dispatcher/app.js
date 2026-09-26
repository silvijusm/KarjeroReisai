/* global firebase, L */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const auth=firebase.auth(), db=firebase.firestore(), fn=firebase.app().functions('europe-west1');
  const s={profile:null,company:null,companyId:null,members:[],vehicles:[],locations:[],sessions:[],unsubs:[],markers:new Map(),lang:(localStorage.getItem('kr-lang')||'LT')};
  const dict={
    LT:{loginTitle:'Įmonės dispečerio centras',email:'El. paštas',password:'Slaptažodis',signIn:'Prisijungti',map:'Žemėlapis',drivers:'Vairuotojai',vehicles:'Automobiliai',reports:'Ataskaitos',billing:'Mokėjimas',logout:'Atsijungti',active:'Aktyvūs',tripsToday:'Reisai šiandien',kmToday:'Km šiandien',tonnesToday:'Tonos šiandien',driversHelp:'Patvirtinkite prisijungimus ir valdykite roles.',companyCode:'Įmonės kodas',newCode:'Naujas kodas',vehiclesHelp:'Įmonės transporto sąrašas.',addVehicle:'Pridėti automobilį',reportsHelp:'Sesijos, reisai, kilometrai ir tonos.',plan:'Planas',billingStatus:'Būsena',portal:'Atidaryti Stripe portalą',billingHelp:'Įmonėms: 3 € už vairuotoją per mėnesį, mažiausiai už 3.',cancel:'Atšaukti',save:'Išsaugoti'},
    EN:{loginTitle:'Company dispatcher centre',email:'Email',password:'Password',signIn:'Sign in',map:'Map',drivers:'Drivers',vehicles:'Vehicles',reports:'Reports',billing:'Billing',logout:'Sign out',active:'Active',tripsToday:'Trips today',kmToday:'Km today',tonnesToday:'Tonnes today',driversHelp:'Approve join requests and manage roles.',companyCode:'Company code',newCode:'New code',vehiclesHelp:'Company vehicle list.',addVehicle:'Add vehicle',reportsHelp:'Sessions, trips, kilometres and tonnes.',plan:'Plan',billingStatus:'Status',portal:'Open Stripe portal',billingHelp:'Company plan: €3 per driver/month, minimum 3.',cancel:'Cancel',save:'Save'},
    RU:{loginTitle:'Диспетчерский центр компании',email:'Эл. почта',password:'Пароль',signIn:'Войти',map:'Карта',drivers:'Водители',vehicles:'Автомобили',reports:'Отчёты',billing:'Оплата',logout:'Выйти',active:'Активные',tripsToday:'Рейсы сегодня',kmToday:'Км сегодня',tonnesToday:'Тонны сегодня',driversHelp:'Подтверждайте заявки и управляйте ролями.',companyCode:'Код компании',newCode:'Новый код',vehiclesHelp:'Транспорт компании.',addVehicle:'Добавить автомобиль',reportsHelp:'Сессии, рейсы, километры и тонны.',plan:'План',billingStatus:'Статус',portal:'Открыть Stripe',billingHelp:'3 € за водителя в месяц, минимум 3.',cancel:'Отмена',save:'Сохранить'},
    LV:{loginTitle:'Uzņēmuma dispečeru centrs',email:'E-pasts',password:'Parole',signIn:'Pieslēgties',map:'Karte',drivers:'Vadītāji',vehicles:'Transportlīdzekļi',reports:'Atskaites',billing:'Maksājumi',logout:'Izrakstīties',active:'Aktīvi',tripsToday:'Reisi šodien',kmToday:'Km šodien',tonnesToday:'Tonnas šodien',driversHelp:'Apstipriniet pieprasījumus un pārvaldiet lomas.',companyCode:'Uzņēmuma kods',newCode:'Jauns kods',vehiclesHelp:'Uzņēmuma transports.',addVehicle:'Pievienot transportu',reportsHelp:'Sesijas, reisi, kilometri un tonnas.',plan:'Plāns',billingStatus:'Statuss',portal:'Atvērt Stripe',billingHelp:'3 € par vadītāju mēnesī, minimums 3.',cancel:'Atcelt',save:'Saglabāt'},
    ET:{loginTitle:'Ettevõtte dispetšerikeskus',email:'E-post',password:'Parool',signIn:'Logi sisse',map:'Kaart',drivers:'Juhid',vehicles:'Sõidukid',reports:'Aruanded',billing:'Maksed',logout:'Logi välja',active:'Aktiivsed',tripsToday:'Reisid täna',kmToday:'Km täna',tonnesToday:'Tonnid täna',driversHelp:'Kinnita liitumised ja halda rolle.',companyCode:'Ettevõtte kood',newCode:'Uus kood',vehiclesHelp:'Ettevõtte sõidukid.',addVehicle:'Lisa sõiduk',reportsHelp:'Sessioonid, reisid, kilomeetrid ja tonnid.',plan:'Plaan',billingStatus:'Olek',portal:'Ava Stripe',billingHelp:'3 € juhi kohta kuus, vähemalt 3.',cancel:'Tühista',save:'Salvesta'},
    PL:{loginTitle:'Centrum dyspozytorskie firmy',email:'E-mail',password:'Hasło',signIn:'Zaloguj',map:'Mapa',drivers:'Kierowcy',vehicles:'Pojazdy',reports:'Raporty',billing:'Płatności',logout:'Wyloguj',active:'Aktywni',tripsToday:'Kursy dzisiaj',kmToday:'Km dzisiaj',tonnesToday:'Tony dzisiaj',driversHelp:'Akceptuj zgłoszenia i zarządzaj rolami.',companyCode:'Kod firmy',newCode:'Nowy kod',vehiclesHelp:'Pojazdy firmy.',addVehicle:'Dodaj pojazd',reportsHelp:'Sesje, kursy, kilometry i tony.',plan:'Plan',billingStatus:'Status',portal:'Otwórz Stripe',billingHelp:'3 € za kierowcę miesięcznie, minimum 3.',cancel:'Anuluj',save:'Zapisz'}
  };
  const tr=k=>(dict[s.lang]||dict.LT)[k]||dict.LT[k]||k;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=(v,d=0)=>Number(v||0).toLocaleString(s.lang.toLowerCase(),{maximumFractionDigits:d});
  const admin=()=>['company_admin','super_admin'].includes(s.profile?.role);
  function i18n(){document.documentElement.lang=s.lang.toLowerCase();document.querySelectorAll('[data-t]').forEach(e=>e.textContent=tr(e.dataset.t));$('lang').value=s.lang;}
  function showApp(on){$('login').classList.toggle('hidden',on);$('app').classList.toggle('hidden',!on);if(on)setTimeout(()=>map.invalidateSize(),50);}
  function cleanup(){s.unsubs.splice(0).forEach(x=>{try{x()}catch{}});}
  function status(msg){$('status').textContent=msg;}
  function adminUi(){document.querySelectorAll('.admin-only').forEach(e=>e.classList.toggle('disabled',!admin()));}
  const map=L.map('map').setView([55.17,23.88],7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);

  async function identity(user){
    const u=await db.collection('users').doc(user.uid).get();
    if(!u.exists) throw new Error('Vartotojo profilis nerastas.');
    s.profile=u.data();
    if(!['company_admin','dispatcher','super_admin'].includes(s.profile.role)) throw new Error('Ši paskyra neturi dispečerio teisių.');
    s.companyId=s.profile.companyId;
    if(!s.companyId) throw new Error('Paskyra nepriskirta įmonei.');
    const c=await db.collection('companies').doc(s.companyId).get();
    if(!c.exists) throw new Error('Įmonė nerasta.');
    s.company={id:c.id,...c.data()};
    $('companyName').textContent=s.company.name||s.companyId;
    $('companyCode').textContent=s.company.companyCode||'—';
    $('userBadge').textContent=(s.profile.name||user.email)+' · '+s.profile.role;
    $('plan').textContent=s.company.plan||'—';
    $('billingState').textContent=s.company.billing?.status||s.company.plan||'—';
    adminUi();
  }
  const memberName=uid=>s.members.find(m=>m.id===uid)?.displayName||uid?.slice(0,8)||'—';
  const vehicleName=id=>{const v=s.vehicles.find(x=>x.id===id);return v?(v.plateNumber||v.name||id):(id||'—');};

  function subscribe(){
    cleanup();const base=db.collection('companies').doc(s.companyId);
    s.unsubs.push(base.collection('members').onSnapshot(q=>{s.members=q.docs.map(d=>({id:d.id,...d.data()}));renderMembers();renderFleet();},e=>status('Nariai: '+e.message)));
    s.unsubs.push(base.collection('vehicles').onSnapshot(q=>{s.vehicles=q.docs.map(d=>({id:d.id,...d.data()}));renderVehicles();renderFleet();},e=>status('Automobiliai: '+e.message)));
    s.unsubs.push(base.collection('liveLocations').onSnapshot(q=>{s.locations=q.docs.map(d=>({id:d.id,...d.data()}));renderMap();renderFleet();status('Atnaujinta '+new Date().toLocaleTimeString());},()=>{s.locations=[];renderMap();status('Gyva vieta bus rodoma įdiegus live-tracking etapą.');}));
    const today=new Date().toISOString().slice(0,10);
    s.unsubs.push(base.collection('sessions').where('date','==',today).onSnapshot(q=>{s.sessions=q.docs.map(d=>({id:d.id,...d.data()}));renderStats();renderReports();renderFleet();},e=>status('Sesijos: '+e.message)));
  }
  function renderStats(){
    const now=Date.now();
    $('activeCount').textContent=s.locations.filter(x=>x.state!=='offline'&&(!x.updatedAt?.toMillis||now-x.updatedAt.toMillis()<600000)).length;
    $('tripsCount').textContent=num(s.sessions.reduce((a,x)=>a+(x.tripsCount||0),0));
    $('kmCount').textContent=num(s.sessions.reduce((a,x)=>a+(x.km||0),0),1);
    $('tonnesCount').textContent=num(s.sessions.reduce((a,x)=>a+(x.tonnes||0),0),1);
  }
  function renderMap(){
    const active=new Set();
    s.locations.forEach(l=>{
      if(typeof l.lat!=='number'||typeof l.lng!=='number')return;active.add(l.id);
      const html='<b>'+esc(vehicleName(l.vehicleId))+'</b><br>'+esc(memberName(l.id))+'<br>'+esc(l.state||'offline')+' · '+num(l.speedKmh)+' km/h';
      let m=s.markers.get(l.id);if(m)m.setLatLng([l.lat,l.lng]).setPopupContent(html);else{s.markers.set(l.id,L.marker([l.lat,l.lng]).addTo(map).bindPopup(html));}
    });
    for(const [id,m] of s.markers)if(!active.has(id)){map.removeLayer(m);s.markers.delete(id);}
    if(s.markers.size){const g=L.featureGroup([...s.markers.values()]);map.fitBounds(g.getBounds().pad(.15),{maxZoom:13});}
    renderStats();
  }
  function renderFleet(){
    const q=$('searchFleet').value.trim().toLowerCase();
    const rows=s.locations.map(l=>({l,plate:vehicleName(l.vehicleId),driver:memberName(l.id),ses:s.sessions.find(x=>x.driverUid===l.id)})).filter(x=>!q||(x.plate+' '+x.driver).toLowerCase().includes(q));
    $('fleet').innerHTML=rows.length?rows.map(x=>'<div class="fleet-row"><div><strong>'+esc(x.plate)+'</strong><small>'+esc(x.driver)+'</small><small><span class="dot '+esc(x.l.state||'')+'"></span>'+esc(x.l.state||'offline')+'</small></div><div><strong>'+num(x.ses?.tripsCount)+'</strong><small>reisai</small></div></div>').join(''):'<div class="empty">Duomenų nėra</div>';
  }
  function renderMembers(){
    const rows=s.members.map(m=>'<tr><td>'+esc(m.displayName||m.id)+'</td><td>'+esc(m.role||'driver')+'</td><td><span class="badge '+esc(m.status)+'">'+esc(m.status||'—')+'</span></td><td class="actions">'+
      (admin()&&m.status==='pending'?'<button class="primary" data-uid="'+esc(m.id)+'" data-action="approve">Patvirtinti</button><button class="secondary" data-uid="'+esc(m.id)+'" data-action="reject">Atmesti</button>':'')+
      (admin()&&m.status==='active'&&m.role!=='company_admin'?'<button class="secondary" data-uid="'+esc(m.id)+'" data-action="set_role" data-role="'+(m.role==='dispatcher'?'driver':'dispatcher')+'">'+(m.role==='dispatcher'?'→ driver':'→ dispatcher')+'</button><button class="ghost" data-uid="'+esc(m.id)+'" data-action="remove">Pašalinti</button>':'')+'</td></tr>').join('');
    $('members').innerHTML='<table class="table"><thead><tr><th>Vardas</th><th>Rolė</th><th>Būsena</th><th>Veiksmai</th></tr></thead><tbody>'+(rows||'<tr><td colspan="4">Duomenų nėra</td></tr>')+'</tbody></table>';
  }
  function renderVehicles(){
    const rows=s.vehicles.map(v=>'<tr><td><b>'+esc(v.plateNumber||v.id)+'</b></td><td>'+esc(v.make||'—')+'</td><td>'+esc(v.name||'—')+'</td><td>'+num(v.payloadT,1)+'</td><td>'+(v.active===false?'Neaktyvus':'Aktyvus')+'</td></tr>').join('');
    $('vehiclesTable').innerHTML='<table class="table"><thead><tr><th>Valst. Nr.</th><th>Markė</th><th>Pavadinimas</th><th>t</th><th>Būsena</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5">Duomenų nėra</td></tr>')+'</tbody></table>';
  }
  function renderReports(){
    const rows=s.sessions.map(x=>'<tr><td>'+esc(x.date||'—')+'</td><td>'+esc(memberName(x.driverUid))+'</td><td>'+esc(x.vehicleId?vehicleName(x.vehicleId):(x.truck||'—'))+'</td><td>'+num(x.tripsCount)+'</td><td>'+num(x.km,1)+'</td><td>'+num(x.tonnes,1)+'</td></tr>').join('');
    $('reportsTable').innerHTML='<table class="table"><thead><tr><th>Data</th><th>Vairuotojas</th><th>Automobilis</th><th>Reisai</th><th>Km</th><th>Tonos</th></tr></thead><tbody>'+(rows||'<tr><td colspan="6">Duomenų nėra</td></tr>')+'</tbody></table>';
  }
  const call=(name,data={})=>fn.httpsCallable(name)(data).then(r=>r.data);
  function exportCsv(){const rows=[['date','driver','vehicle','trips','km','tonnes'],...s.sessions.map(x=>[x.date,memberName(x.driverUid),x.vehicleId?vehicleName(x.vehicleId):x.truck,x.tripsCount,x.km,x.tonnes])];const cell=v=>{const z=String(v??'');return /[;"\n]/.test(z)?'"'+z.replace(/"/g,'""')+'"':z};const blob=new Blob(['\ufeff'+rows.map(r=>r.map(cell).join(';')).join('\n')],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='KarjeroReisai-'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(a.href);}

  $('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';try{await auth.signInWithEmailAndPassword($('email').value.trim(),$('password').value)}catch(x){$('loginError').textContent=x.message}});
  $('logout').onclick=()=>auth.signOut();
  $('lang').onchange=e=>{s.lang=e.target.value;localStorage.setItem('kr-lang',s.lang);i18n();renderStats();renderFleet();renderReports()};
  $('searchFleet').oninput=renderFleet;
  $('nav').onclick=e=>{const b=e.target.closest('[data-page]');if(!b)return;document.querySelectorAll('.nav').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id==='page-'+b.dataset.page));$('title').textContent=b.textContent.trim();if(b.dataset.page==='map')setTimeout(()=>map.invalidateSize(),50)};
  $('members').onclick=async e=>{const b=e.target.closest('[data-uid]');if(!b)return;try{b.disabled=true;await call('reviewCompanyMembership',{companyId:s.companyId,uid:b.dataset.uid,action:b.dataset.action,role:b.dataset.role||'driver'})}catch(x){alert(x.message)}finally{b.disabled=false}};
  $('newCode').onclick=async()=>{if(!confirm('Sugeneruoti naują įmonės kodą?'))return;try{const r=await call('rotateCompanyCode',{companyId:s.companyId});$('companyCode').textContent=r.companyCode}catch(x){alert(x.message)}};
  $('addVehicle').onclick=()=>$('vehicleDialog').showModal();
  $('cancelVehicle').onclick=()=>$('vehicleDialog').close();
  $('vehicleForm').onsubmit=async e=>{e.preventDefault();try{await call('saveCompanyVehicle',{companyId:s.companyId,plateNumber:$('plate').value,name:$('vehicleName').value,make:$('make').value,payloadT:Number($('payload').value||0),active:true});$('vehicleDialog').close();e.target.reset()}catch(x){alert(x.message)}};
  $('csv').onclick=exportCsv;
  $('portal').onclick=async()=>{try{const r=await call('createBillingPortal');if(r.url)location.href=r.url;else alert('Stripe portalas nepasiekiamas.')}catch(x){alert(x.message)}};
  auth.onAuthStateChanged(async user=>{cleanup();if(!user){showApp(false);return}try{status('Kraunama…');await identity(user);showApp(true);subscribe()}catch(x){$('loginError').textContent=x.message;await auth.signOut();showApp(false)}});
  i18n();renderStats();
})();