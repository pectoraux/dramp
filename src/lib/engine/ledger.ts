// Ledger service — double-entry internal ledger.
// Every economic effect originates from a ledger transaction.
// Each entry debits one account and credits another for the same amount, so
// every entry is individually balanced. The idempotency_key is unique, so a
// repeated mutation cannot create a duplicate posting.
//
// Account naming convention:
//   user:{userId}:{asset}
//   provider:{providerId}:operational:{asset}
//   provider:{providerId}:vault:{asset}
//   execution:{executionId}:escrow:{asset}
//   settlement:{assetSymbol}:treasury
//   dramp:fees:{asset}
//   dramp:incentives:{asset}

import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "./money";
import { LEDGER_ENTRY_TYPE, type LedgerEntryType } from "./types";

type Tx = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export interface PostEntryInput {
  debitAccount: string;
  creditAccount: string;
  amount: Decimal | string | number;
  asset: string;
  entryType: LedgerEntryType;
  executionId?: string;
  obligationId?: string;
  idempotencyKey: string;
  description?: string;
  tx?: Tx;
}

export async function postLedgerEntry(input: PostEntryInput) {
  const client = input.tx ?? db;
  return client.ledgerEntry.create({
    data: {
      debitAccount: input.debitAccount,
      creditAccount: input.creditAccount,
      amount: new Decimal(input.amount),
      asset: input.asset,
      entryType: input.entryType,
      executionId: input.executionId ?? null,
      obligationId: input.obligationId ?? null,
      idempotencyKey: input.idempotencyKey,
      description: input.description ?? null,
    },
  });
}

// Convenience helpers — each maps to a canonical entry type.

export async function transfer(
  from: string,
  to: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: to,
    creditAccount: from,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.TRANSFER,
    ...opts,
  });
}

export async function mint(
  to: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  // Minting credits the settlement treasury and debits the destination account.
  return postLedgerEntry({
    debitAccount: to,
    creditAccount: `settlement:${asset}:treasury`,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.MINT,
    ...opts,
  });
}

export async function burn(
  from: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: `settlement:${asset}:treasury`,
    creditAccount: from,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.BURN,
    ...opts,
  });
}

export async function lock(
  owner: string,
  vault: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: vault,
    creditAccount: owner,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.LOCK,
    ...opts,
  });
}

export async function release(
  vault: string,
  owner: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: owner,
    creditAccount: vault,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.RELEASE,
    ...opts,
  });
}

export async function slash(
  vault: string,
  compensationAccount: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: compensationAccount,
    creditAccount: vault,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.SLASH,
    ...opts,
  });
}

export async function fee(
  from: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: `dramp:fees:${asset}`,
    creditAccount: from,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.FEE,
    ...opts,
  });
}

export async function incentive(
  to: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: `dramp:incentives:${asset}`,
    creditAccount: to,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.INCENTIVE,
    ...opts,
  });
}

export async function refund(
  to: string,
  from: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: to,
    creditAccount: from,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.REFUND,
    ...opts,
  });
}

export async function compensation(
  to: string,
  amount: Decimal | string | number,
  asset: string,
  opts: { executionId?: string; obligationId?: string; idempotencyKey: string; description?: string; tx?: Tx },
) {
  return postLedgerEntry({
    debitAccount: to,
    creditAccount: `dramp:incentives:${asset}`,
    amount,
    asset,
    entryType: LEDGER_ENTRY_TYPE.COMPENSATION,
    ...opts,
  });
}

// Compute the net balance of an account (sum of debits - sum of credits) for an asset.
export async function accountBalance(
  account: string,
  asset: string,
  tx?: Tx,
): Promise<Decimal> {
  const client = tx ?? db;
  const debits = await client.ledgerEntry.aggregate({
    where: { debitAccount: account, asset },
    _sum: { amount: true },
  });
  const credits = await client.ledgerEntry.aggregate({
    where: { creditAccount: account, asset },
    _sum: { amount: true },
  });
  return new Decimal(debits._sum.amount ?? 0).minus(new Decimal(credits._sum.amount ?? 0));
}

export async function getLedgerForExecution(executionId: string) {
  return db.ledgerEntry.findMany({
    where: { executionId },
    orderBy: { timestamp: "asc" },
  });
}
