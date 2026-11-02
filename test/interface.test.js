import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {webcrypto} from 'node:crypto';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace('if(main)ownerInit();else memberInit();','');
function context(html,fetch,pathname='/') {
 const parsed=parseHTML(html);
 const window={document:parsed.document,Event:parsed.window.Event,matchMedia:()=>({matches:false}),isSecureContext:false};
 window.document.querySelectorAll('dialog').forEach(d=>{d.showModal=()=>{d.open=true;};d.close=()=>{d.open=false;};});
 class FormData {
   constructor(form){this.items=[...form.querySelectorAll('input,select,textarea')].filter(el=>el.name).map(el=>[el.name,el.value]);}
   [Symbol.iterator](){return this.items[Symbol.iterator]();}
 }
 const ctx=vm.createContext({window,document:window.document,fetch,console,Intl,Date,URL,FormData,crypto:webcrypto,
   navigator:{userAgent:'Test',platform:'Test',maxTouchPoints:0},location:{pathname,origin:'https://gympanel.test'},
   setTimeout:()=>1,clearTimeout:()=>{},Uint8Array,atob,Notification:{permission:'default'}});
 vm.runInContext(source,ctx);return {ctx,document:window.document,window};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('Admin interface renders new sections and submits explicit balance and plan values',async()=>{
 const calls=[],dashboard={today:'2026-11-02',demo:true,plans:[{id:'full',name:'Mensual',price:28000,days:30,description:'Acceso libre',active:1}],members:[{id:1,name:'Ana Pérez',phone:'',token:'a'.repeat(48),plan:'full',expires:'2026-11-01',balance:15000,devices:1}],payments:[],notices:[],classes:[]};
 const {ctx,document,window}=context(readFileSync('public/index.html','utf8'),async(url,options={})=>{
   calls.push({url,...options});
   if(url==='/api/owner/dashboard')return Response.json(dashboard);
   if(url.endsWith('/debt-notice'))return Response.json({title:'Saldo pendiente',body:'Tenés un saldo de $ 15.000.',amount:15000,devices:1});
   if(url.endsWith('/balance')&&options.method==='PUT'){dashboard.members[0].balance=JSON.parse(options.body).balance;return Response.json({balance:dashboard.members[0].balance});}
   return Response.json({ok:true,id:'new'});
 });
 await vm.runInContext('ownerInit()',ctx);
 assert.match(document.querySelector('#main').textContent,/Saldos pendientes/);
 document.querySelector('[data-page="schedule"]').click();
 assert.match(document.querySelector('#main').textContent,/Cada clase, en su horario/);
 document.querySelector('[data-action="new-class"]').click();assert.ok(document.querySelector('#class-form input[name="starts"]'));
 document.querySelector('[data-action="close"]').click();
 await vm.runInContext('noticeForm(1)',ctx);
 assert.match(document.querySelector('.phone-preview').textContent,/15.000/);
 assert.equal(document.querySelector('#notice-form input[name="amount"]').value,'15000');
 assert.equal(calls.filter(c=>c.url.endsWith('/debt-notice')&&c.method==='POST').length,0,'preview never sends a notification');
 vm.runInContext('balanceForm(1)',ctx);
 const form=document.querySelector('#balance-form');form.querySelector('[name="balance"]').value='12000';form.querySelector('[name="reason"]').value='Corrección de saldo';
 form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await flush();await flush();
 const saved=calls.find(c=>c.url.endsWith('/balance')&&c.method==='PUT');assert.deepEqual(JSON.parse(saved.body),{expectedBalance:15000,balance:12000,reason:'Corrección de saldo'});
 vm.runInContext('planForm()',ctx);const plan=document.querySelector('#plan-form');
 plan.querySelector('[name="name"]').value='Trimestral';plan.querySelector('[name="price"]').value='80000';plan.querySelector('[name="days"]').value='90';
 plan.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await flush();await flush();
 const created=calls.find(c=>c.url==='/api/owner/plans'&&c.method==='POST');assert.equal(JSON.parse(created.body).days,90);assert.equal(JSON.parse(created.body).price,80000);
});
test('Member interface displays the recorded balance, weekly classes and renewal/payment distinction',async()=>{
 const data={id:1,name:'Ana Pérez',expires:'2026-11-01',today:'2026-11-02',balance:15000,plan:{name:'Mensual',days:30,price:28000},classes:[{id:1,name:'Funcional',weekday:1,starts:'09:00',ends:'10:00',coach:'Luz',room:'Sala A',capacity:20}],payments:[{date:'2026-11-01',amount:5000,method:'Efectivo',kind:'debt'}],notices:[]};
 const {ctx,document}=context(readFileSync('public/member.html','utf8'),async()=>Response.json(data),'/socio/'+'a'.repeat(48));
 await vm.runInContext('memberInit()',ctx);
 assert.match(document.querySelector('.member-balance').textContent,/15.000/);
 assert.match(document.querySelector('#my-classes').textContent,/Funcional/);
 assert.match(document.querySelector('#my-payments').textContent,/Pago de saldo/);
 assert.match(document.querySelector('#push-status').textContent,/HTTPS/);
 assert.equal(document.querySelector('link[rel="manifest"]').getAttribute('href'),'/manifest/'+'a'.repeat(48)+'.webmanifest');
});
