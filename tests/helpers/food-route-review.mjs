import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url);
const original='import CanonicalFoodPage from "../../food/canonical-food-page";\nexport default function V2FoodPage(){return <CanonicalFoodPage routeScope="v2"/>;}\n';
const reviewed='import V2FoodExperience from "../food-experience";\nexport default function V2FoodPage(){return <V2FoodExperience/>;}\n';
const approvedSources={
 'app/v2/food-experience.tsx':'681bb166658bb1145ef4dda40f130431393356f077e61b183296618b7b7f6ecd',
 'app/v2/food-experience.module.css':'cb96e8065565ad9663d63e70d20310319908b56e2517b140bc02a5f9c4cd4b7c',
};
const hash=source=>createHash('sha256').update(source).digest('hex');
/** Reconcile only the independently reviewed 02f9143 / PR1243 Food entry migration.
 * Historical fixtures remain immutable. A changed bridge is accepted only with the exact
 * reviewed component AND stylesheet; handler/guard/price/auth changes cannot hide here.
 * Every other path, including legacy Food, clients, APIs and subscription modules, is unchanged.
 */
export function preservedReviewedFoodBytes(path,bytes,read=file=>readFileSync(new URL(file,root))){
 if(path!=='app/v2/food/page.tsx'||bytes.toString()===original)return bytes;
 assert.equal(bytes.toString(),reviewed,'Only the exact reviewed V2 Food bridge is accepted');
 for(const[file,expected]of Object.entries(approvedSources))assert.equal(hash(read(file)),expected,'Reviewed Food source changed: '+file);
 return Buffer.from(original);
}
