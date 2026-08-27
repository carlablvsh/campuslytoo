import { initDB, dbRun, dbGet } from '../db.js';
import express from 'express';
import gamificationRoutes from '../routes/gamification.js';
import jwt from 'jsonwebtoken';

async function testApiSummary() {
  await initDB();
  const testUserId = 'test_user_summary_' + Date.now();
  await dbRun(
    'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
    [testUserId, 'testuser_' + Date.now(), 'testuser_' + Date.now() + '@test.com', 'hash']
  );

  // Add a test subject and attendance log
  const subId = 'sub_' + Date.now();
  await dbRun(
    'INSERT INTO subjects (id, user_id, name, code, target_attendance, color) VALUES (?, ?, ?, ?, ?, ?)',
    [subId, testUserId, 'Algorithms', 'CS201', 75, '#cce4f6']
  );
  await dbRun(
    'INSERT INTO attendance_logs (id, subject_id, date, status) VALUES (?, ?, ?, ?)',
    ['att_log_1', subId, '2026-08-27', 'present']
  );

  const token = jwt.sign({ userId: testUserId, username: 'testuser' }, process.env.JWT_SECRET || 'campusly_fallback_jwt_secret_key_13579');

  const app = express();
  app.use(express.json());
  app.use('/api/gamification', gamificationRoutes);

  const server = app.listen(4899);

  try {
    const res = await fetch('http://localhost:4899/api/gamification/summary', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log('Response status:', res.status);
    const data = await res.json();
    console.log('Summary output:', {
      totalXP: data.totalXP,
      level: data.level,
      levelTitle: data.levelTitle,
      currentStreak: data.currentStreak,
      achievementsCount: data.achievements?.length,
      recentActivityCount: data.recentActivity?.length
    });

    if (res.status === 200 && data.totalXP > 0) {
      console.log('✓ API test passed with flying colors!');
    } else {
      console.error('✗ API test output unexpected:', data);
      process.exit(1);
    }
  } finally {
    server.close();
    await dbRun('DELETE FROM users WHERE id = ?', [testUserId]);
    await dbRun('DELETE FROM subjects WHERE id = ?', [subId]);
    await dbRun('DELETE FROM attendance_logs WHERE id = ?', ['att_log_1']);
    await dbRun('DELETE FROM xp_logs WHERE user_id = ?', [testUserId]);
  }
}

testApiSummary().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
