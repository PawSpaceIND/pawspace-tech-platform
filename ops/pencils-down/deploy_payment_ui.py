#!/usr/bin/env python3
"""Deploy the frozen product to NEW test-only resources, never an existing database.
Production need not be configured: isolation is proved by the create response and a
private same-run receipt. Existing Workers/databases are refused, not adopted.
No product patch, production routing, provider send, payment, or promotion.
"""
from __future__ import annotations
import hashlib, json, os, re, subprocess, sys
from pathlib import Path
from uuid import UUID
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError

SHA = '8745bbca5e76185b65ca7c0a7fd4bda60acf35e6'
TREE = '321312aec6e2a96060496bdf4401d41cf024e40d'
WORKER = 'pawspace-beta-payui-8745bbca'
ENVIRONMENT = 'pencils-down-preview'
ROOT = Path(os.environ.get('GITHUB_WORKSPACE', '.')).resolve()
CANDIDATE = ROOT / 'candidate'
EVIDENCE = ROOT / 'pencils-down-evidence'
PRIVATE = Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'pawspace-payment-ui-8745bbca'
REPORT = EVIDENCE / 'report.json'
RECEIPT = PRIVATE / 'new-test-database-receipt.json'
UAT = ['PAWSPACE_UAT_ACCESS_CODE', 'PAWSPACE_UAT_SIGNING_KEY', 'PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT']
RAZOR = ['RAZORPAY_KEY_ID_SANDBOX', 'RAZORPAY_KEY_SECRET_SANDBOX', 'RAZORPAY_WEBHOOK_SECRET_SANDBOX']
SIDE_EFFECTS = ['PAYMENTS','PAYOUTS','REFUNDS','BANK_INSTRUCTIONS','WHATSAPP','SMS','EMAIL','PUSH','TELEPHONY','KYC','ESIGN','MAPS_BILLING','EXTERNAL_AI','ACCOUNTING','TAX_POSTING']
SAFE_VARS = {
    'APP_ENV':'staging', 'FORBID_PRODUCTION':'true',
    'PAWSPACE_DEPLOYMENT_ENV':'staging', 'PAWSPACE_ENVIRONMENT':ENVIRONMENT,
    'PAWSPACE_RELEASE_SHA':SHA, 'PAWSPACE_UAT_LOGIN':'on',
    'PAWSPACE_LOCAL_PREVIEW':'off', 'PAWSPACE_SCHEDULING_ENV':'uat',
    'PAWSPACE_PAYMENT_ENV':'sandbox', 'PAWSPACE_PAYMENT_LIVE_APPROVED':'false',
    'PAWSPACE_STAGING_LIVE_CUSTOMER_OTP':'false',
    'PAWSPACE_PROVIDER_MARKETPLACE_LIVE':'false', 'PAWSPACE_PROVIDER_ORDER_ELIGIBLE':'false',
    'PAWSPACE_PROVIDER_ACTIVATION':'uat_ready',
    **{'PAWSPACE_LIVE_'+key:'false' for key in SIDE_EFFECTS},
}
class Stop(RuntimeError): pass

def require(ok: bool, message: str) -> None:
    if not ok: raise Stop(message)

def initialize() -> dict:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(PRIVATE, 0o700)
    if REPORT.exists(): return json.loads(REPORT.read_text())
    return {'candidate':SHA, 'tree':TREE, 'worker':WORKER, 'run_id':os.environ.get('GITHUB_RUN_ID'),
            'scope':'Test/UAT only. Isolated frontend and read-only route smoke, not payment certification',
            'isolation_method':'CREATE_ONLY_NEW_DATABASE_WITH_SAME_RUN_RECEIPT',
            'production_configuration_required':False, 'existing_resources_reused':False,
            'checks':{}, 'outcome':'NOT_DEPLOYED', 'hosted_payment':'NOT_RUN',
            'authenticated_customer_journey':'NOT_RUN', 'native_device':'NOT_RUN',
            'production_changed':False, 'existing_preview_changed':False, 'product_source_changed':False}

