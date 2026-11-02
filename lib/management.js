import { randomUUID } from 'node:crypto';

const check = (ok, message, status = 400) => { if (!ok) throw Object.assign(new Error(message), { status }); };
const keyValid = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
const out = (body, status = 200) => ({ body, status });
export const nodeStore = db => ({
  get: async (sql, ...args) => db.prepare(sql).get(...args),
  all: async (sql, ...args) => db.prepare(sql).all(...args),
  run: async (sql, ...args) => db.prepare(sql).run(...args)
});
export const d1Store = db => ({
  get: (sql, ...args) => db.prepare(sql).bind(...args).first(),
  all: async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results,
  run: (sql, ...args) => db.prepare(sql).bind(...args).run()
});
export function managementPath(path) {
  return /^\/api\/owner\/(plans(?:\/[^/]+)?|classes(?:\/\d+)?|members\/\d+\/(balance|debt-payment|debt-notice))$/.test(path);
}
export async function management({ store: db, path, method, data = {}, date, deliver }) {
  let match = path.match(/^\/api\/owner\/plans(?:\/([^/]+))?$/);
  if (match) {
    if (method === 'GET' && !match[1]) return out(await db.all('SELECT * FROM plans ORDER BY active DESC,rowid'));
    check(['POST','PUT'].includes(method), 'Operación no disponible.', 405);
    const { name, price, days, description = '', active = 1 } = data;
    check(text(name,2,70), 'El nombre del plan debe tener entre 2 y 70 caracteres.');
    check(integer(price,1,100000000), 'Ingresá el precio en pesos, sin centavos.');
    check(integer(days,1,730), 'La duración debe ser de 1 a 730 días.');
    check(text(description,0,300), 'La descripción puede tener hasta 300 caracteres.');
    check([0,1].includes(active), 'Estado de plan inválido.');
    if (method === 'POST') {
      check(!match[1], 'Ruta inválida.',404);
      const id = randomUUID();
      await db.run('INSERT INTO plans(id,name,price,days,description,active) VALUES(?,?,?,?,?,?)', id, name.trim(),price,days,description.trim(),active);
      return out({ id },201);
    }
    check(match[1], 'Falta el plan.');
    const row = await db.get('UPDATE plans SET name=?,price=?,days=?,description=?,active=? WHERE id=? RETURNING id',name.trim(),price,days,description.trim(),active,match[1]);
    check(row,'Plan no encontrado.',404); return out({ ok:true });
  }
  match = path.match(/^\/api\/owner\/classes(?:\/(\d+))?$/);
  if (match) {
    if (method === 'GET' && !match[1]) return out(await db.all('SELECT * FROM classes WHERE active=1 ORDER BY weekday,starts'));
    if (method === 'DELETE' && match[1]) {
      const row = await db.get('UPDATE classes SET active=0 WHERE id=? AND active=1 RETURNING id',Number(match[1]));
      check(row,'Clase no encontrada.',404); return out({ ok:true });
    }
    check(['POST','PUT'].includes(method), 'Operación no disponible.',405);
    const { name,weekday,starts,ends,coach='',room='',capacity=0 } = data;
    check(text(name,2,70),'Ingresá un nombre de clase de entre 2 y 70 caracteres.');
    check(integer(weekday,1,7),'Seleccioná un día válido.');
    const time = value => typeof value==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    check(time(starts)&&time(ends)&&ends>starts,'El fin debe ser posterior al inicio, dentro del mismo día.');
    check(text(coach,0,80)&&text(room,0,60),'Revisá el profesor y la sala.');
    check(integer(capacity,0,200),'El cupo debe ser de 0 a 200. Usá 0 si no lo definís.');
    const conflict = await db.get('SELECT id FROM classes WHERE active=1 AND weekday=? AND room=? AND starts<? AND ends>? AND id!=?',weekday,room.trim(),ends,starts,Number(match[1]||0));
    check(!conflict, 'Ese horario se superpone con otra clase en la misma sala.',409);
    if (method === 'POST') {
      check(!match[1],'Ruta inválida.',404);
      return out(await db.get('INSERT INTO classes(name,weekday,starts,ends,coach,room,capacity) VALUES(?,?,?,?,?,?,?) RETURNING id',name.trim(),weekday,starts,ends,coach.trim(),room.trim(),capacity),201);
    }
    const row = await db.get('UPDATE classes SET name=?,weekday=?,starts=?,ends=?,coach=?,room=?,capacity=? WHERE id=? AND active=1 RETURNING id',name.trim(),weekday,starts,ends,coach.trim(),room.trim(),capacity,Number(match[1]));
    check(row,'Clase no encontrada.',404); return out({ok:true});
  }
  match = path.match(/^\/api\/owner\/members\/(\d+)\/(balance|debt-payment|debt-notice)$/);
  if (!match) return null;
  const memberId=Number(match[1]), action=match[2];
  const member=await db.get('SELECT m.*,(SELECT count(*) FROM subscriptions s WHERE s.member_id=m.id) AS devices FROM members m WHERE m.id=?',memberId);
  check(member,'Socio no encontrado.',404);
  if(action==='balance') {
    if(method==='GET') return out({balance:member.balance,changes:await db.all('SELECT old_balance,new_balance,reason,created FROM balance_changes WHERE member_id=? ORDER BY id DESC LIMIT 30',memberId)});
    check(method==='PUT','Operación no disponible.',405);
    check(integer(data.balance,0,100000000)&&integer(data.expectedBalance,0,100000000),'Ingresá un saldo válido en pesos.');
    check(text(data.reason,3,200),'Indicá el motivo del ajuste (3 a 200 caracteres).');
    const row=await db.get('UPDATE members SET balance=?,balance_note=? WHERE id=? AND balance=? RETURNING balance',data.balance,data.reason.trim(),memberId,data.expectedBalance);
    check(row,'El saldo cambió. Actualizá la ficha antes de ajustar.',409); return out(row);
  }
  if(action==='debt-payment') {
    check(method==='POST','Operación no disponible.',405);
    const {amount,method:paymentMethod,requestKey}=data;
    check(keyValid(requestKey),'Falta el identificador del pago.');
    const previous=await db.get('SELECT * FROM payments WHERE request_key=?',requestKey);
    const replay=row=>{check(row.member_id===memberId&&row.amount===amount&&row.method===paymentMethod&&row.kind==='debt','El identificador ya se usó para otro pago.');return out({ok:true,replayed:true});};
    if(previous) return replay(previous);
    check(integer(amount,1,100000000)&&amount<=member.balance,'El pago debe ser positivo y no superar el saldo pendiente.');
    check(['Transferencia','Efectivo','Tarjeta'].includes(paymentMethod),'Medio de pago inválido.');
    // The trigger reduces the balance atomically, without renewing the membership.
    const paid=await db.get(`INSERT INTO payments(member_id,amount,method,date,old_expires,new_expires,request_key,kind)
      SELECT id,?,?,?,expires,expires,?,'debt' FROM members WHERE id=? AND balance>=?
      ON CONFLICT(request_key) DO NOTHING RETURNING id`,amount,paymentMethod,date,requestKey,memberId,amount);
    if(!paid) { const existing=await db.get('SELECT * FROM payments WHERE request_key=?',requestKey);if(existing)return replay(existing);check(false,'El saldo cambió. Volvé a abrir el cobro.',409); }
    return out({ok:true},201);
  }
  const title='Recordatorio de saldo pendiente';
  const formatted=new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(member.balance);
  const message=`Hola, ${member.name.split(' ')[0]}. Te recordamos que tenés un saldo pendiente de ${formatted}. Acercate a recepción para regularizarlo. Si ya pagaste, consultanos para actualizar tu cuenta.`;
  if(method==='GET') return out({title,body:message,amount:member.balance,devices:member.devices});
  check(method==='POST','Operación no disponible.',405);
  check(keyValid(data.requestKey),'Falta el identificador del aviso.');
  const previous=await db.get('SELECT * FROM manual_notices WHERE request_key=?',data.requestKey);
  if(previous) {
    check(previous.member_id===memberId&&previous.amount===data.amount,'El identificador corresponde a otro aviso.');
    check(previous.response,'El aviso ya se está procesando. No vuelvas a enviarlo.',409);
    const result=JSON.parse(previous.response);return out({...result,replayed:true},result.sent?200:503);
  }
  check(member.balance>0,'Este socio no tiene saldo pendiente registrado.');
  check(data.amount===member.balance,'El saldo cambió. Revisá el monto antes de enviar el aviso.',409);
  check(member.devices>0,'El socio todavía no activó los avisos. Compartile su credencial para que los active.',409);
  const recent=await db.get('SELECT request_key FROM manual_notices WHERE member_id=? AND created>?',memberId,Date.now()-60000);
  check(!recent,'Esperá un minuto antes de enviar otro aviso a este socio.',429);
  const claimed=await db.get('INSERT INTO manual_notices(request_key,member_id,amount,created) VALUES(?,?,?,?) ON CONFLICT(request_key) DO NOTHING RETURNING request_key',data.requestKey,memberId,member.balance,Date.now());
  check(claimed,'Este aviso ya está siendo procesado.',409);
  const result=await deliver(member,title,message,'manual:'+data.requestKey);
  const response={...result,error:result.sent?undefined:'El proveedor no aceptó el aviso. Revisá los dispositivos activos.'};
  await db.run('UPDATE manual_notices SET response=? WHERE request_key=?',JSON.stringify(response),data.requestKey);
  return out(response,result.sent?200:503);
}
