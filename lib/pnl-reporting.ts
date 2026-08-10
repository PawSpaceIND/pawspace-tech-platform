// Real P&L reporting engine built on top of the actual chart of accounts (lib/chart-of-accounts.ts)
// and the platform's real transactional data (canonical_bookings, finance_journal_entries).
// This computes real numbers from whatever data genuinely exists in the environment it runs in -
// it does not fabricate figures. In a pre-launch UAT environment the output will correctly be
// near-zero until real bookings and approved expenses exist.

import{revenueChartOfAccounts,indirectIncomeChartOfAccounts,expenseChartOfAccounts}from"./chart-of-accounts";

type D1=D1Database;
type Row=Record<string,unknown>;

export interface PnlLine{code:string;category:string;subCategory:string;serviceCode:string|null;trackedByPlatform:boolean;monthly:Record<string,number>;total:number;businessContributionPct:number|null}
export interface PnlSection{title:string;lines:PnlLine[];subtotal:Record<string,number>;subtotalAmount:number}
export interface PnlReport{months:string[];revenue:PnlSection;indirectIncome:PnlSection;totalTurnover:Record<string,number>;totalTurnoverAmount:number;expenses:PnlSection;totalExpenses:Record<string,number>;totalExpensesAmount:number;nettProfit:Record<string,number>;nettProfitAmount:number;generatedAt:number;dataSource:"platform_live";note:string}

