/**
 * FileHound — Florida SFTP Actor
 *
 * Downloads the daily corporate filing file from the Florida Division of
 * Corporations public SFTP server, parses the fixed-width format, normalises
 * records to the FileHound schema, and upserts to Supabase.
 *
 * Data source:  sftp.floridados.gov (public — no account needed)
 * Credentials:  Username: Public | Password: PubAccess1845!
 * File path:    /doc/cor/YYYYMMDDc.txt  (daily corporate filings)
 * File format:  Fixed-width ASCII, 1440 chars per record
 * Official field definitions: https://dos.sunbiz.org/data-definitions/cor.html
 *   → Open that page in a browser and verify FIELD_SPEC below before
 *     running this actor in production for the first time.
 *
 * Build sequence: this is actor #1. The normalise() and upsert() functions
 * defined here are the template for every other state actor.
 */

import { Actor } from 'apify';
import SftpClient from 'ssh2-sftp-client';
import { createClient } from '@supabase/supabase-js';

// ─── SFTP connection details ──────────────────────────────────────────────────
const SFTP_HOST     = 'sftp.floridados.gov';
const SFTP_USER     = 'Public';
const SFTP_PASS     = 'PubAccess1845!';
const SFTP_PORT     = 22;

const RECORD_LENGTH = 1440; // chars per record (confirmed in official docs)
const SOURCE_STATE  = 'FL';

// ─── Field specification ──────────────────────────────────────────────────────
//
// ⚠️  VERIFY THESE POSITIONS BEFORE FIRST PRODUCTION RUN ⚠️
//
// The official definition is at: https://dos.sunbiz.org/data-definitions/cor.html
// Run the actor once in calibrationMode: true to download a real file and
// inspect the raw bytes. Compare against the official page and fix any offsets.
//
// Format: [name, startIndex (0-based), length]
// Positions below are based on the publicly documented structure and community
// implementations. They may need minor adjustment.
//
// The official docs confirm:
//   - Document Number: 12 chars
//   - Record Length: 1440 chars total
//   - Up to 6 officers starting at field 37
//   - Each officer set has the same fields
//
const FIELD_SPEC = {
  // ── Core entity fields ─────────────────────────────────────────────────────
  document_number:    [0,   12],   // e.g. "L01000001234" — unique entity ID
  filing_type:        [12,   2],   // record type code (EN=entity name, etc.)
  filing_date:        [14,   8],   // YYYYMMDD — date entered into database
  effective_date:     [22,   8],   // YYYYMMDD — legal effective date
  entity_name:        [30, 120],   // business name
  status_code:        [150,  1],   // A=Active, I=Inactive, D=Dissolved, R=Revoked
  status_date:        [151,  8],   // YYYYMMDD
  state_of_formation: [159,  2],   // 2-letter state code
  expiration_date:    [161,  8],   // YYYYMMDD
  fei_number:         [169, 10],   // Federal Employer Identification Number

  // ── Principal address ──────────────────────────────────────────────────────
  principal_addr1:    [179, 35],
  principal_addr2:    [214, 35],
  principal_city:     [249, 35],
  principal_state:    [284,  2],
  principal_zip:      [286, 10],

  // ── Mailing address ────────────────────────────────────────────────────────
  mailing_addr1:      [296, 35],
  mailing_addr2:      [331, 35],
  mailing_city:       [366, 35],
  mailing_state:      [401,  2],
  mailing_zip:        [403, 10],

  // ── Registered agent ──────────────────────────────────────────────────────
  ra_name:            [413, 35],
  ra_addr1:           [448, 35],
  ra_addr2:           [483, 35],
  ra_city:            [518, 35],
  ra_state:           [553,  2],
  ra_zip:             [555, 10],

  // ── Annual report years (fields 28–36, approx) ────────────────────────────
  // These are less critical for FileHound's use case — captured in raw_data
  annual_report_1:    [565,  8],   // YYYYMMDD of most recent AR
  annual_report_2:    [573,  8],
  annual_report_3:    [581,  8],
  annual_report_4:    [589,  8],
  annual_report_5:    [597,  8],
  // (Additional AR fields may exist — check official docs)

  // ── Officer sets (fields 37+, 6 sets × ~130 chars = ~780 chars) ───────────
  // Officer 1
  officer_1_name:     [645, 35],
  officer_1_title:    [680,  4],
  officer_1_addr1:    [684, 35],
  officer_1_addr2:    [719, 35],
  officer_1_city:     [754, 35],
  officer_1_state:    [789,  2],
  officer_1_zip:      [791, 10],
  // Officer 2
  officer_2_name:     [801, 35],
  officer_2_title:    [836,  4],
  officer_2_addr1:    [840, 35],
  officer_2_addr2:    [875, 35],
  officer_2_city:     [910, 35],
  officer_2_state:    [945,  2],
  officer_2_zip:      [947, 10],
  // Officer 3
  officer_3_name:     [957, 35],
  officer_3_title:    [992,  4],
  officer_3_addr1:    [996, 35],
  officer_3_addr2:    [1031, 35],
  officer_3_city:     [1066, 35],
  officer_3_state:    [1101,  2],
  officer_3_zip:      [1103, 10],
  // Officer 4
  officer_4_name:     [1113, 35],
  officer_4_title:    [1148,  4],
  officer_4_addr1:    [1152, 35],
  officer_4_addr2:    [1187, 35],
  officer_4_city:     [1222, 35],
  officer_4_state:    [1257,  2],
  officer_4_zip:      [1259, 10],
  // Officer 5
  officer_5_name:     [1269, 35],
  officer_5_title:    [1304,  4],
  officer_5_addr1:    [1308, 35],
  officer_5_addr2:    [1343, 35],
  officer_5_city:     [1378, 35],
  officer_5_state:    [1413,  2],
  officer_5_zip:      [1415, 10],
  // Officer 6 (starts at 1425, only room for partial — check official docs)
  officer_6_name:     [1425,  15], // may be truncated — verify
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a field from a fixed-width record and trim whitespace. */
function field(record, name) {
  const [start, len] = FIELD_SPEC[name];
  return record.substring(start, start + len).trim();
}

/** Convert a YYYYMMDD string to an ISO date string, or null if empty/invalid. */
function parseDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.trim() === '' || yyyymmdd === '00000000') return null;
  const s = yyyymmdd.trim();
  if (s.length !== 8 || !/^\d{8}$/.test(s)) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

