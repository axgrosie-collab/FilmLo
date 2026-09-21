const fs = require('fs');
const html = fs.readFileSync('public/movie.html', 'utf8');

// Extract the main script (last script tag)
const parts = html.split('<script>');
const lastScript = parts[parts.length - 1];
const endIdx = lastScript.indexOf('</script>');
const js = endIdx >= 0 ? lastScript.substring(0, endIdx) : lastScript;

// Check for </script inside the JS (which would prematurely close the script tag)
console.log('=== Checking for premature </script> in JS ===');
const jsLines = js.split('\n');
jsLines.forEach((line, i) => {
  if (line.toLowerCase().includes('</script')) {
    console.log('POTENTIAL CLOSE Line ' + (i+1) + ': ' + line);
  }
  // Also check for </ followed by optional space and script
  if (/<\/\s*script/i.test(line)) {
    console.log('MATCH </script Line ' + (i+1) + ': ' + line);
  }
});

// Check hex of the esc function regex
console.log('\n=== Hex dump of esc function area ===');
const escIdx = js.indexOf('const esc');
if (escIdx >= 0) {
  const snippet = js.substring(escIdx, escIdx + 120);
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    if (ch === '<' || ch === '>' || ch === '&' || ch === '"' || ch === "'") {
      console.log('Char: ' + ch + ' (0x' + snippet.charCodeAt(i).toString(16) + ') at offset ' + i);
    }
  }
}

// Check for </ in the JS (potential HTML parser issues)
console.log('\n=== All </ occurrences in JS ===');
jsLines.forEach((line, i) => {
  if (line.includes('</')) {
    console.log('Line ' + (i+1) + ': ' + line);
  }
});

// Check the regex specifically
console.log('\n=== Regex analysis ===');
const regexLine = jsLines[2]; // line 3 (0-indexed)
console.log('esc line:', regexLine);
// Find the regex pattern
const regexMatch = regexLine.match(/replace\((\/\W+\/\w*)/);
if (regexMatch) {
  console.log('Regex:', regexMatch[1]);
  // Check chars in the regex
  for (let i = 0; i < regexMatch[1].length; i++) {
    console.log('  char ' + i + ': ' + regexMatch[1][i] + ' (0x' + regexMatch[1].charCodeAt(i).toString(16) + ')');
  }
}




