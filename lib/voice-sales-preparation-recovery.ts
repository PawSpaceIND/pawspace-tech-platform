/** Speech copy only: this does not relax saved-address ownership or geocode checks. */
export function voiceSalesPreparationFailureReply(status:number,detail:string):string {
 if(status===409&&/^Address (?:geocode )?identity conflict; select your saved address$/.test(detail.trim()))
  return "I need to verify the matching saved address before preparing this quote. Please select the correct saved address in the PawSpace app, or ask our team to verify it. No booking has been created.";
 return `I couldn't prepare that booking yet: ${detail.slice(0,200)}. Could you check this and tell me again?`;
}
