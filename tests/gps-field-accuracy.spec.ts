import { expect, test, type APIRequestContext } from '@playwright/test';

const baseURL = (process.env.GPS_UAT_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const bookingId = process.env.GPS_UAT_BOOKING_ID || '';
const providerId = process.env.GPS_UAT_PROVIDER_ID || '';
const providerCookie = process.env.GPS_UAT_PROVIDER_COOKIE || '';
const actorEmail = process.env.GPS_UAT_ACTOR_EMAIL || '';
const freshnessSeconds = Number(process.env.GPS_UAT_FRESHNESS_SECONDS || '300');
const allowedAccuracyMeters = Number(process.env.GPS_UAT_ALLOWED_ACCURACY_METERS || '75');

function headers() {
  return {
    'content-type': 'application/json',
    ...(providerCookie ? { cookie: providerCookie } : {}),
    ...(actorEmail ? { 'oai-authenticated-user-email': actorEmail } : {}),
  };
}

async function action(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post(`${baseURL}/api/location-recovery`, { headers: headers(), data: body });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  return payload.data as Record<string, unknown>;
}

async function emit(request: APIRequestContext, sessionId: string, input: { accuracyMeters?: number; clientCapturedAt: number; latitude?: number; longitude?: number }) {
  return action(request, {
    action: 'record_location',
    sessionId,
    providerId,
    latitude: input.latitude ?? 12.9121,
    longitude: input.longitude ?? 77.6446,
    ...(input.accuracyMeters === undefined ? {} : { accuracyMeters: input.accuracyMeters }),
    clientCapturedAt: input.clientCapturedAt,
  });
}

test.describe('GPS field accuracy and freshness trust rules', () => {
  test.skip(!bookingId || !providerId || (!providerCookie && !actorEmail), 'Set GPS_UAT_BOOKING_ID, GPS_UAT_PROVIDER_ID and provider auth before field UAT.');

  test('fresh accurate partner-device coordinate is accepted', async ({ request }) => {
    const session = await action(request, { action: 'start_session', bookingId, providerId });
    const point = await emit(request, String(session.id), {
      accuracyMeters: Math.max(1, Math.min(allowedAccuracyMeters, 15)),
      clientCapturedAt: Date.now(),
    });
    expect(point.trustState).toBe('accepted');
    expect(Number(point.accuracyMeters)).toBeLessThanOrEqual(allowedAccuracyMeters);
  });

  test('stale mobile coordinate cannot be trusted', async ({ request }) => {
    const session = await action(request, { action: 'start_session', bookingId, providerId });
    const point = await emit(request, String(session.id), {
      accuracyMeters: 10,
      clientCapturedAt: Date.now() - (freshnessSeconds + 5) * 1000,
    });
    expect(point.trustState).toBe('stale');
  });

  test('future-skewed mobile clock is also stale', async ({ request }) => {
    const session = await action(request, { action: 'start_session', bookingId, providerId });
    const point = await emit(request, String(session.id), {
      accuracyMeters: 10,
      clientCapturedAt: Date.now() + (freshnessSeconds + 5) * 1000,
    });
    expect(point.trustState).toBe('stale');
  });

  test('poor or missing accuracy is rejected as low_accuracy', async ({ request }) => {
    const session = await action(request, { action: 'start_session', bookingId, providerId });
    const poor = await emit(request, String(session.id), {
      accuracyMeters: allowedAccuracyMeters + 25,
      clientCapturedAt: Date.now(),
    });
    expect(poor.trustState).toBe('low_accuracy');

    // The route converts an omitted accuracy to NaN; the location boundary must
    // fail closed rather than treating unknown accuracy as zero/acceptable.
    const missing = await emit(request, String(session.id), { clientCapturedAt: Date.now() });
    expect(missing.trustState).toBe('low_accuracy');
    expect(Number(missing.accuracyMeters)).toBeGreaterThan(allowedAccuracyMeters);
  });

  test('invalid coordinates fail before evidence is accepted', async ({ request }) => {
    const session = await action(request, { action: 'start_session', bookingId, providerId });
    const response = await request.post(`${baseURL}/api/location-recovery`, {
      headers: headers(),
      data: {
        action: 'record_location',
        sessionId: String(session.id),
        providerId,
        latitude: 190,
        longitude: 77.6446,
        accuracyMeters: 10,
        clientCapturedAt: Date.now(),
      },
    });
    expect(response.ok()).toBeFalsy();
  });
});
