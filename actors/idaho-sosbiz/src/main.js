/**
 * FileHound — Idaho SOSBiz Actor
 *
 * Idaho's business search is a React SPA, but it calls a public, unauthenticated
 * JSON API on the same origin to do the actual searching. We call that API
 * directly instead of scraping HTML or driving a browser.
 *
 * Endpoint:  POST https://sosbiz.idaho.gov/api/Records/businesssearch
 * Auth:      None required
 * Date filter: FILING_DATE: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' | null }
 *
 * NOTE: This API was discovered via independent reverse-engineering (not
 * official Idaho SOS documentation). Field names in the response are
 * unconfirmed until calibration mode is run. Treat this actor as
 * provisional until a successful live calibration run confirms field names.
 */

import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws;
}

const SOURCE_STATE = 'ID';
const API_URL = 'https://sosbiz.idaho.gov/api/Records/businesssearch';

function todayMountain() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Boise' });
}

/**
 * Pull a value from a record trying multiple possible key casings/names,
 * since the exact field names are unconfirmed pre-calibration.
 */
function pick(record, ...keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return String(record[key]).trim();
    }
  }
  return '';
}

function normalise(record) {
  const businessName = pick(record, 'NAME', 'Name', 'name', 'ENTITY_NAME', 'BUSINESS_NAME');
  const filingId      = pick(record, 'RECORD_NUM', 'RecordNum', 'record_num', 'ID', 'FILING_NUMBER');
  const filingDateRaw  = pick(record, 'FILING_DATE', 'FilingDate', 'filing_date');

  if (!businessName || !filingId) return null;

  // Filing date may come back as ISO timestamp or plain date
  const filingDate = filingDateRaw ? filingDateRaw.split('T')[0] : null;

  return {
    business_name:         businessName,
    entity_type:           pick(record, 'ENTITY_TYPE', 'EntityType', 'entity_type', 'TYPE'),
    filing_date:           filingDate,
    street_address:        '', // not returned by the list endpoint — would need a per-record detail call
    city:                  '',
    state:                 SOURCE_STATE,
    zip:                   '',
    county:                '',
    source_state:          SOURCE_STATE,
    state_filing_id:       filingId,
    state_of_formation:    SOURCE_STATE,
    registered_agent_name: pick(record, 'REGISTERED_AGENT', 'RegisteredAgent', 'registered_agent', 'AGENT_NAME'),
    raw_data:              { ...record },
  };
}

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  targetDate      = todayMountain(),
  supabaseUrl,
  supabaseServiceKey,
  calibrationMode = false,
  dryRun          = false,
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
  // ── 1. Query the Idaho API for the target date ──────────────────────────────
  console.log(`Querying Idaho SOSBiz for filings on ${targetDate}...`);

  const requestBody = {
    SEARCH_VALUE:     '',
    STARTS_WITH_YN:   false,
    CRA_SEARCH_YN:    false,
    ACTIVE_ONLY_YN:   false,
    FILING_DATE: {
      start: targetDate,
      end:   targetDate,
    },
  };

  console.log('Request body:', JSON.stringify(requestBody));

  const response = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify(requestBody),
  });

  console.log(`Response status: ${response.status}`);

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Idaho API error ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  const data = await response.json();
  console.log('Raw response keys:', Object.keys(data));

  // Response shape is unconfirmed — try common patterns
  let rawRecords = [];
  if (Array.isArray(data)) {
    rawRecords = data;
  } else if (Array.isArray(data.rows)) {
    rawRecords = data.rows;
  } else if (data.rows && typeof data.rows === 'object') {
    rawRecords = Object.values(data.rows);
  } else if (Array.isArray(data.data)) {
    rawRecords = data.data;
  } else if (Array.isArray(data.results)) {
    rawRecords = data.results;
  }

  console.log(`Parsed ${rawRecords.length} records from response.`);
  recordsFound = rawRecords.length;

  if (recordsFound === 0) {
    console.log('No records returned. Dumping full raw response for inspection:');
    console.log(JSON.stringify(data).slice(0, 2000));
    await logScrapeRun({ supabase, status: 'success', recordsFound: 0, recordsInserted: 0, errorMessage: 'No records (or response shape unrecognised — check logs)', durationMs: Date.now() - startMs });
    await Actor.exit();
  }

  // ── 2. Calibration mode ─────────────────────────────────────────────────────
  if (calibrationMode) {
    console.log('\n--- CALIBRATION MODE ---');
    const sample = rawRecords.slice(0, 5);
    for (const [i, rec] of sample.entries()) {
      console.log(`Record ${i + 1}:`, JSON.stringify(rec, null, 2));
      console.log(`  → normalised:`, JSON.stringify(normalise(rec), null, 2));
    }
    await Actor.pushData(sample.map((raw, i) => ({
      record_index: i + 1,
      raw,
      normalised: normalise(raw),
    })));
    await Actor.exit();
  }

  // ── 3. Normalise ─────────────────────────────────────────────────────────────
  const normalised = [];
  for (const rec of rawRecords) {
    const row = normalise(rec);
    if (row) normalised.push(row);
  }
  console.log(`Normalised ${normalised.length} valid records.`);

  if (dryRun) {
    console.log('Dry run — skipping Supabase upsert.');
    await Actor.pushData(normalised.slice(0, 20));
    await Actor.exit();
  }

  // ── 4. Upsert to Supabase ───────────────────────────────────────────────────
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

await logScrapeRun({ supabase, status, recordsFound, recordsInserted, errorMessage, durationMs: Date.now() - startMs });

if (status === 'failed') throw new Error(`Actor failed: ${errorMessage}`);

await Actor.exit();

async function logScrapeRun({ supabase, status, recordsFound, recordsInserted, errorMessage, durationMs }) {
  try {
    const { error } = await supabase.from('scrape_runs').insert({
      state:            SOURCE_STATE,
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
