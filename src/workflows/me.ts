import { saveAccount } from '../core/config.js';
import type { Scour } from '../core/pipeline.js';

/**
 * Save (or forget) your X account and check it right away: reading it once
 * confirms the handle exists and teaches scour the account's id, which later
 * reads use (that route has its own, rarely used allowance). A link to any of
 * your posts works too, and never hits the timeline allowance at all.
 */
export async function addMyAccount(scour: Scour, input: string, remove = false): Promise<{ ok: boolean; message: string; accounts: string[] }> {
  let handle = input.trim().replace(/^@/, '');
  let checked: string | undefined;
  const link = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(\w{1,15})(?:\/status\/(\d+))?/i.exec(handle);
  if (link) {
    handle = link[1]!;
    if (link[2] && !remove) {
      const d = await scour.get(`https://x.com/${handle}/status/${link[2]}`).catch(() => null);
      if (d?.author?.handle) {
        handle = d.author.handle;
        checked = `Found @${handle} from that post.`;
      }
    }
  }
  if (!/^\w{1,15}$/.test(handle)) return { ok: false, message: `"${input}" is not an X handle or post link.`, accounts: scour.config.accounts?.x ?? [] };

  const accounts = await saveAccount('x', handle, remove);
  scour.config.accounts = { ...(scour.config.accounts ?? {}), x: accounts }; // effective in this process now
  if (remove) return { ok: true, message: `Forgot @${handle}.`, accounts };

  if (!checked) {
    try {
      const d = await scour.get(`https://x.com/${handle}`, { noCache: true });
      const posts = Number(d.extra?.posts ?? 0);
      checked = `Checked @${d.author?.handle ?? handle}: ${posts} recent ${posts === 1 ? 'post' : 'posts'} readable.`;
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0]!;
      checked = /rate-limited/.test(msg)
        ? `Couldn't check @${handle} right now (${msg.replace(/^.*?(rate-limited[^.]*).*$/, '$1')}). It will be read on your next search; ` +
          'or run this again with a link to any of your posts to set it up without waiting.'
        : `Saved, but @${handle} could not be read: ${msg}`;
    }
  }
  return { ok: true, message: `Saved @${handle}. X searches now include your latest posts that match. ${checked}`, accounts };
}
