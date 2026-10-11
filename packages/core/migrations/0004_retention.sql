CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK(id=1),next INTEGER NOT NULL);
INSERT INTO maintenance VALUES (1,0);
CREATE INDEX audit_retention ON audit(at);
CREATE INDEX credentials_expiry ON credentials(expiresAt);
