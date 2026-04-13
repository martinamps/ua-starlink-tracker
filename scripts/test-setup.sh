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

-- Seed flight_routes cache for UA100 so predict_flight_starlink test never
-- falls through to live FR24 (the one network-dependent flake).
INSERT OR REPLACE INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
  VALUES ('UA100', 'EWR', 'TLV', 39600, strftime('%s','now'), strftime('%s','now'), 1);

-- Real AS fleet sample — mid-rollout: Horizon E175s confirmed (first to ship),
-- mainline 737s mostly unknown.
INSERT OR IGNORE INTO united_fleet (tail_number, aircraft_type, fleet, operated_by, starlink_status, verified_wifi, verified_at, first_seen_source, first_seen_at, last_seen_at, airline) VALUES
  ('N654QX','Embraer ERJ-175LR','horizon','Horizon Air','confirmed','Starlink',1774190000,'as_seed',1774190000,1774190000,'AS'),
  ('N658QX','Embraer ERJ-175LR','horizon','Horizon Air','confirmed','Starlink',1774190000,'as_seed',1774190000,1774190000,'AS'),
  ('N292AK','Boeing 737-900ER','mainline','Alaska Airlines','unknown',NULL,NULL,'as_seed',1774190000,1774190000,'AS'),
  ('N915AK','Boeing 737-9 MAX','mainline','Alaska Airlines','unknown',NULL,NULL,'as_seed',1774190000,1774190000,'AS'),
  ('N613AS','Boeing 737-700','mainline','Alaska Airlines','unknown',NULL,NULL,'as_seed',1774190000,1774190000,'AS');

INSERT OR IGNORE INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline) VALUES
  ('Embraer ERJ-175LR','Starlink','as_seed','AS-horizon','2025-12-15','N654QX','Horizon Air','horizon','Starlink','AS'),
  ('Embraer ERJ-175LR','Starlink','as_seed','AS-horizon','2025-12-15','N658QX','Horizon Air','horizon','Starlink','AS');

INSERT OR IGNORE INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline) VALUES
  ('N654QX','QX2304','SEA','PDX',1774200000,1774206000,1774190000,'AS'),
  ('N292AK','AS307','SEA','LAX',1774200000,1774215000,1774190000,'AS');

-- HA + AS meta keys (so previews/tests render real percentages, not 0%).
INSERT OR REPLACE INTO meta (key, value) VALUES
  ('HA:totalAircraftCount', '12'),
  ('HA:mainlineStarlink', '9'),
  ('HA:mainlineTotal', '12'),
  ('HA:mainlinePercentage', '75.00'),
  ('HA:lastUpdated', '2026-04-12T00:00:00.000Z'),
  ('AS:totalAircraftCount', '6'),
  ('AS:mainlineStarlink', '3'),
  ('AS:mainlineTotal', '6'),
  ('AS:mainlinePercentage', '50.00'),
  ('AS:lastUpdated', '2026-04-12T00:00:00.000Z');
SQL

echo "test DB ready at $DB"
