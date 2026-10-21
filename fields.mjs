// The asset fields the integration writes. Names are what an MSP sees on the
// asset's Details tab and what setup-fields.mjs creates; `key` is the property
// of the evaluated result that feeds the field.
export const EOL_FIELDS = [
  { name: 'EOL Product', key: 'product', hint: 'endoflife.ai product the asset was matched to (name and slug)' },
  { name: 'EOL Cycle', key: 'cycle', hint: 'release line matched, e.g. 2016 or 10-22h2' },
  { name: 'EOL Support Ends', key: 'support_end', hint: 'vendor end of active support (blank when the vendor publishes none)' },
  { name: 'EOL Date', key: 'eol_date', hint: 'vendor end of life / end of security fixes' },
  { name: 'EOL Status', key: 'status', hint: 'active, warn (ends within 12 months), eol, needs a more specific version, version not tracked, not tracked' },
  { name: 'EOL Risk Score', key: 'score', hint: 'endoflife.ai EOL Risk Score 0-100 (methodology: https://endoflife.ai/risk-score)' },
  { name: 'EOL Risk Grade', key: 'grade', hint: 'A to F with label' },
  { name: 'EOL Exploited Unpatchable', key: 'exploited', hint: 'Yes when the cycle is on the Exploited & Unpatchable list (CISA KEV, no fix coming)' },
  { name: 'EOL Source', key: 'source', hint: 'vendor page the end-of-life date was read from' },
  { name: 'EOL Verified', key: 'verified', hint: 'day endoflife.ai last verified the date at the vendor' },
  { name: 'EOL Checked', key: 'checked', hint: 'day this integration last evaluated the asset' },
  { name: 'EOL Detail', key: 'detail', hint: 'one line per matched software row' },
];
export const FIELD_NAMES = EOL_FIELDS.map(f => f.name);
export const TICKET_PREFIX = 'endoflife-ai:';
