import { test, expect, type Page } from '@playwright/test';

// Actual application components; network fixtures never reserve, contact, or pay anyone.
const account = {customerId:'UI-UAT-C1',name:'UI Test',primaryPhone:'9000000001',pets:[{id:'UI-UAT-P1',name:'Test Pet',species:'dog',breed:'Labrador',vaccinationStatus:'verified'}],addresses:[{id:'UI-UAT-A1',line1:'Test Street',city:'Bengaluru',postalCode:'560068',isDefault:true}],bookings:[]};
async function fixture(page: Page, signedIn = false) {
  const writes: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const data = (value: unknown) => route.fulfill({json:{data:value}});
    if(path === '/api/identity-session') return signedIn ? data({subjectType:'customer',subjectId:account.customerId}) : route.fulfill({status:401,json:{error:'Signed out'}});
    if(path === '/api/customer-account') return signedIn ? data(account) : route.fulfill({status:401,json:{error:'Signed out'}});
    if(path === '/api/service-availability') return data(['grooming','boarding','pet_sitting'].map(code=>({code,enabled:true})));
    if(path === '/api/service-zone') return data({assignment:{pincode:'560068',cityId:'blr',city:'Bengaluru',zoneId:'blr-south',area:'BTM'},zone:{zoneId:'blr-south',zoneName:'South Bengaluru',serviceAvailable:true}});
    if(path === '/api/uat-scheduling' && request.postDataJSON()?.action === 'preview') return data({providers:[{id:'UI-UAT-SITTER',name:'Test Sitter',model:'commission'}],availabilityChecked:true,reserved:false});
    if(path === '/api/sitting-commercial' && request.method() === 'POST') { const input=request.postDataJSON(); return data({...input,quoteId:'UI-UAT-Q1',packageName:'Test Home Visit',basePricePerPet:399,extraPetPrice:0,billableUnits:1,totalAmount:399,amountDueNow:399,expiresAt:Date.now()+60000,liveMoney:false}); }
    if(path === '/api/team-overview') return data({actor:{name:'UI Founder',roleCode:'founder',permissions:['*']}});
    if(request.method() !== 'GET') writes.push(path);
    return route.fulfill({status:404,json:{error:'Outside isolated UI fixture'}});
  });
  return writes;
}
async function dismissPrivacy(page: Page) {
  const essential=page.getByRole('button',{name:'Essential only',exact:true});
  if(await essential.isVisible()) await essential.click();
}

for(const width of [390,1440]) {
  test(`sign-in focus loops, Escape restores opener, reopen resets at ${width}px`,async({page},info)=>{
    await page.setViewportSize({width,height:900}); await fixture(page); await page.goto('/v2');
    await expect(page.getByText('A home for every part of pet parenting.',{exact:true})).toBeVisible();
    await dismissPrivacy(page);
    const opener=page.getByRole('button',{name:/Sign in/}).filter({visible:true}).first();
    await opener.click();
    const dialog=page.getByRole('dialog',{name:'Sign in to PawSpace'}), phone=dialog.getByRole('textbox',{name:'Mobile number'});
    await expect(phone).toBeFocused();
    await page.screenshot({path:info.outputPath('sign-in-dialog.png'),animations:'disabled'});
    await phone.press('Tab'); await expect(dialog.getByRole('button',{name:/Continue securely/})).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button',{name:'Continue as guest',exact:true})).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button',{name:'Close',exact:true})).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button',{name:'Continue as guest',exact:true})).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button',{name:/Continue securely/})).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
    await opener.click(); await expect(phone).toBeFocused();
    await dialog.getByRole('button',{name:'Close',exact:true}).click(); await expect(opener).toBeFocused();
  });
}

