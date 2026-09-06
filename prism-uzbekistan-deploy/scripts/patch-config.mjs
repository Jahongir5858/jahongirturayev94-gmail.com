import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  throw new Error('Path to frontend/src/config/index.ts is required.');
}

let source = fs.readFileSync(file, 'utf8');

const importMarker = "import ukraine from './ukraine';";
const uzImport = "import uzbekistan from './uzbekistan';";
if (!source.includes(uzImport)) {
  if (!source.includes(importMarker)) {
    throw new Error('Could not find import insertion marker in PRISM config index.');
  }
  source = source.replace(importMarker, `${importMarker}\n${uzImport}`);
}

const mapMarker = '  ukraine,\n  universal,';
const uzMapEntry = '  ukraine,\n  uzbekistan,\n  universal,';
if (!source.includes('  uzbekistan,\n')) {
  if (!source.includes(mapMarker)) {
    throw new Error('Could not find configMap insertion marker in PRISM config index.');
  }
  source = source.replace(mapMarker, uzMapEntry);
}

fs.writeFileSync(file, source);
console.log('Registered Uzbekistan in PRISM configMap.');
