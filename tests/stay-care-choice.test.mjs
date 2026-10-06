import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__STAY_CARE_OPTIONS_DB__','__STAY_CARE_OPTIONS_ENV__');
const React=await import('react');
const {renderToStaticMarkup}=await import('react-dom/server');
const {default:Choice}=await import('../app/mobile-app/stay-care-choice.tsx');
const controls=element=>React.Children.toArray(element.props.children).filter(React.isValidElement);
test('saved custom feeding instructions render without substitution and survive choosing owner-provided food',()=>{
 const value='Small portion at 8am and 6pm\nCustomer-specific routine';let changed;
 const tree=Choice({kind:'feeding',title:'Feeding routine',value,onChange:next=>{changed=next;}});
 const [select,textarea]=controls(tree).filter(node=>['select','textarea'].includes(node.type));
 assert.equal(textarea.props.value,value);assert.equal(select.props.value,'custom');
 select.props.onChange({target:{value:'Owner-provided food'}});
 assert.equal(changed,`Owner-provided food\n${value}`);
 const saved=Choice({kind:'feeding',title:'Feeding routine',value:changed,onChange:()=>{}});
 assert.equal(controls(saved).find(node=>node.type==='textarea').props.value,value);
});
test('a customer explicitly selects no medication; blank care never preselects that claim',()=>{
 let changed;const tree=Choice({kind:'medication',title:'Medication / allergies',value:'',onChange:value=>{changed=value;}});
 const select=controls(tree).find(node=>node.type==='select');assert.equal(select.props.value,'');
 select.props.onChange({target:{value:'No medication or allergies reported'}});assert.equal(changed,'No medication or allergies reported');
 const selected=Choice({kind:'medication',title:'Medication / allergies',value:changed,onChange:()=>{}});
 assert.equal(controls(selected).some(node=>node.type==='textarea'),false);
});
test('medication instructions retain their details in the existing text payload',()=>{
 let changed;const tree=Choice({kind:'medication',title:'Medication / allergies',value:'Medication or allergy instructions\nFollow supplied vet instructions',onChange:value=>{changed=value;}});
 const textarea=controls(tree).find(node=>node.type==='textarea');assert.equal(textarea.props.value,'Follow supplied vet instructions');
 textarea.props.onChange({target:{value:'Use the supplied instructions; customer has updated the details'}});
 assert.equal(changed,'Medication or allergy instructions\nUse the supplied instructions; customer has updated the details');
});
test('closed or busy care disables both dropdown and custom details and keeps accessible labels',()=>{
 const tree=Choice({kind:'specialInstructions',title:'Other care instructions',value:'Keep the usual routine',disabled:true,onChange:()=>{throw Error('must not save');}});
 for(const node of controls(tree).filter(node=>['select','textarea'].includes(node.type)))assert.equal(node.props.disabled,true);
 const html=renderToStaticMarkup(tree);assert.match(html,/aria-label="Other care instructions option"/);assert.match(html,/aria-label="Other care instructions details"/);assert.match(html,/min-height:44px/);
});
