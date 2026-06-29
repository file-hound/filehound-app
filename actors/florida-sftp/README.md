# FileHound — Florida SFTP Actor

Downloads daily new business filing data from the Florida Division of Corporations
public SFTP server, normalises it to the FileHound schema, and upserts to Supabase.

## Data source

- **Host:** sftp.floridados.gov
- **Credentials:** Username: `Public` / Password: `PubAccess1845!` (published publicly by FL DOS)
- **File path:** `/doc/cor/YYYYMMDDc.txt`
- **Format:** Fixed-width ASCII, 1440 chars per record
- **Frequency:** Every business day (Mon–Fri, excluding FL state holidays)
- **Official field definitions:** https://dos.sunbiz.org/data-definitions/cor.html

## First-time setup — calibrate field positions

The Florida file is fixed-width, which means field positions must be exact. Before
running in production:

1. Run the actor once with `calibrationMode: true`
2. The actor will download the file and dump the first 5 raw records to the dataset
3. Open https://dos.sunbiz.org/data-definitions/cor.html in your browser
4. Compare the raw bytes at each position against the official field table
5. Update `FIELD_SPEC` in `src/main.js` where needed
6. Run again with `dryRun: true` to verify the parsed output looks right
7. Run normally for production

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `supabaseUrl` | Yes | Your Supabase project URL |
| `supabaseServiceKey` | Yes | Supabase service role key (secret) |
| `targetDate` | No | Date to fetch (YYYY-MM-DD). Defaults to today (US/Eastern). |
| `calibrationMode` | No | Dump raw records for field verification. Default: false |
| `dryRun` | No | Parse but don't upsert. Default: false |

## How it works

1. Connects to the FL DOS SFTP server
2. Downloads `/doc/cor/YYYYMMDDc.txt` for the target date
3. Splits into 1440-char records
4. Parses each record using `FIELD_SPEC` positions
5. Normalises to the FileHound schema (maps to `filings` table columns)
6. Upserts to Supabase in batches of 500
7. Logs the run result to `scrape_runs` table

## No file = weekend or holiday

If the SFTP file doesn't exist for the requested date, the actor exits cleanly and
logs a `success` run with 0 records. No alert is triggered — this is expected
behaviour on weekends and holidays.

## Monitoring

Every run (success or failure) writes a row to the `scrape_runs` Supabase table.
The staleness detection pg_cron job checks this table each morning and alerts if
any state hasn't produced records in 48 hours on a business day.

## Supabase upsert behaviour

The upsert uses `onConflict: 'source_state,state_filing_id'` — the composite unique
key established in the schema. If a filing already exists (e.g. from a backfill run),
the record is updated rather than duplicated.
