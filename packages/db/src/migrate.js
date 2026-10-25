import { getCoinStoreWebhookSecret, LEGACY_DEFAULT_WEBHOOK_SECRET } from '@youpi/common';
import { getDatabase } from './database.js';
import { applyMigrations } from './migrations.js';
import { MerchantRepository } from './repositories/merchant.repository.js';
import { ReceivingAccountRepository } from './repositories/receiving-account.repository.js';
import { CustomerRepository } from './repositories/customer.repository.js';

const SEED_LOCK_KEY = '5961806049129785416';

export async function seedDefaults(targetDb) {
  const db = targetDb || getDatabase();
  return db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [SEED_LOCK_KEY]);

    const merchantRepo = new MerchantRepository(db);
    const existing = await merchantRepo.findAll();

    let defaultMerchant;
    if (existing.length === 0) {
      defaultMerchant = await merchantRepo.create({
        id: '00000000-0000-0000-0000-000000000001',
        businessName: 'YOUPI Demo Store',
        slug: 'demo-store',
        contactEmail: 'merchant@youpi.local',
        contactPhone: '9876543210',
        webhookUrl: process.env.COIN_STORE_WEBHOOK_URL || 'http://localhost:5000/api/webhook',
        webhookSecret: getCoinStoreWebhookSecret(),
        branding: {
          appName: 'YOUPI PG',
          primaryColor: '#2563eb',
          logoUrl: null
        }
      });
    } else {
      defaultMerchant = existing[0];
      if (!defaultMerchant.webhookSecret) {
        await merchantRepo.update(defaultMerchant.id, {
          webhookUrl: 'http://localhost:5000/api/webhook',
          webhookSecret: getCoinStoreWebhookSecret()
        });
      } else if (defaultMerchant.webhookSecret === LEGACY_DEFAULT_WEBHOOK_SECRET) {
        await merchantRepo.update(defaultMerchant.id, { webhookSecret: getCoinStoreWebhookSecret() });
        console.warn('[migrate] Rotated the default merchant webhook secret away from the legacy public value. Update your merchant webhook verifier.');
      }
    }

    const accountRepo = new ReceivingAccountRepository(db);
    const accounts = await accountRepo.findByMerchantId(defaultMerchant.id);
    if (accounts.length === 0) {
      await accountRepo.create({
        id: '00000000-0000-0000-0000-000000000002',
        merchantId: defaultMerchant.id,
        upiId: 'merchant@upi',
        payeeName: defaultMerchant.businessName,
        isActive: true
      });
    }

    if (process.env.YOUPI_SEED_DEMO_CUSTOMER === 'true') {
      const customerRepo = new CustomerRepository(db);
      const demoMobile = '9000000000';
      if (!(await customerRepo.findByMobile(demoMobile))) {
        await customerRepo.create({
          id: '00000000-0000-0000-0000-000000000002',
          name: 'Demo Customer',
          email: 'demo-customer@youpi.local',
          mobileNumber: demoMobile,
          isPhoneVerified: false
        });
      }
    }

    return { db, defaultMerchant };
  });
}

export async function runMigrations(targetDb) {
  const db = targetDb || getDatabase();
  await applyMigrations(db);
  return seedDefaults(db);
}

export async function reinitializeCustomerIdentity(targetDb) {
  const db = targetDb || getDatabase();
  await db.transaction(async () => {
    await db.execute('UPDATE payment_sessions SET customer_id = NULL WHERE customer_id IS NOT NULL');
    await db.execute('DELETE FROM customer_sessions');
    await db.execute('DELETE FROM customers');
  });
  return { success: true, message: 'All old customer identity records wiped and reinitialized.' };
}