/** Map single-char status codes to human-readable strings. */
function parseStatus(code) {
  const map = {
    A: 'Active',
    I: 'Inactive',
    D: 'Dissolved',
    R: 'Revoked',
    V: 'Voluntarily Dissolved',
    G: 'Administratively Dissolved',
    N: 'Name Reserved',
  };
  return map[code?.trim()] ?? code?.trim() ?? 'Unknown';
}

/** Collect up to 6 officers from a record into an array. */
function parseOfficers(record) {
  const officers = [];
  for (let i = 1; i <= 6; i++) {
    const name  = field(record, `officer_${i}_name`);
    const title = field(record, `officer_${i}_title`);
    if (!name) break; // officers are contiguous — stop at first empty slot
    officers.push({
      name,
      title,
      address: [
        field(record, `officer_${i}_addr1`),
        field(record, `officer_${i}_addr2`),
      ].filter(Boolean).join(', '),
      city:  field(record, `officer_${i}_city`),
      state: field(record, `officer_${i}_state`),
      zip:   field(record, `officer_${i}_zip`),
    });
  }
  return officers;
}

/** Normalise a raw record line into the FileHound schema. */
function normalise(record) {
  if (record.length < RECORD_LENGTH) return null; // skip malformed records

  const officers = parseOfficers(record);
  const filedDateRaw = field(record, 'filing_date');
  const filedDate    = parseDate(filedDateRaw);

  if (!filedDate) return null; // skip records with no filing date

  const docNum    = field(record, 'document_number');
  const entityName = field(record, 'entity_name');

  // Skip obviously corrupt records
  if (!docNum || !entityName) return null;

  return {
    // Core filing fields — map to Supabase schema
    business_name:         entityName,
    entity_type:           inferEntityType(docNum),
    filing_date:           filedDate,

    // Principal address
    street_address:        field(record, 'principal_addr1'),
    city:                  field(record, 'principal_city'),
    state:                 SOURCE_STATE,
    zip:                   field(record, 'principal_zip'),

    // Source tracking
    source_state:          SOURCE_STATE,
    state_filing_id:       docNum,
    state_of_formation:    field(record, 'state_of_formation') || SOURCE_STATE,

    // Registered agent
    registered_agent_name: field(record, 'ra_name'),

    // Raw overflow — capture everything else for future enrichment
    raw_data: {
      fei_number:        field(record, 'fei_number'),
      status:            parseStatus(field(record, 'status_code')),
      status_date:       parseDate(field(record, 'status_date')),
      effective_date:    parseDate(field(record, 'effective_date')),
      mailing_address:   [
        field(record, 'mailing_addr1'),
        field(record, 'mailing_city'),
        field(record, 'mailing_state'),
        field(record, 'mailing_zip'),
      ].filter(Boolean).join(', '),
      ra_address:        [
        field(record, 'ra_addr1'),
        field(record, 'ra_city'),
        field(record, 'ra_state'),
        field(record, 'ra_zip'),
      ].filter(Boolean).join(', '),
      officers,
      filing_type:       field(record, 'filing_type'),
    },
  };
}

