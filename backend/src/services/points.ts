import { all, get, insert, run } from '../db/index.ts';

export type Reason = 'pin_verified' | 'sparse_bonus' | 'neighbor_assist' | 'road_corroborated';

/** Points are always created pending. Reality promotes them, never the submission. */
export function award(phoneHash: string, points: number, reason: Reason,
                      refType: string, refId: number): number {
  insert(`INSERT INTO points_ledger (phone_hash, points, reason, state, ref_type, ref_id)
          VALUES (?,?,?, 'pending', ?, ?)`, phoneHash, points, reason, refType, refId);
  return points;
}

/** Called on delivery: everything staked on this address becomes real. */
export function verifyPointsFor(addressId: number): number {
  const rows = all<{ points: number }>(
    `SELECT points FROM points_ledger
      WHERE ref_type = 'address' AND ref_id = ? AND state = 'pending'`, addressId);
  run(`UPDATE points_ledger SET state = 'verified'
        WHERE ref_type = 'address' AND ref_id = ? AND state = 'pending'`, addressId);
  return rows.reduce((a, r) => a + r.points, 0);
}

export function revokePointsFor(addressId: number) {
  run(`UPDATE points_ledger SET state = 'revoked'
        WHERE ref_type = 'address' AND ref_id = ? AND state = 'pending'`, addressId);
}

export const balance = (phoneHash: string) => ({
  verified: get<{ n: number }>(
    `SELECT COALESCE(SUM(points),0) AS n FROM points_ledger
      WHERE phone_hash = ? AND state = 'verified'`, phoneHash)?.n ?? 0,
  pending: get<{ n: number }>(
    `SELECT COALESCE(SUM(points),0) AS n FROM points_ledger
      WHERE phone_hash = ? AND state = 'pending'`, phoneHash)?.n ?? 0,
});
