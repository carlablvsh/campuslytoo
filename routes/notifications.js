import express from 'express';
import crypto from 'crypto';
import { dbAll, dbGet, dbRun } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Helper: Get date string relative to today (e.g. diffDays = 1 means tomorrow)
function getDateString(diffDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + diffDays);
  return d.toISOString().split('T')[0];
}

// Helper: Run checks and generate notifications
async function syncNotifications(userId) {
  const today = getDateString(0);
  const tomorrow = getDateString(1);
  
  const d3 = new Date();
  d3.setDate(d3.getDate() + 3);
  const in3Days = d3.toISOString().split('T')[0];

  // 1. Check Assignments
  const assignments = await dbAll(`
    SELECT a.*, s.name as subject_name 
    FROM assignments a
    JOIN subjects s ON a.subject_id = s.id
    WHERE a.user_id = ?
  `, [userId]);

  for (const assign of assignments) {
    if (assign.status === 'pending') {
      if (assign.due_date < today) {
        // Overdue assignment
        const refId = `${assign.id}_overdue`;
        const existing = await dbGet('SELECT id FROM notifications WHERE user_id = ? AND reference_id = ?', [userId, refId]);
        if (!existing) {
          await dbRun(`
            INSERT INTO notifications (id, user_id, type, reference_id, title, message)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            crypto.randomUUID(),
            userId,
            'overdue_assignment',
            refId,
            'Assignment Overdue! ⚠️',
            `Your assignment "${assign.title}" for ${assign.subject_name} was due on ${assign.due_date}.`
          ]);
        }
      } else if (assign.due_date === today || assign.due_date === tomorrow) {
        // Upcoming assignment
        const refId = `${assign.id}_upcoming`;
        const existing = await dbGet('SELECT id FROM notifications WHERE user_id = ? AND reference_id = ?', [userId, refId]);
        if (!existing) {
          const timing = assign.due_date === today ? 'today' : 'tomorrow';
          await dbRun(`
            INSERT INTO notifications (id, user_id, type, reference_id, title, message)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            crypto.randomUUID(),
            userId,
            'upcoming_assignment',
            refId,
            'Assignment Due Soon ⏳',
            `"${assign.title}" for ${assign.subject_name} is due ${timing} (${assign.due_date}).`
          ]);
        }
      }
    }
  }

  // 2. Check Exams
  const exams = await dbAll(`
    SELECT e.*, s.name as subject_name 
    FROM exams e
    JOIN subjects s ON e.subject_id = s.id
    WHERE e.user_id = ? AND e.date >= ? AND e.date <= ?
  `, [userId, today, in3Days]);

  for (const exam of exams) {
    const refId = `${exam.id}_upcoming`;
    const existing = await dbGet('SELECT id FROM notifications WHERE user_id = ? AND reference_id = ?', [userId, refId]);
    if (!existing) {
      const daysDiff = Math.ceil((new Date(exam.date) - new Date(today)) / (1000 * 60 * 60 * 24));
      const whenStr = daysDiff === 0 ? 'today' : daysDiff === 1 ? 'tomorrow' : `in ${daysDiff} days`;
      await dbRun(`
        INSERT INTO notifications (id, user_id, type, reference_id, title, message)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        crypto.randomUUID(),
        userId,
        'upcoming_exam',
        refId,
        'Upcoming Exam Alert! 📝',
        `Your exam "${exam.title}" (${exam.subject_name}) is scheduled ${whenStr} at ${exam.start_time} in ${exam.location || 'N/A'}.`
      ]);
    }
  }

  // 3. Check Attendance Targets
  const subjects = await dbAll('SELECT * FROM subjects WHERE user_id = ?', [userId]);
  const logs = await dbAll(`
    SELECT a.* FROM attendance_logs a
    JOIN subjects s ON a.subject_id = s.id
    WHERE s.user_id = ?
  `, [userId]);

  for (const sub of subjects) {
    const subLogs = logs.filter(log => log.subject_id === sub.id);
    const present = subLogs.filter(log => log.status === 'present').length;
    const absent = subLogs.filter(log => log.status === 'absent').length;
    const totalActive = present + absent;
    
    if (totalActive > 0) {
      const percentage = (present / totalActive) * 100;
      const refId = `${sub.id}_low_attendance`;
      
      if (percentage < sub.target_attendance) {
        const existing = await dbGet('SELECT id FROM notifications WHERE user_id = ? AND reference_id = ?', [userId, refId]);
        if (!existing) {
          await dbRun(`
            INSERT INTO notifications (id, user_id, type, reference_id, title, message)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            crypto.randomUUID(),
            userId,
            'low_attendance',
            refId,
            'Low Attendance Warning 📈',
            `Your attendance in "${sub.name}" is currently ${percentage.toFixed(1)}%, which is below your target of ${sub.target_attendance}%.`
          ]);
        }
      } else {
        // If they recovered, remove the low attendance warning so they don't get spammed
        await dbRun('DELETE FROM notifications WHERE user_id = ? AND reference_id = ? AND is_read = 0', [userId, refId]);
      }
    }
  }

  // 4. Timetable / Class Reminders for Today
  const dayOfWeek = new Date().getDay(); // 0 = Sunday, 1 = Monday, etc.
  const todayClasses = await dbAll(`
    SELECT c.*, s.name as subject_name 
    FROM classes c
    JOIN subjects s ON c.subject_id = s.id
    WHERE s.user_id = ? AND c.day_of_week = ?
  `, [userId, dayOfWeek]);

  if (todayClasses.length > 0) {
    const refId = `class_reminder_${today}`;
    const existing = await dbGet('SELECT id FROM notifications WHERE user_id = ? AND reference_id = ?', [userId, refId]);
    if (!existing) {
      await dbRun(`
        INSERT INTO notifications (id, user_id, type, reference_id, title, message)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        crypto.randomUUID(),
        userId,
        'class_reminder',
        refId,
        "Today's Timetable Rhythm ⏰",
        `You have ${todayClasses.length} class(es) scheduled for today. Check your timetable page for details!`
      ]);
    }
  }

  // 5. Calendar Notes for Today or Tomorrow
  const calendarNotes = await dbAll(`
    SELECT * FROM calendar_notes 
    WHERE user_id = ? AND (date = ? OR date = ?)
  `, [userId, today, tomorrow]);

  for (const calNote of calendarNotes) {
    const refId = `${calNote.id}_note_alert`;
    const existing = await dbGet('SELECT id FROM notifications WHERE user_id = ? AND reference_id = ?', [userId, refId]);
    if (!existing) {
      const timingStr = calNote.date === today ? 'today' : 'tomorrow';
      await dbRun(`
        INSERT INTO notifications (id, user_id, type, reference_id, title, message)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        crypto.randomUUID(),
        userId,
        'calendar_note',
        refId,
        'Calendar Event Reminder 📌',
        `Reminder for ${timingStr}: "${calNote.note}"`
      ]);
    }
  }
}

// 1. Get all notifications
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Generate new notifications
    await syncNotifications(req.userId);

    // Fetch all notifications
    const notifications = await dbAll(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );

    res.json(notifications);
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res.status(500).json({ error: 'Server error loading notifications.' });
  }
});

// 2. Mark single notification as read
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
    const existing = await dbGet('SELECT id FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Notification not found.' });
    }

    await dbRun('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    console.error('Read notification error:', err);
    res.status(500).json({ error: 'Server error updating notification status.' });
  }
});

// 3. Mark all notifications as read
router.put('/read-all', authenticateToken, async (req, res) => {
  try {
    await dbRun('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Read all notifications error:', err);
    res.status(500).json({ error: 'Server error marking notifications as read.' });
  }
});

// 4. Delete single notification
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await dbGet('SELECT id FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Notification not found.' });
    }

    await dbRun('DELETE FROM notifications WHERE id = ?', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    console.error('Dismiss notification error:', err);
    res.status(500).json({ error: 'Server error dismissing notification.' });
  }
});

export default router;
