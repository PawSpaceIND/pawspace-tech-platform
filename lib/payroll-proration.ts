import{governedJsonError}from"./governed-http-error";
import{appendPayrollCheck}from"./payroll-integrity";
import{employeeWorkDate}from"./employee-calendar";
type Row=Record<string,unknown>;
export type SalaryComponent={code:string;label:string;kind:"earning"|"deduction"|"reimbursement"|"employer_cost";amount:number};
export async function ensurePayrollProrationTables(db:D1Database){await db.prepare("CREATE TABLE IF NOT EXISTS salary_calculation_policies (structure_id TEXT PRIMARY KEY,mode TEXT NOT NULL,component_codes_json TEXT NOT NULL,approval_reference TEXT NOT NULL,configured_by TEXT NOT NULL,configured_at INTEGER NOT NULL)").run();}
export async function saveSalaryCalculationPolicy(db:D1Database,input:{structureId:string;mode:string;componentCodes:string[];approvalReference:string;actorId:string}){
 await ensurePayrollProrationTables(db);
 if(!["full_period","calendar_days"].includes(input.mode)||input.approvalReference.trim().length<4||!input.actorId.trim())throw governedJsonError({error:"Explicit calculation mode and approval reference are required"},400);
 const structure=await db.prepare("SELECT components_json FROM salary_structure_versions WHERE id=? AND status='active_uat'").bind(input.structureId).first<Row>();
 if(!structure)throw governedJsonError({error:"Active salary structure is required"},409);
 const components=JSON.parse(String(structure.components_json)) as SalaryComponent[],codes=[...new Set(input.componentCodes)];
 if(codes.some(code=>!components.some(c=>c.code===code))||(input.mode==="calendar_days"&&!codes.length))throw governedJsonError({error:"Choose the exact salary components to prorate"},400);
 const writes:D1PreparedStatement[]=[];
 appendPayrollCheck(db,writes,"NOT EXISTS(SELECT 1 FROM employee_payroll_results WHERE structure_id=?)",[input.structureId]);
 writes.push(db.prepare("INSERT INTO salary_calculation_policies (structure_id,mode,component_codes_json,approval_reference,configured_by,configured_at) VALUES (?,?,?,?,?,?) ON CONFLICT(structure_id) DO UPDATE SET mode=excluded.mode,component_codes_json=excluded.component_codes_json,approval_reference=excluded.approval_reference,configured_by=excluded.configured_by,configured_at=excluded.configured_at").bind(input.structureId,input.mode,JSON.stringify(codes),input.approvalReference.trim(),input.actorId,Date.now()));
 try{await db.batch(writes);}catch(error){if(/payroll_integrity_condition/.test(error instanceof Error?error.message:String(error)))throw governedJsonError({error:"This salary structure has payroll history. Create a new version instead of changing its calculation policy."},409);throw error;}
 return{structureId:input.structureId,mode:input.mode,componentCodes:codes,approvalReference:input.approvalReference.trim()};
}
export async function prorateSalaryComponents(db:D1Database,input:{employee:Row;assignment:Row;structure:Row;components:SalaryComponent[];periodStart:number;periodEnd:number}){
 await ensurePayrollProrationTables(db);
 const {employee,assignment,structure,periodStart,periodEnd}=input;
 const joined=employee.joined_at==null?periodStart:Number(employee.joined_at),ended=employee.ended_at==null?periodEnd:Number(employee.ended_at);
 const activeStart=Math.max(periodStart,joined),activeEnd=Math.min(periodEnd,ended);
 if(Number(assignment.effective_from)>activeStart||Number(structure.effective_from)>activeStart||(assignment.effective_until!=null&&Number(assignment.effective_until)<activeEnd-1)||(structure.effective_until!=null&&Number(structure.effective_until)<activeEnd-1))throw governedJsonError({error:"Compensation changes within this period require an explicit correction payroll"},409);
 if(activeStart<=periodStart&&activeEnd>=periodEnd)return{components:input.components,proration:null};
 if(activeEnd<=activeStart)throw governedJsonError({error:"Employee has no payable employment interval in this period"},409);
 const policy=await db.prepare("SELECT * FROM salary_calculation_policies WHERE structure_id=?").bind(structure.id).first<Row>();
 if(!policy)throw governedJsonError({error:"Configure and approve joining/leaving-date proration for this salary structure before calculating a partial period"},409);
 if(policy.mode==="full_period")return{components:input.components,proration:{mode:"full_period",approvalReference:policy.approval_reference,structureId:structure.id}};
 if(policy.mode!=="calendar_days")throw governedJsonError({error:"Unsupported salary calculation policy"},409);
 const first=employeeWorkDate(periodStart),last=employeeWorkDate(periodEnd),[year,month]=first.split("-").map(Number);
 const expectedNext=new Date(Date.UTC(year,month,1)).toISOString().slice(0,10);
 if(!first.endsWith("-01")||last!==expectedNext||periodStart!==Date.parse(`${first}T00:00:00+05:30`)||periodEnd!==Date.parse(`${last}T00:00:00+05:30`))throw governedJsonError({error:"Calendar-day salary proration requires one complete IST payroll month"},409);
 const days=Math.round((periodEnd-periodStart)/86400000),from=employeeWorkDate(activeStart),through=employeeWorkDate(activeEnd-1);
 const covered=Math.round((Date.parse(`${through}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000)+1;
 const codes=JSON.parse(String(policy.component_codes_json)) as string[];
 if(!Array.isArray(codes)||codes.some(code=>!input.components.some(c=>c.code===code)))throw governedJsonError({error:"Salary proration component configuration is invalid"},409);
 const components=input.components.map(c=>({...c,amount:codes.includes(c.code)?Math.round(c.amount*covered/days*100)/100:c.amount}));
 return{components,proration:{mode:"calendar_days",monthDays:days,employedDays:covered,from,through,componentCodes:codes,approvalReference:policy.approval_reference,structureId:structure.id}};
}
