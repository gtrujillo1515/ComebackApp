// Concatenates src/*.js into dist/Code.gs so setup is one copy-paste into Apps Script.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const order = ['Config.js', 'Main.js', 'Util.js', 'Runtime.js', 'PayoutBuilder.js', 'ToastClient.js', 'QboClient.js', 'QboPoster.js', 'Sync.js', 'CashSync.js'];
const all = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js'));
const missing = all.filter((f) => !order.includes(f));
if (missing.length) throw new Error('Add to bundle order: ' + missing.join(', '));
const parts = order.map((f) => '// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(root, 'src', f), 'utf8').trim() + '\n');
const header = '// Toast -> QuickBooks payout sync. GENERATED from src/ by `npm run bundle`; edit src/ instead.\n' +
  '// Paste this whole file into the Apps Script editor as Code.gs (replacing its contents).\n\n';
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'Code.gs'), header + parts.join('\n'));
console.log('Wrote dist/Code.gs');