function monthKey(value:string|number):string{const date=new Date(value);return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}`;}
function monthRange(fromMonth:string,toMonth:string):string[]{
  const months:string[]=[];let[y,m]=fromMonth.split("-").map(Number);const[toY,toM]=toMonth.split("-").map(Number);
  while(y<toY||(y===toY&&m<=toM)){months.push(`${y}-${String(m).padStart(2,"0")}`);m++;if(m>12){m=1;y++;}}
  return months;
}
function emptyMonthly(months:string[]):Record<string,number>{const out:Record<string,number>={};for(const month of months)out[month]=0;return out;}
function addToMonthly(monthly:Record<string,number>,month:string,amount:number){monthly[month]=(monthly[month]||0)+amount;}
function sumMonthly(monthly:Record<string,number>):number{return Object.values(monthly).reduce((sum,value)=>sum+value,0);}
function sumInto(target:Record<string,number>,source:Record<string,number>){for(const[month,value]of Object.entries(source))target[month]=(target[month]||0)+value;}

async function ensurePnlSourceTables(db:D1){
  await db.exec("CREATE TABLE IF NOT EXISTS finance_journal_entries (id text PRIMARY KEY NOT NULL,entry_date text NOT NULL,source_type text NOT NULL,source_id text NOT NULL,account_code text NOT NULL,cost_centre text,vertical text,debit real DEFAULT 0 NOT NULL,credit real DEFAULT 0 NOT NULL,narration text NOT NULL,period_code text NOT NULL,posted integer DEFAULT 0 NOT NULL,created_at integer NOT NULL)");
  const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").first();
  return Boolean(exists);
}

export async function generatePnlReport(db:D1,input:{fromMonth:string;toMonth:string}):Promise<PnlReport>{
  const months=monthRange(input.fromMonth,input.toMonth);
  const bookingsTableExists=await ensurePnlSourceTables(db);

  // --- Revenue side: real canonical_bookings, grouped by service_code -> mapped to MIS revenue categories.
  // Only non-cancelled bookings count as recognized revenue (matches BookingStatus in backend/src/domain.ts).
  const revenueByServiceMonth=new Map<string,Record<string,number>>();
  if(bookingsTableExists){
    const rows=await db.prepare("SELECT service_code,scheduled_start,total_amount FROM canonical_bookings WHERE status!='cancelled' AND status!='draft'").all<Row>();
    for(const row of rows.results){
      const service=String(row.service_code||""),month=monthKey(String(row.scheduled_start)),amount=Number(row.total_amount||0);
      if(!revenueByServiceMonth.has(service))revenueByServiceMonth.set(service,{});
      addToMonthly(revenueByServiceMonth.get(service)!,month,amount);
    }
  }
  const revenueLines:PnlLine[]=revenueChartOfAccounts.map(entry=>{
    const monthly=emptyMonthly(months);
    if(entry.serviceCode){
      const byMonth=revenueByServiceMonth.get(entry.serviceCode);
      if(byMonth)for(const month of months)if(month in byMonth)monthly[month]=byMonth[month];
    }
    return{code:entry.code,category:entry.category,subCategory:entry.subCategory,serviceCode:entry.serviceCode,trackedByPlatform:entry.serviceCode!==null,monthly,total:sumMonthly(monthly),businessContributionPct:null};
  });
  const revenueTotal=revenueLines.reduce((sum,line)=>sum+line.total,0);
  for(const line of revenueLines)line.businessContributionPct=revenueTotal>0?Math.round((line.total/revenueTotal)*1000)/10:0;
  const revenueSubtotal=emptyMonthly(months);for(const line of revenueLines)sumInto(revenueSubtotal,line.monthly);

  // --- Indirect income: no platform source exists yet for any of these lines (Amazon Discount, Balance
  // Writtenoff, Discount Received, Other Income are all manual/legacy bookkeeping entries today).
  const indirectIncomeLines:PnlLine[]=indirectIncomeChartOfAccounts.map(entry=>({code:entry.code,category:entry.category,subCategory:entry.subCategory,serviceCode:null,trackedByPlatform:false,monthly:emptyMonthly(months),total:0,businessContributionPct:0}));
  const indirectIncomeSubtotal=emptyMonthly(months);

  const totalTurnover=emptyMonthly(months);sumInto(totalTurnover,revenueSubtotal);sumInto(totalTurnover,indirectIncomeSubtotal);
  const totalTurnoverAmount=sumMonthly(totalTurnover);

  // --- Expense side: real finance_journal_entries (posted, debit side only = expense recognition),
  // grouped by account_code -> mapped back to the real chart of accounts.
  const expenseByAccountMonth=new Map<string,Record<string,number>>();
  const journalRows=await db.prepare("SELECT account_code,entry_date,debit FROM finance_journal_entries WHERE posted=1 AND debit>0").all<Row>();
  for(const row of journalRows.results){
    const account=String(row.account_code||""),month=monthKey(String(row.entry_date)),amount=Number(row.debit||0);
    if(!expenseByAccountMonth.has(account))expenseByAccountMonth.set(account,{});
    addToMonthly(expenseByAccountMonth.get(account)!,month,amount);
  }
  const expenseLines:PnlLine[]=expenseChartOfAccounts.map(entry=>{
    const monthly=emptyMonthly(months);
    const byMonth=expenseByAccountMonth.get(entry.accountCode);
    if(byMonth)for(const month of months)if(month in byMonth)monthly[month]+=byMonth[month];
    return{code:entry.code,category:entry.category,subCategory:entry.subCategory,serviceCode:null,trackedByPlatform:true,monthly,total:sumMonthly(monthly),businessContributionPct:null};
  });
  const expenseSubtotal=emptyMonthly(months);for(const line of expenseLines)sumInto(expenseSubtotal,line.monthly);
  const totalExpensesAmount=sumMonthly(expenseSubtotal);

  const nettProfit=emptyMonthly(months);for(const month of months)nettProfit[month]=(totalTurnover[month]||0)-(expenseSubtotal[month]||0);
  const nettProfitAmount=totalTurnoverAmount-totalExpensesAmount;

  return{
    months,
    revenue:{title:"Sales Accounts",lines:revenueLines,subtotal:revenueSubtotal,subtotalAmount:revenueTotal},
    indirectIncome:{title:"Indirect Incomes",lines:indirectIncomeLines,subtotal:indirectIncomeSubtotal,subtotalAmount:0},
    totalTurnover,totalTurnoverAmount,
    expenses:{title:"Indirect Expenses",lines:expenseLines,subtotal:expenseSubtotal,subtotalAmount:totalExpensesAmount},
    totalExpenses:expenseSubtotal,totalExpensesAmount,
    nettProfit,nettProfitAmount,
    generatedAt:Date.now(),
    dataSource:"platform_live",
    note:"Computed from real canonical_bookings and finance_journal_entries in this environment. Lines marked trackedByPlatform:false (B2B events, Experience Centre, non-Bengaluru cities, Rapido) have no platform data source yet and will read zero until either a historical import or a new booking flow exists for them.",
  };
}
