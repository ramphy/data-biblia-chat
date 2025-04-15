const axios = require('axios');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const audioconcat = require('audioconcat');
const fs = require('fs').promises; // Use promises for async file operations
const path = require('path');
const os = require('os'); // To get temporary directory
const { v4: uuidv4 } = require('uuid'); // For unique temporary filenames

// --- S3 Configuration (Backblaze B2) ---
// WARNING: Hardcoding credentials is not recommended for production. Use environment variables.
const s3Config = {
  endpoint: "https://s3.us-east-005.backblazeb2.com",
  region: "us-east-005", // Backblaze region often matches the first part of the endpoint
  credentials: {
    accessKeyId: "00551627c51951b000000000f", // Your Key ID
    secretAccessKey: "K005DVjnb9quAOF/5b+6QoV8e74AWtk", // Your Application Key
  },
};
const s3Client = new S3Client(s3Config);
const s3BucketName = "data-biblia-chat";

console.log("S3 Client configured for Backblaze B2 in audio_utils.js.");

// --- Constants ---
const SPEECHIFY_API_URL = "https://audio.api.speechify.com/generateAudioFiles";
const SPEECHIFY_CHAR_LIMIT = 10; // Set back to original requirement

/**
 * Splits text into chunks respecting the character limit, breaking at spaces.
 * @param {string} text - The full text to split.
 * @param {number} limit - The maximum character limit per chunk.
 * @returns {string[]} - An array of text chunks.
 */
