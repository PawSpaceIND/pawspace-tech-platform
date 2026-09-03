import fs from 'node:fs';

function replaceDefaultCache(path, cacheName) {
  const src = fs.readFileSync(path, 'utf8');
  const hits = src.split('caches.default').length - 1;
  if (hits < 1) throw new Error(`${path}: expected caches.default references not found`);
  fs.writeFileSync(path, src.replaceAll('caches.default', `(await caches.open("${cacheName}"))`));
  console.log(`${path}: replaced ${hits} default-cache references`);
}

replaceDefaultCache('app/api/grooming-finance/route.ts', 'pawspace-track3-finance-v2');
replaceDefaultCache('lib/uat-staging-auth.ts', 'pawspace-uat-actor-v1');
console.log('Track 3 Cache API typing compatibility patch applied');
