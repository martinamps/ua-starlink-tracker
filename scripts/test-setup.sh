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
         ('N644AS', '737-700',  'mainline', 'confirmed', 'Starlink', 'canary', 1774190000, 1774190000, 'AS'),
         ('A7-TST', 'B777-300ER', 'mainline', 'confirmed', 'Starlink', 'canary', 1774190000, 1774190000, 'QR');

INSERT OR IGNORE INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
  VALUES ('A330-200', 'Starlink', 'discovery', 'HA-mainline', '2026-01-01', 'N999HA', 'Hawaiian Airlines', 'mainline', 'Starlink', 'HA'),
         ('737-700',  'Starlink', 'discovery', 'AS-mainline', '2026-01-01', 'N644AS', 'Alaska Airlines',   'mainline', 'Starlink', 'AS'),
         ('B777-300ER', 'Starlink', 'discovery', 'QR-mainline', '2026-01-01', 'A7-TST', 'Qatar Airways', 'mainline', 'Starlink', 'QR');

INSERT OR IGNORE INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
  VALUES ('N999HA', 'HA9999', 'HNL', 'LAX', 1774200000, 1774220000, 1774190000, 'HA'),
         ('N644AS', 'AS118',  'SEA', 'SAN', 1774200000, 1774215000, 1774190000, 'AS'),
         ('A7-TST', 'QR9999', 'DOH', 'LHR', 1774200000, 1774230000, 1774190000, 'QR');

-- Real HA fleet sample (subset of seed-hawaiian output) — hermetic stand-in for
-- the live FR24 scrape so isolation tests exercise real tails without network.
INSERT OR IGNORE INTO united_fleet (tail_number, aircraft_type, fleet, operated_by, starlink_status, verified_wifi, verified_at, first_seen_source, first_seen_at, last_seen_at, airline) VALUES
  ('N380HA','Airbus A330-243','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N382HA','Airbus A330-243','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N383HA','Airbus A330-243','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N385HA','Airbus A330-243','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N389HA','Airbus A330-243','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N393HA','Airbus A330-243','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N202HA','Airbus A321-271N','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N205HA','Airbus A321-271N','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N215HA','Airbus A321-271N','mainline','Hawaiian Airlines','confirmed','Starlink',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N475HA','Boeing 717-22A','mainline','Hawaiian Airlines','negative','None',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N488HA','Boeing 717-22A','mainline','Hawaiian Airlines','negative','None',1727136000,'ha_seed',1727136000,1774190000,'HA'),
  ('N490HA','Boeing 717-22A','mainline','Hawaiian Airlines','negative','None',1727136000,'ha_seed',1727136000,1774190000,'HA');

INSERT OR IGNORE INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline) VALUES
  ('Airbus A330-243','Starlink','ha_seed','HA-mainline','2024-09-24','N380HA','Hawaiian Airlines','mainline','Starlink','HA'),
  ('Airbus A330-243','Starlink','ha_seed','HA-mainline','2024-09-24','N382HA','Hawaiian Airlines','mainline','Starlink','HA'),
  ('Airbus A330-243','Starlink','ha_seed','HA-mainline','2024-09-24','N383HA','Hawaiian Airlines','mainline','Starlink','HA'),
  ('Airbus A330-243','Starlink','ha_seed','HA-mainline','2024-09-24','N385HA','Hawaiian Airlines','mainline','Starlink','HA'),
  ('Airbus A330-243','Starlink','ha_seed','HA-mainline','2024-09-24','N389HA','Hawaiian Airlines','mainline','Starlink','HA'),
  ('Airbus A330-243','Starlink','ha_seed','HA-mainline','2024-09-24','N393HA','Hawaiian Airlines','mainline','Starlink','HA'),
  ('Airbus A321-271N','Starlink','ha_seed','HA-mainline','2024-09-24','N202HA','Hawaiian Airlines','mainline','Starlink','HA'),
  ('Airbus A321-271N','Starlink','ha_seed','HA-mainline','2024-09-24','N205HA','Hawaiian Airlines','mainline','Starlink','HA'),
  ('Airbus A321-271N','Starlink','ha_seed','HA-mainline','2024-09-24','N215HA','Hawaiian Airlines','mainline','Starlink','HA');
SQL

echo "test DB ready at $DB"
