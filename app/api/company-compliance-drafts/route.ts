import { authorize, authError } from '../../../lib/server-auth';
import { draftHandlers } from '../../../lib/company-compliance/http';
const handlers = draftHandlers({
  authorize,
  authError: error => authError(error, 'Company compliance access denied'),
  context: async () => {
    const { env } = await import('cloudflare:workers');
    const flag = (env as unknown as Record<string, unknown>).COMPANY_COMPLIANCE_DRAFTS_ENABLED;
    return { db: env.DB, enabled: flag === 'true' };
  },
});
export const GET = handlers.GET;
export const POST = handlers.POST;
