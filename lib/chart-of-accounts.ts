// Real chart of accounts, matching PawSpace's actual MIS Accounts taxonomy (Google Sheet: "PawSpace MIS Accounts").
// This is the source of truth for category/sub-category selection on expenses and bills, and for
// account-code assignment on journal postings. Do not invent categories here - only encode what the
// real business's books actually use.

export type RevenueCategory={code:string;category:string;subCategory:string;serviceCode:string|null;note?:string};
export type ExpenseCategory={code:string;accountCode:string;category:string;subCategory:string};

// serviceCode:null means this MIS revenue line has no equivalent in the platform's schema yet
// (canonical_bookings.service_code only covers grooming/dog_training/boarding/pet_sitting/pet_taxi/
// dog_walking/food/relocation/funeral_memorial). Reports must show these honestly as "not tracked
// by the platform" rather than silently omit or fabricate a mapping.
export const revenueChartOfAccounts:RevenueCategory[]=[
  {code:"REV-B2B-EVENT",category:"B2B Sales",subCategory:"B2B - Pet Event",serviceCode:null,note:"Not modeled in platform schema"},
  {code:"REV-B2B-GROOMING",category:"B2B Sales",subCategory:"B2B - Pet Grooming",serviceCode:null,note:"Not modeled in platform schema"},
  {code:"REV-B2B-RELOCATION",category:"B2B Sales",subCategory:"B2B - Relocation",serviceCode:"relocation"},
  {code:"REV-BOARDING-COMMISSION",category:"Boarding - Commission",subCategory:"Pet Boarding",serviceCode:"boarding"},
  {code:"REV-EXP-CENTRE-BOARDING",category:"Experience Centre",subCategory:"PawSpace BCT (Boarding)",serviceCode:null,note:"Physical Experience Centre revenue not modeled in platform schema"},
  {code:"REV-EXP-CENTRE-TRAINING",category:"Experience Centre",subCategory:"PawSpace BCT (Training)",serviceCode:null,note:"Physical Experience Centre revenue not modeled in platform schema"},
  {code:"REV-EXP-CENTRE",category:"Experience Centre",subCategory:"PawSpace Experience Centre",serviceCode:null,note:"Physical Experience Centre revenue not modeled in platform schema"},
  {code:"REV-GROOMING",category:"Pet Grooming",subCategory:"Pet Grooming",serviceCode:"grooming"},
  {code:"REV-GROOMING-CHN",category:"Pet Grooming",subCategory:"Pet Grooming - CHN",serviceCode:null,note:"Chennai not a live platform city yet"},
  {code:"REV-GROOMING-HYD",category:"Pet Grooming",subCategory:"Pet Grooming - HYD",serviceCode:null,note:"Hyderabad not a live platform city yet"},
  {code:"REV-GROOMING-PUN",category:"Pet Grooming",subCategory:"Pet Grooming - PUN",serviceCode:null,note:"Pune not a live platform city yet"},
  {code:"REV-GROOMING-SUB",category:"Pet Grooming",subCategory:"Pet Grooming Subscription",serviceCode:"grooming",note:"Subscription revenue - filter canonical_bookings by package_code subscription flag"},
  {code:"REV-DOG-DAYCARE",category:"Other Services",subCategory:"Dog Day Care",serviceCode:null,note:"Not a distinct platform service_code yet"},
  {code:"REV-TRAINING",category:"Other Services",subCategory:"Dog Training",serviceCode:"dog_training"},
  {code:"REV-TRAINING-ACADEMY",category:"Other Services",subCategory:"Dog Training Academy",serviceCode:"dog_training",note:"Sub-format of dog_training"},
  {code:"REV-TRAINING-MG",category:"Other Services",subCategory:"Dog Training - M & G",serviceCode:"dog_training",note:"Sub-format of dog_training"},
  {code:"REV-TRAINING-PS",category:"Other Services",subCategory:"PS Dog Training",serviceCode:"dog_training",note:"Sub-format of dog_training"},
  {code:"REV-TRAINING-PS-MG",category:"Other Services",subCategory:"PS Dog Training - M&G",serviceCode:"dog_training",note:"Sub-format of dog_training"},
  {code:"REV-WALKING",category:"Other Services",subCategory:"Dog Walking",serviceCode:"dog_walking"},
  {code:"REV-DROPBY",category:"Other Services",subCategory:"Drop By",serviceCode:null,note:"Not a distinct platform service_code yet"},
  {code:"REV-BOARDING-TRAINING",category:"Other Services",subCategory:"Pet Boarding cum Training",serviceCode:null,note:"Combined-service package not modeled in platform schema"},
  {code:"REV-FUNERAL",category:"Other Services",subCategory:"Pet Cremation-Funeral",serviceCode:"funeral_memorial"},
  {code:"REV-SITTING",category:"Other Services",subCategory:"Pet Sitting",serviceCode:"pet_sitting"},
  {code:"REV-PS-EVENT",category:"Other Services",subCategory:"PS Event",serviceCode:null,note:"Not a distinct platform service_code yet"},
  {code:"REV-PS-PRIORITY",category:"Other Services",subCategory:"PS Priority Fee",serviceCode:null,note:"Not a distinct platform service_code yet"},
  {code:"REV-TAXI-PD",category:"Other Services",subCategory:"Transport - Pick and Drop",serviceCode:"pet_taxi"},
  {code:"REV-TAXI-PD-9179",category:"Other Services",subCategory:"Transport - P&D - 9179",serviceCode:"pet_taxi",note:"Legacy line reference"},
  {code:"REV-WALKING-PAWSPACE",category:"Others - Inhouse",subCategory:"PawSpace Dog Walking",serviceCode:"dog_walking",note:"In-house staffed variant"},
  {code:"REV-TRAINING-INHOUSE",category:"Others - Inhouse",subCategory:"PS Dog Training",serviceCode:"dog_training",note:"In-house staffed variant"},
  {code:"REV-TRAINING-INHOUSE-MG",category:"Others - Inhouse",subCategory:"PS Dog Training - M&G",serviceCode:"dog_training",note:"In-house staffed variant"},
  {code:"REV-FOOD-ONETIME",category:"Food Sales",subCategory:"Food one-time",serviceCode:"food"},
  {code:"REV-FOOD-SUB",category:"Food Sales",subCategory:"Food Subscription",serviceCode:"food",note:"Subscription revenue"},
  {code:"REV-RAPIDO",category:"Other Income",subCategory:"Rapido Income",serviceCode:null,note:"Delivery-partner integration revenue not modeled in platform schema"},
];

