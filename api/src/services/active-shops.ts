// Every live shop, page by page (200 at a time), for the daily and weekly jobs.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import type { Business } from '../domain/business';

export async function* activeShops(db: Firestore, pageSize = 200): AsyncGenerator<Business> {
  let after: string | null = null;
  for (;;) {
    const page = await db.query(C.businesses, [['status', '==', 'active']], { limit: pageSize, afterId: after });
    for (const b of page) yield { ...(b as unknown as Business), id: (b.id as string | undefined) ?? b._id };
    if (page.length < pageSize) return;
    after = page[page.length - 1]._id;
  }
}
