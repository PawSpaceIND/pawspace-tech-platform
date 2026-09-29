"""Run only the two fixed non-telephony audio checks; publish no credentials."""
import json, os, subprocess, sys
prefixes = ('VOICE_AUDIO_TRANSCRIPT=', 'VOICE_AUDIO_REPLY=', 'VOICE_AUDIO_REPLY_CORRECTION=',
            'VOICE_AUDIO_DIAGNOSTICS=', 'VOICE_AUDIO_PROOF=', 'VOICE_AUDIO_FORMATS=',
            'VOICE_AUDIO_CLOSE=', 'VOICE_AUDIO_TERMINATION=')
results = []
for scenario in ('payment', 'rescheduling'):
    env = dict(os.environ, MAYA_DEMO_SCENARIO=scenario)
    try:
        run = subprocess.run(['node', 'scripts/probe-maya-demo-audio.mjs'], env=env,
                             capture_output=True, text=True, timeout=210)
    except subprocess.TimeoutExpired:
        results.append({'scenario': scenario, 'passed': False, 'reason': 'probe_timeout'})
        print('MAYA_DEMO_RESULT=' + json.dumps(results[-1]), flush=True)
        continue
    proof = None
    for line in run.stdout.splitlines():
        if line.startswith(prefixes):
            name, data = line.split('=', 1)
            try:
                parsed = json.loads(data)
            except json.JSONDecodeError:
                continue
            print(name + '=' + json.dumps({'scenario': scenario, 'evidence': parsed}), flush=True)
            if name == 'VOICE_AUDIO_PROOF': proof = parsed
    result = {'scenario': scenario, 'passed': run.returncode == 0 and bool(proof and proof.get('passed')),
              'exitCode': run.returncode, 'dialed': False, 'syntheticCaller': True}
    results.append(result)
    print('MAYA_DEMO_RESULT=' + json.dumps(result), flush=True)
print('MAYA_DEMO_SUMMARY=' + json.dumps(results), flush=True)
sys.exit(0 if all(r['passed'] for r in results) else 1)
