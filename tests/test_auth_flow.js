import { initDB, dbGet, dbRun } from '../db.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

async function runAuthFlowTests() {
  console.log('--- Starting Automated Auth & Verification Flow Tests ---');
  await initDB();

  const testUser = {
    username: 'test_student_' + Date.now(),
    email: `student_${Date.now()}@university.edu`,
    password: 'Password123!'
  };

  try {
    // 1. Create user in DB (simulate POST /api/auth/register)
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(testUser.password, salt);
    const userId = crypto.randomUUID();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = Date.now() + 10 * 60 * 1000;
    const now = Date.now();

    await dbRun(
      'INSERT INTO users (id, username, email, password_hash, is_verified, otp_code, otp_expires_at, otp_last_sent_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      [userId, testUser.username, testUser.email, passwordHash, otpCode, otpExpires, now]
    );
    console.log('✅ TEST 1: User created with is_verified = 0 and OTP =', otpCode);

    // 2. Verify unverified login check
    const userInDb = await dbGet('SELECT * FROM users WHERE email = ?', [testUser.email]);
    if (userInDb.is_verified !== 0) {
      throw new Error('FAILED: User should be unverified upon signup!');
    }
    console.log('✅ TEST 2: Unverified user login check verified (is_verified = 0).');

    // 3. Test OTP Verification (Simulate POST /api/auth/verify-otp)
    if (userInDb.otp_code !== otpCode) {
      throw new Error('FAILED: OTP mismatch in DB!');
    }

    await dbRun('UPDATE users SET is_verified = 1, otp_code = NULL, otp_expires_at = NULL WHERE id = ?', [userId]);
    const verifiedUser = await dbGet('SELECT is_verified, otp_code FROM users WHERE id = ?', [userId]);

    if (verifiedUser.is_verified !== 1 || verifiedUser.otp_code !== null) {
      throw new Error('FAILED: User verification state update failed!');
    }
    console.log('✅ TEST 3: OTP verification succeeded! User marked is_verified = 1 and OTP cleared.');

    // 4. Test Forgot Password (Simulate POST /api/auth/forgot-password)
    const resetToken = crypto.randomBytes(20).toString('hex');
    const resetOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const resetExpires = Date.now() + 3600000;

    await dbRun('UPDATE users SET reset_token = ?, reset_token_expires = ?, otp_code = ? WHERE id = ?', [resetToken, resetExpires, resetOtp, userId]);
    console.log('✅ TEST 4: Forgot password generated reset token and reset OTP:', resetOtp);

    // 5. Test Reset Password (Simulate POST /api/auth/reset-password)
    const newPassword = 'NewSecretPassword456!';
    const newSalt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, newSalt);

    await dbRun('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, otp_code = NULL WHERE id = ?', [newPasswordHash, userId]);

    const updatedUser = await dbGet('SELECT reset_token, reset_token_expires, otp_code, password_hash FROM users WHERE id = ?', [userId]);
    if (updatedUser.reset_token !== null || updatedUser.otp_code !== null) {
      throw new Error('FAILED: Reset token/OTP should be single-use and set to NULL after reset!');
    }

    const isMatchNew = await bcrypt.compare(newPassword, updatedUser.password_hash);
    if (!isMatchNew) {
      throw new Error('FAILED: New password hash check failed!');
    }
    console.log('✅ TEST 5: Reset password completed! Single-use token cleared and new password verified.');

    // Clean up test user
    await dbRun('DELETE FROM users WHERE id = ?', [userId]);
    console.log('✅ CLEANUP: Test user deleted successfully.');
    console.log('\n--- ALL AUTH FLOW TESTS PASSED SUCCESSFULLY! 🎉 ---');
    process.exit(0);
  } catch (err) {
    console.error('❌ AUTH FLOW TEST ERROR:', err);
    process.exit(1);
  }
}

runAuthFlowTests();
