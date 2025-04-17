const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const os = require('os');
const path = require('path');
const fs = require('fs').promises; // Added fs.promises for async file operations
const { v4: uuidv4 } = require('uuid'); // Import uuid for generating unique filenames
const {
    splitTextIntoChunks,
    generateAudioSpeechify,
    saveAudioChunkFromBase64,
    concatenateAudioFiles,
    uploadToS3,
    checkJsonExists,
    getJsonFromS3,
    SPEECHIFY_CHAR_LIMIT
} = require('./utils'); // Import audio utilities

const router = express.Router();

// Simple mapping from ISO 639-1 (2-letter) to ISO 639-3 (3-letter) codes
const langCodeMap = {
    'es': 'spa', // Spanish
    'en': 'eng', // English
    'pt': 'por', // Portuguese
    'fr': 'fra', // French
    'de': 'deu', // German
    'it': 'ita', // Italian
    'ru': 'rus', // Russian
    'zh': 'zho', // Chinese (generic) - Note: Bible.com might use more specific tags like cmn, yue
    'ja': 'jpn', // Japanese
    'ko': 'kor', // Korean
    // Add more mappings as needed
};

// Mapping from Bible abbreviation to ID
const bibleVersionMap = {
  "BDO1573": 1715, "BHTI": 222, "BLPH": 28, "DHH94I": 52, "DHH94PC": 411,
  "DHHDK": 1845, "DHHS94": 1846, "GlossSP": 4212, "JBS": 1076, "LBLA": 89,
  "NBLA": 103, "NBV": 753, "NTBIZ": 3539, "NTV": 127, "NVI-S": 128, // Note: NVI-S maps to 128, ignoring 2664 for simplicity or choosing one. User might need to clarify if distinction is needed.
  "ONBV": 4190, "spaPdDpt": 3365, "PDT": 197, "RVA2015": 1782, "RVC": 146,
  "RVES": 147, "RVR09": 1718, "RVR1960": 149, "RVR95": 150, "TCB": 4013,
  "TLA": 176, "TLAI": 178, "VBL": 3291
};

let currentBuildId = null; // Variable to store the BUILD_ID in memory

// Function to fetch the BUILD_ID from bible.com
async function fetchBuildId() {
    try {
        console.log('Attempting to fetch new BUILD_ID...');
        const response = await axios.get("https://www.bible.com/");
        const html = response.data;
        // Regex updated to be less strict, matching common patterns
        const pattern = /\/_next\/static\/([a-zA-Z0-9_-]+)\/_buildManifest\.js/;
        const match = html.match(pattern);

        if (match && match[1]) {
            console.log(`New BUILD_ID found: ${match[1]}`);
            return match[1];
        } else {
            console.error('BUILD_ID pattern not found in bible.com HTML.');
            throw new Error('BUILD_ID pattern not found.');
        }
    } catch (error) {
        console.error('Error fetching BUILD_ID:', error.message);
        // Rethrow the error to be handled by the caller
        throw error;
    }
}

// Function to get the current BUILD_ID, fetching if necessary
async function getBuildId() {
    if (!currentBuildId) {
        currentBuildId = await fetchBuildId();
    }
    return currentBuildId;
}

