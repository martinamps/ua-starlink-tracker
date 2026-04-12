#!/usr/bin/env bash
set -euo pipefail

DB=/tmp/ua-test.sqlite
SRC=plane-data.production.sqlite

cp "$SRC" "$DB"

sqlite3 "$DB" 'PRAGMA journal_mode=DELETE;'

# Run the real migration path so test schema can never drift from prod.
DB_PATH="$DB" DISABLE_JOBS=1 bun -e 'import {initializeDatabase} from "./src/database/database"; initializeDatabase().close()'

sqlite3 "$DB" <<'SQL'
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
