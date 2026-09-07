import { execFileSync } from 'node:child_process';

const fail = (message) => { throw new Error(message); };
const text = (value) => String(value ?? '').trim();

if (text(process.env.PAWSPACE_PAYMENT_ENV) !== 'sandbox') {
  fail('Refusing voice UAT dispatch unless PAWSPACE_PAYMENT_ENV=sandbox');
}
if (text(process.env.PAWSPACE_COMMUNICATION_ENV) !== 'sandbox') {
  fail('Refusing voice UAT dispatch unless PAWSPACE_COMMUNICATION_ENV=sandbox');
}

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? text(process.argv[index + 1]) : '';
};
let expectedSha = arg('--sha') || text(process.env.PAWSPACE_UAT_EXPECTED_SHA);
if (!expectedSha) {
  try { expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { fail('Provide --sha <40-char commit> or PAWSPACE_UAT_EXPECTED_SHA'); }
}
if (!/^[0-9a-f]{40}$/.test(expectedSha)) fail('UAT expected SHA must be exactly 40 lowercase hex characters');

try { execFileSync('gh', ['auth', 'status'], { stdio: 'inherit' }); }
catch { fail('Authenticated GitHub CLI session is required'); }

execFileSync('gh', [
  'workflow', 'run', 'voice-uat-staging.yml',
  '--ref', expectedSha,
  '-f', 'confirm=voice-uat',
  '-f', `expected_sha=${expectedSha}`,
], { stdio: 'inherit' });

console.log(`Dispatched operator-controlled Voice UAT staging activation for exact SHA ${expectedSha}.`);
console.log('The workflow deploys isolated staging only; it does not create consent or place a carrier call.');