// Function to parse Bible HTML content into JSON using Cheerio (Updated to handle multiple structures)
function parseBibleHtmlToJson(htmlString) {
    const $ = cheerio.load(htmlString);
    const result = {};

    // Extract version info (remains the same)
    const versionDiv = $('div.version');
    result.version = {
        id: versionDiv.data('vid')?.toString(),
        language: versionDiv.data('iso6393')
    };

    // Extract book info (remains the same)
    const bookDiv = $('div.book');
    const bookClass = bookDiv.attr('class')?.split(' ').find(cls => cls.startsWith('bk'));
    result.book = {
        code: bookClass ? bookClass.substring(2) : null,
        chapters: []
    };

    // Extract chapter info
    const chapterDiv = $('div.chapter');
    const chapterClass = chapterDiv.attr('class')?.split(' ').find(cls => cls.startsWith('ch'));
    const chapterData = {
        number: chapterClass ? parseInt(chapterClass.substring(2), 10) : null,
        usfm: chapterDiv.data('usfm'),
        content: [] // Holds headings, paragraphs, etc.
    };

    // Iterate over main content blocks: headings (s, s1), paragraphs (p), quotes (q), references (r), and the new blocks (m, li1)
    // This makes it potentially backward compatible if older formats are encountered.
    chapterDiv.children('div.s, div.s1, div.p, div.q, div.r, div.m, div.li1').each((_, element) => {
        const $element = $(element);

        if ($element.hasClass('s') || $element.hasClass('s1')) { // Section heading (s or s1)
            chapterData.content.push({
                type: 'heading',
                text: $element.find('span.heading').text().trim()
            });
        } else if ($element.hasClass('r')) { // Reference heading
             // Handle potential multiple heading spans within 'r'
            chapterData.content.push({
                type: 'reference',
                text: $element.find('span.heading').map((i, el) => $(el).text()).get().join('').trim()
            });
        } else if ($element.hasClass('p') || $element.hasClass('q') || $element.hasClass('m') || $element.hasClass('li1')) {
            // Treat p, q, m, li1 as paragraph-like blocks containing verses
            const blockType = ($element.hasClass('q')) ? 'quote_line' : 'paragraph'; // Keep quote_line distinction if q is present
            const currentBlock = {
                type: blockType,
                verses: []
            };

            // Find verses within this block
            $element.find('span.verse').each((i, verseElement) => {
                const $verse = $(verseElement);
                const currentUsfm = $verse.data('usfm');
                const currentNumberStr = $verse.children('span.label').first().text(); // Get label text
                const currentNumber = currentNumberStr ? parseInt(currentNumberStr, 10) : null; // Parse label

                // Extract text: Concatenate text from all direct child span.content elements
                let currentText = $verse.children('span.content')
                                     .map((idx, contentSpan) => $(contentSpan).text()) // Get text of each content span
                                     .get() // Get as an array of strings
                                     .join(' ') // Join with space (or newline if preferred: '\n')
                                     .replace(/\s+/g, ' ') // Normalize whitespace
                                     .trim(); // Trim start/end

                 // Fallback if no span.content, get text directly from verse span excluding children (less common now?)
                 if (!currentText && $verse.children('span.content').length === 0) {
                    currentText = $verse.clone().children().remove().end().text().trim();
                 }

                // Extract notes (remains similar)
                const currentNotes = [];
                $verse.find('span.note').each((j, noteElement) => {
                    const $note = $(noteElement);
                    // Extract note body text more carefully
                    const noteBody = $note.find('span.body').text().replace(/\s+/g, ' ').trim();
                    currentNotes.push({
                        // Determine type based on class (f, x, etc.) - adapt if needed
                        type: $note.attr('class')?.split(' ').find(c => c !== 'note'),
                        label: $note.find('span.label').text(),
                        body: noteBody
                    });
                });

                // Add verse to the current block if it has content
                if (currentText || currentNotes.length > 0 || (currentNumber !== null && !isNaN(currentNumber))) {
                     // Basic merging: If the last verse in the block has the same USFM, append text/notes (less likely needed now?)
                     // This simple check might need refinement if complex merging is required across blocks.
                     const lastVerse = currentBlock.verses[currentBlock.verses.length - 1];
                     if (lastVerse && lastVerse.usfm === currentUsfm) {
                         if (currentText) {
                             lastVerse.text += (lastVerse.text ? ' ' : '') + currentText; // Append text
                         }
                         lastVerse.notes.push(...currentNotes);
                         // Update number if the current one is valid and the existing one wasn't
                         if ((lastVerse.number === null || isNaN(lastVerse.number)) && (currentNumber !== null && !isNaN(currentNumber))) {
                             lastVerse.number = currentNumber;
                         }
                     } else {
                         // Add new verse object
                         currentBlock.verses.push({
                             number: (currentNumber !== null && !isNaN(currentNumber)) ? currentNumber : null,
                             usfm: currentUsfm,
                             text: currentText,
                             notes: currentNotes
                         });
                     }
                }
            }); // End verse iteration

            // Add the block to chapter content only if it contains verses
            if (currentBlock.verses.length > 0) {
                chapterData.content.push(currentBlock);
            }
        } // End paragraph/quote/m/li1 block processing
    }); // End main content block iteration

    // No need for extra cleanup if blocks are only added when they have verses

    result.book.chapters.push(chapterData);
    return result;
}

