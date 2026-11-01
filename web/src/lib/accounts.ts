import type { AccountDto, DidDto } from '../../../shared/types';

export interface DidGroup {
  /** Null while the accounts are not loaded, or for numbers of an account missing from the list. */
  account: AccountDto | null;
  dids: DidDto[];
}

/**
 * The numbers of each account, in the order of the accounts: one group per
 * account with numbers. One group of them all while `accounts` is unknown.
 */
export function groupByAccount(dids: DidDto[], accounts: AccountDto[] | null): DidGroup[] {
  if (!accounts) return [{ account: null, dids }];
  const groups: DidGroup[] = accounts.map((account) => ({ account, dids: dids.filter((d) => d.accountId === account.id) }));
  const known = new Set(accounts.map((a) => a.id));
  groups.push({ account: null, dids: dids.filter((d) => !known.has(d.accountId)) });
  return groups.filter((g) => g.dids.length > 0);
}

/**
 * The numbers a user can be given: not those VoIP.ms offers no SMS on, which
 * never have texts, unless the user has one already (so it can be taken away).
 */
export function assignableDids(dids: DidDto[], granted: ReadonlySet<string>): DidDto[] {
  return dids.filter((d) => d.smsAvailable || granted.has(d.did));
}
