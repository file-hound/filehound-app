# FileHound — Idaho SOSBiz Actor

Queries the Idaho Secretary of State's public `businesssearch` JSON API directly
by filing date, instead of scraping the React SPA frontend.

## Important caveat

This API was discovered through independent reverse-engineering of the SOSBiz
website's network requests, not official Idaho SOS API documentation. The exact
response field names are **unconfirmed**. The code defensively tries several
common key name variants (`NAME`/`Name`/`name`, etc.) but this actor should be
treated as provisional until a live calibration run confirms:

1. The request body shape Idaho's API expects (we're guessing based on a blog post)
2. The actual field names in the response
3. Whether the `FILING_DATE` range filter behaves as expected with an empty `SEARCH_VALUE`

## How it works

1. POSTs to `https://sosbiz.idaho.gov/api/Records/businesssearch` with an empty
   search value and a `FILING_DATE: { start, end }` range matching the target date
2. Parses whatever response shape comes back (array, `.rows`, `.data`, `.results`)
3. Normalises to the FileHound schema
4. Upserts to Supabase
5. Logs to `scrape_runs`

## Known limitation

The list endpoint does not return street address, city, or zip — Idaho's API
returns those only via a per-entity detail call
(`/api/FilingDetail/business/{id}/false`), which would require one extra HTTP
request per record. Not implemented in this version to keep the first pass
simple. Address fields will be blank until this is added.

## First run — verify everything

Run with `calibrationMode: true` first. If `recordsFound: 0`, check the logs —
the actor dumps the raw API response shape so we can see what Idaho actually
returned and fix the request body or field mapping accordingly.

## Inputs

| Input | Required | Description |
|-------|----------|--------------|
| `targetDate` | No | Date to fetch (YYYY-MM-DD). Defaults to today (US/Mountain). |
| `supabaseUrl` | Yes | Supabase project URL |
| `supabaseServiceKey` | Yes | Supabase service role key |
| `calibrationMode` | No | Dump raw + normalised records, no upsert |
| `dryRun` | No | Normalise but don't upsert |
