import{DatabaseSync}from"node:sqlite";
export function employeeAuditD1(t){
 const sqlite=new DatabaseSync(":memory:");t.after(()=>sqlite.close());
 const prepare=(sql,args=[])=>({sql,args,bind:(...values)=>prepare(sql,values),first:async()=>sqlite.prepare(sql).get(...args)??null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>({success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})});
 const db={prepare,batch:async statements=>{sqlite.exec("BEGIN IMMEDIATE");try{const result=statements.map(s=>({success:true,meta:{changes:Number(sqlite.prepare(s.sql).run(...s.args).changes)}}));sqlite.exec("COMMIT");return result;}catch(e){sqlite.exec("ROLLBACK");throw e;}}};
 return{db,sqlite};
}
