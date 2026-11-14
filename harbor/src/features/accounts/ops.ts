import type { Client, SecretInfo } from '../../proto/client';
import { ACCT_MAX, buildAccount, type AcctInput } from './logic';

export const isAcct = (s: SecretInfo) => s.name.startsWith('acct.');

export async function listAccounts(c: Pick<Client, 'secretList'>): Promise<SecretInfo[]> {
  return (await c.secretList()).filter(isAcct);
}

export async function addAccount(c: Pick<Client, 'secretList' | 'secretSet'>, i: AcctInput): Promise<string> {
  const b = buildAccount(i);
  if (!b.ok) throw new Error(b.error);
  const have = await listAccounts(c);
  if (have.length >= ACCT_MAX && !have.some((s) => s.name === b.key)) throw new Error(`The device keeps at most ${ACCT_MAX} connections. Remove one first.`);
  await c.secretSet(b.key, b.value);
  return b.key;
}