/**
 * Infer entity type from the document number prefix.
 * Florida document numbers start with a letter indicating entity type:
 *   L = LLC (domestic)
 *   P = Profit corporation
 *   N = Non-profit corporation
 *   F = Foreign corporation/LLC
 *   M = LP (limited partnership)
 *   etc.
 */
function inferEntityType(docNum) {
  const prefix = docNum?.[0]?.toUpperCase();
  const map = {
    L: 'LLC',
    P: 'Corporation',
    N: 'Non-Profit Corporation',
    F: 'Foreign Entity',
    M: 'Limited Partnership',
    Z: 'Limited Liability Limited Partnership',
  };
  return map[prefix] ?? 'Other';
}

// ─── Build the SFTP file path for a given date ────────────────────────────────

function buildSftpPath(date) {
  // Florida filename format: YYYYMMDDc.txt  (c = corporate)
  const d = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `/doc/cor/${d}c.txt`;
}

/** Format a Date as YYYY-MM-DD in US Eastern time. */
function todayEastern() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Main ──────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  targetDate       = todayEastern(),
  supabaseUrl,
  supabaseServiceKey,
  calibrationMode  = false,
  dryRun           = false,
} = input;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('supabaseUrl and supabaseServiceKey are required inputs.');
}

const runDate   = new Date(targetDate + 'T00:00:00');
const sftp      = new SftpClient();
const supabase  = createClient(supabaseUrl, supabaseServiceKey);
const runAt     = new Date().toISOString();

let status           = 'success';
let recordsFound     = 0;
let recordsInserted  = 0;
let errorMessage     = null;
const startMs        = Date.now();

