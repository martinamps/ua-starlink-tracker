#!/usr/bin/env bash
set -euo pipefail

DB=/tmp/ua-test.sqlite
SRC=plane-data.production.sqlite

cp "$SRC" "$DB"

sqlite3 "$DB" <<'SQL'
PRAGMA journal_mode=DELETE;

CREATE TABLE IF NOT EXISTS flight_routes (
  flight_number TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  duration_sec INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER DEFAULT 1,
  PRIMARY KEY (flight_number, origin, destination)
);

CREATE TABLE IF NOT EXISTS departure_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tail_number TEXT NOT NULL,
  airport TEXT NOT NULL,
  departed_at INTEGER NOT NULL
);
SQL

# Prior-snapshot column backfills (idempotent — ignore "duplicate column" errors)
sqlite3 "$DB" 'ALTER TABLE starlink_verification_log ADD COLUMN tail_confirmed INTEGER;' 2>/dev/null || true
sqlite3 "$DB" 'ALTER TABLE united_fleet ADD COLUMN ship_number TEXT;' 2>/dev/null || true

# Multi-airline Phase-1 columns
for T in starlink_planes united_fleet upcoming_flights starlink_verification_log departure_log; do
  sqlite3 "$DB" "ALTER TABLE $T ADD COLUMN airline TEXT NOT NULL DEFAULT 'UA';" 2>/dev/null || true
done

sqlite3 "$DB" <<'SQL'
CREATE INDEX IF NOT EXISTS idx_sp_airline   ON starlink_planes(airline);
CREATE INDEX IF NOT EXISTS idx_uf_airline   ON united_fleet(airline, starlink_status);
CREATE INDEX IF NOT EXISTS idx_upf_airline  ON upcoming_flights(airline, flight_number);
CREATE INDEX IF NOT EXISTS idx_vlog_airline ON starlink_verification_log(airline, tail_number);

UPDATE meta SET key = 'UA:' || key WHERE key NOT LIKE '%:%';

UPDATE starlink_verification_log SET tail_confirmed=1 WHERE error IS NULL AND tail_confirmed IS NULL;

-- Canary rows: must NEVER appear on a UA-scoped surface. Isolation tests grep for these.
INSERT OR IGNORE INTO united_fleet (tail_number, aircraft_type, fleet, starlink_status, verified_wifi, first_seen_source, first_seen_at, last_seen_at, airline)
  VALUES ('N999HA', 'A330-200', 'mainline', 'confirmed', 'Starlink', 'canary', 1774190000, 1774190000, 'HA'),
         ('A7-TST', 'B777-300ER', 'mainline', 'confirmed', 'Starlink', 'canary', 1774190000, 1774190000, 'QR');

INSERT OR IGNORE INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
  VALUES ('A330-200', 'Starlink', 'discovery', 'HA-mainline', '2026-01-01', 'N999HA', 'Hawaiian Airlines', 'mainline', 'Starlink', 'HA'),
         ('B777-300ER', 'Starlink', 'discovery', 'QR-mainline', '2026-01-01', 'A7-TST', 'Qatar Airways', 'mainline', 'Starlink', 'QR');

INSERT OR IGNORE INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
  VALUES ('N999HA', 'HA9999', 'HNL', 'LAX', 1774200000, 1774220000, 1774190000, 'HA'),
         ('A7-TST', 'QR9999', 'DOH', 'LHR', 1774200000, 1774230000, 1774190000, 'QR');
SQL

echo "test DB ready at $DB"
