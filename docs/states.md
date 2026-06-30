# FileHound — 50-State Data Acquisition Reference

**Last researched:** June 2026  
**Purpose:** Permanent reference for how to acquire daily new business filing data from every US state.  
**Repo path:** `/docs/states.md`

---

## Tier definitions

| Tier | Label | Description | Actor template |
|------|-------|-------------|----------------|
| **1** | File feed | State publishes a daily file (SFTP, FTP, or direct download). Zero scraping. | `actors/sftp-download/` |
| **2** | Socrata API | State publishes business entity data on a Socrata-powered open data portal. Free REST API, date-filterable, no browser. | `actors/socrata-api/` |
| **3** | Portal scraping | State has a public SOS portal searchable by date. Requires Playwright or Cheerio + Apify proxies. | `actors/portal-scraper/` |
| **4** | Paywalled / restricted | State charges per search or per record, or has no date-range search. Workaround or skip required. | Custom per state |

> **Note on Wisconsin and other non-SOS states:** Alaska, Hawaii, and Utah have no Secretary of State; business registrations are handled by alternative state offices (Lt. Governor in AK and HI; Lt. Governor's office in UT). Wisconsin's SOS does not handle business entities — the Department of Financial Institutions (DFI) does. Virginia uses the State Corporation Commission (SCC), not the SOS. Arizona uses the Arizona Corporation Commission (ACC). These are noted per state below.

---

## Build sequence (recommended)

**Phase 1 — MVP (5 states):**
Build these in order. First three validate the entire pipeline architecture. Texas and California come last because they're the most complex.

1. **Florida** — Tier 1 SFTP, builds the normalize+upsert pipeline
2. **New York** — Tier 2 Socrata, establishes the API template
3. **Colorado** — Tier 2 Socrata clone (~30 min once template exists)
4. **Texas** — Tier 2 Socrata (franchise tax data workaround)
5. **California** — Tier 3 CALICO API (register for key at calicodev.sos.ca.gov)

**Phase 2 — Socrata sweep (~10–15 states):**
Apply the Socrata template to all confirmed Tier 2 states. Each is a configuration entry, not new code.

Oregon, Connecticut, Pennsylvania, Iowa, and any newly confirmed Socrata states.

**Phase 3 — Portal scraping batch:**
Build portal scrapers. Group Tyler Technologies / NIC-powered portals together — one scraper pattern covers multiple states.

**Phase 4 — Tier 4 workarounds:**
Delaware (sequential file number approach), Indiana, West Virginia, Kentucky — evaluate individually.

---

## Verified production configurations

This section is the source of truth for states that have been live-tested end to end: real API/file pull → parse → normalise → upsert to Supabase, confirmed via a `success` row in `scrape_runs`. Update this section every time a new state goes live. The Apify "Input" JSON for each state is recorded here verbatim so a scrape can be reproduced or rebuilt without depending on chat history.

### Florida — Actor: `filehound-florida-sftp`

| Field | Value |
|-------|-------|
| **Actor folder** | `actors/florida-sftp/` |
| **Method** | SFTP fixed-width file download |
| **Status** | ✅ Verified live — 2,975 records (2026-06-26 file) |
| **Field positions** | Verified against official spec at https://dos.sunbiz.org/data-definitions/cor.html — see `FIELD_SPEC` in `main.js` |
| **Quirks discovered** | Entity name field is 192 chars (not 120 as initially estimated). Filing date format is MMDDYYYY, not YYYYMMDD. Record length 1440 chars confirmed exact. |
| **Calibration** | Run with `calibrationMode: true` to dump raw + parsed records before trusting new field positions. |

### New York — Actor: `filehound-socrata-api`

| Field | Value |
|-------|-------|
| **Status** | ✅ Verified live — 941 unique entities (from 1,844 filing events / 3,952 total records, 2026-06-26) |
| **Apify input config** | ```{ "socrataUrl": "https://data.ny.gov/resource/k4vb-judh.json", "sourceState": "NY", "dateField": "filing_date", "entityNameField": "corp_name", "entityIdField": "dos_id", "newEntitiesOnly": true, "targetDate": "YYYY-MM-DD" }``` |
| **Quirks discovered** | Dataset contains ALL filing event types (renewals, DBAs, amendments) — `newEntitiesOnly: true` filters to formation events only (Articles of Organization, Certificate of Incorporation, Application of Authority, Certificate of Publication). A single entity can have 2+ filing events same day (e.g. Articles of Organization + Certificate of Publication) — deduplication by `state_filing_id` with `FILING_PRIORITY` ordering is required before upsert, or Postgres throws "ON CONFLICT DO UPDATE command cannot affect row a second time." |
| **Address fields used** | `filer_addr1`, `filer_city`, `filer_state`, `filer_zip5` |
| **Registered agent field** | `sop_name` |

### Colorado — Actor: `filehound-socrata-api`

| Field | Value |
|-------|-------|
| **Status** | ✅ Verified live — 581 records (2026-06-26), zero dedup needed |
| **Apify input config** | ```{ "socrataUrl": "https://data.colorado.gov/resource/4ykn-tg5h.json", "sourceState": "CO", "dateField": "entityformdate", "entityNameField": "entityname", "entityIdField": "entityid", "newEntitiesOnly": false, "targetDate": "YYYY-MM-DD" }``` |
| **Quirks discovered** | Dataset is an entity snapshot (one row per entity), not a filing-event log like NY — so `newEntitiesOnly: false` and no deduplication needed. Date format is sometimes MM/DD/YYYY rather than ISO timestamp — `parseToIsoDate()` in `main.js` handles both. Entity type comes through as short codes (`DLLC`, `DCORP`, `FLLC`, etc.) — mapped via `ENTITY_TYPE_MAP`. Registered agent can be an org name (`agentorganizationname`) OR individual name parts (`agentfirstname` + `agentlastname`) — `parseAgentName()` checks both. |
| **Address fields used** | `principaladdress1`, `principalcity`, `principalstate`, `principalzipcode` |
| **State of formation field** | `jurisdictonofformation` (note: typo in CO's own source field name — not ours) |

### Connecticut — Actor: `filehound-socrata-api`

| Field | Value |
|-------|-------|
| **Status** | ✅ Verified live — 150 records (2026-06-26) |
| **Apify input config** | ```{ "socrataUrl": "https://data.ct.gov/resource/n7gp-d28j.json", "sourceState": "CT", "dateField": "date_registration", "entityNameField": "name", "entityIdField": "id", "newEntitiesOnly": false, "targetDate": "YYYY-MM-DD" }``` |
| **Dataset** | Connecticut Business Registry — Business Master |
| **Quirks discovered** | Entity type comes through in `business_type` field with plain-English values ("LLC", "Non-Stock") rather than codes — added as a fallback in `mapEntityType()`. Address fields use a "billing" naming convention (`billingstreet`, `billingcity`, `billingpostalcode`) rather than "business" or "principal" — easy to miss on first pass, caught via calibration mode. Foreign entities use `state_or_territory_formation` for true state of formation rather than `formation_place` (which can read "MAINE" etc. for the home state, while `formation_place` may differ). |
| **Address fields used** | `billingstreet`, `billingcity`, `billingstate`, `billingpostalcode` |

---

## State-by-state reference

### Alabama
| Field | Value |
|-------|-------|
| **Agency** | Alabama Secretary of State |
| **Portal** | https://arc-sos.state.al.us (main search) via https://sos.alabama.gov/government-records/business-entity-records |
| **Data source** | SOS portal — entity search |
| **Tier** | 3 — portal scraping |
| **Date filter** | Not confirmed for bulk retrieval |
| **Update frequency** | Daily |
| **Notes** | **Verified June 2026:** Portal (arc-sos.state.al.us) offers search by entity name, entity number, or officer/agent. Filters include entity type, status, and place of formation (county). **No date-range filter confirmed for bulk new filing retrieval.** Formation date appears in individual entity records and in search results. Workaround: Alabama entity IDs are 9-digit sequential numbers — could potentially iterate through recent IDs to identify today's new filings. Covered by 17-state multi-search Apify actor (suggests a scraping approach exists). Investigate the sequential entity ID approach before building. |

---

### Alaska
| Field | Value |
|-------|-------|
| **Agency** | Alaska Division of Corporations, Business & Professional Licensing (CBPL) — under Dept. of Commerce |
| **Portal** | https://www.commerce.alaska.gov/cbp/Main/CBPLSearch.aspx |
| **Data source** | CBPL search portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Likely yes — "filter by filing date" mentioned in advanced search |
| **Update frequency** | Daily |
| **Notes** | **Verified June 2026:** No Secretary of State in Alaska; handled by Dept. of Commerce CBPL. Portal is public and free. Multiple sources confirm the advanced search includes a "filing date" filter option. **Date filter likely confirmed but needs portal testing to determine exact filter behavior** (single date vs. range). Lower filing volume than most states. |

---

### Arizona
| Field | Value |
|-------|-------|
| **Agency** | Arizona Corporation Commission (ACC) — not the Secretary of State |
| **Portal** | https://ecorp.azcc.gov/BusinessSearch/BusinessSearch |
| **Data source** | ACC eCorp search portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Not confirmed for bulk retrieval |
| **Update frequency** | Daily |
| **Notes** | **Verified June 2026:** Business entity filings go through the ACC, not the SOS. eCorp portal is free and public. "Date of Formation" is displayed in entity detail pages. **No date-range filter confirmed for bulk new filing retrieval** — the search is primarily name and entity ID based. Requires investigation for bulk date-filtered scraping approach. Has captcha ("I'm not a robot" verification) which will need to be handled. ACC uses sequential entity numbers which could be an alternative approach. |

---

### Arkansas
| Field | Value |
|-------|-------|
| **Agency** | Arkansas Secretary of State |
| **Portal** | https://www.sos.arkansas.gov/corps/search_all.php |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Covered by 17-state multi-search Apify actor. Free public portal. Verify date filter support. |

---

### California
| Field | Value |
|-------|-------|
| **Agency** | California Secretary of State |
| **Portal** | https://bizfileonline.sos.ca.gov |
| **API** | https://calicodev.sos.ca.gov (CALICO developer portal) |
| **Data source** | CALICO API (preferred) or bizfile portal A-Z sweep |
| **Tier** | 3 — official API with key |
| **Date filter** | Yes — via API or portal date range |
| **Update frequency** | New entities appear within ~24 hours of processing |
| **Fields available** | Entity name, entity number, formation date, entity type, status, registered agent, principal address |
| **Notes** | Highest filing volume of any US state. CALICO API requires free registration at calicodev.sos.ca.gov (takes 1–3 business days). API key is free for reasonable use. Without API key, an A-Z sweep of bizfile portal works but is compute-intensive. Use API. California updated entity numbering system in 2024 — new entity numbers use a "B" prefix. |

---

### Colorado
| Field | Value |
|-------|-------|
| **Status** | ✅ **VERIFIED LIVE — see "Verified production configurations" above for exact Apify config** |
| **Agency** | Colorado Secretary of State |
| **Portal** | https://data.colorado.gov |
| **API endpoint** | `https://data.colorado.gov/resource/4ykn-tg5h.json` |
| **Data source** | Socrata open data API (data.colorado.gov) |
| **Tier** | 2 — Socrata API |
| **Date filter** | Yes — `entityformdate` field (confirmed; not `entityformationdate` as originally guessed) |
| **Update frequency** | Daily |
| **Fields available** | Entity name (`entityname`), entity ID (`entityid`), entity type code (`entitytype`), formation date (`entityformdate`), status (`entitystatus`), registered agent (org name or first/last name fields), principal + mailing address |
| **Notes** | Clean Socrata API, no proxy needed, no auth required. Dataset is an entity snapshot, not a filing-event log — no deduplication needed, `newEntitiesOnly: false`. Entity type comes through as short codes (DLLC, DCORP, FLLC, etc.) requiring a mapping table. |

---

### Connecticut
| Field | Value |
|-------|-------|
| **Status** | ✅ **VERIFIED LIVE — see "Verified production configurations" above for exact Apify config** |
| **Agency** | Connecticut Secretary of State |
| **Portal** | https://data.ct.gov |
| **API endpoint** | `https://data.ct.gov/resource/n7gp-d28j.json` |
| **Dataset name** | Connecticut Business Registry — Business Master |
| **Data source** | Socrata open data API (data.ct.gov) |
| **Tier** | 2 — Socrata API |
| **Date filter** | Yes — `date_registration` field |
| **Update frequency** | Daily |
| **Fields available** | Entity name (`name`), entity ID (`id`), entity type (`business_type`, plain English), registration date (`date_registration`), address (`billingstreet`/`billingcity`/`billingstate`/`billingpostalcode`) |
| **Notes** | Confirmed Socrata state. Address fields use "billing" naming, not "business" or "principal" as in other states. Foreign entities should use `state_or_territory_formation` for state of formation. |

---

### Delaware
| Field | Value |
|-------|-------|
| **Agency** | Delaware Division of Corporations |
| **Portal** | https://corp.delaware.gov |
| **Data source** | Free name/file number search — no date range; status costs $10–$20 per entity |
| **Tier** | 4 — paywalled / restricted |
| **Date filter** | No — no bulk date range search available |
| **Update frequency** | N/A |
| **Fields available** | Name, file number, formation date, registered agent (free). Status, filing history ($10–$20). |
| **Notes** | Despite hosting 2.1M+ entities including 66% of Fortune 500 companies, Delaware has one of the most restrictive public registries. No bulk date-range search. No open data portal. Workaround: Delaware file numbers are sequential — could potentially increment through recent file numbers to identify today's new filings. Needs engineering evaluation. Delaware added ~290,000 new entities in 2024 — high value state to solve. Lower priority until workaround is confirmed. |

---

### Florida
| Field | Value |
|-------|-------|
| **Status** | ✅ **VERIFIED LIVE — see "Verified production configurations" above for exact field positions and Apify config** |
| **Agency** | Florida Division of Corporations (Sunbiz) |
| **Portal** | https://search.sunbiz.org |
| **SFTP** | Public SFTP server — Florida Division of Corporations |
| **Data source** | Daily bulk filing file via public SFTP — no account, no API key |
| **Tier** | 1 — file feed |
| **Date filter** | Yes — one file per business day |
| **Update frequency** | Every business day (Mon–Fri, excluding FL state holidays) |
| **Fields available** | Entity name, entity type, document number (filing ID), filing date, effective date, status, registered agent name and address, officer names and titles (up to 6), annual report history |
| **Notes** | Best data source found. Zero scraping cost, maximum reliability. Build first — this actor establishes the normalize+upsert pipeline all other actors reuse. Typically hundreds to several thousand new filings per business day. The only state our competitor FiledToday.com covers, which validates the data. Confirmed actual filing date format is MMDDYYYY and entity name field is 192 chars — see verified config above. |

---

### Georgia
| Field | Value |
|-------|-------|
| **Agency** | Georgia Secretary of State — Corporations Division |
| **Portal** | https://ecorp.sos.ga.gov/BusinessSearch |
| **Data source** | eCorp portal — entity search |
| **Tier** | 3 — portal scraping |
| **Date filter** | Not confirmed for bulk retrieval |
| **Update frequency** | 1–3 business days from filing to appearance |
| **Notes** | **Verified June 2026:** eCorp portal searches by business name, control number, registered agent name, or officer name. "Date of Formation / Registration Date" shown in entity detail pages. **No date-range filter confirmed for bulk new filing retrieval.** The search interface has no date-based query. Georgia is a high-volume state. Workaround needed — likely sequential control number approach or A-Z name sweep. Covered by 17-state multi-search Apify actor (suggests a working approach exists). |

---

### Hawaii
| Field | Value |
|-------|-------|
| **Agency** | Hawaii Department of Commerce and Consumer Affairs (DCCA) — Business Registration Division |
| **Portal** | https://hbe.ehawaii.gov/documents/search.html |
| **Data source** | DCCA Hawaii Business Express portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | No Secretary of State in Hawaii; DCCA handles business registration. **Verified June 2026: No Socrata business filing dataset found on data.hawaii.gov.** Business entity data lives exclusively in the DCCA's Hawaii Business Express portal (hbe.ehawaii.gov). Portal is free and public. A Honolulu city-level Socrata dataset exists (data.honolulu.gov) but was marked private. Verify whether the DCCA portal has a date-range filter for new filings before building actor. Lower filing volume due to state population. |

---

### Idaho
| Field | Value |
|-------|-------|
| **Agency** | Idaho Secretary of State |
| **Portal** | https://sosbiz.idaho.gov/search/business |
| **Data source** | SOSBiz portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | **Yes — confirmed. "Search by Date of Organization or Authorization" is an explicit search mode** |
| **Update frequency** | Daily |
| **Fields available** | Business name, file number, entity type, status, filing date, registered agent |
| **Notes** | **Verified June 2026: Date filter explicitly confirmed.** Idaho's SOSBiz portal offers dedicated search modes including "by date of organization or authorization." You can query directly by formation date — no workaround needed. Advanced search also supports Starts With, Contains, active-only filter, and registered agent search. Results include filing date in the table. Relatively low filing volume. This is one of the cleanest Tier 3 portal scrapers — build early as a template for other portal states. |

---

### Illinois
| Field | Value |
|-------|-------|
| **Agency** | Illinois Secretary of State |
| **Portal** | https://www.ilsos.gov/corporatellc/ |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Covered by 17-state multi-search Apify actor. Known to sometimes block traffic from foreign IP ranges (one report noted it blocks traffic from Sweden). Apify proxy rotation should handle this. High filing volume. Verify date filter support. |

---

### Indiana
| Field | Value |
|-------|-------|
| **Agency** | Indiana Secretary of State |
| **Portal** | https://bsd.sos.in.gov/PublicBusinessSearch |
| **Data source** | SOS portal (free public search) or paid bulk download |
| **Tier** | 3 — portal scraping (bulk data too expensive) |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Indiana offers paid bulk data: $9,500 for bulk download with monthly updates. This is too expensive. Use the free public portal instead and scrape for new filings by date. Verify portal date filter. |

---

### Iowa
| Field | Value |
|-------|-------|
| **Agency** | Iowa Secretary of State |
| **Portal** | https://sos.iowa.gov/search/business/search.aspx |
| **Open data** | https://data.iowa.gov — "Active Iowa Business Entities" dataset |
| **Data source** | Iowa open data portal Socrata dataset (data.iowa.gov) |
| **Tier** | 2 — Socrata API |
| **Date filter** | Yes — `effective date` field exists in dataset |
| **Update frequency** | Uncertain — paid API updates daily; free dataset cadence unverified |
| **Fields available** | Business legal name, type, effective date, registered agent name and address, principal office address |
| **Notes** | **Verified June 2026:** Iowa has a confirmed Socrata dataset ("Active Iowa Business Entities") on data.iowa.gov with `effective date` field and SODA API access. Iowa also has a paid API at $2,400/year (daily updates) — too expensive. **Key risk:** The free open dataset update cadence is unconfirmed. If the dataset only refreshes weekly or monthly, fall back to portal scraping. Verify dataset update frequency before building the Socrata actor. |

---

### Kansas
| Field | Value |
|-------|-------|
| **Agency** | Kansas Secretary of State |
| **Portal** | https://www.sos.ks.gov/businesses/bus-sb.html |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Verify date filter support. |

---

### Kentucky
| Field | Value |
|-------|-------|
| **Agency** | Kentucky Secretary of State |
| **Portal** | https://web.sos.ky.gov/ftshow/(S(...))/default.aspx |
| **Data source** | SOS portal (free) or bulk data subscription |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Kentucky offers an excellent bulk data service ($2,000/month) that includes daily/weekly deltas with new companies, new officers, and company/officer changes. This is the gold standard for state bulk data but far too expensive for FileHound. Use the free public portal instead. Covered by 17-state multi-search actor. Verify portal date filter. |

---

### Louisiana
| Field | Value |
|-------|-------|
| **Agency** | Louisiana Secretary of State |
| **Portal** | https://coraweb.sos.la.gov/commercialsearch/commercialsearch.aspx |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Verify whether date range search is supported. |

---

### Maine
| Field | Value |
|-------|-------|
| **Agency** | Maine Secretary of State |
| **Portal** | https://icrs.informe.org/nei-sos-icrs/ICRS?MainPage=x |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Lower filing volume. Verify date filter. |

---

### Maryland
| Field | Value |
|-------|-------|
| **Agency** | Maryland State Department of Assessments and Taxation (SDAT) |
| **Portal** | https://egov.maryland.gov/BusinessExpress/EntitySearch |
| **Data source** | Maryland Business Express portal (via SDAT, not SOS) |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Business entities in Maryland are handled by SDAT, not the Secretary of State. Portal is free and public. Verify whether it has a formation date filter. Maryland has Maryland Business Express as the public-facing interface. |

---

### Massachusetts
| Field | Value |
|-------|-------|
| **Agency** | Massachusetts Secretary of the Commonwealth |
| **Portal** | https://corp.sec.state.ma.us/CorpWeb/CorpSearch/CorpSearch.aspx |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. High filing volume (major business state). Verify date filter support. |

---

### Michigan
| Field | Value |
|-------|-------|
| **Agency** | Michigan Dept. of Licensing and Regulatory Affairs (LARA) — Corporations, Securities & Commercial Licensing Bureau |
| **Portal** | https://mibusinessregistry.lara.state.mi.us/search/business |
| **Data source** | MiBusiness Registry Portal (launched June 23, 2025 — replaced legacy COFS system) |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification on new portal |
| **Update frequency** | Daily |
| **Notes** | **Verified June 2026:** Michigan launched a completely new portal (MiBusiness Registry) on June 23, 2025. Public search does not require login. Has Advanced search with dropdown filters. "Date of incorporation/organization" is visible in entity details. **Date-range filter for new filing bulk retrieval not confirmed** — the new portal's advanced filters need to be tested. Note: The old LARA portal URL (cofs.lara.state.mi.us) is now replaced by mibusinessregistry.lara.state.mi.us. This is a brand new portal as of mid-2025, so scraping patterns from previous actors may not apply. |

---

### Minnesota
| Field | Value |
|-------|-------|
| **Agency** | Minnesota Secretary of State |
| **Portal** | https://mblsportal.sos.state.mn.us/Business/Search |
| **Data source** | SOS portal (free) or paid bulk data ($30 one-time) |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Minnesota sells "Active Business Data" (name + primary address for active entities) for $30 flat — no officers, no date filtering. The free portal is a better option for daily new filings. Covered by 17-state multi-search actor. Verify portal date filter support. |

---

### Mississippi
| Field | Value |
|-------|-------|
| **Agency** | Mississippi Secretary of State |
| **Portal** | https://corp.sos.ms.gov/corp/portal/c/page/corpBusinessIdSearch/portal.aspx |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Covered by 17-state multi-search actor. Verify date filter support. |

---

### Missouri
| Field | Value |
|-------|-------|
| **Agency** | Missouri Secretary of State |
| **Portal** | https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Covered by 17-state multi-search actor. Free public portal. Verify date filter support. |

---

### Montana
| Field | Value |
|-------|-------|
| **Agency** | Montana Secretary of State |
| **Portal** | https://biz.sosmt.gov/search |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Lower filing volume. Montana SOS portal has historically used NIC/Tyler Technologies — verify current vendor. |

---

### Nebraska
| Field | Value |
|-------|-------|
| **Agency** | Nebraska Secretary of State |
| **Portal** | https://www.nebraska.gov/sos/corp/corpsearch.cgi |
| **Batch service** | https://www.nebraska.gov/SpecialRequestSearches/index.cgi — $15 per 1,000 records |
| **Data source** | SOS portal (Tyler Technologies) + paid Special Request batch service |
| **Tier** | 3 — portal scraping |
| **Date filter** | Not in public portal; **yes via paid batch service** |
| **Update frequency** | Daily |
| **Notes** | **Verified June 2026: Confirmed Tyler Technologies** (footer reads "Powered by Tyler Technologies"). Public portal searches by name/captcha — **no date filter in public search.** However, Nebraska offers a "Corporation Special Request" batch service at **$15 per 1,000 records** that CAN filter by date registered/incorporated. At ~100 new filings/day, this would cost ~$1.50/day = ~$45/month — affordable. Evaluate the paid batch service vs. portal scraping difficulty. The Tyler Tech template scraper will need to handle captcha. |

---

### Nevada
| Field | Value |
|-------|-------|
| **Agency** | Nevada Secretary of State |
| **Portal** | https://esos.nv.gov/EntitySearch/OnlineEntitySearch |
| **Data source** | SOS portal (SilverFlume) |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Nevada's public-facing entity search is at esos.nv.gov. SilverFlume (nvsilverflume.gov) is the filing portal. High filing volume — Nevada is a popular incorporation state. Verify date filter support on the entity search. |

---

### New Hampshire
| Field | Value |
|-------|-------|
| **Agency** | New Hampshire Secretary of State |
| **Portal** | https://quickstart.sos.nh.gov/online/BusinessInquire |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Lower filing volume. Verify date filter. |

---

### New Jersey
| Field | Value |
|-------|-------|
| **Agency** | New Jersey Division of Revenue and Enterprise Services |
| **Portal** | https://www.njportal.com/DOR/BusinessNameSearch |
| **Data source** | NJ Division of Revenue portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Not the Secretary of State — handled by Division of Revenue. Covered by 17-state multi-search actor. Multiple Apify actors exist for NJ. Verify date filter support. |

---

### New Mexico
| Field | Value |
|-------|-------|
| **Agency** | New Mexico Secretary of State |
| **Portal** | https://portal.sos.state.nm.us/BFS/(S(...))/BusinessSearch.aspx |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Lower filing volume. Verify date filter. |

---

### New York
| Field | Value |
|-------|-------|
| **Status** | ✅ **VERIFIED LIVE — see "Verified production configurations" above for exact Apify config** |
| **Agency** | New York Department of State — Division of Corporations |
| **Portal** | https://apps.dos.ny.gov/publicInquiry/ |
| **Open data** | https://data.ny.gov |
| **API endpoint** | `https://data.ny.gov/resource/k4vb-judh.json` |
| **Data source** | data.ny.gov Socrata API — **"Daily Corporation and Other Entity Filing Data"** dataset (last 30 days, updated daily) |
| **Tier** | 2 — Socrata API |
| **Date filter** | Yes — `filing_date` field (confirmed; not `date_filed` as originally guessed) |
| **Update frequency** | Daily |
| **Fields available** | `dos_id` (entity ID), `corp_name` (entity name), `filing_date`, `filing_type`, `filer_addr1`/`filer_city`/`filer_state`/`filer_zip5`, `sop_name` (registered agent) |
| **Notes** | New York is not run by a "Secretary of State" office in the traditional sense — it's the NY Dept. of State, Division of Corporations. This dataset is a filing-EVENT log, not an entity snapshot — it includes renewals, DBAs, and amendments alongside new formations. Use `newEntitiesOnly: true` to filter to formation events only. A single new entity can generate 2+ filing events the same day (Articles of Organization + Certificate of Publication) — deduplicate by `dos_id` before upsert or Postgres will reject the batch. Approximately 3 million total business entities. |

---

### North Carolina
| Field | Value |
|-------|-------|
| **Agency** | North Carolina Secretary of State |
| **Portal** | https://www.sosnc.gov/online_services/search/Business_Registration_Results |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | NC SOS recently updated their website. Free public portal. High filing volume. Verify date filter support. |

---

### North Dakota
| Field | Value |
|-------|-------|
| **Agency** | North Dakota Secretary of State |
| **Portal** | https://firststop.sos.nd.gov/search/business |
| **Data source** | SOS FirstStop portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Covered by 17-state multi-search actor. Free public portal. Lower filing volume. Verify date filter. |

---

### Ohio
| Field | Value |
|-------|-------|
| **Agency** | Ohio Secretary of State |
| **Portal** | https://businesssearch.ohiosos.gov |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. High filing volume (large population state). Verify date filter support. |

---

### Oklahoma
| Field | Value |
|-------|-------|
| **Agency** | Oklahoma Secretary of State |
| **Portal** | https://www.sos.ok.gov/corp/corpsearch.aspx |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Verify date filter support. |

---

### Oregon
| Field | Value |
|-------|-------|
| **Agency** | Oregon Secretary of State |
| **Portal** | https://data.oregon.gov |
| **API endpoint** | `https://data.oregon.gov/resource/qzxy-edyf.json?$where=registry_date>'2026-06-01'` |
| **Data source** | Socrata open data API (data.oregon.gov) — includes "New Filings Last Month" and "New Businesses Registered Last Month" datasets |
| **Tier** | 2 — Socrata API |
| **Date filter** | Yes — `registry_date` field (exact SOS registration date) |
| **Update frequency** | Daily (confirmed from live CSV data showing current date entries) |
| **Fields available** | Business name, registry date, first name, last name (registrant), address, city, zip |
| **Notes** | Excellent data source. The `registry_date` field is the exact SOS filing date — not a tax date or approximation. Data includes officer/registrant names. Use the Socrata template. |

---

### Pennsylvania
| Field | Value |
|-------|-------|
| **Agency** | Pennsylvania Department of State |
| **Portal** | https://file.dos.pa.gov |
| **Open data** | https://data.pa.gov — "Registered Businesses in PA Current by County" dataset (xvd7-5r2c) |
| **Data source** | Socrata open data API (data.pa.gov) |
| **Tier** | 2 — Socrata API |
| **Date filter** | Yes — `Creation Date` field confirmed in dataset |
| **Update frequency** | Periodic (verify frequency) |
| **Fields available** | Business Name, Filing Number, Address Line 1/2, City, State, Zip, Type of Business Registration, **Creation Date**, Governor/Principal Officer, First/Last Name, County Name, County Code, Georeferenced coordinates |
| **Notes** | **Verified June 2026:** The Socrata dataset (xvd7-5r2c) on data.pa.gov has a `Creation Date` field (confirmed from live CSV data). This is the formation/registration date and can be used to filter for new businesses. Dataset appears to be a rolling snapshot of active registered businesses, not a pure filings stream — verify update frequency (daily vs. periodic) before building. If update frequency is insufficient, fall back to the file.dos.pa.gov portal which has date filtering in its advanced search. |

---

### Rhode Island
| Field | Value |
|-------|-------|
| **Agency** | Rhode Island Secretary of State |
| **Portal** | https://business.sos.ri.gov/CorpWeb/CorpSearch/CorpSearch.aspx |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Covered by 17-state multi-search actor. Free public portal. Lower filing volume. Verify date filter. |

---

### South Carolina
| Field | Value |
|-------|-------|
| **Agency** | South Carolina Secretary of State |
| **Portal** | https://businessfilings.sc.gov |
| **Data source** | businessfilings.sc.gov portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Covered by 17-state multi-search actor. Free public portal. Verify date filter support. |

---

### South Dakota
| Field | Value |
|-------|-------|
| **Agency** | South Dakota Secretary of State |
| **Portal** | https://sosenterprise.sd.gov/BusinessServices/Business/FilingSearch.aspx |
| **Data source** | SOS portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Lower filing volume. Verify date filter. |

---

### Tennessee
| Field | Value |
|-------|-------|
| **Agency** | Tennessee Secretary of State |
| **Portal** | https://tnbear.tn.gov/ECommerce/FilingSearch.aspx |
| **Data source** | SOS TNbear portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | TNbear is Tennessee's business filing system. Free public portal. Verify date filter support. |

---

### Texas
| Field | Value |
|-------|-------|
| **Agency** | Texas Secretary of State (SOSDirect) + Texas Comptroller (open data) |
| **Portal** | https://direct.sos.state.tx.us (SOSDirect) — $1/search |
| **Open data** | https://data.texas.gov — "Active Franchise Tax Permit Holders" dataset (9cir-efmm) |
| **Data source** | data.texas.gov Socrata API — franchise tax data as SOS filing proxy |
| **Tier** | 2/3 hybrid — Socrata API with caveats |
| **Date filter** | Yes — `responsibilitybeginningdate` field |
| **Update frequency** | Periodic — **not confirmed as daily**. Verified June 2026: update cadence unclear from public metadata. Must test actual dataset before launch. |
| **Fields available** | Taxpayer name, address, entity type, franchise tax responsibility date, SOS file number |
| **Notes** | **SOSDirect is NOT viable** — charges $1 per search. The data.texas.gov Socrata dataset is the workaround. Key caveat: the date field is `responsibilityBeginningDate` (when the business became responsible for franchise tax), which lags behind the actual SOS filing date by days to weeks. Not identical to a formation date. **Verification needed before launch:** confirm whether dataset updates daily or periodically. If periodic, fall back to portal scraping via the new SOS portal (sos.texas.gov launched 2025). Disclose the franchise-tax-date lag limitation in the product. |

---

### Utah
| Field | Value |
|-------|-------|
| **Agency** | Utah Division of Corporations and Commercial Code — under Lt. Governor's office |
| **Portal** | https://secure.utah.gov/bes/index.html |
| **Data source** | Utah Division of Corporations portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | No Secretary of State in Utah. Business registrations handled by Division of Corporations under the Lt. Governor's office. Portal is free and public. Verify date filter support. |

---

### Vermont
| Field | Value |
|-------|-------|
| **Agency** | Vermont Secretary of State |
| **Portal** | https://bizfilings.vermont.gov/online/DatabrokerInquiry/index |
| **Data source** | SOS Databroker portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Free public portal. Very low filing volume (small state). Verify date filter. |

---

### Virginia
| Field | Value |
|-------|-------|
| **Agency** | Virginia State Corporation Commission (SCC) — not the Secretary of State |
| **Portal** | https://cis.scc.virginia.gov |
| **Data source** | SCC CIS (Clerk's Information System) portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Not confirmed for bulk retrieval |
| **Update frequency** | Daily (new formations may take a few business days to appear) |
| **Notes** | **Verified June 2026:** SCC CIS portal searches by entity name (exact match, starts with, or contains), SCC entity ID, or person name. "Date of Formation" is shown in entity detail pages. **No date-range filter confirmed for bulk new filing retrieval.** Workaround options: (1) sequential SCC entity ID approach (IDs follow format: letter prefix + 7 digits), (2) covered by 17-state multi-search Apify actor suggesting a working approach exists. Note: Updates to SCC CIS can lag a few business days behind actual processing. |

---

### Washington
| Field | Value |
|-------|-------|
| **Agency** | Washington Secretary of State |
| **Portal** | https://ccfs.sos.wa.gov/#/ |
| **Data source** | SOS Corporations & Charities Filing System (CCFS) — date filter and CSV export confirmed |
| **Tier** | 3 — portal scraping |
| **Date filter** | Yes — "Date of Incorporation/Formation/Registration" with start and end date confirmed in CCFS |
| **Update frequency** | Daily |
| **Fields available** | Entity name, registration number, entity type, status, date of formation, registered agent, governor name and address |
| **Notes** | **Verified June 2026:** No Socrata business entity dataset on data.wa.gov for SOS filings. The SOS "Corporations Data Extract" feature was discontinued. The CCFS portal (ccfs.sos.wa.gov) has a **confirmed date-of-incorporation filter** with start/end date search and CSV export capability. Use CCFS portal for date-filtered scraping. WA Dept. of Revenue has a "Business Lookup" dataset on data.wa.gov but that covers business licenses, not SOS entity registrations. |

---

### West Virginia
| Field | Value |
|-------|-------|
| **Agency** | West Virginia Secretary of State |
| **Portal** | https://apps.wv.gov/sos/BusinessEntity/SearchEntity.aspx |
| **Paid bulk** | $25 minimum + $0.05 per record |
| **Data source** | Free SOS portal (scrape) — bulk data is too expensive at volume |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | WV offers a Business Entity List Service at $25 + $0.05/record and a monthly Bulk Data Service. At 500 records/day this would be ~$25/day = $750/month, which is borderline viable. Evaluate against portal scraping difficulty. Free portal likely easier to start with. |

---

### Wisconsin
| Field | Value |
|-------|-------|
| **Agency** | Wisconsin Department of Financial Institutions (DFI) — not the Secretary of State |
| **Portal** | https://www.wdfi.org/apps/corpsearch/search.aspx |
| **Data source** | DFI Corporations search portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Needs verification |
| **Update frequency** | Daily |
| **Notes** | Wisconsin SOS does NOT handle business entities (their scope is limited to legislature/governor records). Business registrations are handled by DFI. Covered by 17-state multi-search actor. Verify date filter. |

---

### Wyoming
| Field | Value |
|-------|-------|
| **Agency** | Wyoming Secretary of State |
| **Portal** | https://wyobiz.wyo.gov |
| **Data source** | WyoBiz Business Center — public portal |
| **Tier** | 3 — portal scraping |
| **Date filter** | Yes — "Filing Date" filter confirmed in portal search |
| **Update frequency** | Daily |
| **Fields available** | Filing name, filing ID, status, standing, filed date |
| **Notes** | WyoBiz has a "Filing Date" filter in its search interface. No account required. An Apify actor already exists for Wyoming. Wyoming is a popular incorporation state (privacy-friendly LLC laws), so filing volume may be significant relative to its population. |

---

## Tier summary

| Tier | States | Count |
|------|--------|-------|
| **1 — File feed** | Florida | 1 |
| **2 — Socrata API (confirmed)** | New York, Colorado, Connecticut, Oregon, Texas (with caveats) | 5 |
| **2 — Socrata API (verified, cadence TBC)** | Iowa, Pennsylvania | 2 |
| **2 — Socrata API (removed after verification)** | Hawaii (→ Tier 3), Washington (→ Tier 3) | — |
| **3 — Portal scraping (date filter confirmed)** | Idaho, Wyoming, Washington | 3 |
| **3 — Portal scraping (date filter likely)** | Alaska | 1 |
| **3 — Portal scraping (date filter not confirmed)** | Alabama, Arizona, Arkansas, Georgia, Illinois, Indiana, Kansas, Kentucky, Louisiana, Maine, Maryland, Massachusetts, Michigan, Minnesota, Mississippi, Missouri, Montana, Nevada, New Hampshire, New Jersey, New Mexico, North Carolina, North Dakota, Ohio, Oklahoma, Rhode Island, South Carolina, South Dakota, Tennessee, Utah, Vermont, Virginia, West Virginia, Wisconsin | 34 |
| **3 — Official API with key** | California | 1 |
| **3 — Paid batch service (date filter via payment)** | Nebraska ($15/1,000 records) | 1 |
| **3 — Non-SOS agency portals** | Alaska (CBPL), Arizona (ACC), Hawaii (DCCA), Maryland (SDAT), Michigan (LARA), Utah (Lt. Governor), Virginia (SCC), Wisconsin (DFI) | — |
| **4 — Paywalled / restricted** | Delaware | 1 |
| **4 — Portal paywalled (use Tier 2 alternative)** | Texas SOSDirect ($1/search) | — |

**Total: 50 states covered**

---

## States needing pre-build verification

The following 13 states were flagged for verification. Status after June 2026 research:

| State | Question | Result |
|-------|----------|--------|
| **Alabama** | Date filter on SOS portal? | ❌ Not confirmed. 9-digit sequential entity IDs suggest workaround possible. |
| **Alaska** | Date filter on CBPL portal? | ✅ Likely — "filter by filing date" confirmed in advanced search. Test exact behavior. |
| **Arizona** | Date filter on ACC eCorp? | ❌ Not confirmed. Has captcha. Sequential entity approach may be needed. |
| **Georgia** | Date filter on SOS eCorp? | ❌ Not confirmed. Sequential control number approach likely needed. |
| **Hawaii** | Socrata dataset on data.hawaii.gov? | ❌ No Socrata dataset found. Reclassified to Tier 3 (DCCA portal). |
| **Idaho** | Date filter on SOSBiz? | ✅ **Confirmed.** Explicit "Search by date of organization or authorization" mode. |
| **Iowa** | Socrata update frequency daily? | ⚠️ Dataset confirmed on data.iowa.gov. Frequency not confirmed as daily. |
| **Michigan** | Date filter on LARA portal? | ⚠️ New portal (June 2025). Advanced filters exist. Date filter needs portal testing. |
| **Nebraska** | Date filter on Tyler Tech portal? | ❌ No date filter in public portal. Paid batch service ($15/1k records) has date filter. |
| **Pennsylvania** | Socrata dataset has formation date? | ✅ **Confirmed.** `Creation Date` field in dataset xvd7-5r2c. Update frequency TBC. |
| **Texas** | data.texas.gov update frequency daily? | ⚠️ Not confirmed as daily. Must test before launch. |
| **Virginia** | Date filter on SCC CIS portal? | ❌ Not confirmed. Sequential entity ID (letter + 7 digits) workaround likely. |
| **Washington** | Socrata business entity dataset? | ❌ No SOS Socrata dataset. CCFS portal has confirmed date filter + CSV export. |

**Key takeaways:**
- Idaho has the cleanest portal with a direct date filter — build first among Tier 3 portal states
- Hawaii and Washington are reclassified from Tier 2 to Tier 3
- Iowa and Pennsylvania remain Tier 2 but update frequency needs live testing
- Alabama, Arizona, Georgia, and Virginia will need sequential entity ID workarounds
- Nebraska's paid batch service ($15/1k records) is viable for daily new filings

---

## Non-obvious agency mapping (quick reference)

| State | Who handles business filings |
|-------|------------------------------|
| Alaska | Division of Corporations, Business & Professional Licensing (Dept. of Commerce) |
| Arizona | Arizona Corporation Commission (ACC) — not SOS |
| Hawaii | Dept. of Commerce and Consumer Affairs (DCCA) |
| Maryland | State Dept. of Assessments and Taxation (SDAT) |
| Michigan | Dept. of Licensing and Regulatory Affairs (LARA) |
| Utah | Division of Corporations & Commercial Code (Lt. Governor's office) |
| Virginia | State Corporation Commission (SCC) — not SOS |
| Wisconsin | Dept. of Financial Institutions (DFI) — not SOS |

---

## Actor template inventory (build these once)

| Template | States it covers | Location |
|----------|-----------------|----------|
| `sftp-download` | Florida + any future SFTP states | `actors/sftp-download/` |
| `socrata-api` | NY, CO, CT, OR, TX, IA, HI, PA, WA (and any future Socrata states) | `actors/socrata-api/` |
| `portal-scraper-tyler` | Nebraska + any confirmed Tyler Tech states | `actors/portal-tyler/` |
| `portal-scraper-generic` | All other Tier 3 portal states | `actors/portal-generic/` |
| `calico-api` | California only | `actors/calico-api/` |

---

*Last updated: June 2026. Verify all portal URLs and API endpoints before building — state portals update periodically.*

**Verification progress: 4 of 50 states confirmed live (FL, NY, CO, CT).** See "Verified production configurations" section near the top of this document for exact endpoints, field mappings, and Apify input JSON for each. Update that section every time a new state goes live — it is the source of truth, not chat history.
