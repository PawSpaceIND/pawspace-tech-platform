# PawSpace staging — Dog Training master E2E

- Origin: https://pawspace-staging.karthik-fce.workers.dev
- Run: 2026-09-26T07:40:18.723Z
- Customers: Master A 8408323854

| # | Area | Step | Result | Detail | Evidence |
|---|---|---|---|---|---|
| 1 | Customer | Customer A: sandbox OTP sign-in + address (560038) + 3 dogs + 1 cat | PASS | 8408323854 · address 201, Bruno 201, Coco 201, Max 201, Whiskers 201 | shots/001-customer-a-account.jpg |
| 2 | Maps | Google Places autocomplete, place resolve, reverse geocode | PASS | 1 suggestion(s); first="42, Indiranagar Double Road, Doopanahalli, Domlur, Bengaluru, Karnataka, India"; resolve=configured 12.9689746,77.6360876; reverse(Koramangala)=configured "002, KHB Colony, 4th Block, Koramangala, Bengaluru, Karnataka 560095, India" |  |
| 3 | Maps | Service zone by PIN (serviceable and not) | PASS | 560038=200:blr-east · 560068=200:blr-south · 560001=200:blr-central · 560102=200:blr-south · 110001=404:Zone not found for this pincode · 12345=400:Invalid pincode |  |

## API errors observed (4xx/5xx)

- customer:Master A 401 GET /api/mobile-employee-ai 
- customer:Master A 404 GET /api/service-zone {"error":"Zone not found for this pincode"}
