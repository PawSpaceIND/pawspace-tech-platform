#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

SHA='43ba4002bacbd129b359bc6c8ec3fd4f260272bf'
TREE='16086bd5fddbb72de5a55b807d00668503c7b516'
WORKER='pawspace-beta-golden-wallet-43ba4002'
DB_NAME='pawspace-beta-golden-wallet-43ba4002'
ROOT=Path(os.environ['GITHUB_WORKSPACE'])
CANDIDATE=ROOT/'candidate'
OUT=ROOT/'golden-service-evidence'
SECRET_NAMES=['PAWSPACE_UAT_ACCESS_CODE','PAWSPACE_UAT_SIGNING_KEY','PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT','GOOGLE_MAPS_SERVER_API_KEY_UAT','RAZORPAY_KEY_ID_SANDBOX','RAZORPAY_KEY_SECRET_SANDBOX','RAZORPAY_WEBHOOK_SECRET_SANDBOX']

def require(ok,msg):
    if not ok: raise RuntimeError(msg)

def api(path, method='GET', body=None):
    account=os.environ['CLOUDFLARE_ACCOUNT_ID']; token=os.environ['CLOUDFLARE_API_TOKEN']
    require(path.startswith('/') and '..' not in path,'unsafe Cloudflare path')
    req=Request('https://api.cloudflare.com/client/v4/accounts/'+account+path,
        data=None if body is None else json.dumps(body).encode(),method=method,
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with urlopen(req,timeout=45) as r: payload=json.load(r)
    except HTTPError as e: raise RuntimeError(f'Cloudflare {method} failed HTTP {e.code}')
    require(payload.get('success') is True,'Cloudflare did not acknowledge success')
    return payload.get('result')

def git(*args):
    p=subprocess.run(['git','-C',str(CANDIDATE),*args],capture_output=True,text=True,timeout=30)
    require(p.returncode==0,'candidate git check failed')
    return p.stdout.strip()

def binding_map(settings):
    rows=settings.get('bindings',[])
    out={r['name']:r for r in rows if isinstance(r,dict) and r.get('name')}
    require(len(out)==len(rows),'malformed or duplicate Worker bindings')
    return out

def database_id():
    rows=api('/d1/database?per_page=100')
    hits=[r for r in rows if r.get('name')==DB_NAME]
    require(len(hits)==1,'isolated Golden D1 identity is not unique')
    return hits[0].get('uuid') or hits[0].get('id')

def validate(settings, db, expect_media):
    b=binding_map(settings)
    require(b.get('PAWSPACE_RELEASE_SHA',{}).get('text')==SHA,'Worker candidate SHA changed')
    require(b.get('PAWSPACE_PAYMENT_ENV',{}).get('text')=='sandbox','payment environment is not sandbox')
    require(b.get('PAWSPACE_PAYMENT_LIVE_APPROVED',{}).get('text')=='false','live payment approval changed')
    require(b.get('FORBID_PRODUCTION',{}).get('text')=='true','production guard changed')
    require(b.get('DB',{}).get('id')==db,'Worker D1 binding changed')
    live=[n for n,v in b.items() if n.startswith('PAWSPACE_LIVE_') and v.get('text')!='false']
    require(not live,'one or more live side effects are enabled')
    secrets={n for n,v in b.items() if v.get('type') in ('secret_text','secret_key')}
    require(secrets==set(SECRET_NAMES),'unexpected or missing Worker secret binding')
    if expect_media: require(b.get('PAWSPACE_MEDIA_ENV',{}).get('text')=='uat','media UAT mode not active')
    return b

def main():
    OUT.mkdir(exist_ok=True)
    require(git('rev-parse','HEAD')==SHA,'candidate SHA mismatch')
    require(git('rev-parse','HEAD^{tree}')==TREE,'candidate tree mismatch')
    require(not git('status','--porcelain'),'candidate worktree is modified')
    for name in SECRET_NAMES: require(bool(os.environ.get(name,'')),'missing test secret '+name)
    require(os.environ['RAZORPAY_KEY_ID_SANDBOX'].startswith('rzp_test_'),'Razorpay key is not Test Mode')
    db=database_id(); current=api('/workers/scripts/'+WORKER+'/settings')
    before=validate(current,db,False)
    plain={n:v.get('text') for n,v in before.items() if v.get('type')=='plain_text'}
    plain['PAWSPACE_MEDIA_ENV']='uat'
    built=json.loads((CANDIDATE/'dist/server/wrangler.json').read_text())
    allowed=['main','compatibility_date','compatibility_flags','assets','rules','no_bundle','find_additional_modules','base_dir','upload_source_maps','preserve_file_names','module_root','tsconfig','minify','jsx_factory','jsx_fragment','build','wasm_modules','text_blobs','data_blobs','limits','images']
    cfg={k:built[k] for k in allowed if k in built}
    require(bool(cfg.get('main')) and bool(cfg.get('assets')),'candidate Worker build is incomplete')
    cfg.update(name=WORKER,topLevelName=WORKER,workers_dev=True,preview_urls=False,vars=plain,
        d1_databases=[{'binding':'DB','database_name':DB_NAME,'database_id':db}],
        triggers={'crons':['*/5 * * * *']},observability={'enabled':True},keep_vars=False)
    config=CANDIDATE/'dist/server/wrangler.json'; config.write_text(json.dumps(cfg))
    secret_file=Path(os.environ['RUNNER_TEMP'])/'golden-service-secrets.json'
    secret_file.write_text(json.dumps({n:os.environ[n] for n in SECRET_NAMES})); os.chmod(secret_file,0o600)
    try:
        wrangler=CANDIDATE/'node_modules/.bin/wrangler'; require(wrangler.is_file(),'Wrangler unavailable')
        run=subprocess.run([str(wrangler),'deploy','--message','same-record UAT media '+SHA,'--secrets-file',str(secret_file)],cwd=CANDIDATE,capture_output=True,text=True,timeout=420)
        require(run.returncode==0,'same-record test Worker deploy failed')
    finally:
        secret_file.unlink(missing_ok=True)
    after=api('/workers/scripts/'+WORKER+'/settings'); validate(after,db,True)
    proof={'testOnly':True,'productionChanged':False,'candidate':SHA,'tree':TREE,'worker':WORKER,'database':DB_NAME,
      'databaseId':db,'change':'PAWSPACE_MEDIA_ENV=uat only; same code, D1 and secret set re-bound','paymentEnvironment':'sandbox','livePaymentApproved':False,'forbidProduction':True}
    (OUT/'media-uat-rebind.json').write_text(json.dumps(proof,indent=2)+'\n')
    print(json.dumps(proof))

if __name__=='__main__':
    try: main()
    except Exception as e:
        print('STOP:',str(e),file=sys.stderr); sys.exit(1)
