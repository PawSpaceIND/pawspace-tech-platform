import { test, expect } from '@playwright/test';
test('wallet keeps actual savings zero, exposes expiry and loads older owner history',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const entry={id:'earned-new',serviceCode:'taxi',source_kind:'booking',source_id:'taxi-old',entry_type:'earned',coins:100,created_at:1700000000000};
 await page.route('**/api/v2/test-coins**',route=>{
  const older=new URL(route.request().url()).searchParams.has('historyCursor');
  return route.fulfill({contentType:'application/json',body:JSON.stringify({data:{customerId:"fixture-owner",policy:{enabled:true},spendableCoins:80,grantBalanceAdjustment:0,reversalDebt:0,expiredCoins:10,expiryPendingCoins:5,expiryConfigurationRequired:true,history:[older?{...entry,id:'refund-old',entry_type:'earn_reversal',coins:-10}:entry],nextHistoryCursor:older?null:'earned-new',grants:[{grant_id:'active-grant',source_kind:'booking',source_id:'training-old',remaining:80,expires_at:Date.now()+3600000},{grant_id:'old-grant',source_kind:'booking',source_id:'taxi-old',remaining:10,expires_at:1700000000000}],walletSummary:{lifetimeCoinsEarned:1050,lifetimeCoinsRedeemed:20,lifetimeEarningsReversed:10,lifetimeRedemptionsRestored:0,lifetimeNetSimulatedSavings:20,lifetimeActualRupeesSaved:0,pendingEarnedCoins:0}}})});
 });
 await page.goto('/v2/test-coin-wallet');
 await expect(page.getByRole('heading',{name:'TEST coin wallet'})).toBeVisible();
 await expect(page.getByText('Actual savings are zero because TEST redemptions never reduce a real payment.',{exact:false})).toBeVisible();
 await expect(page.getByText('New grants are unavailable until an expiry duration is configured.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Load older history'}).click();
 await expect(page.getByText('earn reversal',{exact:false})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);expect(errors).toEqual([]);
 await page.screenshot({path:`../receipts/coin-wallet-${info.project.name}.png`,fullPage:true});
});
