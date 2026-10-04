import {expect,test,type Page} from '@playwright/test';
const menu={text:'Hi! Choose a service or type your question.',inputHint:'Type a question or pick a service',choices:[{id:'grooming',label:'Grooming'},{id:'training',label:'Dog Training'},{id:'boarding',label:'Boarding'},{id:'pet_sitting',label:'Pet Sitting'},{id:'dog_walking',label:'Dog Walking'},{id:'pet_taxi',label:'Pet Taxi'},{id:'fresh_food',label:'Fresh Food'},{id:'relocation',label:'Pet Relocation'},{id:'question',label:'Ask a question'}]};
test.beforeEach(async({page,baseURL})=>{
 expect(['localhost','127.0.0.1']).toContain(new URL(baseURL!).hostname);
 await page.route('**/api/**',route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/api/identity-session')return route.fulfill({status:401,json:{error:'Synthetic signed-out state'}});
  if(url.pathname==='/api/ai-web-chat'&&route.request().method()==='POST'){
   const body=route.request().postDataJSON();
   if(body.start===true&&body.mode==='public')return route.fulfill({json:{data:{bot:menu}}});
   return route.abort('blockedbyclient');
  }
  return route.fulfill({json:{data:null}});
 });
});
async function openChat(page:Page){
 await page.goto('/v2/chat',{waitUntil:'domcontentloaded'});
 await expect(page.locator('[data-v2-chat]')).toHaveAttribute('data-identity','guest');
 await expect(page.getByRole('button',{name:'Grooming',exact:true})).toBeAttached();
 await page.evaluate(()=>document.fonts.ready);
 const consent=page.getByRole('button',{name:'Essential only',exact:true});if(await consent.isVisible())await consent.click();
 await page.evaluate(()=>{window.scrollTo({top:0,behavior:'instant'});document.querySelector('[aria-live="polite"]')?.scrollTo({top:0,behavior:'instant'});});
}
// A visually passing screen must also complete without client-side exceptions.
const pageErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];pageErrors.set(page,errors);page.on('pageerror',error=>errors.push(error.message));});
test.afterEach(async({page})=>{expect(pageErrors.get(page)||[], 'Unexpected client-side error').toEqual([]);});
const viewports=[{width:320,height:844},{width:390,height:844},{width:768,height:1024},{width:1440,height:1000}];
for(const viewport of viewports)for(const theme of ['emerald','signature','coral'])for(const mode of ['light','dark'])for(const style of ['professional','cartoon']){
 test(`chat layout ${viewport.width}/${theme}/${mode}/${style}`,async({page},info)=>{
  await page.setViewportSize(viewport);
  await page.addInitScript(({theme,mode,style})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);localStorage.setItem('pawspace.visual-style',style);},{theme,mode,style});
  await openChat(page);
  // Legacy palette and style keys remain migration metadata; the released layout is Editorial.
  for(const [key,value] of Object.entries({theme:'editorial',mode,style:'professional'}))await expect(page.locator('html')).toHaveAttribute(`data-paw-${key}`,value);
  const broken=await page.locator('[aria-label="Chat topic"]').evaluate(element=>{
   const words:string[]=[];const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node:Node|null;
   while((node=walker.nextNode()))for(const match of (node.textContent||'').matchAll(/[A-Za-z]+/g)){
    const range=document.createRange();range.setStart(node,match.index!);range.setEnd(node,match.index!+match[0].length);
    if(new Set(Array.from(range.getClientRects()).filter(r=>r.width>0).map(r=>Math.round(r.top))).size>1)words.push(match[0]);
   }return words;
  });
  expect.soft(broken,'UI-24: navigation must wrap between words, not within words').toEqual([]);
  const placeholder=await page.locator('#v2-chat-message').evaluate((input:HTMLTextAreaElement)=>{
   const css=getComputedStyle(input),probe=document.createElement('div');
   Object.assign(probe.style,{position:'absolute',visibility:'hidden',width:`${input.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight)}px`,font:css.font,lineHeight:css.lineHeight,letterSpacing:css.letterSpacing,whiteSpace:'pre-wrap',overflowWrap:css.overflowWrap,wordBreak:css.wordBreak,padding:'0',border:'0'});
   probe.textContent=input.placeholder;document.body.appendChild(probe);const required=probe.getBoundingClientRect().height;probe.remove();
   return {required,available:input.clientHeight-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom)};
  });
  expect.soft(placeholder.available,'UI-25: the entire placeholder must fit').toBeGreaterThanOrEqual(placeholder.required-1);
  const pane=page.getByRole('region',{name:'Conversation with PawSpace'}),footer=page.locator('.legal-footer'),dock=page.getByRole('navigation',{name:'PawSpace V2 navigation'});
  const gap=await footer.evaluate(e=>e.getBoundingClientRect().top-document.querySelector('[aria-label="Conversation with PawSpace"]')!.getBoundingClientRect().bottom);
  expect.soft(gap,'UI-26: footer immediately follows the chat surface').toBeGreaterThanOrEqual(0);
  expect.soft(gap,'UI-26: remove duplicate spacer below chat').toBeLessThanOrEqual(32);
  expect.soft((await pane.boundingBox())!.y+(await pane.boundingBox())!.height).toBeLessThanOrEqual((await dock.boundingBox())!.y);
  expect.soft(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width+2);
  await page.screenshot({path:info.outputPath('chat-top.png')});
  const options=page.getByRole('group',{name:'Choose an option'});
  for(const label of ['Grooming','Ask a question']){const choice=options.getByRole('button',{name:label,exact:true});await choice.scrollIntoViewIfNeeded();await expect(choice).toBeVisible();}
  await page.evaluate(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));
  const appearance=page.getByRole('button',{name:'Change PawSpace appearance',exact:true});
  for(const link of await footer.getByRole('link').all())expect.soft((await link.boundingBox())!.y+(await link.boundingBox())!.height).toBeLessThanOrEqual((await dock.boundingBox())!.y);
  expect.soft((await appearance.boundingBox())!.y+(await appearance.boundingBox())!.height).toBeLessThanOrEqual((await dock.boundingBox())!.y);
  expect.soft((await appearance.boundingBox())!.x,'Appearance is aligned with the right page margin').toBeGreaterThanOrEqual(viewport.width-(await appearance.boundingBox())!.width-32);
  await page.screenshot({path:info.outputPath('chat-footer.png')});
  await appearance.click();await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Done',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
 });
}