try {
  // ── 1. Connect to SFTP ──────────────────────────────────────────────────────
  console.log(`Connecting to ${SFTP_HOST}...`);
  await sftp.connect({
    host:     SFTP_HOST,
    port:     SFTP_PORT,
    username: SFTP_USER,
    password: SFTP_PASS,
  });

  // ── 2. Download the daily file ──────────────────────────────────────────────
  const remotePath = buildSftpPath(runDate);
  console.log(`Downloading ${remotePath}...`);

  let fileBuffer;
  try {
    fileBuffer = await sftp.get(remotePath);
  } catch (err) {
    // File not found usually means a weekend or holiday — not an error
    if (err.message?.includes('No such file') || err.code === 2) {
      console.log(`No file for ${targetDate} (weekend or holiday). Exiting cleanly.`);
      await sftp.end();
      await logScrapeRun({ supabase, status: 'success', recordsFound: 0, recordsInserted: 0, errorMessage: 'No file (weekend/holiday)', durationMs: Date.now() - startMs });
      await Actor.exit();
    }
    throw err;
  }

  await sftp.end();

  const fileContent = fileBuffer.toString('latin1'); // FL files use ASCII/latin1
  const lines       = fileContent.split('\n').filter(l => l.length > 0);

  console.log(`Downloaded ${lines.length} records.`);
  recordsFound = lines.length;

  // ── 3. Calibration mode ─────────────────────────────────────────────────────
  if (calibrationMode) {
    console.log('--- CALIBRATION MODE ---');
    console.log('Dumping first 5 raw records. Compare against:');
    console.log('  https://dos.sunbiz.org/data-definitions/cor.html');
    console.log('Then update FIELD_SPEC in main.js and re-run with calibrationMode: false.\n');

    const sample = lines.slice(0, 5);
    for (const [i, line] of sample.entries()) {
      console.log(`\n--- Record ${i + 1} (${line.length} chars) ---`);
      console.log(`Raw: ${line}`);
      console.log('\nField attempts (verify positions against official docs):');
      for (const [name, [start, len]] of Object.entries(FIELD_SPEC)) {
        const val = line.substring(start, start + len).trim();
        if (val) console.log(`  [${start}:${start+len}] ${name}: "${val}"`);
      }
    }

    await Actor.pushData(sample.map((raw, i) => ({
      record_index: i + 1,
      raw_length:   raw.length,
      raw:          raw,
      field_attempts: Object.fromEntries(
        Object.entries(FIELD_SPEC).map(([name, [start, len]]) => [
          name,
          raw.substring(start, start + len).trim()
        ])
      )
    })));

    await Actor.exit();
  }

  // ── 4. Parse and normalise ──────────────────────────────────────────────────
  const normalised = [];
  for (const line of lines) {
    const record = normalise(line);
    if (record) normalised.push(record);
  }

  console.log(`Parsed ${normalised.length} valid records from ${lines.length} raw lines.`);

  if (dryRun) {
    console.log('Dry run — skipping Supabase upsert. First 3 normalised records:');
    console.log(JSON.stringify(normalised.slice(0, 3), null, 2));
    await Actor.pushData(normalised.slice(0, 20));
    await Actor.exit();
  }

  // ── 5. Upsert to Supabase ───────────────────────────────────────────────────
  // Batch in groups of 500 to stay within Supabase limits
  const BATCH_SIZE = 500;
  for (let i = 0; i < normalised.length; i += BATCH_SIZE) {
    const batch = normalised.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('filings')
      .upsert(batch, {
        onConflict: 'source_state,state_filing_id',
        ignoreDuplicates: false, // update if record changes
      });

    if (error) {
      console.error(`Batch ${i}-${i+BATCH_SIZE} upsert error:`, error.message);
      status = 'partial';
      errorMessage = error.message;
    } else {
      recordsInserted += batch.length;
    }

    // Brief pause between batches to avoid overwhelming Supabase
    if (i + BATCH_SIZE < normalised.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`Upserted ${recordsInserted} records to Supabase.`);

} catch (err) {
  console.error('Actor error:', err.message);
  status       = 'failed';
  errorMessage = err.message;
  try { await sftp.end(); } catch {}
}

// ── 6. Log to scrape_runs ────────────────────────────────────────────────────
await logScrapeRun({
  supabase,
  status,
  recordsFound,
  recordsInserted,
  errorMessage,
  durationMs: Date.now() - startMs,
});

if (status === 'failed') {
  throw new Error(`Actor failed: ${errorMessage}`);
}

await Actor.exit();

// ─── Scrape run logger ─────────────────────────────────────────────────────────

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
