# Staff report truth and recovery

A missing daily sales calculation previously disappeared from the manager dashboard's seven-day sum. That made a partial total look complete. The weekly value is now unavailable if any of its seven daily calculations is unavailable; successful empty reads still produce zero. Other successfully calculated periods remain visible, with an explicit list of unavailable metrics.

People reports now have separate loading and failure screens, with a retry action, so an unsuccessful request does not display zero employees or fabricated permission outcomes. The manager dashboard rejects unsuccessful HTTP responses and incomplete top-level responses. Finance clears old data before refreshing and hides figures after an unsuccessful refresh. All three use a shared fifteen-second request/body deadline and readable malformed-response errors. Finance cards and actions wrap on narrow screens; manager tables scroll within their sections.

## Verification

- Four SQLite execution tests reconcile daily/weekly/monthly sales to known source bookings, exclude another manager's employee and cancelled bookings, inject a daily database failure, preserve valid zero, and exercise an incomplete historical configuration window.
- Four response tests cover HTTP errors containing data, malformed bodies, invalid empty payloads, genuine zero values, and timeouts.
- The focused run including existing People scope/report tests passed 17 tests with no failures or skips.
- Full branch regression passed 4,650 tests, zero failures and zero skips, including the verified build.
- Typecheck passed; lint has zero errors and 80 existing warnings.
- Local in-app browser checks: People and manager authentication failures offer retry without showing metric values; finance failure and retry render at 390x844 with readable, wrapped controls.

These checks do not certify every report, signed-in staff browser workflows, production records, native applications, or connected AI/voice. Complete customer/partner UAT and external integrations remain open. No live money, external messages, or deployment occurred.
