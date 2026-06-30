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
 * Verified state configurations:
 *   NY: https://data.ny.gov/resource/k4vb-judh.json
 *       date: filing_date | name: corp_name | id: dos_id | newEntitiesOnly: true
 *   CO: https://data.colorado.gov/resource/4ykn-tg5h.json
 *       date: entityformdate | name: entityname | id: entityid | newEntitiesOnly: false
 *   OR: https://data.oregon.gov/resource/qzxy-edyf.json
 *       date: registry_date | name: business_name | id: registry_nbr | newEntitiesOnly: false
 *   CT: https://data.ct.gov/resource/... (verify endpoint and fields)
 *   IA: https://data.iowa.gov/resource/... (verify endpoint and fields)
 *   PA: https://data.pa.gov/resource/xvd7-5r2c.json
 *       date: creation_date | name: business_name | id: filing_number | newEntitiesOnly: false
 */

import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// Fix for Node.js < 22 which lacks native WebSocket support
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws;
}

const SOURCE_STATE_DEFAULT = 'NY';

// ─── Filing types that represent new business formations (NY-style event datasets) ──
// Only used when newEntitiesOnly: true. NY's dataset contains all filing events
// (renewals, amendments etc), so we filter to formation events only.
// CO, OR, PA datasets contain entity records not events — set newEntitiesOnly: false.
const NEW_ENTITY_FILING_TYPES = new Set([
  'ARTICLES OF ORGANIZATION',
  'CERTIFICATE OF INCORPORATION',
  'APPLICATION OF AUTHORITY',
  'CERTIFICATE OF PUBLICATION',
  'ARTICLES OF INCORPORATION',
  'NEW FILING',
]);

// Priority order for dedup — when same entity has multiple filings on same day
const FILING_PRIORITY = [
  'ARTICLES OF ORGANIZATION',
  'CERTIFICATE OF INCORPORATION',
  'APPLICATION OF AUTHORITY',
  'ARTICLES OF INCORPORATION',
  'CERTIFICATE OF PUBLICATION',
];

// ─── Entity type code mappings ────────────────────────────────────────────────
// Handles both NY's descriptive strings and CO's short codes
const ENTITY_TYPE_MAP = {
  // NY filing type → entity type
  'ARTICLES OF ORGANIZATION':     'LLC',
  'CERTIFICATE OF INCORPORATION': 'Corporation',
  'APPLICATION OF AUTHORITY':     'Foreign Entity',
  'CERTIFICATE OF PUBLICATION':   'LLC',
  'ARTICLES OF INCORPORATION':    'Corporation',
  // CO entity type codes
  'DLLC':  'LLC',
  'FLLC':  'Foreign LLC',
  'DCORP': 'Corporation',
  'FCORP': 'Foreign Corporation',
  'DLP':   'Limited Partnership',
  'FLP':   'Foreign Limited Partnership',
  'DLLP':  'Limited Liability Partnership',
  'FLLP':  'Foreign Limited Liability Partnership',
  'DNPC':  'Non-Profit Corporation',
  'FNPC':  'Foreign Non-Profit Corporation',
  'DCOOP': 'Cooperative',
  'DBEN':  'Benefit Corporation',
  // OR entity type values (verify on calibration)
  'LLC':         'LLC',
  'CORP':        'Corporation',
  'LP':          'Limited Partnership',
  'LLP':         'Limited Liability Partnership',
  'NONPROFIT':   'Non-Profit Corporation',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayEastern() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Parse a date string in any common format to YYYY-MM-DD.
 * Handles: ISO timestamps, YYYY-MM-DD, MM/DD/YYYY (CO format).
 */
function parseToIsoDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // ISO timestamp: "2026-06-26T00:00:00.000"
  if (s.includes('T')) return s.split('T')[0];

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY (Colorado format)
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [mm, dd, yyyy] = s.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function buildSocrataUrl(baseUrl, dateField, targetDate, offset = 0, limit = 10000) {
  const params = new URLSearchParams({
    [`$where`]: `${dateField} >= '${targetDate}T00:00:00.000' AND ${dateField} < '${targetDate}T23:59:59.999'`,
    [`$limit`]: String(limit),
    [`$offset`]: String(offset),
    [`$order`]: dateField,
  });
  return `${baseUrl}?${params.toString()}`;
}

async function fetchAllRecords(baseUrl, dateField, targetDate) {
  const LIMIT    = 10000;
  let offset     = 0;
  let allRecords = [];

  while (true) {
    const url = buildSocrataUrl(baseUrl, dateField, targetDate, offset, LIMIT);
    console.log(`Fetching: ${url}`);

    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`Socrata API error: ${response.status} ${response.statusText}`);

    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    allRecords = allRecords.concat(batch);
    console.log(`  Got ${batch.length} records (total so far: ${allRecords.length})`);

    if (batch.length < LIMIT) break;
    offset += LIMIT;
  }

  return allRecords;
}

function mapEntityType(filingType, entityType) {
  return ENTITY_TYPE_MAP[filingType?.trim()]
    ?? ENTITY_TYPE_MAP[entityType?.trim()]
    ?? entityType?.trim()
    ?? filingType?.trim()
    ?? 'Other';
}

/**
 * Build registered agent display name from whatever fields are available.
 * CO uses separate first/last name fields or an org name field.
 * NY uses sop_name. OR uses registered_agent_name.
 */
