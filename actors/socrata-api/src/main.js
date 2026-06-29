/**
 * FileHound — Generic Socrata API Actor
 *
 * Fetches new business filings from any Socrata-powered state open data portal
 * and upserts them to Supabase. Default configuration is New York.
 *
 * To use for a different state, change the following inputs:
 *   - socrataUrl:      The state's Socrata API endpoint
 *   - sourceState:     2-letter state code (e.g. "CO", "CT")
 *   - dateField:       Field name for the filing date
 *   - entityNameField: Field name for the business name
 *   - entityIdField:   Field name for the unique entity ID
 *
 * Known Socrata states and their endpoints:
 *   NY: https://data.ny.gov/resource/k4vb-judh.json  (date: filing_date, name: corp_name, id: dos_id)
 *   CO: https://data.colorado.gov/resource/...        (verify endpoint and fields)
 *   CT: https://data.ct.gov/resource/...              (verify endpoint and fields)
 *   OR: https://data.oregon.gov/resource/qzxy-edyf.json (date: registry_date, name: business_name, id: ...)
 *   IA: https://data.iowa.gov/resource/...            (verify endpoint and fields)
 *   PA: https://data.pa.gov/resource/xvd7-5r2c.json  (date: creation_date, name: business_name, id: ...)
 */

import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// Fix for Node.js < 22 which lacks native WebSocket support
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws;
}

const SOURCE_STATE_DEFAULT = 'NY';

