import type { SiteProfile } from '../contracts/index.js';
import { isAllowed } from '../security/scope.js';
import type { PolicyDecision, RequestPolicy } from './adapter.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface GuardState {
  caseMutating: boolean;
  authPhase: () => boolean;
  owned: () => Set<string>;
}

/**
 * Request policy enforced inside the adapter before any request leaves the browser.
 * Unsafe methods are allowed only for (a) the declared login submit during auth, or
 * (b) a declared mutation endpoint of a `mutating` case whose {owned} path segment is an identifier
 * owned by the CURRENT attempt in the ledger. Anything else is blocked (fail closed).
 * Target-side assumption: safe methods (GET/HEAD/OPTIONS) have no side effects.
 */
export function buildRequestPolicy(profile: SiteProfile, st: GuardState): RequestPolicy {
  return {
    check(url, method): PolicyDecision {
      const scope = isAllowed(url, profile.allowed_origins);
      if (!scope.allowed) return { allow: false, reason: 'SCOPE_DENIED', detail: scope.reason ?? 'denied' };
      const m = method.toUpperCase();
      if (SAFE.has(m)) return { allow: true };
      const u = new URL(url);
      if (profile.auth.strategy === 'form_login' && st.authPhase() && m === 'POST' && u.pathname === profile.auth.login_path) return { allow: true };
      if (st.caseMutating) {
        const segs = u.pathname.split('/');
        for (const ep of profile.mutation_endpoints) {
          if (ep.method !== m) continue;
          const tpl = ep.path.split('/');
          if (tpl.length !== segs.length) continue;
          let owned: string | undefined;
          const ok = tpl.every((t, i) => {
            if (t === '{owned}') {
              owned = decodeURIComponent(segs[i] ?? '');
              return true;
            }
            return t === segs[i];
          });
          if (ok && owned !== undefined && st.owned().has(owned)) return { allow: true };
        }
      }
      return { allow: false, reason: 'UNOWNED_MUTATION', detail: `${m} ${u.pathname} is not an authorised operation on an owned resource` };
    },
  };
}
