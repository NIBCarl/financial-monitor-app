import { getDatabase } from '../client';
import { Borrower } from '../types';

export const borrowerRepo = {
  async getAll(searchQuery?: string, filterStatus?: string): Promise<Borrower[]> {
    const db = await getDatabase();
    let query = `
      SELECT 
        b.id,
        b.full_name as fullName,
        b.phone_number as phoneNumber,
        b.category_tag as categoryTag,
        b.photo_uri as photoUri,
        b.address,
        b.guarantor_info as guarantorInfo,
        b.notes,
        b.created_at as createdAt,
        COUNT(DISTINCT CASE WHEN l.status IN ('ACTIVE', 'OVERDUE') THEN l.id END) as activeLoansCount,
        COALESCE(SUM(CASE WHEN l.status IN ('ACTIVE', 'OVERDUE') THEN l.remaining_balance ELSE 0 END), 0) as totalOutstanding,
        MAX(
          CASE WHEN EXISTS (
            SELECT 1 FROM loan_schedules s
            WHERE s.loan_id = l.id
              AND s.status <> 'PAID'
              AND s.due_date < date('now', 'localtime')
          ) THEN 1 ELSE 0 END
        ) as hasOverdue
      FROM borrowers b
      LEFT JOIN loans l ON b.id = l.borrower_id
    `;

    const conditions: string[] = [];
    const params: any[] = [];

    if (searchQuery && searchQuery.trim() !== '') {
      conditions.push(`(b.full_name LIKE ? OR b.phone_number LIKE ? OR b.category_tag LIKE ?)`);
      const pattern = `%${searchQuery.trim()}%`;
      params.push(pattern, pattern, pattern);
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }

    query += ` GROUP BY b.id ORDER BY b.full_name ASC`;

    const results = await db.getAllAsync<any>(query, params);

    let borrowers: Borrower[] = results.map(row => ({
      ...row,
      hasOverdue: Boolean(row.hasOverdue),
      activeLoansCount: Number(row.activeLoansCount || 0),
      totalOutstanding: Number(row.totalOutstanding || 0),
    }));

    if (filterStatus === 'OVERDUE') {
      borrowers = borrowers.filter(b => b.hasOverdue);
    } else if (filterStatus === 'ACTIVE') {
      borrowers = borrowers.filter(b => (b.activeLoansCount || 0) > 0);
    } else if (filterStatus === 'CLEARED') {
      borrowers = borrowers.filter(b => (b.activeLoansCount || 0) === 0);
    }

    return borrowers;
  },

  async getById(id: string): Promise<Borrower | null> {
    const db = await getDatabase();
    const query = `
      SELECT 
        b.id,
        b.full_name as fullName,
        b.phone_number as phoneNumber,
        b.category_tag as categoryTag,
        b.photo_uri as photoUri,
        b.address,
        b.guarantor_info as guarantorInfo,
        b.notes,
        b.created_at as createdAt,
        COUNT(DISTINCT CASE WHEN l.status IN ('ACTIVE', 'OVERDUE') THEN l.id END) as activeLoansCount,
        COALESCE(SUM(CASE WHEN l.status IN ('ACTIVE', 'OVERDUE') THEN l.remaining_balance ELSE 0 END), 0) as totalOutstanding,
        MAX(
          CASE WHEN EXISTS (
            SELECT 1 FROM loan_schedules s
            WHERE s.loan_id = l.id
              AND s.status <> 'PAID'
              AND s.due_date < date('now', 'localtime')
          ) THEN 1 ELSE 0 END
        ) as hasOverdue
      FROM borrowers b
      LEFT JOIN loans l ON b.id = l.borrower_id
      WHERE b.id = ?
      GROUP BY b.id
    `;
    const row = await db.getFirstAsync<any>(query, [id]);
    if (!row) return null;

    return {
      ...row,
      hasOverdue: Boolean(row.hasOverdue),
      activeLoansCount: Number(row.activeLoansCount || 0),
      totalOutstanding: Number(row.totalOutstanding || 0),
    };
  },

  async create(data: {
    fullName: string;
    phoneNumber: string;
    categoryTag?: string;
    address?: string;
    guarantorInfo?: string;
    notes?: string;
    photoUri?: string;
  }): Promise<string> {
    const db = await getDatabase();
    const id = 'b_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    await db.runAsync(
      `INSERT INTO borrowers (id, full_name, phone_number, category_tag, address, guarantor_info, notes, photo_uri)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.fullName.trim(),
        data.phoneNumber.trim(),
        data.categoryTag?.trim() || 'General',
        data.address?.trim() || null,
        data.guarantorInfo?.trim() || null,
        data.notes?.trim() || null,
        data.photoUri || null,
      ]
    );

    return id;
  },

  async update(id: string, data: Partial<Borrower>): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE borrowers 
       SET full_name = COALESCE(?, full_name),
           phone_number = COALESCE(?, phone_number),
           category_tag = COALESCE(?, category_tag),
           address = COALESCE(?, address),
           notes = COALESCE(?, notes),
           photo_uri = COALESCE(?, photo_uri)
       WHERE id = ?`,
      [
        data.fullName || null,
        data.phoneNumber || null,
        data.categoryTag || null,
        data.address || null,
        data.notes || null,
        data.photoUri || null,
        id,
      ]
    );
  },

  async delete(id: string): Promise<{ success: boolean; message?: string }> {
    const db = await getDatabase();
    // Check if there are active loans
    const active = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM loans WHERE borrower_id = ? AND status IN ('ACTIVE', 'OVERDUE')`,
      [id]
    );

    if (active && active.count > 0) {
      return { success: false, message: 'Cannot delete a borrower with active or overdue loans.' };
    }

    await db.runAsync(`DELETE FROM borrowers WHERE id = ?`, [id]);
    return { success: true };
  }
};