test('closing an outstanding OTP request does not reopen its code step',async({page})=>{
  await fixture(page); let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  // Match the current customer OTP endpoint, without calling a real provider.
  await page.route('**/api/customer-otp',async route=>{
    if(route.request().method()==='POST') { await pending; return route.fulfill({json:{data:{challengeId:'UI-UAT-OTP',existingCustomer:true,sandboxCode:'123456'}}}); }
    return route.fulfill({status:401,json:{error:'Signed out'}});
  });
  await page.goto('/v2');
  await expect(page.getByText('A home for every part of pet parenting.',{exact:true})).toBeVisible();
  await dismissPrivacy(page);
  const opener=page.getByRole('button',{name:'Sign in',exact:true}); await opener.click();
  const dialog=page.getByRole('dialog',{name:'Sign in to PawSpace'});
  await dialog.getByRole('textbox',{name:'Mobile number'}).fill('9000000001');
  await dialog.getByRole('button',{name:/Continue securely/}).click();
  await expect(dialog.getByRole('button',{name:/Sending/})).toBeDisabled();
  await page.keyboard.press('Escape');
  const settled=page.waitForResponse(response=>response.url().endsWith('/api/customer-otp')&&response.request().method()==='POST');
  release(); await settled;
  await opener.click(); await expect(dialog.getByRole('textbox',{name:'Mobile number'})).toBeVisible();
  await expect(dialog.getByRole('textbox',{name:'Verification code'})).toHaveCount(0);
});

test('using a different number clears the old phone before requesting another OTP',async({page})=>{
  await fixture(page);
  const requestedPhones: string[]=[];
  await page.route('**/api/customer-otp',async route=>{
    requestedPhones.push(String(route.request().postDataJSON().phone));
    return route.fulfill({json:{data:{challengeId:`UI-UAT-OTP-${requestedPhones.length}`,existingCustomer:true,sandboxCode:'123456'}}});
  });
  await page.goto('/v2');
  await expect(page.getByText('3 services ready',{exact:true})).toHaveCount(1);
  await dismissPrivacy(page);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Sign in to PawSpace'});
  const phone=dialog.getByRole('textbox',{name:'Mobile number'});
  await phone.fill('9000000001');
  await expect(dialog.getByRole('button',{name:/Continue securely/})).toBeEnabled();
  await dialog.getByRole('button',{name:/Continue securely/}).click();
  await expect(dialog.getByRole('textbox',{name:'Verification code'})).toBeVisible();
  await dialog.getByRole('button',{name:/Use a different number/}).click();
  await expect(phone).toHaveValue('');
  await dialog.getByRole('button',{name:/Continue securely/}).click();
  await expect(dialog.getByText('Enter a valid 10-digit mobile number.',{exact:true})).toBeVisible();
  expect(requestedPhones).toEqual(['9000000001']);
  await phone.fill('9000000002');
  await dialog.getByRole('button',{name:/Continue securely/}).click();
  await expect(dialog.getByRole('textbox',{name:'Verification code'})).toBeVisible();
  await expect(dialog.getByText(/Enter the 6-digit code for \+91 9000000002/)).toBeVisible();
  expect(requestedPhones).toEqual(['9000000001','9000000002']);
});

