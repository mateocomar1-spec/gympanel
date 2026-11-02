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
