/**
 * The phone's Model: the Codex session and client bound into agent/model.ts. The only agent file
 * that loads expo-*, through codex/session.ts, so jest can load the rest of src/agent and src/jobs.
 */

import { runTurn } from '../codex/responses';
import { credentials } from '../codex/session';
import { codexModel, type Model } from './model';

export const phoneModel: Model = codexModel({
  credentials: (opts) => credentials(fetch, opts),
  runTurn: (creds, req) => runTurn(fetch, creds, req),
  setTimer: (ms, fire) => {
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  },
});
