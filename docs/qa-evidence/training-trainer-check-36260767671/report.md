# Staging check: can a tester select a Dog Training trainer?

- Origin: https://pawspace-staging.karthik-fce.workers.dev
- Started: Sat, 26 Sept 2026, 23:30 IST
- Read-only: nothing is reserved, paid or changed. Times are IST.
- Test customer: 8445633838 (new, sandbox OTP) · address 560038 Indiranagar · 1 vaccinated dog

## 1. The reported case on /v2/training

Basic Obedience Plan · 1 dog · first session 12 Oct 2026, 10:00 IST · every 4 days

**Result: 3 trainer(s) offered: PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT).** "Reserve trainer & continue to payment" is enabled with PawSpace Training Team 2 (UAT) selected (availability preview HTTP 200).

Calendar shown:
- Session 1: 12 Oct, 10:00 am IST → 11:00 am IST
- Session 2: 16 Oct, 10:00 am IST → 11:00 am IST
- Session 3: 20 Oct, 10:00 am IST → 11:00 am IST
- Session 4: 24 Oct, 10:00 am IST → 11:00 am IST
- Session 5: 28 Oct, 10:00 am IST → 11:00 am IST
- Session 6: 1 Nov, 10:00 am IST → 11:00 am IST
- Session 7: 5 Nov, 10:00 am IST → 11:00 am IST
- Session 8: 9 Nov, 10:00 am IST → 11:00 am IST

Calls the page made (quote, roster, availability):
- GET /api/training-commercial → HTTP 200 [server-timing: app;dur=5331, d1;dur=4829;desc="14 calls", q2;dur=442;desc="063becbc", q9;dur=431;desc="db983b60", q10;dur=393;desc="db983b60", q3;dur=377;desc="1c181ae8", q4;d] in 5.4 s
- GET /api/training-trainers → HTTP 200 [server-timing: app;dur=3707, d1;dur=4373;desc="11 calls", q4;dur=780;desc="19e89d4a", q6;dur=433;desc="b76630bd", q5;dur=422;desc="d0221915", q8;dur=409;desc="3a615e5f", q10;d] in 3.7 s
- POST /api/training-commercial → HTTP 201 [server-timing: app;dur=8749, d1;dur=7894;desc="20 calls", q3;dur=742;desc="063becbc", q12;dur=659;desc="db983b60", q14;dur=470;desc="14873d51", q8;dur=460;desc="db983b60", q11] in 8.8 s
- POST /api/uat-scheduling → failed (net::ERR_ABORTED) in 4.9 s
- GET /api/training-trainers → HTTP 200 [server-timing: app;dur=1317, d1;dur=1811;desc="5 calls", q2;dur=624;desc="19e89d4a", q5;dur=454;desc="e9c26d9e", q4;dur=255;desc="afedaa52", q1;dur=239;desc="6297a7ad", q3;dur] in 1.3 s
- GET /api/training-trainers → HTTP 200 [server-timing: app;dur=1365, d1;dur=2897;desc="5 calls", q4;dur=817;desc="e9c26d9e", q5;dur=817;desc="afedaa52", q3;dur=716;desc="d0221915", q2;dur=293;desc="19e89d4a", q1;dur] in 1.4 s
- GET /api/training-trainers → HTTP 200 [server-timing: app;dur=1381, d1;dur=2967;desc="5 calls", q5;dur=806;desc="d0221915", q3;dur=793;desc="e9c26d9e", q4;dur=793;desc="afedaa52", q2;dur=319;desc="19e89d4a", q1;dur] in 1.4 s
- POST /api/training-commercial → HTTP 201 [server-timing: app;dur=5661, d1;dur=5306;desc="17 calls", q17;dur=416;desc="70e8edc0", q3;dur=378;desc="063becbc", q2;dur=349;desc="410e4a8e", q9;dur=346;desc="db983b60", q16;] in 5.7 s
- POST /api/training-commercial → HTTP 201 [server-timing: app;dur=5728, d1;dur=5235;desc="17 calls", q6;dur=437;desc="db983b60", q17;dur=431;desc="70e8edc0", q3;dur=374;desc="063becbc", q16;dur=353;desc="44516673", q9;] in 5.7 s
- POST /api/training-commercial → HTTP 201 [server-timing: app;dur=5753, d1;dur=5252;desc="17 calls", q17;dur=460;desc="70e8edc0", q6;dur=420;desc="db983b60", q3;dur=356;desc="063becbc", q16;dur=356;desc="44516673", q9;] in 5.8 s
- POST /api/uat-scheduling → HTTP 200 [server-timing: pre;dur=733, auth;dur=297, addr;dur=956, setup;dur=605, providers;dur=1604, eval;dur=438, d1;dur=9376;desc="n=24 seq=11 srv=37.5ms", total;dur=4874, cfExtPri] in 4.9 s

Screenshots: shots/01-v2-training-reported-case.jpg, shots/02-v2-training-reported-case-full.jpg

## 2. Availability preview matrix (East Bengaluru, 1 dog)

**50 of 50 programmes had at least one trainer; 50 of 50 offered a PawSpace Training Team seat.**

| Plan | First session (IST) | Every | Sessions | Trainers offered | Note |
|---|---|---|---|---|---|
| Basic Obedience Plan | 2026-09-28 10:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-28 10:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-28 11:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-28 11:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-28 15:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-28 15:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-29 10:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-29 10:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-29 11:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-29 11:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-29 15:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-29 15:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-30 10:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-30 10:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-30 11:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-30 11:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-30 15:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-09-30 15:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-01 10:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-01 10:00 | 7 days | 8 | Arjun T. (UAT East), PawSpace Training Team (UAT), PawSpace Training Team 2 (UAT) |  |
| Basic Obedience Plan | 2026-10-01 11:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-01 11:00 | 7 days | 8 | Arjun T. (UAT East), PawSpace Training Team (UAT), PawSpace Training Team 2 (UAT) |  |
| Basic Obedience Plan | 2026-10-01 15:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-01 15:00 | 7 days | 8 | Arjun T. (UAT East), PawSpace Training Team (UAT), PawSpace Training Team 2 (UAT) |  |
| Basic Obedience Plan | 2026-10-03 10:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-03 10:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-03 11:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-03 11:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-03 15:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-03 15:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-06 10:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-06 10:00 | 7 days | 8 | Arjun T. (UAT East), PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT) |  |
| Basic Obedience Plan | 2026-10-06 11:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-06 11:00 | 7 days | 8 | Arjun T. (UAT East), PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT) |  |
| Basic Obedience Plan | 2026-10-06 15:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-06 15:00 | 7 days | 8 | Arjun T. (UAT East), PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT) |  |
| Basic Obedience Plan | 2026-10-10 10:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-10 10:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-10 11:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-10 11:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-10 15:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-10 15:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-12 10:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-12 10:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-12 11:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-12 11:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-12 15:00 | 4 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Basic Obedience Plan | 2026-10-12 15:00 | 7 days | 8 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Pro Training Plan | 2026-09-29 10:00 | 7 days | 16 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |
| Pro Training Plan | 2026-10-12 10:00 | 7 days | 16 | PawSpace Training Team 2 (UAT), PawSpace Training Team 3 (UAT), PawSpace Training Team 4 (UAT) |  |

Finished: Sat, 26 Sept 2026, 23:35 IST
