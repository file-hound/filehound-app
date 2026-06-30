# FileHound — Sequential Entity ID Sweep Actor

Generic actor for states with sequential entity IDs but no date-range search
(Alabama, Arizona, Georgia, Virginia, possibly Idaho). One codebase, configured
per state via Apify input — same pattern as the Socrata actor.

## How it works

1. **Determine cursor.** Queries Supabase for the most recently inserted record
   for this state. The cursor is `(last known ID) + 1`. On the very first run
   for a state, uses the `startId` input instead.
2. **Sweep forward.** Fetches entity detail pages one ID at a time, starting
   from the cursor, for `sweepCount` IDs (default 200 per run).
3. **Detect misses.** If a page matches `notFoundIndicatorText`, it's counted
   as a miss. After `consecutiveMissesToStop` misses in a row, the sweep stops
   early — we've caught up to IDs that haven't been issued yet.
4. **Parse via CSS selectors.** All field extraction uses selectors passed in
   via the `selectors` input — nothing is hardcoded for any specific state.
5. **Upsert and log**, same as every other actor.

## No cursor-tracking table needed

The cursor is derived from `MAX(state_filing_id)` for that state in the
existing `filings` table (via most-recent `created_at`). No schema changes
required.

## ⚠️ This actor is UNVERIFIED until calibration mode runs successfully

Unlike Florida (official field spec) or the Socrata states (official API
docs), the states this actor targets don't have published documentation for
their detail-page HTML structure. The `idUrlTemplate` and `selectors` inputs
are **best-guess placeholders** until you run calibration mode and inspect
real output.

### First-time setup for any new state

1. Find the entity detail page URL pattern by manually looking up one known
   entity ID in a browser and copying the URL structure
2. Set `idUrlTemplate` with `{ID}` as the placeholder
3. View page source on a real entity page, find the HTML elements containing
   business name, entity type, filing date, address, registered agent —
   note their CSS selectors (class names, IDs)
4. Run with `calibrationMode: true` and a small `sweepCount` (e.g. 5)
5. Read the dumped HTML snippets and parsed output in the log
6. Fix selectors in the Apify input as needed, re-run calibration until clean
7. Run with `dryRun: true` to verify a larger batch
8. Go live

## Inputs

| Input | Required | Description |
|-------|----------|--------------|
| `sourceState` | Yes | 2-letter state code |
| `idUrlTemplate` | Yes | URL with `{ID}` placeholder |
| `idPadLength` | No | Zero-pad ID to this many digits (0 = no padding) |
| `startId` | First run only | Starting ID if no prior data exists |
| `sweepCount` | No | IDs to check per run (default 200) |
| `consecutiveMissesToStop` | No | Stop early after this many misses in a row (default 30) |
| `requestDelayMs` | No | Politeness delay between requests (default 300ms) |
| `notFoundIndicatorText` | No | Text on the page indicating "no such entity" |
| `selectors` | Yes (eventually) | JSON object of CSS selectors per field |
| `supabaseUrl` / `supabaseServiceKey` | Yes | Supabase credentials |
| `calibrationMode` | No | Dump raw HTML + parsed attempts |
| `dryRun` | No | Parse but don't upsert |

## A note on respecting state servers

`requestDelayMs` defaults to 300ms between requests — please don't lower this
significantly. These are government servers, not commercial APIs built for
high-volume automated traffic. Being a polite, low-impact requester protects
FileHound's continued access to public data.
