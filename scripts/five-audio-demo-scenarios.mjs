// Fixed synthetic enquiries only. No confirmation, dial, payment, or external-message instruction.
export const audioDemoScenarios=[
 {id:1,title:'Grooming package selection and home visit',agent:'grooming',questions:[
  'This is an enquiry only. Explain the grooming packages for my dog Bruno and how they differ.',
  'Which grooming package includes a full haircut, and how is that different from a bath with basic grooming?',
  'For home grooming, what should I provide and what equipment does your groomer bring?',
  'How long should I allow for grooming, and can you guarantee an exact finishing time?'
 ]},
 {id:2,title:'Grooming pricing, offers and payment boundaries',agent:'grooming',questions:[
  'Do not create a booking. Explain the current Essential Bath price for one adult dog and what can change the final amount.',
  'Does the grooming amount include taxes? Could travel, coat condition, or add ons change it?',
  'Are there genuine current discounts or multi session grooming plans? Please explain eligibility rather than promising an offer.',
  'I am not confirming a service. Explain online payment and paying after grooming. Do not create a payment link.'
 ]},
 {id:3,title:'Puppy training programme and realistic expectations',agent:'training',questions:[
  'This is an enquiry only. My puppy pulls on walks and jumps on visitors. Explain your dog training programme and how it is delivered.',
  'I am comparing options, not enrolling. What is included in the training package, and how are sessions scheduled?',
  'Can you guarantee my puppy will be perfectly trained after the course? What practice is expected from me?',
  'Do not book anything. Do you offer weekend socialisation or support between training sessions?'
 ]},
 {id:4,title:'Availability enquiries, rescheduling and refunds',agent:'grooming',questions:[
  'This is an enquiry only. I live in Indiranagar, Bengaluru. What do you need to check home grooming availability at my address?',
  'Do not reserve a slot. Bruno is an adult dog and I prefer mornings. What details do you need before showing a final grooming quote?',
  'Do not change any booking. If I later need to reschedule grooming, what process and charges apply?',
  'Do not issue a refund. If I cancel later or the groomer does not arrive, how is a refund reviewed?'
 ]},
 {id:5,title:'Nervous pet safety, complaint handling and staff escalation',agent:'grooming',questions:[
  'Bruno gets nervous during grooming. What should I tell the groomer beforehand, and how do you handle a nervous dog safely?',
  'Would you use sedation or force to finish grooming? I only want a safe service and no medical advice.',
  'If grooming causes a concern, how do I raise a complaint and how will your team follow it up?',
  'Please hand this conversation to a human grooming coordinator. Do not call my number or send any message.'
 ],expectedHandoffAt:4}
];