test('Care Card validates in place, focuses missing input, preserves back/review details',async({page})=>{
  const writes=await fixture(page,true); await page.goto('/v2/sitting'); await dismissPrivacy(page);
  await page.getByRole('button',{name:'See available sitters',exact:true}).click();
  await page.getByRole('button',{name:'Continue with Test',exact:true}).click();
  const review=page.getByRole('button',{name:'Review protected booking',exact:true}); await review.click();
  await expect(page.getByRole('heading',{name:'Build the Care Card',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Vet contact',exact:true})).toBeFocused();
  await expect(page.getByRole('textbox',{name:'Vet contact',exact:true})).toHaveAttribute('aria-invalid','true');
  await page.getByRole('textbox',{name:'Vet contact',exact:true}).fill('   '); await review.click();
  await expect(page.getByRole('textbox',{name:'Vet contact',exact:true})).toBeFocused();
  await page.getByRole('textbox',{name:'Vet contact',exact:true}).fill('Synthetic test vet');
  await page.getByRole('textbox',{name:'Emergency contact',exact:true}).fill('Synthetic test contact'); await review.click();
  await expect(page.getByRole('textbox',{name:'Home access instructions',exact:true})).toBeFocused();
  await page.getByRole('textbox',{name:'Home access instructions',exact:true}).fill('Synthetic test access'); await review.click();
  await expect(page.getByRole('heading',{name:'Review and confirm',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'← Care plan',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Vet contact',exact:true})).toHaveValue('Synthetic test vet');
  await expect(page.getByRole('textbox',{name:'Home access instructions',exact:true})).toHaveValue('Synthetic test access');
  expect(writes.filter(path=>path==='/api/uat-scheduling'||path.includes('booking'))).toEqual([]);
});

test.describe('Ops business timezone',()=>{
  test.use({timezoneId:'America/Los_Angeles'});
  test('list and detail use explicit IST, not the browser day',async({page})=>{
    await fixture(page);
    await page.route('**/api/booking-command-center*',route=>route.fulfill({json:{bookings:[{
      id:'UI-UAT-BOOKING',customer_name:'UI Test',service_code:'pet_sitting',package_name:'Home Visit',status:'confirmed',scheduled_start:'2026-10-03T03:30:00.000Z',scheduled_end:'2026-10-03T04:30:00.000Z',
      pets:[],lifecycle:[],operations:[],notifications:[],rebooking:[],refunds:[],tickets:[],adminActions:[],
    }]}}));
    await page.goto('/team/operations/bookings');
    await expect(page.getByRole('button',{name:/UI-UAT-BOOKING 3 Oct, 9:00 am IST/})).toBeVisible();
    await expect(page.getByText(/3 Oct, 9:00 am IST/)).toHaveCount(2);
    await expect(page.getByText(/02 Oct, 8:30 pm/)).toHaveCount(0);
  });
});

for(const species of ['cat','other','pet']) {
 test(`Funeral request submits and displays selected ${species}, never default dog`,async({page})=>{
  await fixture(page,true); let submitted:Record<string,unknown>|undefined;
  await page.route('**/api/funeral-memorial*',async route=>{
    const url=new URL(route.request().url());
    if(url.searchParams.has('availability')) return route.fulfill({json:{data:[{service_type:'cremation',enabled:1}]}});
    if(route.request().method()==='POST') {
      submitted=route.request().postDataJSON();
      return route.fulfill({json:{data:{id:'UI-UAT-FUNERAL',customer_id:account.customerId,pet_name:submitted!.petName,pet_species:submitted!.petSpecies,status:'urgent_request',service_type:'cremation',memorial_option:'none',pickup_address:'Synthetic address',milestones:[]}}});
    }
    return route.fulfill({json:{data:[]}});
  });
  await page.goto('/v2/funeral-memorial');
  await expect(page.getByText('Checking service availability…',{exact:true})).toHaveCount(0);
  await dismissPrivacy(page);
  await expect(page.getByRole('combobox',{name:'Pet species',exact:true})).toHaveValue('pet');
  await page.getByRole('textbox',{name:'Pet name',exact:true}).fill('UI Test Pet');
  await page.getByRole('combobox',{name:'Pet species',exact:true}).selectOption(species);
  await page.getByRole('textbox',{name:'Pickup details',exact:true}).fill('Synthetic address');
  await page.getByRole('button',{name:'Create urgent support request',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Support request UI-UAT-FUNERAL',exact:true})).toBeVisible();
  expect(submitted?.petSpecies).toBe(species);
  await expect(page.getByText(`Pet: UI Test Pet · ${species==='pet'?'Species not specified':species}`,{exact:true})).toBeVisible();
 });
}

test('pre-completion sitting finance clarifies tax status without enabling settlement',async({page})=>{
  await fixture(page);
  await page.route('**/api/sitting-finance*',route=>route.fulfill({json:{data:{booking:{id:'UI-UAT-BOOKING',status:'confirmed',total_amount:399,captured_amount:399,payment_status:'captured'},cancellations:[],dateChanges:[],refunds:[],settlement:null,reconciliation:{status:'attention_required',refund_state:'none',settlement_state:'not_due',tax_state:'configuration_required'}}}}));
  await page.goto('/team/finance/sitting?bookingId=UI-UAT-BOOKING');
  await expect(page.getByText(/Settlement and tax reconciliation pending service completion/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Prepare canonical settlement',exact:true})).toBeDisabled();
});


test.afterEach(async ({page},info)=>{
  if(!page.isClosed()) await page.screenshot({path:info.outputPath('ui-readiness-result.png'),animations:'disabled'});
});
