-- OTP codes now go to an email address instead of a phone number.
-- Pending codes were addressed to phone numbers, so they are dropped.
DELETE FROM "otp_codes";

ALTER TABLE "otp_codes" RENAME COLUMN "phone" TO "email";
ALTER INDEX "otp_codes_phone_createdAt_idx" RENAME TO "otp_codes_email_createdAt_idx";

-- Users: the verification timestamp now belongs to the email address.
ALTER TABLE "users" RENAME COLUMN "mobileVerifiedAt" TO "emailVerifiedAt";
UPDATE "users" SET "emailVerifiedAt" = NULL;
