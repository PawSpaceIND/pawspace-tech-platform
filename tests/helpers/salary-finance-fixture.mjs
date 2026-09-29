/** Explicit synthetic Finance mappings; no production defaults or credentials are configured. */
export async function configureSalaryFinanceFixture(db){
 const finance=await import("../../lib/people-finance-integration.ts");
 const accounts={"payroll.salary_expense":"6100-QA Salary Expense","payroll.reimbursement_expense":"6101-QA Reimbursements","payroll.employer_cost_expense":"6102-QA Employer Cost","payroll.deductions_payable":"2131-QA Payroll Deductions","payroll.net_pay_payable":"2120-Employee Salary Payable","payroll.employer_cost_payable":"2132-QA Employer Cost Payable"};
 for(const[sourceKey,accountCode]of Object.entries(accounts))await finance.configurePayrollAccountMapping(db,{sourceKey,accountCode,approvalReference:"OFFLINE-FINANCE-FIXTURE",actorId:"finance@offline.test"});
}