def save(report:dict) -> None:
    REPORT.write_text(json.dumps(report, indent=2)+'\n')

def private_json(path: Path, value:dict) -> None:
    with path.open('x') as handle: json.dump(value, handle)
    os.chmod(path,0o600)

def git(*args: str) -> str:
    run = subprocess.run(['git','-C',str(CANDIDATE),*args], capture_output=True, text=True, timeout=30)
    require(run.returncode==0, 'Candidate Git verification failed.')
    return run.stdout.strip()

def source_gate() -> None:
    require(git('rev-parse','HEAD')==SHA, 'Candidate SHA mismatch; no deployment.')
    require(git('rev-parse','HEAD^{tree}')==TREE, 'Candidate tree mismatch; no deployment.')
    require(not git('status','--porcelain'), 'Candidate source is modified; no deployment.')
    manifest_path = Path(__file__).with_name('payment-ui-source-manifest.json')
    approved = json.loads(manifest_path.read_text())
    require(approved['candidate'] == SHA and approved['tree'] == TREE, 'UI manifest candidate mismatch.')
    require(approved['ui_source'] == '5f12f6efbe4545894f38f817154d798131145f16', 'Unreviewed UI reference.')
    require(len(approved['files']) == 10, 'Incomplete presentation/artwork manifest.')
    for item in approved['files']:
        name = item['path']
        require(name.startswith(('app/mobile-app/', 'public/assets/')) and '..' not in name, 'Invalid UI manifest path.')
        require(hashlib.sha256((CANDIDATE / name).read_bytes()).hexdigest() == item['sha256'], 'Reviewed UI file mismatch: ' + name)

def configured() -> tuple[str,str,dict]:
    # No production/shared-staging identifier is required or used as a fake comparator.
    # Only a database newly returned by Cloudflare's CREATE API in this run can be bound.
    names = ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID',*UAT]
    missing = [n for n in names if not os.environ.get(n,'').strip()]
    require(not missing, 'Missing GitHub test environment configuration: '+', '.join(missing))
    account = os.environ['CLOUDFLARE_ACCOUNT_ID'].strip()
    require(bool(re.fullmatch(r'[0-9a-f]{32}',account)), 'Cloudflare account identifier has an invalid format.')
    values = {name:os.environ[name].strip() for name in UAT}
    for name,value in values.items():
        require(len(value)>=32 and not re.match(r'^pawspace[-_]',value,re.I), name+' fails the existing UAT credential policy.')
    require(len(set(values.values()))==len(values), 'The three UAT credentials must be distinct.')
    provided = [bool(os.environ.get(n,'').strip()) for n in RAZOR]
    if any(provided):
        require(all(provided), 'Incomplete Razorpay TEST secret set; configure all three SANDBOX variables together.')
        require(os.environ[RAZOR[0]].strip().startswith('rzp_test_'), 'Razorpay key is not a TEST key; deployment refused.')
        values.update({n:os.environ[n].strip() for n in RAZOR})
    return account,os.environ['CLOUDFLARE_API_TOKEN'].strip(),values

