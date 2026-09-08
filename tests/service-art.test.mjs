import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import { SERVICE_ART } from '../app/mobile-app/service-art.ts';

test('every service illustration is a local asset with meaningful alternative text',()=>{
  assert.equal(Object.keys(SERVICE_ART).length,8);
  for(const art of Object.values(SERVICE_ART)){
    assert.ok(existsSync(new URL('../public'+art.image,import.meta.url)),art.image);
    assert.ok(art.alt.length>20);
    assert.equal(art.illustrated,true);
    assert.match(art.alt,/AI illustration/);
    assert.match(art.image,/-cartoon\.webp$/);
  }
});
test('cartoon discovery retains real identities and prevents photographic gallery fallbacks',()=>{
  const home=readFileSync(new URL('../app/mobile-app/premium-discovery-home.tsx',import.meta.url),'utf8');
  assert.match(home,/src=\{pet.profile.photo\}/);
  assert.match(home,/src=\{SERVICE_ART.dog_training.image\}/);
  assert.doesNotMatch(home,/src="\/assets\/pawspace-home.png"/);
  const banner=readFileSync(new URL('../app/mobile-app/service-banner.tsx',import.meta.url),'utf8');
  assert.match(banner,/!serviceArt\?\.illustrated && media/);
  assert.match(banner,/const mainVisual = serviceArt \?\?/);
  assert.match(banner,/poster=\{serviceArt\?\.image \?\? media.videoPoster\}/);
});
test('home and service headers share art without changing provider identity',()=>{
  for(const file of ['premium-discovery-home.tsx','service-hero.tsx','service-banner.tsx']){
    const source=readFileSync(new URL('../app/mobile-app/'+file,import.meta.url),'utf8');
    assert.match(source,/SERVICE_ART/);
  }
  const art=readFileSync(new URL('../app/mobile-app/service-art.ts',import.meta.url),'utf8');
  assert.doesNotMatch(art,/providerId|customerId|price:|rating:/);
  const banner=readFileSync(new URL('../app/mobile-app/service-banner.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(banner,/4\.9 ★/);
});