// Route handler for fetching all versions configuration
router.get('/versions', async (req, res) => {
    const s3Key = `versions/index.json`;
    
    // First try to get from S3 cache
    try {
        const exists = await checkJsonExists(s3Key);
        if (exists) {
            console.log(`Found cached versions configuration in S3 for key: ${s3Key}`);
            const cachedData = await getJsonFromS3(s3Key);
            return res.json(cachedData );
        }
    } catch (s3Error) {
        console.error(`Error checking S3 cache for key ${s3Key}:`, s3Error.message);
        // Continue with normal flow if S3 check fails
    }

    let versionsData = null;
    try {
        const apiUrl = 'https://www.bible.com/api/bible/configuration';
        console.log(`Fetching versions configuration from: ${apiUrl}`);
        
        const response = await axios.get(apiUrl, {
            timeout: 10000 // 10 seconds timeout
        });

        if (response.data) {
            console.log('Successfully fetched versions configuration');
            versionsData = response.data.response.data.default_versions;
            
            // Save to S3 cache for future requests
            try {
                const tempFilePath = path.join(os.tmpdir(), `${uuidv4()}.json`);
        
                if (versionsData) {
                    await fs.writeFile(tempFilePath, JSON.stringify({data: versionsData}));
                    await uploadToS3(s3Key, tempFilePath, 'application/json');
                    console.log(`Successfully cached versions configuration in S3 with key: ${s3Key}`);
                } else {
                    console.warn('No default_versions found in response data');
                }
            } catch (s3Error) {
                console.error('Error saving to S3 cache:', s3Error.message);
                // Optionally, add more error handling or logging here
            }
        
            return res.json({ data: versionsData });
        } else {
            console.warn('Received empty or unexpected data structure for versions configuration');
            return res.status(404).json({ error: 'No versions configuration found' });
        }
    } catch (error) {
        console.error(`Failed to fetch versions configuration: ${error.message}`);
        const statusCode = error.response ? error.response.status : 500;
        const errorMessage = `Failed to retrieve versions configuration. ${error.message}`;
        return res.status(statusCode).json({ error: errorMessage });
    }
});

// Route handler for fetching all versions by language (defined last to avoid conflict)
// Accepts ISO 639-1 (e.g., 'es') and converts to ISO 639-3 (e.g., 'spa') for the API call
router.get('/versions/:lang', async (req, res) => {
    const langParam = req.params.lang.toLowerCase(); // Ensure lowercase for matching map keys

    // Check if the input looks like a 2-letter ISO 639-1 code
    if (langParam && langParam.length === 2) {
        const lang_tag_3 = langCodeMap[langParam]; // Look up the 3-letter code

        if (!lang_tag_3) {
            console.log(`Unsupported ISO 639-1 language code received: ${langParam}`);
            return res.status(400).json({ error: `Unsupported or unknown language code: ${langParam}. Please use a supported 2-letter ISO 639-1 code.` });
        }

        // First try to get from S3 cache
        const s3Key = `versions/${langParam}/index.json`;
        try {
            const exists = await checkJsonExists(s3Key);
            if (exists) {
                console.log(`Found cached versions in S3 for key: ${s3Key}`);
                const cachedData = await getJsonFromS3(s3Key);
                return res.json(cachedData);
            }
        } catch (s3Error) {
            console.error(`Error checking S3 cache for key ${s3Key}:`, s3Error.message);
            // Continue with normal flow if S3 check fails
        }

        const apiUrl = `https://www.bible.com/api/bible/versions?language_tag=${lang_tag_3}&type=all`;

        console.log(`Request received for all versions in language (ISO 639-1): ${langParam}, mapped to (ISO 639-3): ${lang_tag_3}`);
        console.log(`Fetching data from: ${apiUrl}`);

        try {
            const response = await axios.get(apiUrl, {
                timeout: 10000 // 10 seconds timeout
            });

            // Check if the response has data
            if (response.data) {
                console.log(`Successfully fetched versions for language: ${langParam}`);

                // Save to S3 cache for future requests
                try {
                    const tempFilePath = path.join(os.tmpdir(), `${uuidv4()}.json`);
                    await fs.writeFile(tempFilePath, JSON.stringify({data: response.data.response.data}));
                    await uploadToS3(s3Key, tempFilePath, 'application/json');
                    console.log(`Successfully cached versions in S3 with key: ${s3Key}`);
                } catch (s3Error) {
                    console.error('Error saving to S3 cache:', s3Error.message);
                    // Continue with response even if S3 save fails
                }

                return res.json({data: response.data.response.data});
            } else {
                console.warn(`Received empty or unexpected data structure for versions language: ${langParam}`);
                return res.status(404).json({ error: `No versions found for language tag: ${langParam}` });
            }

        } catch (error) {
            console.error(`Failed to fetch versions for language ${langParam}: ${error.message}`);
            const statusCode = error.response ? error.response.status : 500;
            const errorMessage = `Failed to retrieve Bible versions for language ${langParam}. ${error.message}`;
            return res.status(statusCode).json({ error: errorMessage });
        }
    } else {
        console.log(`Parameter '${langParam}' doesn't look like a valid 2-letter language code. Sending 400.`);
        return res.status(400).json({ error: `Invalid language parameter format: ${langParam}. Expected 2-letter ISO 639-1 code.` });
    }
});

