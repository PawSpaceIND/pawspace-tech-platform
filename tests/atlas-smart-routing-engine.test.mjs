import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks();
const {rankAtlasProviders,routeAtlasLead}=await import("../lib/intelligence/atlas-smart-routing-engine.ts");

const provider=(providerId,overrides={})=>({providerId,verticals:["grooming"],serviceZones:["blr-south"],active:true,compliant:true,available:true,currentLoad:1,maxLoad:5,distanceKm:3,skillScore:.9,qualityScore:.9,acceptanceRate:.9,recentCancellationRate:.05,...overrides});

test("provider routing rejects unsafe candidates before scoring",()=>{const result=rankAtlasProviders({vertical:"grooming",zone:"blr-south",candidates:[provider("ok"),provider("noncompliant",{compliant:false,skillScore:1,qualityScore:1}),provider("full",{currentLoad:5,maxLoad:5})]});assert.equal(result.recommendedProviderId,"ok");assert.deepEqual(result.rejected.map(item=>item.providerId).sort(),["full","noncompliant"]);assert.equal(result.explainable,true);});

test("provider routing prefers the stronger eligible operational fit",()=>{const result=rankAtlasProviders({vertical:"grooming",zone:"blr-south",candidates:[provider("near-quality",{distanceKm:1,qualityScore:.97}),provider("far-weaker",{distanceKm:20,qualityScore:.7,skillScore:.75,acceptanceRate:.7})]});assert.equal(result.ranked[0].providerId,"near-quality");assert.ok(result.ranked[0].score>result.ranked[1].score);assert.ok(result.ranked[0].reasons.some(item=>item.startsWith("quality:")));});

test("provider routing supports non-grooming verticals without hardcoded provider types",()=>{const result=rankAtlasProviders({vertical:"pet_taxi",zone:"blr-east",candidates:[provider("taxi",{verticals:["pet_taxi"],serviceZones:["blr-east"]})]});assert.equal(result.recommendedProviderId,"taxi");});

test("lead routing combines intent urgency contactability and recency",()=>{const result=routeAtlasLead({lead:{leadId:"L1",serviceVertical:"training",zone:"blr-central",intentScore:.9,urgencyScore:.8,contactabilityScore:.75,ageMinutes:10},owners:[{ownerId:"A",active:true,serviceVerticals:["training"],zones:["blr-central"],currentOpenLeads:2,maxOpenLeads:10,conversionRate:.7,responseSlaRate:.95},{ownerId:"B",active:true,serviceVerticals:["training"],zones:["blr-central"],currentOpenLeads:9,maxOpenLeads:10,conversionRate:.9,responseSlaRate:.9}]});assert.ok(result.leadPriority>75);assert.equal(result.recommendedOwnerId,"A");assert.equal(result.explainable,true);});

test("lead routing excludes inactive mismatched and overloaded owners",()=>{const lead={leadId:"L2",serviceVertical:"boarding",zone:"blr-west",intentScore:.8,urgencyScore:.5,contactabilityScore:.8,ageMinutes:30};const result=routeAtlasLead({lead,owners:[{ownerId:"inactive",active:false,serviceVerticals:["boarding"],zones:["blr-west"],currentOpenLeads:0,maxOpenLeads:5,conversionRate:1,responseSlaRate:1},{ownerId:"wrong-zone",active:true,serviceVerticals:["boarding"],zones:["blr-east"],currentOpenLeads:0,maxOpenLeads:5,conversionRate:1,responseSlaRate:1},{ownerId:"full",active:true,serviceVerticals:["boarding"],zones:["blr-west"],currentOpenLeads:5,maxOpenLeads:5,conversionRate:1,responseSlaRate:1}]});assert.equal(result.recommendedOwnerId,null);assert.deepEqual(result.rankedOwners,[]);});
