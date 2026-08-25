import express from 'express';
import { dbAll, dbGet } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  // Client can pass clientDay (0-6) and clientDate (YYYY-MM-DD) to align with timezone
  const clientDay = req.query.dayOfWeek !== undefined 
    ? parseInt(req.query.dayOfWeek, 10) 
    : new Date().getDay();
  
  const clientDate = req.query.date || new Date().toISOString().split('T')[0];

  try {
    // 1. Get today's classes
    const classesToday = await dbAll(`
      SELECT c.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM classes c
      JOIN subjects s ON c.subject_id = s.id
      WHERE s.user_id = ? AND c.day_of_week = ?
      ORDER BY c.start_time ASC
    `, [req.userId, clientDay]);

    // 2. Get upcoming deadlines (next 5 pending assignments)
    const upcomingAssignments = await dbAll(`
      SELECT a.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM assignments a
      JOIN subjects s ON a.subject_id = s.id
      WHERE a.user_id = ? AND a.status = 'pending' AND a.due_date >= ?
      ORDER BY a.due_date ASC
      LIMIT 5
    `, [req.userId, clientDate]);

    // 3. Get next exam
    const nextExam = await dbGet(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM exams e
      JOIN subjects s ON e.subject_id = s.id
      WHERE e.user_id = ? AND e.date >= ?
      ORDER BY e.date ASC, e.start_time ASC
      LIMIT 1
    `, [req.userId, clientDate]);

    // 3.5. Get upcoming exams (up to 4)
    const upcomingExams = await dbAll(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM exams e
      JOIN subjects s ON e.subject_id = s.id
      WHERE e.user_id = ? AND e.date >= ?
      ORDER BY e.date ASC, e.start_time ASC
      LIMIT 4
    `, [req.userId, clientDate]);

    // 3.6. Get recent notes (up to 4)
    const recentNotes = await dbAll(`
      SELECT n.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM notes n
      JOIN subjects s ON n.subject_id = s.id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC
      LIMIT 4
    `, [req.userId]);

    // 4. Calculate key quick statistics
    // Average attendance
    const subjects = await dbAll('SELECT id FROM subjects WHERE user_id = ?', [req.userId]);
    const attendanceLogs = await dbAll(`
      SELECT a.subject_id, a.status 
      FROM attendance_logs a
      JOIN subjects s ON a.subject_id = s.id
      WHERE s.user_id = ?
    `, [req.userId]);

    let totalActiveClasses = 0;
    let totalPresentClasses = 0;

    subjects.forEach(sub => {
      const logs = attendanceLogs.filter(log => log.subject_id === sub.id);
      const present = logs.filter(log => log.status === 'present').length;
      const absent = logs.filter(log => log.status === 'absent').length;
      totalActiveClasses += (present + absent);
      totalPresentClasses += present;
    });

    const averageAttendance = totalActiveClasses > 0 
      ? parseFloat(((totalPresentClasses / totalActiveClasses) * 100).toFixed(1)) 
      : 100.0;

    // Total pending assignments count
    const pendingCountRow = await dbGet(`
      SELECT COUNT(*) as count FROM assignments WHERE user_id = ? AND status = 'pending'
    `, [req.userId]);
    const totalPendingAssignments = pendingCountRow ? pendingCountRow.count : 0;

    // Total saved notes count
    const notesCountRow = await dbGet(`
      SELECT COUNT(*) as count FROM notes WHERE user_id = ?
    `, [req.userId]);
    const totalNotesSaved = notesCountRow ? notesCountRow.count : 0;

    res.json({
      classesToday,
      upcomingAssignments,
      nextExam,
      upcomingExams,
      recentNotes,
      stats: {
        averageAttendance,
        totalPendingAssignments,
        totalSubjects: subjects.length,
        totalNotesSaved
      }
    });

  } catch (err) {
    console.error('Fetch dashboard error:', err);
    res.status(500).json({ error: 'Server error aggregating dashboard stats.' });
  }
});

export default router;
