/**
 * Database Status Report
 * Shows overview of planes, flights, and verification status
 *
 * Usage:
 *   bun run src/scripts/db-status.ts         # Overview table
 *   bun run src/scripts/db-status.ts --full  # Detailed by tail number
 */

import { initializeDatabase } from "../database/database";

const db = initializeDatabase();

interface PlaneRow {
  TailNumber: string;
  Aircraft: string;
  WiFi: string;
  DateFound: string;
  OperatedBy: string;
  fleet: string;
  last_flight_check: number;
}

interface FlightRow {
  tail_number: string;
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  departure_time: number;
}

interface VerificationRow {
  tail_number: string;
  source: string;
  has_starlink: number | null;
  wifi_provider: string | null;
  checked_at: number;
  error: string | null;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "never";
  return new Date(timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function formatRelative(timestamp: number): string {
  if (!timestamp) return "never";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function printOverview() {
  console.log("\n" + "=".repeat(60));
  console.log("DATABASE STATUS OVERVIEW");
  console.log("=".repeat(60));

  // Planes summary
  const totalPlanes = db.query("SELECT COUNT(*) as count FROM starlink_planes").get() as {
    count: number;
  };
  const byFleet = db
    .query(`
    SELECT fleet, COUNT(*) as count
    FROM starlink_planes
    GROUP BY fleet
  `)
    .all() as { fleet: string; count: number }[];

  console.log("\n📊 PLANES");
  console.log("-".repeat(40));
  console.log(`  Total Starlink planes: ${totalPlanes.count}`);
  for (const row of byFleet) {
    console.log(`    ${row.fleet || "unknown"}: ${row.count}`);
  }

  // Flights summary
  const now = Math.floor(Date.now() / 1000);
  const totalFlights = db.query("SELECT COUNT(*) as count FROM upcoming_flights").get() as {
    count: number;
  };
  const futureFlights = db
    .query("SELECT COUNT(*) as count FROM upcoming_flights WHERE departure_time > ?")
    .get(now) as { count: number };
  const staleFlights = db
    .query("SELECT COUNT(*) as count FROM upcoming_flights WHERE departure_time <= ?")
    .get(now) as { count: number };
  const planesWithFlights = db
    .query(
      "SELECT COUNT(DISTINCT tail_number) as count FROM upcoming_flights WHERE departure_time > ?"
    )
    .get(now) as { count: number };

  console.log("\n✈️  FLIGHTS");
  console.log("-".repeat(40));
  console.log(`  Total flights in DB: ${totalFlights.count}`);
  console.log(`  Future flights: ${futureFlights.count}`);
  console.log(`  Stale flights: ${staleFlights.count}`);
  console.log(`  Planes with future flights: ${planesWithFlights.count}`);

  // Flight check status
  const neverChecked = db
    .query(
      "SELECT COUNT(*) as count FROM starlink_planes WHERE last_flight_check = 0 OR last_flight_check IS NULL"
    )
    .get() as { count: number };
  const checkedLast6h = db
    .query("SELECT COUNT(*) as count FROM starlink_planes WHERE last_flight_check > ?")
    .get(now - 6 * 3600) as { count: number };
  const checkedLast24h = db
    .query("SELECT COUNT(*) as count FROM starlink_planes WHERE last_flight_check > ?")
    .get(now - 24 * 3600) as { count: number };

  console.log("\n🔄 FLIGHT DATA FRESHNESS");
  console.log("-".repeat(40));
  console.log(`  Never checked: ${neverChecked.count}`);
  console.log(`  Checked in last 6h: ${checkedLast6h.count}`);
  console.log(`  Checked in last 24h: ${checkedLast24h.count}`);

  // Verification summary
  const totalVerifications = db
    .query("SELECT COUNT(*) as count FROM starlink_verification_log")
    .get() as { count: number };
  const verifyLast24h = db
    .query("SELECT COUNT(*) as count FROM starlink_verification_log WHERE checked_at > ?")
    .get(now - 24 * 3600) as { count: number };

  const bySource = db
    .query(`
    SELECT source, COUNT(*) as count
    FROM starlink_verification_log
    GROUP BY source
  `)
    .all() as { source: string; count: number }[];

  const byResult = db
    .query(`
    SELECT
      CASE
        WHEN has_starlink = 1 THEN 'Starlink confirmed'
        WHEN has_starlink = 0 THEN 'No Starlink'
        WHEN error IS NOT NULL THEN 'Error'
        ELSE 'Unknown'
      END as result,
      COUNT(*) as count
    FROM starlink_verification_log
    WHERE source = 'united'
    GROUP BY result
  `)
    .all() as { result: string; count: number }[];

  console.log("\n✅ UNITED VERIFICATION");
  console.log("-".repeat(40));
  console.log(`  Total verifications: ${totalVerifications.count}`);
  console.log(`  Last 24h: ${verifyLast24h.count}`);
  console.log("  By source:");
  for (const row of bySource) {
    console.log(`    ${row.source}: ${row.count}`);
  }
  console.log("  United results:");
  for (const row of byResult) {
    console.log(`    ${row.result}: ${row.count}`);
  }

  // Recent verifications
  const recentVerifications = db
    .query(`
    SELECT tail_number, has_starlink, wifi_provider, checked_at, error
    FROM starlink_verification_log
    WHERE source = 'united'
    ORDER BY checked_at DESC
    LIMIT 5
  `)
    .all() as VerificationRow[];

  console.log("\n🕐 RECENT UNITED VERIFICATIONS");
  console.log("-".repeat(40));
  for (const v of recentVerifications) {
    const status = v.has_starlink === 1 ? "✓" : v.has_starlink === 0 ? "✗" : "?";
    const provider = v.wifi_provider || v.error?.slice(0, 20) || "unknown";
    console.log(
      `  ${status} ${v.tail_number.padEnd(8)} ${provider.padEnd(20)} ${formatRelative(v.checked_at)}`
    );
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

function printFull() {
  console.log("\n" + "=".repeat(100));
  console.log("FULL DATABASE STATUS BY TAIL NUMBER");
  console.log("=".repeat(100));

  const now = Math.floor(Date.now() / 1000);

  const planes = db
    .query(`
    SELECT * FROM starlink_planes
    ORDER BY DateFound DESC, TailNumber
  `)
    .all() as PlaneRow[];

  // Get all flights grouped by tail
  const flights = db
    .query(`
    SELECT * FROM upcoming_flights
    WHERE departure_time > ?
    ORDER BY departure_time
  `)
    .all(now) as FlightRow[];

  const flightsByTail: Record<string, FlightRow[]> = {};
  for (const f of flights) {
    if (!flightsByTail[f.tail_number]) flightsByTail[f.tail_number] = [];
    flightsByTail[f.tail_number].push(f);
  }

  // Get latest verification for each tail
  const verifications = db
    .query(`
    SELECT v.* FROM starlink_verification_log v
    INNER JOIN (
      SELECT tail_number, MAX(checked_at) as max_checked
      FROM starlink_verification_log
      WHERE source = 'united'
      GROUP BY tail_number
    ) latest ON v.tail_number = latest.tail_number AND v.checked_at = latest.max_checked
    WHERE v.source = 'united'
  `)
    .all() as VerificationRow[];

  const verificationByTail: Record<string, VerificationRow> = {};
  for (const v of verifications) {
    verificationByTail[v.tail_number] = v;
  }

  // Print header
  console.log(
    "\n" +
      [
        "Tail".padEnd(10),
        "Aircraft".padEnd(12),
        "Fleet".padEnd(10),
        "Installed".padEnd(12),
        "Flights".padEnd(8),
        "Last Check".padEnd(12),
        "Verified".padEnd(20),
      ].join(" | ")
  );
  console.log("-".repeat(100));

  for (const plane of planes) {
    const tailFlights = flightsByTail[plane.TailNumber] || [];
    const verification = verificationByTail[plane.TailNumber];

    let verifiedStr = "not verified";
    if (verification) {
      if (verification.has_starlink === 1) {
        verifiedStr = `✓ ${verification.wifi_provider}`;
      } else if (verification.has_starlink === 0) {
        verifiedStr = `✗ ${verification.wifi_provider || "no starlink"}`;
      } else if (verification.error) {
        verifiedStr = `? ${verification.error.slice(0, 15)}`;
      }
    }

    console.log(
      [
        plane.TailNumber.padEnd(10),
        (plane.Aircraft || "").slice(0, 11).padEnd(12),
        (plane.fleet || "").padEnd(10),
        (plane.DateFound || "").padEnd(12),
        String(tailFlights.length).padEnd(8),
        formatRelative(plane.last_flight_check).padEnd(12),
        verifiedStr.slice(0, 20).padEnd(20),
      ].join(" | ")
    );

    // Show upcoming flights
    if (tailFlights.length > 0) {
      for (const f of tailFlights.slice(0, 2)) {
        const route = `${f.departure_airport}->${f.arrival_airport}`;
        console.log(
          `           └─ ${f.flight_number.padEnd(10)} ${route.padEnd(12)} ${formatDate(f.departure_time)}`
        );
      }
      if (tailFlights.length > 2) {
        console.log(`           └─ ... and ${tailFlights.length - 2} more flights`);
      }
    }
  }

  console.log("\n" + "=".repeat(100) + "\n");
}

// Main
const args = process.argv.slice(2);
const showFull = args.includes("--full") || args.includes("-f");

if (showFull) {
  printFull();
} else {
  printOverview();
}

db.close();