// Route handler for fetching Bible chapter data using abbreviation
router.get('/:lang/:bible_abbreviation/:bible_book/:bible_chapter', async (req, res) => {
    const { lang, bible_abbreviation, bible_book, bible_chapter } = req.params;

    // Look up the bible_id from the abbreviation
    const bible_id = bibleVersionMap[bible_abbreviation];

    if (!bible_id) {
        console.log(`Bible abbreviation not found: ${bible_abbreviation}`);
        return res.status(404).json({ error: `Bible version abbreviation '${bible_abbreviation}' not found.` });
    }

    const bible_id_json = `${bible_id}.json`; // Construct the JSON filename using the found ID

    console.log(`Request received for: ${lang}/${bible_abbreviation} (ID: ${bible_id})/${bible_book}/${bible_chapter}`);

    // First try to get from S3 cache
    const s3Key = `text/${bible_abbreviation}/${bible_book.toUpperCase()}/${bible_chapter}.json`;
    try {
        const exists = await checkJsonExists(s3Key);
        if (exists) {
            console.log(`Found cached JSON in S3 for key: ${s3Key}`);
            const cachedData = await getJsonFromS3(s3Key);
            return res.json(cachedData);
        }
    } catch (s3Error) {
        console.error(`Error checking S3 cache for key ${s3Key}:`, s3Error.message);
        // Continue with normal flow if S3 check fails
    }

    let attempt = 1;
    while (attempt <= 2) { // Allow one initial attempt and one retry
        try {
            const buildId = await getBuildId(); // Get current or fetch new BUILD_ID
            // Use the looked-up bible_id and ensure bible_book is uppercase in the API URL
            const apiUrl = `https://www.bible.com/_next/data/${buildId}/${lang}/bible/${bible_id}/${bible_book.toUpperCase()}.${bible_chapter}.${bible_abbreviation}.json?versionId=${bible_id}&usfm=${bible_book.toUpperCase()}.${bible_chapter}.${bible_abbreviation}`;
            // const apiUrl = `https://www.bible.com/_next/data/${buildId}/${lang}/bible/${bible_id}/${bible_book.toUpperCase()}.${bible_chapter}.${bible_abbreviation}.json?versionId=${bible_id}&usfm=${bible_book.toUpperCase()}.${bible_chapter}.${bible_abbreviation}`; // Also updated commented line for consistency

            console.log(`Attempt ${attempt}: Fetching data from ${apiUrl}`);
            const bibleResponse = await axios.get(apiUrl, {
                // Set a reasonable timeout
                timeout: 10000 // 10 seconds
            });

            // Check if the response looks valid (adjust based on actual API response structure)
            if (bibleResponse.data && bibleResponse.data.pageProps) {
                 // Extract essential data
                 const pageProps = bibleResponse.data.pageProps;
                 const rawHtmlContent = pageProps.chapterInfo?.content; // Get the raw HTML
                 let parsedContent = null;
                 if (rawHtmlContent) {
                     try {
                         // Parse the HTML content using the function defined below
                         const fullParsedData = parseBibleHtmlToJson(rawHtmlContent);
                         // Extract the relevant chapter content array
                         parsedContent = fullParsedData?.book?.chapters?.[0]?.content;
                     } catch (parseError) {
                         console.error("Error parsing HTML content:", parseError);
                         // Decide how to handle parsing errors, maybe return raw HTML or an error indicator
                          parsedContent = { error: "Failed to parse HTML content", details: parseError.message };
                      }
                  }

                  // Process parsedContent to flatten verses while keeping headings
                  let finalContent = [];
                  if (Array.isArray(parsedContent)) {
                      parsedContent.forEach(item => {
                          // Keep heading and reference (subheading) objects
                          if (item.type === 'heading' || item.type === 'reference') {
                              finalContent.push(item);
                          } else if (item.verses && Array.isArray(item.verses)) {
                              item.verses.forEach(verse => {
                                  // Push an object containing number, usfm, and text for each verse
                                   // Ensure number, usfm, or text exist, or if notes exist
                                   if (verse.number !== null || verse.usfm || verse.text || (verse.notes && verse.notes.length > 0)) {
                                       finalContent.push({
                                           number: verse.number,
                                           usfm: verse.usfm,
                                           text: verse.text || "", // Ensure text is at least an empty string
                                           notes: verse.notes || [] // Include notes array, default to empty
                                       });
                                   }
                               });
                           }
                          // Ignore items that are neither headings nor contain verses (or handle other types if needed)
                      });
                  } else if (parsedContent && parsedContent.error) {
                      // If parsing failed, pass the error object through
                      finalContent = parsedContent;
                  }
                  // If parsedContent is null or not an array/error object, finalContent remains empty []

                  const simplifiedResponse = {
                    title: pageProps.chapterInfo?.reference.human,
                    usfm: pageProps.usfm,
                    locale: pageProps.locale,
                    content: finalContent, // Use the processed content
                    previous_chapter: pageProps.chapterInfo?.previous,
                    next_chapter: pageProps.chapterInfo?.next,
                    language: pageProps.versionData?.language?.iso_639_1,
                    direction: pageProps.versionData?.language?.text_direction,
                    publisher: pageProps.versionData?.publisher?.name,
                    copyright: pageProps.chapterInfo?.copyright.text,
                    notes: [{
                      text: pageProps.versionData?.reader_footer?.text,
                      url: pageProps.versionData?.reader_footer_url
                    }]
                  };

                 console.log(`Attempt ${attempt}: Successfully fetched and processed data.`);
                 
                 // Save to S3 cache for future requests
                 try {
                     const s3Key = `text/${bible_abbreviation}/${bible_book.toUpperCase()}/${bible_chapter}.json`;
                     const tempFilePath = path.join(os.tmpdir(), `${uuidv4()}.json`);
                     await fs.writeFile(tempFilePath, JSON.stringify({data: simplifiedResponse}));
                     await uploadToS3(s3Key, tempFilePath, 'application/json');
                     console.log(`Successfully cached response in S3 with key: ${s3Key}`);
                 } catch (s3Error) {
                     console.error('Error saving to S3 cache:', s3Error.message);
                     // Continue with response even if S3 save fails
                 }
                 
                 return res.json({data: simplifiedResponse}); // Send the simplified response
            } else {
                 // If response is OK but data is unexpected, treat as an error for retry
                 console.warn(`Attempt ${attempt}: Received unexpected data structure.`);
                 throw new Error('Unexpected data structure received from Bible API.');
            }

        } catch (error) {
            console.error(`Attempt ${attempt} failed: ${error.message}`);
            // Check if it's likely a BUILD_ID issue (e.g., 404 Not Found) or a network issue
            // Axios errors have a 'response' property for HTTP errors
            const isBuildIdError = error.response && error.response.status === 404;

            if (attempt === 1 && isBuildIdError) {
                console.log('Potential BUILD_ID mismatch. Forcing refresh and retrying...');
                try {
                    // Force refresh of BUILD_ID
                    currentBuildId = await fetchBuildId();
                    // Increment attempt counter and loop will retry
                } catch (refreshError) {
                    console.error('Failed to refresh BUILD_ID:', refreshError.message);
                    // If refreshing fails, don't retry, send error immediately
                    return res.status(500).json({ error: 'Failed to retrieve data after BUILD_ID refresh failed.' });
                }
            } else {
                // If it's the second attempt or not a BUILD_ID error, send error response
                const statusCode = error.response ? error.response.status : 500;
                const errorMessage = `Failed to retrieve Bible data. Attempt ${attempt}. ${error.message}`;
                return res.status(statusCode).json({ error: errorMessage });
            }
        }
        attempt++; // Increment attempt counter for the loop
    }
});