function splitTextIntoChunks(text, limit) {
    const chunks = [];
    let currentChunk = "";
    const words = text.split(/\s+/); // Split by whitespace

    for (const word of words) {
        if (currentChunk.length === 0 && word.length > limit) {
            console.warn(`Word "${word.substring(0, 50)}..." exceeds limit ${limit}. Splitting mid-word.`);
            let remainingWord = word;
            while (remainingWord.length > 0) {
                const part = remainingWord.substring(0, limit);
                chunks.push(part);
                remainingWord = remainingWord.substring(limit);
            }
            currentChunk = "";
        } else if ((currentChunk.length > 0 ? currentChunk.length + 1 : 0) + word.length <= limit) {
            currentChunk += (currentChunk.length > 0 ? " " : "") + word;
        } else {
            chunks.push(currentChunk);
            currentChunk = word;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}


/**
 * Generates audio using the Speechify API.
 * @param {string} textChunk - The text chunk (<= 3000 chars).
 * @param {string} voiceName - The desired voice name (e.g., "Linda").
 * @param {string} languageCode - The language code (e.g., "es-ES").
 * @param {string} audioFormat - The audio format (e.g., "mp3").
 * @returns {Promise<object>} - The JSON response from Speechify, likely containing audio URL(s).
 */
async function generateAudioSpeechify(textChunk, voiceName = "Linda", languageCode = "es-ES", audioFormat = "mp3") {
    console.log(`Requesting audio generation for chunk starting with: "${textChunk.substring(0, 50)}..."`);
    const payload = {
        audioFormat: audioFormat,
        paragraphChunks: [textChunk], // API expects an array of strings
        voiceParams: {
            name: "Dalia",
            engine: "azure", // Assuming Azure engine based on Python example
            languageCode: "es-MX"
        }
    };

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/113.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Origin': 'https://speechify.com/voiceover/', // Important for CORS/API checks
        'Referer': 'https://speechify.com/voiceover/', // Important for CORS/API checks
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'X-Speechify-Client': 'API',
        'X-Speechify-Client-Version': '0.1.297',
        'Content-Type': 'application/json' // Ensure content type is set
    };

    try {
        const response = await axios.post(SPEECHIFY_API_URL, payload, { headers: headers, timeout: 60000 }); // 60s timeout for potentially long audio generation
        if (response.status === 200 && response.data && response.data.audioStream) { // Check for audioStream field based on typical API responses
            console.log("Speechify API call successful.");
            return response.data; // Return the whole data object
        } else {
            console.error(`Speechify API error: Status ${response.status}`, response.data);
            throw new Error(`Speechify API returned status ${response.status} or missing audioStream`);
        }
    } catch (error) {
        console.error('Error calling Speechify API:', error.response ? error.response.data : error.message);
        throw new Error(`Failed to generate audio via Speechify: ${error.message}`);
    }
}

/**
 * Decodes a Base64 audio chunk and saves it to a temporary file.
 * @param {string} base64Audio - The Base64 encoded audio data.
 * @param {string} tempDir - The directory to save the temporary file.
 * @returns {Promise<string>} - The path to the saved temporary file.
 */
async function saveAudioChunkFromBase64(base64Audio, tempDir) {
    const tempFilePath = path.join(tempDir, `${uuidv4()}.mp3`);
    console.log(`Decoding Base64 audio chunk and saving to ${tempFilePath}`);
    try {
        // Decode the Base64 string into a buffer
        const audioBuffer = Buffer.from(base64Audio, 'base64');
        // Write the buffer to the temporary file
        await fs.writeFile(tempFilePath, audioBuffer);
        console.log(`Successfully saved decoded audio to ${tempFilePath}`);
        return tempFilePath;
    } catch (error) {
        console.error(`Error decoding/saving Base64 audio chunk to ${tempFilePath}:`, error.message);
        throw new Error(`Failed to process Base64 audio chunk: ${error.message}`);
    }
}

/**
 * Concatenates multiple MP3 files into one using audioconcat.
 * @param {string[]} inputFilePaths - An array of paths to the input MP3 files.
 * @param {string} outputFilePath - The path for the final concatenated MP3 file.
 * @returns {Promise<string>} - The path to the concatenated output file.
 */
function concatenateAudioFiles(inputFilePaths, outputFilePath) {
    return new Promise((resolve, reject) => {
        console.log(`Concatenating ${inputFilePaths.length} files into ${outputFilePath}`);
        audioconcat(inputFilePaths)
            .concat(outputFilePath)
            .on('start', function (command) {
                console.log('ffmpeg process started:', command);
            })
            .on('error', function (err, stdout, stderr) {
                console.error('Error during audio concatenation:', err);
                console.error('ffmpeg stderr:', stderr);
                // Attempt to clean up input files even on error
                Promise.all(inputFilePaths.map(filePath => fs.unlink(filePath).catch(e => console.error(`Failed to delete temp file ${filePath}: ${e.message}`))))
                    .finally(() => reject(new Error(`Audio concatenation failed: ${err.message}`)));
            })
            .on('end', function (output) {
                // Log the output from the event for debugging, but don't rely on it for the path
                console.log(`Audio concatenation 'end' event received. Event output: ${output}`);
                // Clean up the individual chunk files after successful concatenation
                Promise.all(inputFilePaths.map(filePath => fs.unlink(filePath).catch(e => console.error(`Failed to delete temp input file ${filePath}: ${e.message}`))))
                    .finally(() => {
                        // Always resolve with the known outputFilePath after attempting cleanup
                        console.log(`Resolving concatenation promise with path: ${outputFilePath}`);
                        resolve(outputFilePath);
                    });
            });
    });
}


/**
 * Uploads a file from the local filesystem to S3 (Backblaze B2).
 * @param {string} key - The S3 object key (filename).
 * @param {string} filePath - The local path of the file to upload.
 * @param {string} contentType - The MIME type (e.g., 'audio/mpeg').
 * @returns {Promise<string>} - The URL of the uploaded object.
 */
async function uploadToS3(key, filePath, contentType) {
    console.log(`Uploading ${filePath} to S3 key ${key}`);
    try {
        const fileBuffer = await fs.readFile(filePath);
        const command = new PutObjectCommand({
            Bucket: s3BucketName,
            Key: key,
            Body: fileBuffer,
            ContentType: contentType,
            ACL: 'public-read' // Make file publicly accessible if needed
        });

        await s3Client.send(command);
        // Construct the public URL using the custom domain format
        const url = `https://s3.redmasiva.ai/file/${s3BucketName}/${key}`;
        console.log(`Successfully uploaded to S3. Custom URL: ${url}`);
        return url;
    } catch (error) {
        console.error(`Error uploading ${filePath} to S3:`, error);
        throw new Error(`S3 upload failed for key ${key}: ${error.message}`);
    } finally {
         // Clean up the local file after upload attempt (success or failure)
         await fs.unlink(filePath).catch(e => console.error(`Failed to delete local file ${filePath} after S3 upload attempt: ${e.message}`));
    }
}

module.exports = {
    splitTextIntoChunks,
    generateAudioSpeechify,
    saveAudioChunkFromBase64, // Updated function name
    concatenateAudioFiles,
    uploadToS3,
    SPEECHIFY_CHAR_LIMIT
};