for(const viewport of viewports){
 test(`chat busy error retry and guest navigation ${viewport.width}`,async({page},info)=>{
  await page.setViewportSize(viewport);await openChat(page);
  let release:()=>void=()=>{};const paused=new Promise<void>(resolve=>{release=resolve;});let attempts=0;const bodies:Array<Record<string,unknown>>=[];
  await page.route('**/api/ai-web-chat',async route=>{
   if(route.request().method()!=='POST')return route.abort('blockedbyclient');
   const body=route.request().postDataJSON();bodies.push(body);attempts++;
   if(attempts===1){await paused;return route.fulfill({status:503,json:{error:'Synthetic temporary error'}});}
   return route.fulfill({json:{data:{bot:{text:'Synthetic reply received.',choices:[],inputHint:'Type your next question'}}}});
  });
  const input=page.getByRole('textbox',{name:'Your message'}),send=page.getByRole('button',{name:'Send',exact:true});
  await expect(send).toBeDisabled();await input.fill('  Visual audit question\nsecond line  ');await send.click();
  try{
   await expect(input).toBeDisabled();await expect(send).toBeDisabled();
   await expect(page.getByRole('button',{name:'My PawSpace',exact:true})).toBeDisabled();
   await expect(page.getByRole('status',{name:'PawSpace is typing'})).toBeVisible();
   await page.screenshot({path:info.outputPath('busy.png')});
  }finally{release();}
  await expect(page.getByRole('alert')).toHaveText('Synthetic temporary error');await expect(input).toBeEnabled();
  await page.screenshot({path:info.outputPath('error.png')});await send.click();
  await expect(page.getByText('Synthetic reply received.',{exact:true})).toBeVisible();await expect(input).toHaveValue('');
  expect(bodies).toHaveLength(2);for(const body of bodies)expect(body.message).toBe('Visual audit question\nsecond line');
  await page.getByRole('button',{name:'My PawSpace',exact:true}).click();
  await expect(page.getByText('Sign in from the V2 home to discuss bookings and account details.',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Open V2 home',exact:true})).toHaveAttribute('href','/v2');
  await page.screenshot({path:info.outputPath('guest-account.png')});
 });
}

for(const viewport of viewports){
 test(`authenticated chat display and internal payment reference ${viewport.width}`,async({page},info)=>{
  await page.setViewportSize(viewport);
  await page.route('**/api/identity-session',route=>route.fulfill({json:{data:{subjectType:'customer'}}}));
  const transcript={threadId:'UI-THREAD',handoff:{active:true,status:'staff_active'},messages:[{id:'UI-TEAM',role:'team',text:'Synthetic booking reference: /v2/booking?bookingId=UI-BOOKING-1',author:'PawSpace team',createdAt:Date.UTC(2026,8,29)}]};
  await page.route('**/api/ai-web-chat**',route=>{
   const request=route.request();const body=request.method()==='POST'?request.postDataJSON():null;
   if(request.method()==='GET'||body?.mode==='authenticated')return route.fulfill({json:{data:request.method()==='GET'?transcript:{transcript}}});
   if(body?.start)return route.fulfill({json:{data:{bot:menu}}});
   return route.abort('blockedbyclient');
  });
  await page.goto('/v2/chat',{waitUntil:'domcontentloaded'});
  await expect(page.locator('[data-v2-chat]')).toHaveAttribute('data-identity','customer');
  const consent=page.getByRole('button',{name:'Essential only',exact:true});if(await consent.isVisible())await consent.click();
  await page.getByRole('button',{name:'My PawSpace',exact:true}).click();
  await expect(page.getByRole('link',{name:'Pay now',exact:true})).toHaveAttribute('href','/v2/booking?bookingId=UI-BOOKING-1');
  await expect(page.getByText('Chat is now with the PawSpace team',{exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Your message'})).toHaveAttribute('placeholder','Message the PawSpace team');
  await expect(page.getByRole('textbox',{name:'Your message'})).toHaveAttribute('maxlength','4000');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width+2);
  await page.screenshot({path:info.outputPath('account-chat.png')});
 });
}

for(const viewport of [{width:320,height:460},{width:390,height:460},{width:844,height:390}]){
 test(`chat compact viewport ${viewport.width}x${viewport.height}`,async({page},info)=>{
  await page.setViewportSize({width:viewport.width,height:844});await openChat(page);
  await page.setViewportSize(viewport);
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  const input=page.getByRole('textbox',{name:'Your message'}),dock=page.getByRole('navigation',{name:'PawSpace V2 navigation'});
  await input.fill('Visible input');const bounds=(await input.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);expect(bounds.y+bounds.height).toBeLessThanOrEqual((await dock.boundingBox())!.y);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width+2);
  await page.screenshot({path:info.outputPath('compact.png')});
 });
}
