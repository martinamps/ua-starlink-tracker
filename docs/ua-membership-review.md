# Proposed UA/N63571 membership repair

This candidate is for upstream owner review. It has not been deployed or applied to a production database. It changes one reviewed membership, not the meaning of “equipped,” the treatment of unknown aircraft types, or WiFiOdds' acceptance rules.

## Evidence and reachable defect

The [FAA exact-number result](https://registry.faa.gov/aircraftinquiry/Search/NNumberResult?NNumberTxt=63571), checked October 17, 2026, identifies N63571 as an Aerostar RX 8 balloon, serial RX8-3127. Its inclusion in United's passenger-fleet denominator conflicts with that identity. [Issue 168](https://github.com/martinamps/ua-starlink-tracker/issues/168) records the public report. N34571 is a separate registration; this patch does not rename either tail.

`updateDatabase` can accept an untyped sheet listing. `syncSpreadsheetToFleet` can then insert an untyped, unverified fleet member. A later sheet replacement removes the listing but deliberately retains fleet membership: losing Starlink does not mean an aircraft left the airline. This explains a reachable persistence path. We have not inspected the production insertion event and do not claim that a synthetic reproduction proves its provenance.

## Candidate behavior

- A dated, exact UA/N63571 hold guards sheet ingestion, sheet-to-fleet sync, fleet upsert, and discovered listings. Other airlines and legitimate unknown types retain their existing behavior. Release requires explicit review of new identity/admission evidence; it does not expire automatically.
- A scrape refuses before changing anything if a held legacy fleet/listing row still exists. It cannot silently delete the evidence before an explicit correction. When no held row exists, rejected incoming entries do not count toward the existing nonempty or relative-shrink floors.
- An explicit repair previews the existing target rows, sanitized FAA identity, relevant flight/verification evidence, UA metadata and programme-roster fingerprint. It requires one canonical, untyped, unverified, spreadsheet-sourced UA fleet row, with at most one unverified numeric-sheet listing. Typed, verified, ambiguous, reassigned, independently corroborated or otherwise unexpected states stop for review. It refuses to leave an empty programme roster.
- Applying requires the exact reviewed fingerprint, rechecked inside an independent SQLite immediate transaction. It archives the complete reviewed plan in `fleet_membership_corrections`, deletes only the exact scoped fleet/listing rows, and recomputes metadata through `refreshFleetMeta`. A failed step rolls back archive and data changes together. UA's source timestamp remains unchanged. Verification and flight histories are never deleted.
- No migration, startup path, job, endpoint or scheduler calls the repair. The CLI defaults to a read-only handle on an explicitly supplied existing database; it does not use `DB_PATH` or initialize/migrate the database. A fingerprint protects reviewed content; it is not an authorization credential.

## Upstream operator sequence — requires approval and database ownership

1. Review this code and the exact-tail evidence. Inspect the actual production schema and target provenance; this candidate has no production database access. Check target records in other serving/provenance tables, especially `fleet_progress_tails`, `pipeline_events`, guide data, BTS and ADS-B records. This bounded repair does not inspect or rewrite those tables and does not claim comprehensive absence of corroboration. If relevant records exist, stop and extend the reviewed plan instead of deleting them ad hoc.
2. Coordinate a maintenance window, stop all old ingestion writers, and retain a verified database backup. Install the prevention guards before writers resume. Deploying the guards alone leaves an existing held row in place and intentionally refuses UA sheet replacements until correction is resolved.
3. On a private production copy first, run the default preview with an explicit absolute path. Retain its output privately; it contains database row evidence. Confirm target provenance, optional local FAA gaps, unchanged external identity, expected counts and the original source date. A missing local FAA row/model is disclosed in the preview, not treated as proof of absence. Contradictory local FAA identity fails closed.
4. After the upstream owner's explicit approval of that exact state, use the apply form on the intended database with its separately reviewed fingerprint. Do not generate and apply a new fingerprint automatically after a mismatch. Refusal requires evidence review and, if necessary, a new bounded patch.

```sh
# Read-only preview. Do not use a shared/public path for the output.
bun src/scripts/review-ua-membership.ts /absolute/existing.sqlite

# Mutating form, only after explicit upstream approval of this database/plan:
bun src/scripts/review-ua-membership.ts /absolute/existing.sqlite --apply REVIEWED_SHA256
```

5. Inspect the archive and retained histories, then restart only the approved writer version. Obtain a new source observation. Check API, fleet summary, fleet page and badge agree, N63571 is absent, legitimate members remain, and a stale incoming listing cannot restore it. Existing in-process caches or derived assets must be refreshed through their normal sanctioned path and verified; the fixture tests do not prove a running production instance refreshed.
6. Preserve the archive and guard on rollback. Restore data only under a separately reviewed plan that accounts for intervening legitimate changes. Do not delete the archive, restart an old importer, fabricate a fresh source timestamp or automatically reinstate unsupported membership.

## Downstream limit

The saved October 17 source was 644/1678; N63571 was already unequipped. Removing that member alone would arithmetically leave 644/1677. This is a counterfactual, not a verified new measurement or accepted baseline. N34571's admission and the earlier unidentified 787 population change still need source history. WiFiOdds' accepted denominator remains 1675 and its unchanged review gate will still apply to any different denominator. This patch contains no local normalization, rebaseline, workflow dispatch or publication authority.

Tests use synthetic in-memory databases and disposable files only. They cover all four ingestion paths, retained legitimate unknown members, listing disappearance, tenant separation, normalization aliases, empty/shrinking inputs, immutable review state, archived rollback, FAA/flight evidence, CLI defaults and consistent API/summary/fleet/badge fixture outputs. Existing contract goldens are unchanged.
