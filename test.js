const axios = require('axios');
const colors = require('colors');

const API_BASE = 'https://data.biblia.chat/api';

async function testRoute(description, testFn) {
  try {
    console.log(`\nTesting: ${description}`.cyan);
    await testFn();
    console.log('✅ Test passed'.green);
  } catch (error) {
    console.error('❌ Test failed'.red);
    console.error(error);
  }
}

// Test 1: Get Bible chapter
testRoute('GET Bible chapter', async () => {
  const url = `${API_BASE}/es/RVR1960/GEN/1`;
  console.log('GET URL:', url);
  const response = await axios.get(url);
  if (!response.data || !response.data.data.title || !Array.isArray(response.data.data.content)) {
    throw new Error('Invalid response structure');
  }
  console.log('Received chapter:', response.data.data.title);
});

// Test 2: Generate audio Bible
testRoute('POST Generate audio Bible', async () => {
  const response = await axios.post(`${API_BASE}/audio-bible`, {
    bible_abbreviation: 'RVR1960',
    bible_book: 'GEN',
    bible_chapter: '1',
    bible_lang: 'es'
  });
  if (!response.data || !response.data.data.audio_url) {
    throw new Error('Missing audio URL in response');
  }
  console.log('Audio URL:', response.data.data.audio_url);
});

// Test 3: Get Bible version info
testRoute('GET Bible version info', async () => {
  const url = `${API_BASE}/es/RVR1960`;
  console.log('GET URL:', url);
  const response = await axios.get(url);
  if (!response.data || !response.data.data.title || !Array.isArray(response.data.data.books)) {
    throw new Error('Invalid version info structure');
  }
  console.log('Version info:', response.data.data.title);
});

// Test 4: Get all versions by language
testRoute('GET All versions by language', async () => {
  const url = `${API_BASE}/versions/es`;
  console.log('GET URL:', url);
  const response = await axios.get(url);
  if (!response.data || !Array.isArray(response.data.data.versions)) {
    throw new Error('Invalid versions list structure');
  }
  console.log('Found versions:', response.data.data.versions.length);
});

// Test 5: Get versions configuration
testRoute('GET Versions configuration', async () => {
  const url = `${API_BASE}/versions`;
  console.log('GET URL:', url);
  const response = await axios.get(url);
  if (!response.data || !response.data.data) {
    throw new Error('Invalid versions configuration structure');
  }
  console.log('Versions configuration loaded');
});

// Run all tests
(async () => {
  console.log('Starting API tests...'.bold);
  console.log('\nAll tests completed'.bold);
})();