export const indirectIncomeChartOfAccounts:RevenueCategory[]=[
  {code:"IND-AMAZON",category:"Indirect Incomes",subCategory:"Amazon Discount",serviceCode:null},
  {code:"IND-WRITEOFF",category:"Indirect Incomes",subCategory:"Balance Writtenoff",serviceCode:null},
  {code:"IND-DISCOUNT",category:"Indirect Incomes",subCategory:"Discount Received",serviceCode:null},
  {code:"IND-OTHER",category:"Indirect Incomes",subCategory:"Other Income",serviceCode:null},
];

// Expense side. accountCode follows a real double-entry convention: 6xxx = expense accounts.
// This replaces the two hardcoded generic codes ("6200-Operating expense", "6300-Vendor expense")
// that previously swallowed every category's granularity on journal posting.
export const expenseChartOfAccounts:ExpenseCategory[]=[
  {code:"EXP-COMM-FUNERAL",accountCode:"6010-Commissions",category:"Commissions",subCategory:"Commission - Funeral"},
  {code:"EXP-CP-FOOD",accountCode:"6020-Contract Partners (1)",category:"Contract Partners",subCategory:"Pet Food Contract Partners"},
  {code:"EXP-CP-GROOMING",accountCode:"6020-Contract Partners (2)",category:"Contract Partners",subCategory:"Grooming Contract Partners"},
  {code:"EXP-CP-TRAINER",accountCode:"6020-Contract Partners (3)",category:"Contract Partners",subCategory:"Trainer Contract Partners"},
  {code:"EXP-CP-BADDEBT",accountCode:"6020-Contract Partners (4)",category:"Contract Partners",subCategory:"Bad Debts"},
  {code:"EXP-B2B-HOTEL",accountCode:"6030-B2B Service Expenses (1)",category:"Expenses Related to B2B Service",subCategory:"Hotel Expenses"},
  {code:"EXP-B2B-INCENTIVE",accountCode:"6030-B2B Service Expenses (2)",category:"Expenses Related to B2B Service",subCategory:"Incentive - Event"},
  {code:"EXP-B2B-GROOMING-OTHER",accountCode:"6030-B2B Service Expenses (3)",category:"Expenses Related to B2B Service",subCategory:"Other Grooming Expenses"},
  {code:"EXP-B2B-PETEVENT",accountCode:"6030-B2B Service Expenses (4)",category:"Expenses Related to B2B Service",subCategory:"Pet Event Expenses"},
  {code:"EXP-B2B-TRAVEL",accountCode:"6030-B2B Service Expenses (5)",category:"Expenses Related to B2B Service",subCategory:"Travelling Expenses"},
  {code:"EXP-EC-SALARY",accountCode:"6040-Experience Centre (1)",category:"Experience Centre - Exp",subCategory:"Experience Centre Employee - Salary"},
  {code:"EXP-EC-BOARDING",accountCode:"6040-Experience Centre (2)",category:"Experience Centre - Exp",subCategory:"Boarding Centre Expenses"},
  {code:"EXP-EC-RENT",accountCode:"6040-Experience Centre (3)",category:"Experience Centre - Exp",subCategory:"Boarding Centre - Rent (70%)"},
  {code:"EXP-EC-ELECTRICITY",accountCode:"6040-Experience Centre (4)",category:"Experience Centre - Exp",subCategory:"Electricity Charges - Experience Centre"},
  {code:"EXP-FIN-BANK",accountCode:"6050-Finance Cost (1)",category:"Finance Cost",subCategory:"Bank Charges"},
  {code:"EXP-FIN-LOAN",accountCode:"6050-Finance Cost (2)",category:"Finance Cost",subCategory:"Interest on Loan"},
  {code:"EXP-FIN-CARLOAN",accountCode:"6050-Finance Cost (3)",category:"Finance Cost",subCategory:"Interest on Car Loan"},
  {code:"EXP-FIN-OTHERLOAN",accountCode:"6050-Finance Cost (4)",category:"Finance Cost",subCategory:"Interest on Other Loans"},
  {code:"EXP-FIN-PROCESSING",accountCode:"6050-Finance Cost (5)",category:"Finance Cost",subCategory:"Loan Processing Fee"},
  {code:"EXP-FOOD-EMPLOYEE",accountCode:"6060-Fresh Food Expenses (1)",category:"Fresh Food Expenses",subCategory:"Pet Fresh Food Employees"},
  {code:"EXP-FOOD-PETROL",accountCode:"6060-Fresh Food Expenses (2)",category:"Fresh Food Expenses",subCategory:"Fresh Food - Petrol Expenses"},
  {code:"EXP-FOOD-COST",accountCode:"6060-Fresh Food Expenses (3)",category:"Fresh Food Expenses",subCategory:"Pet Fresh Food Expenses"},
  {code:"EXP-GROOM-PRODUCTS",accountCode:"6070-Grooming Expenses (1)",category:"Grooming - Exp",subCategory:"Grooming Products"},
  {code:"EXP-GROOM-SALARY",accountCode:"6070-Grooming Expenses (2)",category:"Grooming - Exp",subCategory:"Grooming Employees - Salary"},
  {code:"EXP-GROOM-LEADCOMM",accountCode:"6070-Grooming Expenses (3)",category:"Grooming - Exp",subCategory:"Commission - Grooming Leads"},
  {code:"EXP-GROOM-GENERAL",accountCode:"6070-Grooming Expenses (4)",category:"Grooming - Exp",subCategory:"Grooming Expenses"},
  {code:"EXP-GROOM-HELPER",accountCode:"6070-Grooming Expenses (5)",category:"Grooming - Exp",subCategory:"Grooming Helper"},
  {code:"EXP-MKT-FACEBOOK",accountCode:"6080-Marketing and Advertisement (1)",category:"Marketing and Advertisement Exp",subCategory:"Digital Marketing - Facebook"},
  {code:"EXP-MKT-GOOGLE",accountCode:"6080-Marketing and Advertisement (2)",category:"Marketing and Advertisement Exp",subCategory:"Digital Marketing - Google Ads"},
  {code:"EXP-MKT-GENERAL",accountCode:"6080-Marketing and Advertisement (3)",category:"Marketing and Advertisement Exp",subCategory:"Marketing Expenses"},
  {code:"EXP-OFF-ELECTRICITY",accountCode:"6090-Office and Administration (1)",category:"Office & Administration Expenses",subCategory:"Electricity Charges - Office"},
  {code:"EXP-OFF-INTERNET",accountCode:"6090-Office and Administration (2)",category:"Office & Administration Expenses",subCategory:"Internet Expenses"},
  {code:"EXP-OFF-MAID",accountCode:"6090-Office and Administration (3)",category:"Office & Administration Expenses",subCategory:"Maid Salary"},
  {code:"EXP-OFF-CONVEYANCE",accountCode:"6090-Office and Administration (4)",category:"Office & Administration Expenses",subCategory:"Office conveyance allowance"},
  {code:"EXP-OFF-GENERAL",accountCode:"6090-Office and Administration (5)",category:"Office & Administration Expenses",subCategory:"Office Expenses"},
  {code:"EXP-OFF-RENT",accountCode:"6090-Office and Administration (6)",category:"Office & Administration Expenses",subCategory:"Office Rent (30%)"},
  {code:"EXP-OFF-PRINTING",accountCode:"6090-Office and Administration (7)",category:"Office & Administration Expenses",subCategory:"Printing & Stationery"},
  {code:"EXP-OFF-REPAIR",accountCode:"6090-Office and Administration (8)",category:"Office & Administration Expenses",subCategory:"Repair & Maintenance Service"},
  {code:"EXP-OFF-TELEPHONE",accountCode:"6090-Office and Administration (9)",category:"Office & Administration Expenses",subCategory:"Telephone Expenses"},
  {code:"EXP-OTHER-ACADEMY",accountCode:"6100-Other Expenses (1)",category:"Other Expenses",subCategory:"Academy Training - Expenses"},
  {code:"EXP-OTHER-COMPENSATION",accountCode:"6100-Other Expenses (2)",category:"Other Expenses",subCategory:"Compensation Expenses"},
  {code:"EXP-OTHER-BOARDING",accountCode:"6100-Other Expenses (3)",category:"Other Expenses",subCategory:"Boarding Expenses"},
  {code:"EXP-OTHER-INHOUSE-EMP",accountCode:"6110-Other Inhouse Exp (1)",category:"Other Inhouse - Exp",subCategory:"Other Inhouse Employees"},
  {code:"EXP-OTHER-INHOUSE-LEGAL",accountCode:"6110-Other Inhouse Exp (2)",category:"Other Inhouse - Exp",subCategory:"Legal Consultancy Services"},
  {code:"EXP-PROF-MANPOWER",accountCode:"6120-Professional Expenses (1)",category:"Professional Expenses",subCategory:"Manpower Agency Service"},
  {code:"EXP-PROF-CHARGES",accountCode:"6120-Professional Expenses (2)",category:"Professional Expenses",subCategory:"Professional Charges"},
  {code:"EXP-TAX-INCOMETAX",accountCode:"6130-Rates and Taxes (1)",category:"Rates & Taxes",subCategory:"Income Tax Paid"},
  {code:"EXP-TAX-ITC",accountCode:"6130-Rates and Taxes (2)",category:"Rates & Taxes",subCategory:"Ineligible ITC As Per Rule 42"},
  {code:"EXP-TAX-GSTLATE",accountCode:"6130-Rates and Taxes (3)",category:"Rates & Taxes",subCategory:"Interest/Late Fee on GST"},
  {code:"EXP-TAX-PROFTAX-INT",accountCode:"6130-Rates and Taxes (4)",category:"Rates & Taxes",subCategory:"Interest on Professional Tax"},
  {code:"EXP-TAX-TDS-INT",accountCode:"6130-Rates and Taxes (5)",category:"Rates & Taxes",subCategory:"Interest on TDS"},
  {code:"EXP-TAX-MCA",accountCode:"6130-Rates and Taxes (6)",category:"Rates & Taxes",subCategory:"MCA Fees"},
  {code:"EXP-TAX-PROFTAX",accountCode:"6130-Rates and Taxes (7)",category:"Rates & Taxes",subCategory:"Professional Tax"},
  {code:"EXP-TAX-PF",accountCode:"6130-Rates and Taxes (8)",category:"Rates & Taxes",subCategory:"Provident Fund"},
  {code:"EXP-TAX-ROUNDOFF",accountCode:"6130-Rates and Taxes (9)",category:"Rates & Taxes",subCategory:"Round Off"},
  {code:"EXP-RENT-COWORKING",accountCode:"6140-Rent Expenses",category:"Rent Expenses",subCategory:"Co-Working Space Membership Expenses"},
  {code:"EXP-SAL-SALARIES",accountCode:"6150-Salary and Remuneration (1)",category:"Salary and Remuneration",subCategory:"Salaries"},
  {code:"EXP-SAL-HEALTH",accountCode:"6150-Salary and Remuneration (2)",category:"Salary and Remuneration",subCategory:"Employee Health Insurance"},
  {code:"EXP-SAL-WELFARE",accountCode:"6150-Salary and Remuneration (3)",category:"Salary and Remuneration",subCategory:"Staff Welfare"},
  {code:"EXP-SAL-INCENTIVE",accountCode:"6150-Salary and Remuneration (4)",category:"Salary and Remuneration",subCategory:"Incentives"},
  {code:"EXP-SUB-EXOTEL",accountCode:"6160-Subscription and Licenses (1)",category:"Subscription and Licenses Expenses",subCategory:"Exotel Subscription Charges"},
  {code:"EXP-SUB-GMAIL",accountCode:"6160-Subscription and Licenses (2)",category:"Subscription and Licenses Expenses",subCategory:"Gmail Subscription"},
  {code:"EXP-SUB-GENERAL",accountCode:"6160-Subscription and Licenses (3)",category:"Subscription and Licenses Expenses",subCategory:"Subscription Charges"},
  {code:"EXP-SUB-RAZORPAY",accountCode:"6160-Subscription and Licenses (4)",category:"Subscription and Licenses Expenses",subCategory:"Razorpay Subscription"},
  {code:"EXP-TAXI-EMPLOYEES",accountCode:"6170-Taxi Related Expenses (1)",category:"Taxi Related Expenses",subCategory:"Taxi Employees"},
  {code:"EXP-TAXI-INSURANCE",accountCode:"6170-Taxi Related Expenses (2)",category:"Taxi Related Expenses",subCategory:"Car Insurance"},
  {code:"EXP-TAXI-GENERAL",accountCode:"6170-Taxi Related Expenses (3)",category:"Taxi Related Expenses",subCategory:"Taxi Expenses"},
  {code:"EXP-TAXI-MAINTENANCE",accountCode:"6170-Taxi Related Expenses (4)",category:"Taxi Related Expenses",subCategory:"Vehicle Maintenance"},
  {code:"EXP-EVENT",accountCode:"6180-Event Expenses",category:"Event Expenses",subCategory:"Event Expenses"},
  {code:"EXP-IT",accountCode:"6190-IT Maintenance",category:"IT Maintenance Expenses",subCategory:"IT Maintenance Expenses"},
  {code:"EXP-SOFTWARE",accountCode:"6200-Software Expenses",category:"Software Expenses",subCategory:"Software Expenses"},
];

export function findExpenseCategory(code:string):ExpenseCategory|undefined{return expenseChartOfAccounts.find(item=>item.code===code);}
export function findRevenueCategory(code:string):RevenueCategory|undefined{return[...revenueChartOfAccounts,...indirectIncomeChartOfAccounts].find(item=>item.code===code);}
export function expenseCategoryGroups():{category:string;items:ExpenseCategory[]}[]{
  const groups=new Map<string,ExpenseCategory[]>();
  for(const item of expenseChartOfAccounts){const list=groups.get(item.category)??[];list.push(item);groups.set(item.category,list);}
  return[...groups.entries()].map(([category,items])=>({category,items}));
}
