const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio'); // Import cheerio

const router = express.Router();

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

    let attempt = 1;
    while (attempt <= 2) { // Allow one initial attempt and one retry
        try {
            const buildId = await getBuildId(); // Get current or fetch new BUILD_ID
            // Use the looked-up bible_id and ensure bible_book is uppercase in the API URL
            const apiUrl = `https://www.bible.com/_next/data/${buildId}/${lang}/bible/${bible_id}/${bible_book.toUpperCase()}.${bible_chapter}/${bible_id_json}?versionId=${bible_id}&usfm=${bible_book.toUpperCase()}.${bible_chapter}.${bible_abbreviation}`;
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

                 const simplifiedResponse = {
                   reference: pageProps.chapterInfo?.reference,
                   content: parsedContent, // Use the parsed JSON content
                   copyright: pageProps.chapterInfo?.copyright,
                   next_chapter: pageProps.chapterInfo?.next,
                   previous_chapter: pageProps.chapterInfo?.previous,
                   version: {
                     id: pageProps.versionData?.id,
                     abbreviation: pageProps.versionData?.local_abbreviation,
                     title: pageProps.versionData?.local_title,
                     language: pageProps.versionData?.language,
                     publisher: pageProps.versionData?.publisher,
                     copyright: pageProps.versionData?.copyright_short
                   },
                   audio_info: pageProps.audioVersionInfo ? { // Check if audio info exists
                     title: pageProps.audioVersionInfo.title,
                     copyright: pageProps.audioVersionInfo.copyright_short,
                     publisher: pageProps.audioVersionInfo.publisher
                   } : null,
                   usfm: pageProps.usfm,
                   locale: pageProps.locale
                 };

                 console.log(`Attempt ${attempt}: Successfully fetched and processed data.`);
                 return res.json(simplifiedResponse); // Send the simplified response
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
                // Return only the pageProps.version object
                return res.json(versionResponse.data.pageProps.version);
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

// Route handler for fetching all versions by language (defined last to avoid conflict)
// Accepts ISO 639-1 (e.g., 'es') and converts to ISO 639-3 (e.g., 'spa') for the API call
router.get('/:lang', async (req, res) => {
    const langParam = req.params.lang.toLowerCase(); // Ensure lowercase for matching map keys

    // Check if the input looks like a 2-letter ISO 639-1 code
    if (langParam && langParam.length === 2) {
        const lang_tag_3 = langCodeMap[langParam]; // Look up the 3-letter code

        if (!lang_tag_3) {
            console.log(`Unsupported ISO 639-1 language code received: ${langParam}`);
            return res.status(400).json({ error: `Unsupported or unknown language code: ${langParam}. Please use a supported 2-letter ISO 639-1 code.` });
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
                console.log(`Successfully fetched versions for language: ${langParam}`); // Use langParam
                return res.json(response.data); // Return the API response directly
            } else {
                console.warn(`Received empty or unexpected data structure for versions language: ${langParam}`); // Use langParam
                // Send 404 as it's likely the language tag was invalid or had no versions
                return res.status(404).json({ error: `No versions found for language tag: ${langParam}` }); // Use langParam
            }

        } catch (error) {
            console.error(`Failed to fetch versions for language ${langParam}: ${error.message}`); // Use langParam
            const statusCode = error.response ? error.response.status : 500;
            const errorMessage = `Failed to retrieve Bible versions for language ${langParam}. ${error.message}`; // Use langParam
            return res.status(statusCode).json({ error: errorMessage });
        }
    } else {
        // If 'langParam' doesn't look like a 2-letter code
        console.log(`Parameter '${langParam}' doesn't look like a valid 2-letter language code. Sending 400.`); // Use langParam
        return res.status(400).json({ error: `Invalid language parameter format: ${langParam}. Expected 2-letter ISO 639-1 code.` }); // Use langParam
    }
});


module.exports = router; // Keep the original export
// Example usage (for testing purposes, could be removed or adapted)
// const sampleHtml = `<div class="version vid149 iso6393spa" data-vid="149" data-iso6393="spa">...</div>`; // Your HTML here
// const jsonData = parseBibleHtmlToJson(sampleHtml);
// console.log(JSON.stringify(jsonData, null, 2));
