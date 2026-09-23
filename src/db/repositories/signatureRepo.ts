import { getDatabase, runWriteTransaction } from '../client';
import { BorrowerSignature, SignatureEntity, SignatureStrokes } from '../types';
import { auditRepo } from './auditRepo';

/**
 * Borrower signatures.
 *
 * One signature per record (loan or payment), enforced by a unique index. Re-signing replaces the
 * row and writes both versions to the audit log, so a signature can be corrected but never quietly
 * swapped. A signature is captured once, at the moment the money changed hands — there is no flow
 * that signs on a borrower's behalf afterwards.
 */

const SIGNATURE_COLUMNS = `
  id,
  entity,
  entity_id as entityId,
  borrower_id as borrowerId,
  signer_name as signerName,
  strokes,
  taken_at as takenAt
`;

export interface SignatureInput {
  entity: SignatureEntity;
  entityId: string;
  borrowerId?: string | null;
  signerName?: string | null;
  strokes: SignatureStrokes;
}

export const signatureRepo = {
  async save(input: SignatureInput): Promise<BorrowerSignature> {
    let saved: BorrowerSignature | null = null;

    await runWriteTransaction(async (txn) => {
      const existing = await txn.getFirstAsync<BorrowerSignature>(
        `SELECT ${SIGNATURE_COLUMNS} FROM signatures WHERE entity = ? AND entity_id = ?`,
        [input.entity, input.entityId]
      );

      const serialised = JSON.stringify(input.strokes);
      const id = existing?.id ?? 'sig_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

      if (existing) {
        await txn.runAsync(
          `UPDATE signatures
              SET strokes = ?, signer_name = ?, borrower_id = ?, taken_at = datetime('now')
            WHERE id = ?`,
          [serialised, input.signerName ?? null, input.borrowerId ?? null, id]
        );
      } else {
        await txn.runAsync(
          `INSERT INTO signatures (id, entity, entity_id, borrower_id, signer_name, strokes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            id,
            input.entity,
            input.entityId,
            input.borrowerId ?? null,
            input.signerName ?? null,
            serialised,
          ]
        );
      }

      await auditRepo.logWith(txn, {
        entity: 'signature',
        entityId: id,
        action: existing ? 'UPDATE' : 'CREATE',
        reason: `Borrower signature captured for ${input.entity.toLowerCase()} ${input.entityId}`,
        before: existing ? { strokes: existing.strokes, takenAt: existing.takenAt } : undefined,
        after: { entity: input.entity, entityId: input.entityId, signerName: input.signerName ?? null },
      });

      saved = await txn.getFirstAsync<BorrowerSignature>(
        `SELECT ${SIGNATURE_COLUMNS} FROM signatures WHERE id = ?`,
        [id]
      );
    });

    if (!saved) throw new Error('The signature could not be saved.');
    return saved;
  },

  async getFor(entity: SignatureEntity, entityId: string): Promise<BorrowerSignature | null> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<BorrowerSignature>(
      `SELECT ${SIGNATURE_COLUMNS} FROM signatures WHERE entity = ? AND entity_id = ?`,
      [entity, entityId]
    );
    return row ?? null;
  },

  /** Signatures for several payments at once (the receipt list view). */
  async getForEntities(
    entity: SignatureEntity,
    entityIds: string[]
  ): Promise<Record<string, BorrowerSignature>> {
    if (entityIds.length === 0) return {};
    const db = await getDatabase();

    const placeholders = entityIds.map(() => '?').join(', ');
    const rows = await db.getAllAsync<BorrowerSignature>(
      `SELECT ${SIGNATURE_COLUMNS}
       FROM signatures
       WHERE entity = ? AND entity_id IN (${placeholders})`,
      [entity, ...entityIds]
    );

    const map: Record<string, BorrowerSignature> = {};
    for (const row of rows) map[row.entityId] = row;
    return map;
  },

  async countForBorrower(borrowerId: string): Promise<number> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ total: number }>(
      `SELECT COUNT(*) as total FROM signatures WHERE borrower_id = ?`,
      [borrowerId]
    );
    return Number(row?.total ?? 0);
  },
};