def cf(path:str, method:str='GET', body:dict|None=None, missing_ok:bool=False):
    account,token,_ = configured()
    require(path.startswith('/') and '..' not in path, 'Unexpected Cloudflare API path.')
    # The sole direct API mutation is creating this exact NEW test database.
    require(method=='GET' or (method=='POST' and path=='/d1/database' and body=={'name':WORKER,'primary_location_hint':'apac'}),
            'A Cloudflare mutation outside new test database creation was refused.')
    url = 'https://api.cloudflare.com/client/v4/accounts/'+account+path
    req = Request(url, data=None if body is None else json.dumps(body).encode(), method=method,
                  headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with urlopen(req, timeout=45) as response: payload=json.loads(response.read())
    except HTTPError as error:
        if missing_ok and error.code==404: return None
        try: codes=[e.get('code') for e in json.loads(error.read()).get('errors',[])]
        except Exception: codes=[]
        raise Stop('Cloudflare '+method+' request failed: HTTP '+str(error.code)+'; codes='+str(codes)) from None
    except (URLError,TimeoutError,ValueError): raise Stop('Cloudflare API unavailable or response unreadable.') from None
    require(payload.get('success') is True, 'Cloudflare API did not acknowledge success.')
    return payload.get('result')

def binding_map(settings:dict) -> dict:
    bindings=settings.get('bindings',[])
    result={b['name']:b for b in bindings if isinstance(b,dict) and 'name' in b}
    require(len(result)==len(bindings),'Duplicate or malformed active bindings.')
    return result

def own_worker(settings:dict, database_id:str) -> None:
    bindings=binding_map(settings)
    require(bindings.get('PAWSPACE_RELEASE_SHA',{}).get('text')==SHA and
            bindings.get('PAWSPACE_ENVIRONMENT',{}).get('text')==ENVIRONMENT,
            'Active test Worker source/environment mismatch.')
    require(bindings.get('DB',{}).get('id')==database_id,'Active test Worker has a different D1 binding.')

def database_inventory() -> list[dict]:
    rows=[]
    for page in range(1,101):
        part=cf('/d1/database?per_page=100&page='+str(page))
        require(isinstance(part,list),'Could not inspect the database inventory.')
        rows.extend(part)
        if len(part)<100: return rows
    raise Stop('Database inventory pagination was not exhausted; no resource created.')

def fresh_namespace() -> list[dict]:
    require(cf('/workers/scripts/'+WORKER+'/settings',missing_ok=True) is None,
            'Test Worker already exists. It was left unchanged; inspect its evidence instead of redeploying blindly.')
    rows=database_inventory()
    require(all(r.get('name')!=WORKER for r in rows),
            'Test database name already exists. No existing database is adopted, overwritten, or deleted.')
    return rows

def isolated(database_id:str) -> None:
    require(RECEIPT.is_file(),'No new-test-database creation receipt; refusing any database binding.')
    receipt=json.loads(RECEIPT.read_text())
    expected={'candidate':SHA,'tree':TREE,'worker':WORKER,'database':database_id,
              'run_id':os.environ.get('GITHUB_RUN_ID'),'run_attempt':os.environ.get('GITHUB_RUN_ATTEMPT'),
              'created_new':True,'not_in_prior_inventory':True}
    require(all(receipt.get(k)==v for k,v in expected.items()),'Database is not the resource created by this exact run.')
    detail=cf('/d1/database/'+database_id)
    require(isinstance(detail,dict) and detail.get('uuid')==database_id and detail.get('name')==WORKER,
            'New test database identity could not be verified.')

def preflight(report:dict) -> None:
    source_gate(); _,_,secrets=configured()
    domain=cf('/workers/subdomain')
    require(isinstance(domain,dict) and re.fullmatch(r'[a-z0-9-]+',domain.get('subdomain','')),
            'No usable existing workers.dev subdomain was returned.')
    fresh_namespace()
    report['origin']='https://'+WORKER+'.'+domain['subdomain']+'.workers.dev'
    report['checks']['credentials_and_namespace']='PASS'
    report['sandbox_keys']='CONFIGURED_TEST_ONLY' if all(n in secrets for n in RAZOR) else 'NOT_CONFIGURED'
    report['checks']['candidate_source']='PASS'
    save(report)
    print('Preflight passed: frozen product, test credentials and unused test namespace. Production setup is not required.')

def create_test_database(report:dict) -> str:
    require(not RECEIPT.exists(),'A creation receipt already exists in this run; no second database creation.')
    before=fresh_namespace()
    created=cf('/d1/database',method='POST',body={'name':WORKER,'primary_location_hint':'apac'})
    require(isinstance(created,dict) and created.get('name')==WORKER,'Created database identity mismatch.')
    db=created.get('uuid','')
    try: valid=str(UUID(db))==db.lower()
    except (ValueError,TypeError,AttributeError): valid=False
    require(valid and db not in {r.get('uuid') for r in before},'Cloudflare did not return a distinct new test database.')
    private_json(RECEIPT,{'candidate':SHA,'tree':TREE,'worker':WORKER,'database':db,
                         'run_id':os.environ.get('GITHUB_RUN_ID'),'run_attempt':os.environ.get('GITHUB_RUN_ATTEMPT'),
                         'created_new':True,'not_in_prior_inventory':True})
    isolated(db)
    report['database_action']='CREATED_NEW_TEST_DATABASE_NO_EXISTING_DATA_REUSED'
    report['checks']['database_isolation']='PASS_CREATE_RESPONSE_AND_READBACK'
    save(report)
    return db

def make_config(built:dict, db:str) -> dict:
    allowed=['main','compatibility_date','compatibility_flags','assets','rules','no_bundle',
             'find_additional_modules','base_dir','upload_source_maps','preserve_file_names',
             'module_root','tsconfig','minify','jsx_factory','jsx_fragment','build','wasm_modules',
             'text_blobs','data_blobs','limits','images']
    out={k:built[k] for k in allowed if k in built}
    require(bool(out.get('main')) and bool(out.get('assets')), 'Candidate Worker/asset build is incomplete.')
    require(not built.get('durable_objects',{}).get('bindings'),
            'Candidate has Durable Object bindings needing a separately reviewed test mapping.')
    out.update(name=WORKER,topLevelName=WORKER,workers_dev=True,preview_urls=False,
               vars=SAFE_VARS,d1_databases=[{'binding':'DB','database_name':WORKER,'database_id':db}],
               triggers={'crons':['*/5 * * * *']},observability={'enabled':True},keep_vars=False)
    return out

def active_version(database_id:str) -> str:
    data=cf('/workers/scripts/'+WORKER+'/deployments')
    deployments=data.get('deployments',[]) if isinstance(data,dict) else data
    require(bool(deployments),'No active deployment returned.')
    latest=max(deployments,key=lambda d:d.get('created_on',''))
    versions=latest.get('versions',[])
    require(len(versions)==1 and versions[0].get('percentage')==100,
            'Test Worker is not serving exactly one version at 100 percent.')
    version_id=versions[0]['version_id']
    version=cf('/workers/scripts/'+WORKER+'/versions/'+version_id)
    bindings=version.get('resources',{}).get('bindings')
    require(isinstance(bindings,list),'Active version did not disclose bindings for verification.')
    own_worker({'bindings':bindings},database_id)
    lookup=binding_map({'bindings':bindings})
    for name,value in SAFE_VARS.items():
        require(lookup.get(name,{}).get('text')==value,'Active test switch mismatch: '+name)
    allowed_names=set(SAFE_VARS)|set(UAT)|set(RAZOR)|{'DB','ASSETS','IMAGES'}
    require(not (set(lookup)-allowed_names),'Unexpected active binding; isolation requires review.')
    isolated(database_id)
    return version_id

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def request_path(origin:str,path:str) -> tuple[int,str,bytes]:
    request=Request(origin+path,headers={'User-Agent':'PawSpace-scoped-staging-check','Cache-Control':'no-cache'})
    try:
        with build_opener(NoRedirect).open(request,timeout=45) as response:
            return response.status,response.headers.get('Content-Type',''),response.read(2_000_000)
    except HTTPError as error:
        return error.code,error.headers.get('Content-Type',''),error.read(4096)

def deploy(report:dict) -> None:
    preflight(report); source_gate()
    config_path=CANDIDATE/'dist/server/wrangler.json'
    require(config_path.is_file(),'Candidate has not produced dist/server/wrangler.json.')
    built=json.loads(config_path.read_text())
    make_config(built,'00000000-0000-4000-8000-000000000000')
    wrangler=CANDIDATE/'node_modules/.bin/wrangler'
    require(wrangler.is_file(),'Locked Wrangler executable is unavailable.')
    db=create_test_database(report)
    # Recheck before uploading; even a matching pre-existing Worker is not taken over.
    require(cf('/workers/scripts/'+WORKER+'/settings',missing_ok=True) is None,
            'Worker namespace became occupied; no existing Worker was updated.')
    isolated(db)
    config_path.write_text(json.dumps(make_config(built,db)))
    _,_,secrets=configured()
    secret_file=PRIVATE/'worker-secrets.json'; private_json(secret_file,secrets)
    cmd=[str(wrangler),'deploy','--message','pencils-down '+SHA,'--secrets-file',str(secret_file)]
    print('Deploying the pinned application to NEW '+WORKER+' (test only; no existing database or custom domain).')
    try:
        result=subprocess.run(cmd,cwd=CANDIDATE,capture_output=True,text=True,timeout=420)
    finally:
        secret_file.unlink(missing_ok=True)
    raw=(result.stdout or '')+'\n'+(result.stderr or '')
    (PRIVATE/'wrangler-deploy.log').write_text(raw); os.chmod(PRIVATE/'wrangler-deploy.log',0o600)
    if result.returncode:
        redacted=raw
        for value in [*secrets.values(),os.environ['CLOUDFLARE_API_TOKEN'],os.environ['CLOUDFLARE_ACCOUNT_ID'],db]:
            if value: redacted=redacted.replace(value,'[redacted]')
        redacted=re.sub(r'[a-f0-9]{8}-[a-f0-9-]{27,}', '[id-redacted]',redacted)
        (EVIDENCE/'deploy-error.txt').write_text(redacted[-16000:])
        raise Stop('Wrangler deployment failed, exit '+str(result.returncode)+'; see sanitized deploy-error.txt.')
    require(report['origin'] in raw,'Wrangler did not confirm the expected dedicated workers.dev origin.')
    report['outcome']='DEPLOYED_NOT_YET_VERIFIED'; save(report)
    version=active_version(db)
    report['active_version']=version
    report['checks']['active_source_and_sandbox_bindings']='PASS'
    report['routes']=[]
    for path in ['/healthz','/','/mobile-app','/partner-app','/staging-login']:
        status,ctype,body=request_path(report['origin'],path)
        ok=status==200 and ((path=='/healthz' and json.loads(body).get('status')=='ok') or
                            (path!='/healthz' and 'text/html' in ctype and b'pawspace' in body.lower()))
        report['routes'].append({'path':path,'status':status,'content_type':ctype,'ok':ok,
                                 'response_sha256':hashlib.sha256(body).hexdigest()})
        save(report); print('GET '+path+' -> '+str(status))
    require(all(r['ok'] for r in report['routes']),'One or more frontend/health routes failed the deployed smoke.')
    status,_,_=request_path(report['origin'],'/api/canonical-bookings')
    report['checks']['anonymous_booking_api']={'status':status,'ok':status in [401,403]}
    require(status in [401,403],'Anonymous booking API was not denied as expected.')
    require(active_version(db)==version,'Active Worker changed during validation.')
    source_gate()
    report['checks']['frontend_http']='PASS'
    report['cron']='FIVE_MINUTE_CONFIG_DEPLOYED_EXECUTION_NOT_VERIFIED'
    report['outcome']='ISOLATED_APPLICATION_HTTP_READY'
    report['limitations']=['Hosted TEST checkout not executed','Authenticated customer journey not executed',
                          'Device launch not executed','R2/media upload is not enabled',
                          'No live messaging/telephony/AI credentials installed','Scheduled execution not yet observed',
                          'Production activation requires separate approval after human testing']
    save(report)
    with open(os.environ['GITHUB_OUTPUT'],'a') as f: f.write('origin='+report['origin']+'\n')
    print('Isolated TEST frontend HTTP checks passed for '+SHA+'. No production or payment certification claimed.')

if __name__=='__main__':
    report=initialize()
    try:
        require(len(sys.argv)==2 and sys.argv[1] in ['preflight','deploy'],'Expected preflight or deploy action.')
        {'preflight':preflight,'deploy':deploy}[sys.argv[1]](report)
    except Exception as error:
        message=str(error) if isinstance(error,Stop) else type(error).__name__+' during test deployment; no success certified.'
        report['error']=message; report['failed_step']=sys.argv[1] if len(sys.argv)>1 else 'arguments'
        report['outcome']='BLOCKED_OR_FAILED'; save(report)
        print('STOP: '+message); sys.exit(1)