// --- New POST Audio Bible Endpoint ---
router.post('/audio-bible', async (req, res) => {
    // Extract data from JSON body - Removed 'text', added bible_lang
    const {
        // text,            // REMOVED: Text will be fetched internally
        bible_abbreviation, // Bible version abbreviation (e.g., "NVI-S")
        bible_book,         // Book code (e.g., "GEN")
        bible_chapter,      // Chapter number (e.g., "1")
        bible_lang          // NEW: Language identifier (e.g., "es")
    } = req.body;

    // Basic Input Validation - Removed 'text' check, added bible_lang check
    if (!bible_abbreviation || !bible_book || !bible_chapter || !bible_lang) {
        return res.status(400).json({ error: "Missing required fields: 'bible_abbreviation', 'bible_book', 'bible_chapter', and 'bible_lang' are required in the JSON body." });
    }

    // Determine language_code and voice_name based on bible_lang
    let language_code;
    let voice_name;

    if (bible_lang.toLowerCase() === 'es') {
        language_code = "es-ES";
        voice_name = "Linda";
        console.log(`Language set to Spanish (es-ES) with voice 'Linda' based on bible_lang='es'.`);
    } else {
        // Handle unsupported languages - Returning error for now
        console.warn(`Unsupported bible_lang received: ${bible_lang}. Only 'es' is currently supported.`);
        return res.status(400).json({ error: `Unsupported language specified: '${bible_lang}'. Currently, only 'es' is supported.` });
        // Alternative: Set defaults or add more 'else if' blocks for other languages here
    }

    // Normalize inputs for consistency (remains the same)
    const normAbbr = bible_abbreviation;
    const normBook = bible_book.toUpperCase();
    const normChapter = bible_chapter.toString();

    // Construct a reference string for logging and S3 key generation (remains the same)
    const bible_reference_log = `${normAbbr}/${normBook}/${normChapter}`;
    const s3Key = `audio/${normAbbr}/${normBook}/${normChapter}.mp3`; // S3 key format without lang

    console.log(`POST /audio-bible request received for: ${bible_reference_log} with lang: ${bible_lang}`);

    const tempDir = os.tmpdir();
    let tempAudioFiles = []; // Keep track of temporary files created

    try {
        // 1. Check if audio exists in S3
        const s3Key = `audio/${normAbbr}/${normBook}/${normChapter}.mp3`;
        const exists = await checkJsonExists(s3Key);
        if (exists) {
            console.log(`Found cached audio in S3 for key: ${s3Key}`);
            const s3Url = `https://s3.redmasiva.ai/file/data-biblia-chat/${s3Key}`;
            return res.json({ audio_url: s3Url });
        }
        console.log(`Audio not found in S3 for ${bible_reference_log}. Proceeding to generate.`);

        // 2. Fetch Text Internally
        let fetchedText = '';
        try {
            const textApiUrl = `http://localhost:1020/api/${bible_lang}/${bible_abbreviation}/${bible_book}/${bible_chapter}`; // Corrected API path
            console.log(`Fetching text from internal API: ${textApiUrl}`);
            const textResponse = await axios.get(textApiUrl, { timeout: 5000 }); // 5 second timeout

            if (textResponse.data && textResponse.data.title && Array.isArray(textResponse.data.content)) {
                const title = textResponse.data.title;
                const content = textResponse.data.content;
                let textParts = [];

                // Add formatted title
                if (title) {
                    textParts.push(`${title}:`);
                }

                // Find and add formatted first heading
                const firstHeadingIndex = content.findIndex(item => item.type === 'heading');
                let firstHeadingText = null;
                if (firstHeadingIndex !== -1 && content[firstHeadingIndex].text) {
                    firstHeadingText = content[firstHeadingIndex].text;
                    textParts.push(`${firstHeadingText}...`);
                }

                // Add remaining content text (excluding the first heading if found and excluding references)
                content.forEach((item, index) => {
                    // Add text if it exists, is not the first heading we already added, and is not a reference type
                    if (item.text && index !== firstHeadingIndex && item.type !== 'reference') {
                        textParts.push(item.text);
                    }
                });

                fetchedText = textParts.join('\n'); // Join with newline
                console.log("Formatted Text Content for Audio:\n", fetchedText); // Log the formatted text
            } else {
                throw new Error('Invalid or incomplete data received from internal text API (missing title or content array).');
            }
        } catch (fetchError) {
            console.error(`Error fetching text from internal API for ${bible_reference_log}:`, fetchError.message);
            return res.status(500).json({ error: `Failed to fetch required text content: ${fetchError.message}` });
        }

        // 3. Split Fetched Text if Necessary
        const textChunks = splitTextIntoChunks(fetchedText, SPEECHIFY_CHAR_LIMIT);
        console.log(`Fetched text split into ${textChunks.length} chunk(s).`);

        // 4. Generate Audio for Each Chunk
        const speechifyPromises = textChunks.map(chunk =>
            generateAudioSpeechify(chunk, voice_name, language_code, "mp3")
        );
        const speechifyResults = await Promise.all(speechifyPromises);

        // 4. Save Audio Chunks from Base64
        const savePromises = speechifyResults.map(result => {
            if (!result || !result.audioStream) {
                 throw new Error("Invalid response received from Speechify API (missing audioStream).");
            }
            // Call the function to decode Base64 and save the file
            return saveAudioChunkFromBase64(result.audioStream, tempDir);
        });
        tempAudioFiles = await Promise.all(savePromises); // Get paths to saved temp files

        // 5. Concatenate Audio Files (if more than one chunk)
        let finalAudioPath;
        if (tempAudioFiles.length === 1) {
            finalAudioPath = tempAudioFiles[0];
            console.log("Single audio chunk, no concatenation needed.");
        } else {
            // Use a unique name for the concatenated file in temp dir (without lang)
            const concatenatedPath = path.join(tempDir, `final_${normAbbr}_${normBook}_${normChapter}.mp3`);
            finalAudioPath = await concatenateAudioFiles(tempAudioFiles, concatenatedPath);
            // tempAudioFiles are deleted by concatenateAudioFiles on success/error
            tempAudioFiles = [finalAudioPath]; // Track only the final concatenated file
        }

        // 6. Upload Final Audio to S3
        const s3Url = await uploadToS3(s3Key, finalAudioPath, 'audio/mpeg');
        // finalAudioPath is deleted by uploadToS3 on success/error

        // 7. Log the audio generation (removed database insertion)
        console.log(`Audio generated for ${bible_reference_log}: ${s3Url}`);

        // 8. Return S3 URL
        return res.json({ audio_url: s3Url });

    } catch (error) {
        console.error(`Error processing POST /audio-bible request for ${bible_reference_log}:`, error);
        // Ensure temporary files are cleaned up on error
        if (tempAudioFiles.length > 0) {
            console.error(`Cleaning up ${tempAudioFiles.length} temporary audio file(s) due to error...`);
            await Promise.all(tempAudioFiles.map(filePath =>
                fs.unlink(filePath).catch(e => console.error(`Failed to delete temp file ${filePath}: ${e.message}`))
            ));
        }
        return res.status(500).json({ error: `Failed to generate audio: ${error.message}` });
    } finally {
    }
});

