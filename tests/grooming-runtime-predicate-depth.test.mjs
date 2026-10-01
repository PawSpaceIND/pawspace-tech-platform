import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {installAiHooks,freshAiDb,seedCustomer,inboundMessage,applyOwnedDdl} from './helpers/ai-harness.mjs';
import {installRevisionFixture,revisionMigration} from './helpers/grooming-authority-harness.mjs';
installAiHooks();
const {groomingInstallationPredicate,groomingRevisionTriggers}=await import('../lib/grooming-revision-installation.ts');
const {readPersistedGroomingOwnershipLease,persistedOwnershipBatchGuard}=await import('../lib/grooming-persisted-ownership-lease.ts');
const {CANONICAL_BOOKING_CORE_DDL}=await import('../lib/canonical-booking-core-schema.ts');

// Python exposes sqlite3_limit; node:sqlite does not. All data is synthetic, copied from the actual
// repository-owned fixture/schema, and all limit-100 mutations run in a private in-memory database.
const depthProbe=String.raw`
import json,sqlite3,sys
p=json.load(sys.stdin)
source=sqlite3.connect(p['database'],cached_statements=0)
db=sqlite3.connect(':memory:',cached_statements=0)
source.backup(db);source.close()
assert hasattr(db,'setlimit'), 'Python 3.11+ with sqlite3_limit is required'
assert len(p['triggers'])==len(set(p['triggers']))==57
actual=dict(db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'"))
assert set(p['triggers']).issubset(actual)
def ready():
    return db.execute('SELECT ('+p['predicate']+') AS ready').fetchone()[0]
def guard_ok():
    assert db.execute(p['guardSql'],p['guardArgs']).fetchone()[0]==1

def guard_refused():
    try:
        db.execute(p['guardSql'],p['guardArgs']).fetchone()
    except sqlite3.Error as error:
        assert 'integer overflow' in str(error), str(error)
    else:
        raise AssertionError('Invalid or stale installation authorized a guarded commit')

assert ready()==1;guard_ok()
db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
assert db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH)==100
assert ready()==1;guard_ok()
checks=['intact predicate and actual ownership guard execute at depth 100']
for name in p['triggers']:
    sql=actual[name]
    for kind in ('missing','altered'):
        db.execute('DROP TRIGGER '+name)
        if kind=='altered':
            # Preserve a real source table but change the installed definition under the same name.
            table=db.execute("SELECT tbl_name FROM sqlite_master WHERE type='table' LIMIT 1").fetchone()[0]
            db.execute('CREATE TRIGGER '+name+' AFTER UPDATE ON '+table+' BEGIN SELECT 1; END')
        assert ready()==0,(name,kind)
        guard_refused()
        if kind=='altered':db.execute('DROP TRIGGER '+name)
        db.execute(sql)
        assert ready()==1;guard_ok()
checks.append('114 missing/altered definitions refuse; exact restoration authorizes')
for marker in (1,3,None):
    db.execute('DELETE FROM grooming_revision_installation')
    if marker is not None:db.execute('INSERT INTO grooming_revision_installation VALUES(1,?)',(marker,))
    assert ready()==0;guard_refused()
db.execute('INSERT OR REPLACE INTO grooming_revision_installation VALUES(1,2)')
assert ready()==1;guard_ok()
checks.append('missing/wrong marker refuses; marker 2 authorizes')
epoch=db.execute('SELECT epoch,incarnation FROM grooming_revision_installation_epoch').fetchone()
control=db.execute('SELECT revision,database_incarnation FROM grooming_effective_control_revision').fetchone()
revision=db.execute('SELECT thread_id,revision FROM conversation_ownership_revisions ORDER BY thread_id').fetchall()
db.executescript(p['migration'])
assert db.execute('SELECT epoch,incarnation FROM grooming_revision_installation_epoch').fetchone()==epoch
assert db.execute('SELECT revision,database_incarnation FROM grooming_effective_control_revision').fetchone()==control
assert db.execute('SELECT thread_id,revision FROM conversation_ownership_revisions ORDER BY thread_id').fetchall()==revision
assert ready()==1;guard_ok()
checks.append('intact real archive replay preserves authority at depth 100')
db.execute('CREATE TRIGGER unrelated_depth_probe AFTER UPDATE ON ai_handoffs BEGIN SELECT 1; END')
assert ready()==1;guard_ok()
checks.append('unrelated extra trigger leaves exact manifest authorized')
db.execute('SAVEPOINT ownership_probe')
db.execute("UPDATE communication_threads SET assigned_to='employee' WHERE id='THREAD-DEPTH'")
db.execute("UPDATE communication_threads SET assigned_to='ai-orchestrator' WHERE id='THREAD-DEPTH'")
assert ready()==1;guard_refused()
checks.append('takeover/resume ABA still rejects the actual stale ownership guard')
db.execute('ROLLBACK TO ownership_probe');db.execute('RELEASE ownership_probe')
assert ready()==1;guard_ok()
db.execute('UPDATE grooming_revision_installation_epoch SET epoch=epoch+1 WHERE id=1')
assert ready()==1;guard_refused()
checks.append('a valid advanced installation epoch rejects the stale guard independently of ownership')
print(json.dumps({'depth':db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH),'triggerCases':114,'checks':checks}))
`;

test('runtime manifest and actual CAS guard preserve semantics at SQLite/D1 expression depth 100',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'grooming-runtime-depth-'));
 const {sqlite,db}=freshAiDb();
 try {
  seedCustomer(sqlite,'CUS-DEPTH','Depth fixture','9876500077');
  await inboundMessage(sqlite,db,{threadId:'THREAD-DEPTH',customerId:'CUS-DEPTH',text:'Grooming',idempotencyKey:'DEPTH'});
  applyOwnedDdl(sqlite,'lib/ai-human-handoff.ts');applyOwnedDdl(sqlite,'lib/ai-conversation-orchestrator.ts');
  sqlite.exec('DROP TABLE canonical_bookings');for(const sql of CANONICAL_BOOKING_CORE_DDL)sqlite.exec(sql);
  installRevisionFixture(sqlite);
  const lease=await readPersistedGroomingOwnershipLease(db,{threadId:'THREAD-DEPTH',customerId:'CUS-DEPTH',actor:'ai'});
  // Capture the real guard builder's SQL/bindings without reimplementing its CAS conditions.
  const guard=persistedOwnershipBatchGuard({prepare:sql=>({bind:(...args)=>({sql,args})})},lease);
  const database=join(directory,'fixture.sqlite');sqlite.prepare('VACUUM INTO ?').run(database);
  const result=JSON.parse(execFileSync('python3',['-c',depthProbe],{encoding:'utf8',input:JSON.stringify({database,
   predicate:groomingInstallationPredicate,triggers:groomingRevisionTriggers,migration:revisionMigration,
   guardSql:guard.sql,guardArgs:guard.args})}));
  assert.equal(result.depth,100);assert.equal(result.triggerCases,114);assert.equal(result.checks.length,7);
 } finally {sqlite.close();rmSync(directory,{recursive:true,force:true});}
});
