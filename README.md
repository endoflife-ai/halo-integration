# endoflife.ai EOL Risk for HaloPSA

An integration for HaloPSA that puts software end-of-life data on your Halo
assets. Once a day it reads each asset's operating system and the software
rows on its Software tab, matches them to [endoflife.ai](https://endoflife.ai)
lifecycle data, and writes twelve fields back onto the asset: end of support,
end of life, a status, the EOL Risk Score and grade, whether the version is
actively exploited with no fix coming, the vendor source and the day it was
last verified. Assets past end of life can open a ticket against their
customer and site, so the upgrade work flows through your normal queue.

Plain Node.js (22 or newer), no packages to install, nothing hosted by
endoflife.ai touches your Halo. The scripts run where you run them: a
management server, a scheduled task, a pipeline. They read assets and write
only the twelve `EOL …` fields and the tickets you enable.

Nothing is guessed. A title we do not track is reported as "not tracked", and
an operating system recorded too loosely to name a release (a bare "Windows
10", with no 22H2 or build number) is reported as "needs a more specific
version" instead of being given a date that might be wrong.

endoflife.ai is not affiliated with or endorsed by HaloPSA or Halo Service
Solutions. Halo, HaloPSA and HaloITSM are trademarks of their owner.
Questions: partners@endoflife.ai.

## What lands on the asset

| Field | Meaning |
|---|---|
| EOL Product | endoflife.ai product the asset was matched to |
| EOL Cycle | release line matched (2016, 10-22h2, 15.0) |
| EOL Support Ends | vendor end of active support, when the vendor publishes one |
| EOL Date | vendor end of life / end of security fixes (a month when the vendor names only the month) |
| EOL Status | `active`, `warn` (ends within 12 months), `eol`, `needs a more specific version`, `version not tracked`, `not tracked` |
| EOL Risk Score | 0 to 100 ([methodology](https://endoflife.ai/risk-score)) |
| EOL Risk Grade | A to F with its label |
| EOL Exploited Unpatchable | Yes when the release is on the [Exploited & Unpatchable](https://endoflife.ai/exploited-and-unpatchable) list: actively exploited per CISA, no fix coming |
| EOL Source | where the date comes from: the vendor's own lifecycle page where endoflife.ai reads it there, otherwise the upstream dataset, named as such |
| EOL Verified | the day endoflife.ai last verified the date at that source |
| EOL Checked | the day this integration last evaluated the asset |
| EOL Detail | one entry per operating system and software row, each with its own verdict |

The asset's single-value fields carry its worst row: exploited beats eol,
eol beats warn, warn beats active, and a higher score breaks a tie. EOL Detail
lists every row, so nothing is hidden.

## What you need

- Node.js 22 or newer.
- A Halo administrator, once, to register an API application and create the
  twelve fields.
- An endoflife.ai API key. **From 2026-11-16 every request to
  api.endoflife.ai needs one** (until then keyless requests work at a low
  daily limit). A free key is issued at
  https://endoflife.ai/api#free-key and covers a small estate (150 requests
  a day, five components per lookup call). A tenant with a few hundred
  distinct product versions needs a paid key; see https://endoflife.ai/api.

## 1. Register the application in Halo

Configuration > Integrations > Halo API > View Applications > New:

| Setting | Value |
|---|---|
| Active | on |
| Application name | `endoflife.ai EOL Risk` (any name) |
| Authentication method | Client Credentials |
| Agent to log in as | an agent allowed to read and edit assets and to raise tickets (the application can do no more than this agent) |
| Permissions | `read:assets`, `edit:assets`, `read:tickets`, `edit:tickets`, `read:customers` |

Save and copy the Client ID and the Client Secret (shown once). Your resource
server and tenant id are on the same Halo API page.

These five permissions cover every daily call. The only thing they do not
cover is creating the asset fields, which is configuration and needs Halo's
admin API permission (step 4).

## 2. Credentials file

Copy `halo.env.example` to `halo.env` next to the scripts and fill it in (or
set the same names as environment variables, or pass `--env <path>`):

```
HALO_BASE=https://<your tenant>.halopsa.com
HALO_TENANT=<tenant id from the Halo API page>
HALO_CLIENT_ID=<client id>
HALO_CLIENT_SECRET=<client secret>
HALO_SCOPE=all
EOL_API_KEY=<your endoflife.ai key>
```

`halo.env` is in `.gitignore`. Keep it readable only by the account that runs
the scripts. The scripts never print the secret or the key.

## 3. Look before you write (optional)

```
node probe.mjs
```

Read-only. Fetches a token, one page of assets, one asset in full (fields and
software rows), the field catalogue, asset types and ticket types, and saves
the raw responses under `probe-output/`. Confirms the credentials and shows
you the ticket type id to use.

## 4. Create and attach the twelve fields

Creating an asset field is configuration, so through the API it needs Halo's
admin API permission on the application. The recommended path keeps the
application to the five permissions above:

1. In Halo, Configuration > Asset Management > Asset Fields > New, twelve
   times: type Text, no system use, not mandatory, with exactly these names:
   EOL Product, EOL Cycle, EOL Support Ends, EOL Date, EOL Status, EOL Risk
   Score, EOL Risk Grade, EOL Exploited Unpatchable, EOL Source, EOL
   Verified, EOL Checked, EOL Detail.
2. Attach them to the asset types that hold computers, servers, databases
   and applications:

```
node setup-fields.mjs --dry-run
node setup-fields.mjs
```

Default types: Laptop, Workstation, Server, Virtual Server, Database,
Database Server, Application Server, Business Application, Cluster. Choose
your own with `--types "Server,Workstation"`.

Attachment matters. Halo accepts a value written to a field that is not on
the asset's type, returns success and stores nothing, with no warning. The
sync therefore writes only to assets whose type carries the fields and names
the types that do not.

If you prefer the script to create the fields, give the application the admin
API permission and run `node setup-fields.mjs --create-fields` (with
`--dry-run` first). It clones your "OS Version" field's settings for each
missing EOL field, then attaches all twelve.

## 5. Dry run, then live

```
node sync.mjs --dry-run --report run.json
node sync.mjs --report run.json
node sync.mjs --tickets --ticket-type <id> [--ticket-priority <id>] --report run.json
```

- `--dry-run` evaluates every asset and writes nothing. It prints one line
  per asset with the verdict and the fields that would change, and a summary.
- `--report run.json` also writes `run.csv`, one row per asset with the
  twelve values, for review or for Halo's CSV import if you would rather not
  let the script write.
- `--client <id>`, `--site <id>`, `--asset-type <id>`, `--asset-group <id>`
  limit the scope; `--max <n>` caps a trial run.
- Only changed values are written, 50 assets per call.
- `--tickets` opens one ticket per asset whose worst row is past end of life
  or exploited and unpatchable. Each carries
  `third_party_id_string = endoflife-ai:<asset id>:<product>:<cycle>`, and
  the script checks the asset's open tickets for that key first, so a daily
  run never opens the same ticket twice. The integration never updates or
  closes tickets.

Schedule it daily, outside busy hours. Windows Task Scheduler:

```
schtasks /create /tn "endoflife.ai EOL Risk" /sc daily /st 06:00 /tr "node C:\halo-integration\sync.mjs --tickets --ticket-type 1 --report C:\halo-integration\run.json"
```

cron:

```
0 6 * * * cd /opt/halo-integration && node sync.mjs --tickets --ticket-type 1 --report run.json
```

## How assets are read

1. The operating system: the asset's `OS Version` field (plus `OS Service
   Pack`), else the Intune OS string, else `os_override`.
2. The software rows on the asset's Software tab (`software[]`), plus rows
   imported by the Lansweeper and Qualys connectors when present.

The integration only reads software rows; in your tenant they come from your
RMM or discovery connector. Billable licences are a separate Halo feature
(the Subscriptions tab, `/api/SoftwareLicence`) that this integration does
not touch.

Each title goes through `mapping.json`: a regular expression to an
endoflife.ai product and a rule for the release line (product year for SQL
Server and Office, release and edition for Windows 10 and 11, major or
major.minor for most others). A title no rule matches is tried once by name
through endoflife.ai's alias table. Add your own titles to `mapping.json`;
`npm test` pins the behaviour.

## Call budget

Halo allows 700 API calls per rolling five minutes **per host**: your tenant's
hostname, shared by every application and integration calling it. This
integration keeps itself under 500 in any five minutes and pauses when it
gets there, so your other integrations keep at least 200, and it honours HTTP
429 with the server's `Retry-After`.

A run costs:

| Step | Calls |
|---|---|
| token | 1 per hour of run time |
| field catalogue | 1 |
| asset list (100 per page) | assets / 100 |
| asset detail (the only call that returns software rows) | 1 per asset |
| write-back (50 assets per call, changed values only) | changed assets / 50 |
| ticket check and ticket, when enabled | 2 per qualifying asset, first run only |

About 2,000 assets take some twenty minutes; 10,000 take under two hours,
spread under the ceiling. Calls to endoflife.ai do not count against Halo's
limit: one lookup per batch of distinct (product, version) pairs per run, one
score call per distinct matched release, and one fetch of the Exploited &
Unpatchable list.

## Data and privacy

Only product names and version strings are sent to endoflife.ai. Asset names,
customers, sites, users and every other Halo record stay in your environment.
endoflife.ai stores nothing about your assets. The optional run report stays
where you write it.

Every date carries its source and the day it was last verified. Dates
endoflife.ai reads at the vendor's own lifecycle page name that page; dates
from the upstream endoflife.date dataset say so. Licence terms for the data:
https://endoflife.ai/terms.

## Files

- `sync.mjs` the daily run; `probe.mjs` a read-only look; `setup-fields.mjs` field attachment (and creation with `--create-fields`).
- `halo-client.mjs` token, paging, call budget, retries; `eol-client.mjs` endoflife.ai lookups and the Exploited & Unpatchable list.
- `map.mjs` and `mapping.json` title-to-product rules; `evaluate.mjs` the per-asset verdict; `fields.mjs` the field list.
- `test/` node:test suites with mocked Halo and endoflife.ai responses (`npm test`).

## Licence

MIT, see `LICENSE`. The code is free to use and change. The endoflife.ai data
it fetches is governed by https://endoflife.ai/terms.