// Route handler for fetching Bible version data using abbreviation
router.get('/:lang/:bible_abbreviation', async (req, res) => {
    const { lang, bible_abbreviation } = req.params;

    // Look up the bible_id from the abbreviation
    const bible_id = bibleVersionMap[bible_abbreviation];

    if (!bible_id) {
        console.log(`Bible abbreviation not found for version info: ${bible_abbreviation}`);
        return res.status(404).json({ error: `Bible version abbreviation '${bible_abbreviation}' not found.` });
    }

    const bible_id_json = `${bible_id}.json`; // Construct the JSON filename using the found ID

    console.log(`Request received for version info: ${lang}/${bible_abbreviation} (ID: ${bible_id})`);

    // First try to get from S3 cache
                    const s3Key = `versions/${lang}/${bible_abbreviation}.json`; // Guardamos en la ruta correcta con el idioma
    try {
        const exists = await checkJsonExists(s3Key);
        if (exists) {
            console.log(`Found cached version info in S3 for key: ${s3Key}`);
            const cachedData = await getJsonFromS3(s3Key);
            return res.json(cachedData);
        }
    } catch (s3Error) {
        console.error(`Error checking S3 cache for key ${s3Key}:`, s3Error.message);
        // Continue with normal flow if S3 check fails
    }

    let attempt = 1;
    while (attempt <= 2) { // Allow one initial attempt and one retry
        try {
            const buildId = await getBuildId(); // Get current or fetch new BUILD_ID
            // Note the different URL structure for version info - use the looked-up bible_id
            const apiUrl = `https://www.bible.com/_next/data/${buildId}/${lang}/versions/${bible_id_json}`;

            console.log(`Attempt ${attempt}: Fetching version data from ${apiUrl}`);
            const versionResponse = await axios.get(apiUrl, {
                timeout: 10000 // 10 seconds timeout
            });

            // Check if the response looks valid and contains the required data
            if (versionResponse.data && versionResponse.data.pageProps && versionResponse.data.pageProps.version) {
                console.log(`Attempt ${attempt}: Successfully fetched version data.`);
                // Extract version data
                const pageProps = versionResponse.data.pageProps;
                    const modifiedBooks = pageProps.version.books.map(book => {
                        const newBook = {
                            text: book.text,
                            usfm: book.usfm,
                            audio: book.audio,
                            canon: book.canon,
                            human: book.human
                        };

                        if (book.chapters && book.chapters.length > 0) {
                            newBook.first_chapter = {
                                ...book.chapters[0],
                                usfm: `${book.usfm}.1`
                            };
                            newBook.last_chapter = book.chapters[book.chapters.length - 1];
                        }

                        return newBook;
                    });

                const versionData = {
                    title: pageProps.version.title,
                    usfm: pageProps.version.abbreviation,
                    books: modifiedBooks,
                    language: pageProps.version?.language?.iso_639_1,
                    direction: pageProps.version?.language?.text_direction,
                    publisher: [{
                        name: pageProps.version?.publisher?.name,
                        description: pageProps.version?.publisher?.description,
                        url: pageProps.version?.publisher?.url
                    }],
                    copyright: pageProps.chapterInfo?.copyright.text,
                    notes: [{
                        text: pageProps.versionData?.reader_footer?.text,
                        url: pageProps.versionData?.reader_footer_url
                    }]
                };

                // Save to S3 cache for future requests
                try {
                    const s3Key = `versions/${bible_abbreviation}.json`; // Eliminamos el idioma de la clave S3
                    const tempFilePath = path.join(os.tmpdir(), `${uuidv4()}.json`);
                    await fs.writeFile(tempFilePath, JSON.stringify({data: versionData }));
                    await uploadToS3(s3Key, tempFilePath, 'application/json');
                    console.log(`Successfully cached version data in S3 with key: ${s3Key}`);
                } catch (s3Error) {
                    console.error('Error saving to S3 cache:', s3Error.message);
                    // Continue with response even if S3 save fails
                }

                return res.json({data: versionData });
            } else {
                console.warn(`Attempt ${attempt}: Received unexpected data structure for version info.`);
                throw new Error('Unexpected data structure received from Bible API for version info.');
            }

        } catch (error) {
            console.error(`Attempt ${attempt} failed for version info: ${error.message}`);
            const isBuildIdError = error.response && error.response.status === 404;

            if (attempt === 1 && isBuildIdError) {
                console.log('Potential BUILD_ID mismatch for version info. Forcing refresh and retrying...');
                try {
                    currentBuildId = await fetchBuildId(); // Force refresh
                } catch (refreshError) {
                    console.error('Failed to refresh BUILD_ID for version info:', refreshError.message);
                    return res.status(500).json({ error: 'Failed to retrieve version data after BUILD_ID refresh failed.' });
                }
            } else {
                const statusCode = error.response ? error.response.status : 500;
                const errorMessage = `Failed to retrieve Bible version data. Attempt ${attempt}. ${error.message}`;
                return res.status(statusCode).json({ error: errorMessage });
            }
        }
        attempt++;
    }
});

module.exports = router; // Keep the original export
// Example usage (for testing purposes, could be removed or adapted)
// const sampleHtml = `<div class="version vid149 iso6393spa" data-vid="149" data-iso6393="spa">...</div>`; // Your HTML here
// const jsonData = parseBibleHtmlToJson(sampleHtml);
// console.log(JSON.stringify(jsonData, null, 2));
