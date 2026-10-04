import {preservedGroomingBackBarBytes} from './grooming-back-bar-reviewed-delta.mjs';
import {preservedChatLedgerBytes} from './chat-ledger-reviewed-delta.mjs';
import {preservedChatQualificationBytes} from './chat-qualification-reviewed-delta.mjs';
import {preservedCiRuntimeBytes} from './ci-runtime-reviewed-delta.mjs';
import {preservedGroomingAutoRefusalBytes} from './grooming-auto-refusal-reviewed-delta.mjs';
import {preservedCombinedLocalBytes,preservedServiceLintBytes} from './combined-local-reviewed-delta.mjs';
import {preservedServiceFixBytes} from './service-fix-reviewed-delta.mjs';
import {preservedReviewedFoodBytes} from './food-route-review.mjs';
// Reverse the exact reviewed customer-flow delta before existing Food/Audio guards.
export function preservedCustomerServiceBytes(path,bytes,read){
 bytes=preservedGroomingBackBarBytes(path,bytes);
 return preservedReviewedFoodBytes(path,preservedCombinedLocalBytes(path,preservedServiceFixBytes(path,preservedServiceLintBytes(path,preservedGroomingAutoRefusalBytes(path,preservedCiRuntimeBytes(path,preservedChatQualificationBytes(path,preservedChatLedgerBytes(path,bytes))))))),read);
}
