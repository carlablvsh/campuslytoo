export function getOccurrencesForDateRange(classes, breaks, exceptions, events, startDateStr, endDateStr) {
  const occurrences = [];
  const [sY, sM, sD] = startDateStr.split('-').map(Number);
  const start = new Date(sY, sM - 1, sD, 12, 0, 0);
  const [eY, eM, eD] = endDateStr.split('-').map(Number);
  const end = new Date(eY, eM - 1, eD, 12, 0, 0);

  // Parse exceptions for easier lookups
  const skips = new Set();
  const movesByOriginalDate = new Map(); // original_date_class_id -> new occurrence details
  
  exceptions.forEach(exc => {
    const key = `${exc.original_date}_${exc.class_id}`;
    if (exc.exception_type === 'skip') {
      skips.add(key);
    } else if (exc.exception_type === 'move') {
      skips.add(key); // A moved class is skipped on its original date
      if (exc.new_date) {
        movesByOriginalDate.set(key, {
          new_date: exc.new_date,
          new_start_time: exc.new_start_time,
          new_end_time: exc.new_end_time,
          new_location: exc.new_location
        });
      }
    }
  });

  // Helper to check if a date falls in any break period
  const isDateInBreak = (dateStr) => {
    return breaks.some(b => dateStr >= b.start_date && dateStr <= b.end_date);
  };

  // Helper to format date as YYYY-MM-DD
  const formatDateLocal = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  // Loop through each day in the date range
  let current = new Date(start.getTime());
  while (current <= end) {
    const currentDateStr = formatDateLocal(current);
    const dayOfWeek = current.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

    const inBreak = isDateInBreak(currentDateStr);

    // 1. Process recurring classes
    classes.forEach(c => {
      // Check if the class's date range covers the current date
      const classStartStr = c.start_date || '1970-01-01';
      const classEndStr = c.end_date || '2099-12-31';
      if (currentDateStr < classStartStr || currentDateStr > classEndStr) {
        return;
      }

      // Check recurrence rules
      const recType = c.recurrence_type || 'weekly';
      const recDays = c.recurrence_days ? c.recurrence_days.split(',').map(Number) : [];

      let matchesRecurrence = false;
      if (recType === 'none') {
        matchesRecurrence = (currentDateStr === classStartStr);
      } else if (recType === 'weekly') {
        matchesRecurrence = (c.day_of_week === dayOfWeek);
      } else if (recType === 'biweekly') {
        if (c.day_of_week === dayOfWeek) {
          // Calculate number of weeks between start_date and current
          const [cSY, cSM, cSD] = classStartStr.split('-').map(Number);
          const startDateObj = new Date(cSY, cSM - 1, cSD, 12, 0, 0);
          const msDiff = current.getTime() - startDateObj.getTime();
          const weeksDiff = Math.floor(msDiff / (7 * 24 * 60 * 60 * 1000));
          matchesRecurrence = (weeksDiff % 2 === 0);
        }
      } else if (recType === 'custom_days') {
        matchesRecurrence = recDays.includes(dayOfWeek);
      } else if (recType === 'monthly') {
        const [cSY, cSM, cSD] = classStartStr.split('-').map(Number);
        matchesRecurrence = (current.getDate() === cSD);
      } else if (recType === 'yearly') {
        const [cSY, cSM, cSD] = classStartStr.split('-').map(Number);
        matchesRecurrence = (current.getDate() === cSD && current.getMonth() === (cSM - 1));
      }

      if (!matchesRecurrence) {
        return;
      }

      // 2. Handle breaks and exceptions
      const key = `${currentDateStr}_${c.id}`;

      // Break periods automatically skip recurring classes
      if (inBreak) {
        return;
      }

      // Check exceptions
      if (skips.has(key)) {
        if (movesByOriginalDate.has(key)) {
          const moveDetails = movesByOriginalDate.get(key);
          if (moveDetails.new_date >= startDateStr && moveDetails.new_date <= endDateStr) {
            occurrences.push({
              type: 'class_occurrence',
              id: `${c.id}_move_${currentDateStr}`,
              class_id: c.id,
              subject_id: c.subject_id,
              subject_name: c.subject_name,
              subject_code: c.subject_code,
              subject_color: c.subject_color,
              date: moveDetails.new_date,
              start_time: moveDetails.new_start_time || c.start_time,
              end_time: moveDetails.new_end_time || c.end_time,
              location: moveDetails.new_location || c.location,
              is_moved: true,
              original_date: currentDateStr
            });
          }
        }
        return; // Skip original slot
      }

      // No break & no exception: standard occurrence
      occurrences.push({
        type: 'class_occurrence',
        id: `${c.id}_${currentDateStr}`,
        class_id: c.id,
        subject_id: c.subject_id,
        subject_name: c.subject_name,
        subject_code: c.subject_code,
        subject_color: c.subject_color,
        date: currentDateStr,
        start_time: c.start_time,
        end_time: c.end_time,
        location: c.location,
        is_moved: false
      });
    });

    // Move to next day (safe increment)
    current.setDate(current.getDate() + 1);
  }

  // 3. Process custom calendar events
  events.forEach(evt => {
    if (evt.date >= startDateStr && evt.date <= endDateStr) {
      occurrences.push({
        type: 'event',
        id: evt.id,
        title: evt.title,
        event_type: evt.type, // 'class_extra', 'work', 'study', 'personal', 'other'
        subject_id: evt.subject_id,
        subject_name: evt.subject_name,
        subject_code: evt.subject_code,
        subject_color: evt.subject_color,
        date: evt.date,
        start_time: evt.start_time,
        end_time: evt.end_time,
        location: evt.location
      });
    }
  });

  // Sort by date, then start_time
  occurrences.sort((a, b) => {
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    return a.start_time.localeCompare(b.start_time);
  });

  return occurrences;
}
