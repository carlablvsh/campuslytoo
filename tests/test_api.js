import assert from 'assert';

const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
  console.log('🚀 Starting Campusly API Verification Tests...');
  
  try {
    // Test 1: Health Check
    console.log('Testing /health endpoint...');
    const healthRes = await fetch('http://localhost:5000/health');
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'ok');
    console.log('✅ Health check passed.');

    // Test 2: User registration
    console.log('Testing student registration...');
    const testUser = {
      username: `TestStudent_${Date.now()}`,
      email: `student_${Date.now()}@test.edu`,
      password: 'securePassword123'
    };

    const registerRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testUser)
    });

    assert.strictEqual(registerRes.status, 201);
    const registerData = await registerRes.json();
    assert.ok(registerData.token);
    assert.strictEqual(registerData.user.username, testUser.username);
    console.log('✅ Registration passed.');

    // Test 3: User login
    console.log('Testing student login...');
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testUser.email,
        password: testUser.password
      })
    });

    assert.strictEqual(loginRes.status, 200);
    const loginData = await loginRes.json();
    const token = loginData.token;
    assert.ok(token);
    console.log('✅ Login passed.');

    // Test 4: Access profile
    console.log('Testing profile retrieval with JWT...');
    const meRes = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(meRes.status, 200);
    const meData = await meRes.json();
    assert.strictEqual(meData.user.username, testUser.username);
    console.log('✅ Token authorization passed.');

    // Test 5: Verify subjects CRUD
    console.log('Testing subjects creation...');
    const subjectPayload = {
      name: 'Introduction to Artificial Intelligence',
      code: 'CS401',
      target_attendance: 75,
      color: '#6366f1'
    };

    const createSubRes = await fetch(`${BASE_URL}/academic/subjects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(subjectPayload)
    });

    assert.strictEqual(createSubRes.status, 201);
    const createSubData = await createSubRes.json();
    assert.ok(createSubData.id);
    assert.strictEqual(createSubData.code, 'CS401');
    console.log('✅ Subject creation passed.');

    // Test 6: Verify attendance calculations
    console.log('Testing attendance stats calculation...');
    const statsRes = await fetch(`${BASE_URL}/academic/attendance/stats`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(statsRes.status, 200);
    const statsData = await statsRes.json();
    assert.ok(Array.isArray(statsData));
    const subStat = statsData.find(s => s.id === createSubData.id);
    assert.ok(subStat);
    assert.strictEqual(subStat.currentPercentage, 100); // 0 present, 0 absent defaults to 100%
    console.log('✅ Attendance calculations passed.');

    console.log('🎉 All Campusly API tests completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  }
}

// Small delay to ensure server started
setTimeout(runTests, 1000);
