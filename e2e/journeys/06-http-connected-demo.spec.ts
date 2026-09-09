import { expect, test } from "@playwright/test";
import { runGroomingDemo } from "../helpers/correlated-grooming";

test("local D1 connected demo: booking, sandbox payment, provider proof, completion and admin finance", async ({ baseURL }) => {
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const result = await runGroomingDemo(baseURL!, `${Date.now()}-http-demo`, Number(process.env.E2E_DEMO_DAY_OFFSET || (test.info().project.name === "mobile-chromium" ? 8 : 7)));
  console.log(JSON.stringify(result));
  await test.info().attach("connected-demo", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
