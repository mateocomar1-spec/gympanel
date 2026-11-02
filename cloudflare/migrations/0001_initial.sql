CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL CHECK(plan IN ('full','three','morning')),
  expires TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created TEXT NOT NULL
);
CREATE INDEX members_expiry ON members(expires);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL CHECK(amount > 0),
  method TEXT NOT NULL CHECK(method IN ('Transferencia','Efectivo','Tarjeta')),
  date TEXT NOT NULL,
  old_expires TEXT NOT NULL,
  new_expires TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE
);
-- The payment and renewal commit together, including concurrent requests.
CREATE TRIGGER renew_membership AFTER INSERT ON payments BEGIN
  UPDATE members SET expires = NEW.new_expires WHERE id = NEW.member_id;
END;
CREATE INDEX payments_member ON payments(member_id);
CREATE TABLE subscriptions (
  endpoint TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  subscription TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX subscriptions_member ON subscriptions(member_id);
CREATE TABLE notices (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created TEXT NOT NULL,
  kind TEXT NOT NULL,
  expiry TEXT NOT NULL
);
CREATE UNIQUE INDEX reminder_once ON notices(member_id,kind,expiry) WHERE kind != 'test';
CREATE INDEX notices_member ON notices(member_id);
CREATE TABLE reminder_jobs (
  member_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL,
  expiry TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(member_id,kind,expiry)
);
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