function parseAgentName(record) {
  // Org name (CO: agentorganizationname)
  if (record.agentorganizationname?.trim()) return record.agentorganizationname.trim();

  // Individual name parts (CO: agentfirstname + agentlastname)
  const firstName = record.agentfirstname?.trim() || '';
  const lastName  = record.agentlastname?.trim()  || '';
  if (firstName || lastName) return [firstName, lastName].filter(Boolean).join(' ');

  // NY: sop_name
  if (record.sop_name?.trim()) return record.sop_name.trim();

  // Generic fallback
  return record.registered_agent_name?.trim()
    || record.agent_name?.trim()
    || '';
}

function normalise(record, { sourceState, entityNameField, entityIdField, dateField }) {
  const entityName = record[entityNameField]?.trim()
    || record.fictitious_name?.trim()
    || record.orig_lp_name?.trim();

  const stateFilingId = record[entityIdField]?.trim();

  // Try the configured dateField first, then fallbacks for each state
  const rawDate   = record[dateField]
    || record.filing_date
    || record.registry_date
    || record.creation_date
    || record.entityformdate      // CO
    || record.entityformationdate // alt CO
    || null;
  const filingDate = parseToIsoDate(rawDate);

  if (!entityName || !stateFilingId || !filingDate) return null;

  // Address — covers NY (filer_addr1), CO (principaladdress1), OR (address_line1)
  const streetAddress = record.filer_addr1?.trim()
    || record.principaladdress1?.trim()
    || record.business_street?.trim()
    || record.address_line1?.trim()
    || record.street_address?.trim()
    || '';

  const city = record.filer_city?.trim()
    || record.principalcity?.trim()
    || record.business_city?.trim()
    || record.city?.trim()
    || '';

  const zip = record.filer_zip5?.trim()
    || record.principalzipcode?.trim()
    || record.zip?.trim()
    || record.zip_code?.trim()
    || record.business_zip?.trim()
    || '';

  const county = record.cnty_prin_ofc?.trim()
    || record.county?.trim()
    || '';

  const stateOfFormation = record.for_juris?.trim()
    || record.jurisdictonofformation?.trim()  // CO field (note typo in source data)
    || record.state_of_formation?.trim()
    || sourceState;

  return {
    business_name:         entityName,
    entity_type:           mapEntityType(record.filing_type, record.entitytype || record.entity_type),
    filing_date:           filingDate,
    street_address:        streetAddress,
    city,
    state:                 sourceState,
    zip,
    county,
    source_state:          sourceState,
    state_filing_id:       stateFilingId,
    state_of_formation:    stateOfFormation,
    registered_agent_name: parseAgentName(record),
    raw_data:              { ...record },
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  socrataUrl      = 'https://data.ny.gov/resource/k4vb-judh.json',
  sourceState     = SOURCE_STATE_DEFAULT,
  dateField       = 'filing_date',
  entityNameField = 'corp_name',
  entityIdField   = 'dos_id',
  newEntitiesOnly = true,
  targetDate      = todayEastern(),
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
  // ── 1. Fetch ────────────────────────────────────────────────────────────────
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
    const sample = rawRecords.slice(0, 5);
    for (const [i, rec] of sample.entries()) {
      console.log(`Record ${i + 1}:`, JSON.stringify(rec, null, 2));
      console.log(`  → normalised:`, JSON.stringify(normalise(rec, { sourceState, entityNameField, entityIdField, dateField }), null, 2));
    }
    await Actor.pushData(sample.map((raw, i) => ({
      record_index: i + 1,
      raw,
      normalised: normalise(raw, { sourceState, entityNameField, entityIdField, dateField }),
    })));
    await Actor.exit();
  }

  // ── 3. Filter to new formations only (NY-style event datasets) ──────────────
  const filtered = newEntitiesOnly
    ? rawRecords.filter(r => NEW_ENTITY_FILING_TYPES.has(r.filing_type?.trim()?.toUpperCase()))
    : rawRecords;

  console.log(`After filtering: ${filtered.length} new entity filings (from ${rawRecords.length} total).`);

  // ── 4. Normalise ────────────────────────────────────────────────────────────
  const normalised = [];
  for (const rec of filtered) {
    const row = normalise(rec, { sourceState, entityNameField, entityIdField, dateField });
    if (row) normalised.push(row);
  }
  console.log(`Normalised ${normalised.length} valid records.`);

  // ── 5. Deduplicate by state_filing_id ───────────────────────────────────────
  const seen = new Map();
  for (const row of normalised) {
    const existing = seen.get(row.state_filing_id);
    if (!existing) {
      seen.set(row.state_filing_id, row);
    } else {
      const newPriority = FILING_PRIORITY.indexOf(row.raw_data.filing_type);
      const oldPriority = FILING_PRIORITY.indexOf(existing.raw_data.filing_type);
      if (newPriority !== -1 && (oldPriority === -1 || newPriority < oldPriority)) {
        seen.set(row.state_filing_id, row);
      }
    }
  }
  const deduped = Array.from(seen.values());
  console.log(`After deduplication: ${deduped.length} unique entities (from ${normalised.length} normalised records).`);

  if (dryRun) {
    console.log('Dry run — skipping Supabase upsert.');
    await Actor.pushData(deduped.slice(0, 20));
    await Actor.exit();
  }

  // ── 6. Upsert to Supabase ───────────────────────────────────────────────────
  const BATCH_SIZE = 500;
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
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
    if (i + BATCH_SIZE < deduped.length) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Upserted ${recordsInserted} records to Supabase.`);

} catch (err) {
  console.error('Actor error:', err.message);
  status = 'failed';
  errorMessage = err.message;
}

// ── 7. Log to scrape_runs ────────────────────────────────────────────────────
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
