// Parses every inline <script> in the given HTML files. A syntax error here kills page boot
// entirely — nav dead, nothing loads — and is invisible to any test that only touches the DOM
// or a separate .js file, which is exactly how one shipped.
const fs = require('fs');
let bad = 0;
for (const file of process.argv.slice(2)) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    i++;
    const src = m[1];
    const line = html.slice(0, m.index).split('\n').length;
    try {
      new Function(src);
      console.log(`OK    ${file} inline script #${i} (from line ${line}, ${src.split('\n').length} lines)`);
    } catch (err) {
      bad++;
      console.log(`FAIL  ${file} inline script #${i} (from line ${line}): ${err.message}`);
    }
  }
  if (i === 0) console.log(`----  ${file}: no inline scripts`);
}
process.exit(bad ? 1 : 0);
