-- Rebuild related tables together: D1 does not allow disabling foreign keys.
-- Backups have no foreign keys, so old tables can be removed in dependency order.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE upgrade_payments AS SELECT * FROM payments;
CREATE TABLE upgrade_subscriptions AS SELECT * FROM subscriptions;
CREATE TABLE upgrade_notices AS SELECT * FROM notices;
CREATE TABLE upgrade_reminder_jobs AS SELECT * FROM reminder_jobs;
CREATE TABLE members_new (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',plan TEXT NOT NULL,
 expires TEXT NOT NULL,token TEXT NOT NULL UNIQUE,created TEXT NOT NULL,
 balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),balance_note TEXT NOT NULL DEFAULT ''
);
INSERT INTO members_new(id,name,phone,plan,expires,token,created) SELECT id,name,phone,plan,expires,token,created FROM members;
DROP TABLE reminder_jobs;
DROP TABLE subscriptions;
DROP TABLE notices;
DROP TABLE payments;
DROP TABLE members;
ALTER TABLE members_new RENAME TO members;
CREATE INDEX members_expiry ON members(expires);
CREATE TABLE payments (
 id INTEGER PRIMARY KEY,member_id INTEGER NOT NULL REFERENCES members(id),amount INTEGER NOT NULL CHECK(amount>0),
 method TEXT NOT NULL CHECK(method IN ('Transferencia','Efectivo','Tarjeta')),date TEXT NOT NULL,
 old_expires TEXT NOT NULL,new_expires TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL DEFAULT 'renewal'
);
INSERT INTO payments(id,member_id,amount,method,date,old_expires,new_expires,request_key)
 SELECT id,member_id,amount,method,date,old_expires,new_expires,request_key FROM upgrade_payments;
CREATE INDEX payments_member ON payments(member_id);
CREATE TRIGGER renew_membership AFTER INSERT ON payments WHEN NEW.kind='renewal' BEGIN
 UPDATE members SET expires=NEW.new_expires WHERE id=NEW.member_id;
END;
CREATE TABLE subscriptions (
 endpoint TEXT PRIMARY KEY,member_id INTEGER NOT NULL REFERENCES members(id),subscription TEXT NOT NULL,created TEXT NOT NULL
);
INSERT INTO subscriptions SELECT * FROM upgrade_subscriptions;
CREATE INDEX subscriptions_member ON subscriptions(member_id);
CREATE TABLE notices (
 id INTEGER PRIMARY KEY,member_id INTEGER NOT NULL REFERENCES members(id),title TEXT NOT NULL,body TEXT NOT NULL,
 created TEXT NOT NULL,kind TEXT NOT NULL,expiry TEXT NOT NULL
);
INSERT INTO notices SELECT * FROM upgrade_notices;
CREATE UNIQUE INDEX reminder_once ON notices(member_id,kind,expiry) WHERE kind!='test';
CREATE INDEX notices_member ON notices(member_id);
CREATE TABLE reminder_jobs (
 member_id INTEGER NOT NULL REFERENCES members(id),kind TEXT NOT NULL,expiry TEXT NOT NULL,lease_until INTEGER NOT NULL,
 completed INTEGER NOT NULL DEFAULT 0,attempted_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(member_id,kind,expiry)
);
INSERT INTO reminder_jobs SELECT * FROM upgrade_reminder_jobs;
DROP TABLE upgrade_payments;
DROP TABLE upgrade_subscriptions;
DROP TABLE upgrade_notices;
DROP TABLE upgrade_reminder_jobs;
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price > 0),
  days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 730), description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
INSERT OR IGNORE INTO plans(id,name,price,days,description) VALUES
 ('full','Pase libre',28000,30,'Acceso libre al gimnasio.'),
 ('three','3 veces por semana',22000,30,'Tres entrenamientos por semana.'),
 ('morning','Turno mañana',19000,30,'Entrenamiento en el turno mañana.');
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, weekday INTEGER NOT NULL CHECK(weekday BETWEEN 1 AND 7),
  starts TEXT NOT NULL, ends TEXT NOT NULL, coach TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL DEFAULT 0 CHECK(capacity BETWEEN 0 AND 200), active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS classes_weekday ON classes(active,weekday,starts);
CREATE TABLE IF NOT EXISTS balance_changes (
  id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
  old_balance INTEGER NOT NULL, new_balance INTEGER NOT NULL, reason TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS balance_audit AFTER UPDATE OF balance ON members WHEN OLD.balance != NEW.balance BEGIN
 INSERT INTO balance_changes(member_id,old_balance,new_balance,reason) VALUES(NEW.id,OLD.balance,NEW.balance,NEW.balance_note);
END;
CREATE TRIGGER IF NOT EXISTS validate_debt_payment BEFORE INSERT ON payments WHEN NEW.kind='debt' BEGIN
 SELECT CASE WHEN NEW.amount > (SELECT balance FROM members WHERE id=NEW.member_id)
 THEN RAISE(ABORT,'El pago supera el saldo pendiente.') END;
END;
CREATE TRIGGER IF NOT EXISTS settle_debt AFTER INSERT ON payments WHEN NEW.kind='debt' BEGIN
 UPDATE members SET balance=balance-NEW.amount,balance_note='Pago de saldo pendiente' WHERE id=NEW.member_id;
END;
CREATE TABLE IF NOT EXISTS manual_notices (
  request_key TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), amount INTEGER NOT NULL,
  response TEXT, created INTEGER NOT NULL
);
