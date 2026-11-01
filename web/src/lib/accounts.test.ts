import { describe, expect, it } from 'vitest';
import { assignableDids, groupByAccount } from './accounts';
import type { AccountDto, DidDto } from '../../../shared/types';

const account = (id: number, label: string | null = null): AccountDto => ({
  id,
  label,
  username: `account${id}@example.com`,
  credentialsSource: 'db',
  numbers: 0,
  error: null,
});

const did = (number: string, accountId: number, smsAvailable = true): DidDto => ({ did: number, accountId, smsAvailable }) as DidDto;

describe('groupByAccount', () => {
  it('groups the numbers in the order of the accounts, keeping their own order within each', () => {
    const accounts = [account(1), account(2, 'SIGP')];
    const dids = [did('4185550142', 2), did('5145550100', 1), did('4505550199', 1), did('8195550123', 2)];
    expect(groupByAccount(dids, accounts).map((g) => [g.account?.id, g.dids.map((d) => d.did)])).toEqual([
      [1, ['5145550100', '4505550199']],
      [2, ['4185550142', '8195550123']],
    ]);
  });

  it('leaves out the accounts without numbers', () => {
    expect(groupByAccount([did('5145550100', 1)], [account(1), account(2)])).toEqual([{ account: account(1), dids: [did('5145550100', 1)] }]);
  });

  it('keeps the numbers in one group until the accounts are known', () => {
    const dids = [did('5145550100', 1), did('4185550142', 2)];
    expect(groupByAccount(dids, null)).toEqual([{ account: null, dids }]);
  });

  it('puts the numbers of an account missing from the list last, without a name', () => {
    const groups = groupByAccount([did('4185550142', 3), did('5145550100', 1)], [account(1)]);
    expect(groups.map((g) => [g.account?.id ?? null, g.dids.map((d) => d.did)])).toEqual([
      [1, ['5145550100']],
      [null, ['4185550142']],
    ]);
  });
});

describe('assignableDids', () => {
  it('leaves out the numbers VoIP.ms offers no SMS on, unless the user already has one', () => {
    const dids = [did('5145550100', 1), did('4505550199', 1, false), did('8195550123', 2, false)];
    expect(assignableDids(dids, new Set()).map((d) => d.did)).toEqual(['5145550100']);
    expect(assignableDids(dids, new Set(['8195550123'])).map((d) => d.did)).toEqual(['5145550100', '8195550123']);
  });
});
