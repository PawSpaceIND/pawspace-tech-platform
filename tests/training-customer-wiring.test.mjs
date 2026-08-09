import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Training customer route uses canonical commercial, trainer, scheduler and programme ledgers",async()=>{const page=await read("app/training/page.tsx");for(const token of["loadTrainingPackages","quoteTraining","loadTrainingTrainers","reserveUatSchedule","createCanonicalTrainingBooking","materializeTrainingProgramme","programme.sessions","Canonical scheduler assignment"])assert.equal(page.includes(token),true,token);assert.equal(page.includes("const challenges ="),false);assert.equal(page.includes("Meet Arjun Kumar"),false)});

test("Training customer booking consumes a server quote and records only UAT sandbox payment truth",async()=>{const client=await read("lib/training-booking-client.ts");for(const token of["/api/canonical-bookings","serviceCode:\"dog_training\"","trainingQuoteId:quote.quoteId","status:\"captured\"","Training UAT sandbox capture marker","liveMoney:false"])assert.equal(client.includes(token),true,token)});

test("Training customer programme reserves the server-governed number of sessions",async()=>{const page=await read("app/training/page.tsx");for(const token of["occurrences:quote.meetAndGreet?1:quote.sessions","cadenceDays:7","quote.minutesPerSession","quote.amountDueNow"])assert.equal(page.includes(token),true,token)});
