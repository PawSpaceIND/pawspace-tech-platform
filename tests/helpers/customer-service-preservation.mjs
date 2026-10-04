import {preservedGroomingAutoRefusalBytes} from './grooming-auto-refusal-reviewed-delta.mjs';
import {preservedCombinedLocalBytes,preservedServiceLintBytes} from './combined-local-reviewed-delta.mjs';
import {preservedServiceFixBytes} from './service-fix-reviewed-delta.mjs';
import {preservedReviewedFoodBytes} from './food-route-review.mjs';
// Reverse the exact reviewed customer-flow delta before existing Food/Audio guards.
export function preservedCustomerServiceBytes(path,bytes,read){
 return preservedReviewedFoodBytes(path,preservedCombinedLocalBytes(path,preservedServiceFixBytes(path,preservedServiceLintBytes(path,preservedGroomingAutoRefusalBytes(path,bytes)))),read);
}
