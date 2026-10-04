# Staff inbox integration evidence

Accepted application source9f614bb17feeec4ace1ba51d3dc79a1eeacfe90e on d9a91e94. Independent queue-race review47/47 passes. No source behavior change in publisher composition.

Six existing changed source files have exact reviewed-after to base-before restoration. The new receipt is a reversible accepted delta, not a historical pin refresh. Hash equality, unique replacement and final exact hash are required; unknown bytes, append/first-byte/truncation/CRLF mutations refuse. Historical inbox AST/binding/style/source assertions are evaluated after restoration; actual new behavior is separately exercised by unchanged staff contract/race tests. Existing fixture files are unchanged.

Publisher composition128/128 tests pass across inbox/customer/partner/display consumers and actual SQLite queue controls. Full TypeScript and corrected compiled Worker build/artifact validation passed. Dedicated browser CI selects existing staff-inbox spec without changing assertions/timeouts; actual-route readiness avoids initial cold-module page-load timeout. Three original browser cases pass at1440/390 and access loss.

Authenticated compiled local sandbox UAT: preview superuser disabled; anonymous conversations401; normal Founder staging sign-in with real signed Secure cookie on loopback HTTPS; no API interception. Real browser→compiled Worker/gateway→disposable D1 persists views/read/favourite through reload and queues exact en_US synthetic utility template through sandbox_simulator, externalDelivery:false. This is local sandbox acceptance, not hosted delivery or customer end-to-end proof. Only self-signed localhost certificate validation is accepted by this local browser. No provider dispatch, live messages/campaigns, production or shared staging writes. Servers stopped after proof.

CI and independent review of this new publisher composition remain release gates. No merge/deployment from this evidence; old compiled archive remains held. PR1267/1271/1272/address work untouched.
