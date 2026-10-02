import assert from 'node:assert/strict';
export function reversePayrollShell(source,path){
 if(path!=='app/team/people/payroll/page.tsx')return source;
 const replacements=[['import{Fragment,useEffect,useState}from"react";','import{useEffect,useState}from"react";'],['export default function PayrollPage({embedded=false}:{embedded?:boolean}={}){const Frame=embedded?Fragment:StaffModule;','export default function PayrollPage(){'],['return <Frame><main','return <StaffModule><main'],['</main></Frame>','</main></StaffModule>']];
 for(const [after,before]of replacements){assert.equal(source.split(after).length,2,'Exactly one reviewed payroll shell change: '+after);source=source.replace(after,before);}
 return source;
}
export function assertEmbeddedPayrollBridge(source){
 assert.equal(source,'import PayrollPage from "../../../../team/people/payroll/page";\n\n// The V2 layout owns the single workspace shell for payroll and governance.\nexport default function V2PayrollPage(){return <PayrollPage embedded/>;}\n','Payroll delegates only to the canonical embedded surface.');
}