// ─── Filing types that represent new business formations ─────────────────────
// These are the NY values. Other states may use different terminology — adjust
// via the newEntitiesOnly flag and the filterFilingTypes array if needed.
const NEW_ENTITY_FILING_TYPES = new Set([
  'ARTICLES OF ORGANIZATION',        // New LLC
  'CERTIFICATE OF INCORPORATION',    // New corporation
  'APPLICATION OF AUTHORITY',        // Foreign entity registering in state
  'CERTIFICATE OF PUBLICATION',      // Required NY LLC publication (signals new LLC)
  'ARTICLES OF INCORPORATION',       // Alternative term for some states
  'NEW FILING',                      // Generic catch-all some states use
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return today's date as YYYY-MM-DD in US Eastern time. */
function todayEastern() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Build the Socrata SODA API URL for a given date.
 * Socrata dates are stored as ISO timestamps; we filter >= target date.
 */
function buildSocrataUrl(baseUrl, dateField, targetDate, offset = 0, limit = 10000) {
  const params = new URLSearchParams({
    [`$where`]: `${dateField} >= '${targetDate}T00:00:00.000' AND ${dateField} < '${targetDate}T23:59:59.999'`,
    [`$limit`]: String(limit),
    [`$offset`]: String(offset),
    [`$order`]: dateField,
  });
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Fetch all records from the Socrata API for the target date, handling pagination.
 * Socrata returns up to $limit records per call; we loop until we get all of them.
 */
async function fetchAllRecords(baseUrl, dateField, targetDate) {
  const LIMIT   = 10000;
  let offset    = 0;
  let allRecords = [];

  while (true) {
    const url = buildSocrataUrl(baseUrl, dateField, targetDate, offset, LIMIT);
    console.log(`Fetching: ${url}`);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Socrata API error: ${response.status} ${response.statusText}`);
    }

    const batch = await response.json();

    if (!Array.isArray(batch) || batch.length === 0) break;

    allRecords = allRecords.concat(batch);
    console.log(`  Got ${batch.length} records (total so far: ${allRecords.length})`);

    if (batch.length < LIMIT) break; // last page
    offset += LIMIT;
  }

  return allRecords;
}

/**
 * Normalise a single raw Socrata record into the FileHound schema.
 * Field names default to NY but are overridden by input config.
 */
function normalise(record, { sourceState, entityNameField, entityIdField }) {
  const entityName = record[entityNameField]?.trim()
    || record.fictitious_name?.trim()
    || record.orig_lp_name?.trim();

  const stateFilingId = record[entityIdField]?.trim();
  const filingDate    = record.filing_date?.split('T')[0]     // NY: filing_date
    || record.registry_date?.split('T')[0]                    // OR: registry_date
    || record.creation_date?.split('T')[0]                    // PA: creation_date
    || record.entityformationdate?.split('T')[0]              // CO: entityformationdate
    || null;

  if (!entityName || !stateFilingId || !filingDate) return null;

  // Build street address from available fields (varies by state)
  const streetAddress = record.filer_addr1?.trim()
    || record.address_line1?.trim()
    || record.street_address?.trim()
    || '';

  const city = record.filer_city?.trim()
    || record.city?.trim()
    || '';

  const zip = record.filer_zip5?.trim()
    || record.zip?.trim()
    || record.zip_code?.trim()
    || '';

  const county = record.cnty_prin_ofc?.trim()
    || record.county?.trim()
    || '';

  const registeredAgent = record.sop_name?.trim()
    || record.registered_agent_name?.trim()
    || '';

  const stateOfFormation = record.for_juris?.trim()
    || record.state_of_formation?.trim()
    || sourceState;

  return {
    business_name:         entityName,
    entity_type:           mapEntityType(record.filing_type, record.entity_type),
    filing_date:           filingDate,
    street_address:        streetAddress,
    city,
    state:                 sourceState,
    zip,
    county,
    source_state:          sourceState,
    state_filing_id:       stateFilingId,
    state_of_formation:    stateOfFormation,
    registered_agent_name: registeredAgent,
    raw_data: {
      // Preserve all original fields for future enrichment
      ...record,
    },
  };
}

/**
 * Map NY filing type strings to human-readable entity types.
 * Falls back to the entity_type field if available.
 */
function mapEntityType(filingType, entityType) {
  const map = {
    'ARTICLES OF ORGANIZATION':       'LLC',
    'CERTIFICATE OF INCORPORATION':   'Corporation',
    'APPLICATION OF AUTHORITY':       'Foreign Entity',
    'CERTIFICATE OF PUBLICATION':     'LLC',
    'ARTICLES OF INCORPORATION':      'Corporation',
  };
  return map[filingType?.trim()] ?? entityType?.trim() ?? filingType?.trim() ?? 'Other';
}

// ─── Main ──────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  socrataUrl       = 'https://data.ny.gov/resource/k4vb-judh.json',
  sourceState      = SOURCE_STATE_DEFAULT,
  dateField        = 'filing_date',
  entityNameField  = 'corp_name',
  entityIdField    = 'dos_id',
  newEntitiesOnly  = true,
  targetDate       = todayEastern(),
  supabaseUrl,
  supabaseServiceKey,
  calibrationMode  = false,
  dryRun           = false,
} = input;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('supabaseUrl and supabaseServiceKey are required inputs.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

let status          = 'success';
let recordsFound    = 0;
let recordsInserted = 0;
let errorMessage    = null;
const startMs       = Date.now();

try {
  // ── 1. Fetch records from Socrata ───────────────────────────────────────────
  console.log(`Fetching ${sourceState} filings for ${targetDate} from Socrata...`);
  const rawRecords = await fetchAllRecords(socrataUrl, dateField, targetDate);
  console.log(`Retrieved ${rawRecords.length} total records from API.`);
  recordsFound = rawRecords.length;

  if (recordsFound === 0) {
    console.log('No records returned — may be a weekend, holiday, or no filings for this date.');
    await logScrapeRun({ supabase, sourceState, status: 'success', recordsFound: 0, recordsInserted: 0, errorMessage: 'No records', durationMs: Date.now() - startMs });
    await Actor.exit();
  }

  // ── 2. Calibration mode ─────────────────────────────────────────────────────
  if (calibrationMode) {
    console.log('\n--- CALIBRATION MODE ---');
    console.log('Dumping first 5 raw records to verify field mappings.\n');
    const sample = rawRecords.slice(0, 5);
    for (const [i, rec] of sample.entries()) {
      console.log(`Record ${i + 1}:`, JSON.stringify(rec, null, 2));
    }
    await Actor.pushData(sample.map((raw, i) => ({
      record_index: i + 1,
      raw,
      normalised: normalise(raw, { sourceState, entityNameField, entityIdField }),
    })));
    await Actor.exit();
  }

  // ── 3. Filter to new formations only (if enabled) ──────────────────────────
  const filtered = newEntitiesOnly
    ? rawRecords.filter(r => NEW_ENTITY_FILING_TYPES.has(r.filing_type?.trim()?.toUpperCase()))
    : rawRecords;

  console.log(`After filtering: ${filtered.length} new entity filings (from ${rawRecords.length} total).`);

  // ── 4. Normalise ────────────────────────────────────────────────────────────
  const normalised = [];
  for (const rec of filtered) {
    const row = normalise(rec, { sourceState, entityNameField, entityIdField });
    if (row) normalised.push(row);
  }
  console.log(`Normalised ${normalised.length} valid records.`);

  if (dryRun) {
    console.log('Dry run — skipping Supabase upsert.');
    await Actor.pushData(normalised.slice(0, 20));
    await Actor.exit();
  }

  // ── 5. Upsert to Supabase ───────────────────────────────────────────────────
  const BATCH_SIZE = 500;
  for (let i = 0; i < normalised.length; i += BATCH_SIZE) {
    const batch = normalised.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('filings')
      .upsert(batch, { onConflict: 'source_state,state_filing_id', ignoreDuplicates: false });
    if (error) {
      console.error(`Batch ${i} upsert error:`, error.message);
      status = 'partial';
      errorMessage = error.message;
    } else {
      recordsInserted += batch.length;
    }
    if (i + BATCH_SIZE < normalised.length) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Upserted ${recordsInserted} records to Supabase.`);

} catch (err) {
  console.error('Actor error:', err.message);
  status = 'failed';
  errorMessage = err.message;
}

// ── 6. Log to scrape_runs ────────────────────────────────────────────────────
await logScrapeRun({ supabase, sourceState, status, recordsFound, recordsInserted, errorMessage, durationMs: Date.now() - startMs });

if (status === 'failed') throw new Error(`Actor failed: ${errorMessage}`);

await Actor.exit();

// ─── Scrape run logger ────────────────────────────────────────────────────────

async function logScrapeRun({ supabase, sourceState, status, recordsFound, recordsInserted, errorMessage, durationMs }) {
  try {
    const { error } = await supabase.from('scrape_runs').insert({
      state:            sourceState,
      status,
      records_found:    recordsFound,
      records_inserted: recordsInserted,
      error_message:    errorMessage,
      duration_ms:      durationMs,
    });
    if (error) console.error('Failed to log scrape_run:', error.message);
  } catch (err) {
    console.error('Failed to log scrape_run:', err.message);
  }
}
