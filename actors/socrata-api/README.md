# FileHound — Generic Socrata API Actor

Fetches daily new business filings from any Socrata-powered state open data portal.
Default configuration is New York. Reuse for any other Socrata state by changing inputs.

## How it works

1. Calls the Socrata SODA API with a date filter for the target date
2. Optionally filters to new entity formations only (Articles of Organization, Certificate of Incorporation, etc.)
3. Normalises records to the FileHound schema
4. Upserts to Supabase in batches of 500
5. Logs the run to the `scrape_runs` table

## Default configuration — New York

- **Endpoint:** `https://data.ny.gov/resource/k4vb-judh.json`
- **Dataset:** Daily Corporation and Other Entity Filing Data
- **Date field:** `filing_date`
- **Entity name field:** `corp_name`
- **Entity ID field:** `dos_id`
- **Update frequency:** Daily

## Using this actor for other states

| State | socrataUrl | sourceState | dateField | entityNameField | entityIdField |
|-------|-----------|-------------|-----------|-----------------|---------------|
| NY (default) | `https://data.ny.gov/resource/k4vb-judh.json` | NY | filing_date | corp_name | dos_id |
| CO | `https://data.colorado.gov/resource/{id}.json` | CO | entityformationdate | entityname | entityid |
| OR | `https://data.oregon.gov/resource/qzxy-edyf.json` | OR | registry_date | business_name | registry_nbr |
| CT | `https://data.ct.gov/resource/{id}.json` | CT | (verify) | (verify) | (verify) |
| PA | `https://data.pa.gov/resource/xvd7-5r2c.json` | PA | creation_date | business_name | filing_number |
| IA | `https://data.iowa.gov/resource/{id}.json` | IA | effective_date | (verify) | (verify) |

> For each new state: run once with `calibrationMode: true` to inspect the raw API fields,
> then fill in the correct field names above.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `socrataUrl` | NY endpoint | Full Socrata API endpoint URL |
| `sourceState` | NY | 2-letter state code |
| `dateField` | filing_date | Field to filter by date |
| `entityNameField` | corp_name | Field containing business name |
| `entityIdField` | dos_id | Field containing unique entity ID |
| `newEntitiesOnly` | true | Filter to new formations only |
| `targetDate` | today | Date to fetch (YYYY-MM-DD) |
| `supabaseUrl` | required | Supabase project URL |
| `supabaseServiceKey` | required | Supabase service role key |
| `calibrationMode` | false | Dump raw records for field verification |
| `dryRun` | false | Parse but don't upsert |

## Adding this to Apify for each state

In Apify, create one actor per state using this same GitHub folder:
- `actors/socrata-api/` for all states
- In each Apify actor's **Saved tasks**, save a task with the state-specific input defaults
- This way you have one codebase, one build, multiple scheduled tasks
